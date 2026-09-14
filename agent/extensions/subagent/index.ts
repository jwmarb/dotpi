/**
 * Subagent Tool — delegate tasks to specialized agents as background Tasks.
 *
 * Every `subagent` call registers a background **Task**, returns its **Task ID**
 * immediately, and never blocks the orchestrator's turn. The orchestrator either
 * waits on the Task via `subagent_tasks wait`, or lets the completion **Reminder**
 * wake it later.
 *
 * Modes:
 *   - Single:   { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent, task }, ...] }
 *   - Chain:    { chain: [{ agent, task: "... {previous} ..." }, ...] }
 *
 * Design decisions live in docs/adr/:
 *   0001 — Tasks die with the orchestrator process
 *   0002 — Task IDs address invocations, not runs
 *   0003 — Always background; blocking is an explicit wait
 *   0004 — Subagents wrap write-ups in <result>
 *   0005 — Headless drains Tasks before exit
 *   0006 — Reminders are system messages, not simulated user messages
 *   0012 — The child's plan file is keyed by Task ID, passed via PI_PLAN_KEY
 */

import { spawn } from "node:child_process";
import {
	closeTab,
	closePane,
	createTab,
	findPaneByLabel,
	herdrAvailable,
	herdrContext,
	HERDR_PI_AGENT,
	nextSeq,
	releaseAgent,
	renamePane,
	reportAgent,
	reportAgentSession,
	runInPane,
	splitPane,
} from "../herdr/client.js";
// The socket client, for what the CLI cannot do: open a plugin pane and
// subscribe to pane lifecycle events (docs/adr/0044).
import {
	herdrSocketAvailable,
	openPluginPane,
} from "../herdr/socket.js";
import { watchNativeRun } from "./watcher.js";
import * as fs from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionUIContext,
	getAgentDir,
	getMarkdownTheme,
	type ThemeColor,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { extractResult } from "./results.js";
import { reapSessions, thawRun } from "./reaper.js";
import { formatRunIndex, scanRunDirs } from "./runindex.js";
import { DONE_TOOL_NAME } from "./child-done.js";
import {
	buildLaunchPlan,
	buildSubagentToolAllowlist,
	RUN_ENTRYPOINT,
	RUN_PLUGIN_ID,
} from "./native.js";
import type { RunOutcome } from "./rundir.js";
import {
	mirrorPaneLabel,
	runsRoot,
	shortRunId,
	writeRunSidecar,
} from "./rundir.js";
// The shared admission cap: one machine, one budget (docs/adr/0040), counted
// across every pi in this tree since native Runs can spawn (docs/adr/0044).
import {
	claimSlot,
	MAX_SPAWNED_CHILDREN,
	setSpawnCapRoot,
} from "./spawnlimit.js";
import { matchTaskRunDirs } from "./taskdirs.js";
import {
	aggregateUsage,
	emptyUsage,
	formatTaskResults,
	formatTaskStatus,
	isTerminal,
	MAX_ACTIVE_TASKS,
	type ModelAttempt,
	type RunResult,
	runFailed,
	type RunSummary,
	summarizeRun,
	type Task,
	type TaskMode,
	setKnownDiskTaskIds,
	TaskRegistry,
	TooManyTasksError,
} from "./tasks.js";
import { formatPreloadedSkills, MAX_SKILL_BYTES, resolveSkills } from "./skills.js";

/** Maximum Runs in one parallel Task. */
const MAX_PARALLEL_TASKS = 8;
/**
 * Concurrent Runs within a single Task.
 *
 * This is a within-Task shaping limit, NOT a limit on load. The real ceiling on
 * concurrent child processes is the shared spawn cap, claimed per Run at the
 * spawn site (docs/adr/0040). This comment previously claimed the ceiling was
 * MAX_ACTIVE_TASKS, which was false in a way that mattered: Tasks are not
 * processes, and six Tasks running four Runs apiece is twenty-four children.
 */
const MAX_CONCURRENCY = 4;
/** Cap on retained stderr per Run. A chatty or looping child would otherwise
 * grow this string for the life of the session. */
const MAX_STDERR_BYTES = 64 * 1024;

/** Grace period between SIGTERM and SIGKILL when reaping a child that reported
 * a terminal error but is still alive. Short: the child has already given up on
 * the turn, so there is nothing left to flush but its own exit. */
const ERROR_REAP_GRACE_MS = 2000;

/** How long a Run may produce no output at all before it is treated as stalled.
 * Generously above pi's own worst-case retry ladder (~10.6 min at 10 retries
 * capped at 128s), so a Run legitimately grinding through retries is never cut
 * short. A long *thinking* turn still streams nothing — hence the wide margin. */
const STALL_TIMEOUT_MS = 20 * 60 * 1000;

/** How often to test for the stall above. */
const STALL_CHECK_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a token count into a human-readable string (e.g. "1.5k", "12k", "1.2M").
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Format usage statistics into a compact display string.
 */
function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns)
		parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0)
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

/**
 * Format a tool call into a compact, themed display string.
 */
function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview =
				command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg(
					"warning",
					`:${startLine}${endLine ? `-${endLine}` : ""}`,
				);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return (
				themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
			);
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "find ") +
				themeFg("accent", pattern) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview =
				argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

/** A single display item extracted from a Run's Transcript. */
type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

/**
 * Extract text and tool-call display items from a message list.
 *
 * Used only for the human-facing TUI view — never for the orchestrator.
 */
function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
					});
			}
		}
	}
	return items;
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------

/**
 * Map over an array with a concurrency limit.
 */
async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

/**
 * Write the agent's system prompt to a temporary file for `--append-system-prompt`.
 */
async function writePromptToTempFile(
	agentName: string,
	prompt: string,
): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(
		path.join(os.tmpdir(), "pi-subagent-"),
	);
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
	return { dir: tmpDir, filePath };
}

/**
 * Determine how to re-invoke the current `pi` process.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

/**
 * How a **Native Run**'s wrapper should invoke `pi`, as a full argv prefix.
 *
 * Separate from {@link getPiInvocation} because the two answer different
 * questions. That one re-invokes *this* process and may legitimately return a
 * runtime plus `process.argv[1]`; here the command is written into a shell script
 * that herdr runs later, in another process, where `argv[1]` means nothing. Using
 * it directly is what produced `node: bad option: --session-dir` — the runtime
 * arrived without its script.
 *
 * So resolution goes from most to least self-describing:
 *
 * 1. `PI_BIN`, when the user has said explicitly which `pi` to run.
 * 2. A `pi` on `PATH`. The installed launcher carries its own `#!/usr/bin/env
 *    node` shebang, so it needs no runtime prefix and cannot be split from its
 *    script — which is exactly the failure this avoids.
 * 3. This process's own runtime plus its entry script, for a pi run from a
 *    checkout with nothing installed on PATH. Correct only because the child is
 *    the same program as the parent.
 *
 * @returns argv words to invoke pi, never empty.
 */
function nativePiCommand(): string[] {
	const explicit = process.env.PI_BIN;
	if (explicit) return [explicit];

	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "pi");
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return [candidate];
		} catch {
			// Not here, or not executable: keep looking.
		}
	}

	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script))
		return [process.execPath, script];
	return ["pi"];
}

/** The write-up contract, appended to every subagent's system prompt so it
 * holds even for agent files that predate it. */
const RESULT_CONTRACT = [
	"## Write-up contract (required)",
	"",
	"Your final message MUST end with your complete answer wrapped in a single",
	"`<result>` element:",
	"",
	"```",
	"<result>",
	"...your full write-up here, in the format your role specifies...",
	"</result>",
	"```",
	"",
	"Only the content inside `<result>` reaches the orchestrator. Anything outside",
	"the tags is discarded, so never leave part of your answer outside it, and never",
	"emit more than one `<result>` element. Markdown inside the tags is fine.",
].join("\n");

/**
 * Run a single subagent, falling back through the agent's declared fallback
 * models when an attempt fails.
 *
 * Only genuine failures trigger a fallback: a canceled Run stops immediately,
 * because the user asked for it to stop, not for a different model. Usage from
 * failed attempts is kept — that cost was really incurred — while the failed
 * transcript is discarded so the extracted Result comes from the winning
 * attempt alone.
 *
 * @param defaultCwd - Fallback working directory.
 * @param agents - Available agents.
 * @param runResult - The record to populate (already registered on the Task).
 * @param skillNames - Skills to preload into the agent's system prompt.
 * @param cwd - Optional working directory for this Run.
 * @param signal - Abort signal from the owning Task.
 * @param onProgress - Called after each streamed message.
 * @param planKey - Plan file key for this Run (docs/adr/0012).
 */
async function executeRun(
	defaultCwd: string,
	agents: AgentConfig[],
	runResult: RunResult,
	skillNames: string[] | undefined,
	cwd: string | undefined,
	signal: AbortSignal,
	onProgress: () => void,
	planKey: string,
): Promise<void> {
	const agent = agents.find((a) => a.name === runResult.agent);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		runResult.exitCode = 1;
		runResult.stopReason = "unknown_agent";
		runResult.errorMessage = `Unknown agent: "${runResult.agent}". Available agents: ${available}.`;
		return;
	}

	runResult.agentSource = agent.source;

	const chain: (string | undefined)[] = [
		agent.model,
		...(agent.fallbackModels ?? []),
	];
	const attempts: ModelAttempt[] = [];

	for (let i = 0; i < chain.length; i++) {
		const model = chain[i];

		// Each attempt starts from a clean per-attempt slate; accumulated usage is
		// deliberately left alone.
		runResult.model = model;
		runResult.messages = [];
		runResult.exitCode = -1;
		runResult.stopReason = undefined;
		runResult.errorMessage = undefined;
		runResult.resultWarning = undefined;

		await executeAttempt(
			defaultCwd,
			agent,
			model,
			runResult,
			skillNames,
			cwd,
			signal,
			onProgress,
			planKey,
		);

		const failed = runFailed(runResult);
		const isLast = i === chain.length - 1;
		// A cancel is a decision, not a fault: never burn a fallback on it.
		const retryable =
			failed && runResult.stopReason !== "aborted" && !signal.aborted;

		attempts.push({
			model,
			error: failed
				? (runResult.stopReason ?? `exit ${runResult.exitCode}`)
				: undefined,
		});

		if (!failed || !retryable || isLast) {
			// Report the chain only when it was actually exercised, so unchanged
			// single-model agents produce byte-identical output to before.
			if (attempts.length > 1) runResult.modelAttempts = attempts;
			// The Run is over: stop claiming its pane hosts a live agent, but leave
			// the pane itself open so its evidence survives (docs/adr/0016).
			void closeMirrorReporting(runResult);
			return;
		}
	}
}

/**
 * Shorten a Task or Run ID to the digits a human reads out loud.
 *
 * `sub-6748` and `sub-6748-1` both shorten to `6748`: the prefix is noise in a
 * label, and the ordinal is carried separately by the pane's own `#N`.
 *
 * Re-exported from the shared Run-directory contract so this extension and the
 * plan extension shorten IDs identically (docs/adr/0039).
 *
 * @param id - A Task ID or Run ID.
 * @returns The identifying digits, or the whole id if it does not match.
 */
const shortId = shortRunId;

/**
 * Record a Run's identity beside its session file.
 *
 * The session file records what the child *did*, never which specialist it was,
 * and the Board discovers Runs by reading these directories from a separate
 * process with no view of the Task. This sidecar is the only place the two can
 * meet (docs/adr/0026). Best-effort: a Run must not fail because a label could
 * not be written.
 *
 * A thin adapter over the shared Run-directory contract (docs/adr/0039), which
 * owns the layout so this extension and the plan extension cannot disagree about
 * it. Kept as a wrapper because callers here hold a `RunResult`, and because the
 * `step` field is chain-only and meaningless to a single-Run producer.
 *
 * @param sessionDir - The Run's session directory.
 * @param run - The Run being started.
 * @param outcome - Its lifecycle state; rewritten on termination, never once.
 */
async function writeRunMeta(
	sessionDir: string,
	run: RunResult,
	outcome: RunOutcome = "running",
): Promise<void> {
	await writeRunSidecar(
		sessionDir,
		{ runId: run.runId, agent: run.agent, step: run.step },
		outcome,
	);
}

// The Mirror Pane label lives in the shared Run-directory contract: the
// re-opener keys its findPaneByLabel check off this exact string, and the plan
// extension now labels its own Runs, so a second copy would drift and silently
// open duplicate panes for one Run (docs/adr/0039).
/**
 * Open a Mirror Pane for a Run and report it to herdr as an agent.
 *
 * The pane renders the Run's session file; it does not own the child process,
 * so closing it stops nothing (docs/adr/0016, docs/adr/0020). Reporting the
 * pane as an agent with its session path is what puts the Run into herdr's
 * agents sidebar as a browsable live session (docs/adr/0019) — the state is
 * declared by us because a JSON-mode child has no detectable UI on screen.
 *
 * Two conditions must both hold for the session to actually attach
 * (docs/adr/0021): the viewer is launched with `HERDR_AGENT=pi` so herdr
 * *detects* a pi agent in the pane, and the claim uses herdr's official
 * `herdr:pi`/`pi` source-agent pair. The specialist name goes in the pane label,
 * not the agent label, or the session is silently discarded.
 *
 * Every failure is swallowed: a display surface must never affect the Run.
 *
 * @param run - The Run to mirror; its mirrorPaneId is filled in on success.
 * @param tabId - Tab for this Task, if one was created.
 * @param sessionDir - Where the child is writing its session.
 */
async function openMirrorPane(
	run: RunResult,
	paneId: string,
	sessionDir: string,
): Promise<void> {
	try {
		// The label doubles as the re-opener's findPaneByLabel key, so it is
		// computed once in mirrorPaneLabel: two computations would drift.
		await renamePane(paneId, mirrorPaneLabel(run));

		// A re-opened Run may have been archived since it ran (docs/adr/0022):
		// compressed sessions are cold storage, so thaw it back to plain JSONL
		// before anything tries to read it.
		let sessionFile: string | null = null;
		try {
			sessionFile = await thawRun(sessionDir);
		} catch {
			// Thaw is only relevant for an existing archive; a fresh Run has none.
		}
		if (sessionFile) run.sessionFile = sessionFile;

		const viewer = path.join(
			path.dirname(new URL(import.meta.url).pathname),
			"mirror.ts",
		);
		// HERDR_AGENT=pi is herdr's documented hint for a foreground wrapper that
		// hides the real agent process. Without it the pane has no *detected* agent
		// and herdr refuses to attach a session to it (docs/adr/0021).
		//
		// The viewer is given the Run's *directory* and resolves the session file
		// itself: the child writes it only after its own startup, so any deadline
		// we set here is a race we can lose (docs/adr/0025).
		await runInPane(
			paneId,
			`HERDR_AGENT=pi bun ${JSON.stringify(viewer)} ${JSON.stringify(
				sessionDir,
			)} --agent ${JSON.stringify(run.agent)} --task ${JSON.stringify(run.runId)}`,
		);

		// Announce the session first, then the lifecycle state. The specialist name
		// rides in `message`; the agent label must stay canonical.
		if (sessionFile)
			await reportAgentSession(paneId, HERDR_PI_AGENT, sessionFile, nextSeq());
		await reportAgent(paneId, HERDR_PI_AGENT, "working", {
			sessionPath: sessionFile ?? undefined,
			message: `${run.agent}: ${run.task.slice(0, 60)}`,
			seq: nextSeq(),
		});

		// A FRESH Run has no session file yet: `thawRun` only finds an existing
		// archive, so `sessionFile` is null and the two calls above ship no path at
		// all. The viewer resolves the file moments later but never tells anyone, so
		// herdr had no session for any live Run — ADR 0025 removed the parent's
		// discovery deadline without replacing what it fed (docs/adr/0036).
		//
		// So watch for it in the background: no deadline, no polling budget the
		// child can lose, and the pane is already rendering meanwhile.
		if (!sessionFile)
			void announceSessionWhenWritten(run, paneId).catch(() => {
				// Best-effort, like every other display call here.
			});
	} catch {
		// Display is best-effort.
	}
}

/** How long to keep watching for a fresh Run's first session write. */
const SESSION_ANNOUNCE_WINDOW_MS = 5 * 60 * 1000;

/** Interval between checks for that first write. */
const SESSION_ANNOUNCE_POLL_MS = 500;

/**
 * Tell herdr the Run's session path once the child creates it.
 *
 * The parent cannot know the path up front — the filename carries a timestamp
 * the child chooses — and it cannot wait for it either, since a deadline is a
 * race it can lose (that race was the original "0 turns" bug, docs/adr/0025).
 * So it watches without a deadline it can fail: the pane renders regardless, and
 * this only enriches herdr's view when the file appears.
 *
 * The window exists to stop the timer outliving a Run that never writes at all,
 * not to bound a Run that is merely slow: 5 minutes is far beyond any observed
 * startup, and giving up costs only the session link.
 */
async function announceSessionWhenWritten(
	run: RunResult,
	paneId: string,
): Promise<void> {
	const sessionDir = path.join(getAgentDir(), "subagent-sessions", run.runId);
	const deadline = Date.now() + SESSION_ANNOUNCE_WINDOW_MS;

	while (Date.now() < deadline) {
		if (run.stopReason || run.exitCode !== -1) {
			// The Run ended. One last look, then stop: a Run that finished without
			// ever writing a session has nothing to announce.
			const found = await newestSessionFile(sessionDir);
			if (found) await publishSession(run, paneId, found);
			return;
		}
		const found = await newestSessionFile(sessionDir);
		if (found) {
			await publishSession(run, paneId, found);
			return;
		}
		await new Promise((r) => setTimeout(r, SESSION_ANNOUNCE_POLL_MS));
	}
}

/** Newest `.jsonl` in a Run directory by mtime, or null if there is none. */
async function newestSessionFile(sessionDir: string): Promise<string | null> {
	try {
		const names = (await readdir(sessionDir)).filter((n) =>
			n.endsWith(".jsonl"),
		);
		let newest: { path: string; mtimeMs: number } | null = null;
		for (const name of names) {
			const full = path.join(sessionDir, name);
			try {
				const info = await stat(full);
				if (!newest || info.mtimeMs > newest.mtimeMs)
					newest = { path: full, mtimeMs: info.mtimeMs };
			} catch {
				// Vanished mid-scan; the next pass will see whatever replaced it.
			}
		}
		return newest?.path ?? null;
	} catch {
		// The directory may not exist yet.
		return null;
	}
}

/** Record the resolved session on the Run and announce it to herdr. */
async function publishSession(
	run: RunResult,
	paneId: string,
	sessionFile: string,
): Promise<void> {
	if (run.sessionFile === sessionFile) return;
	run.sessionFile = sessionFile;
	try {
		await reportAgentSession(paneId, HERDR_PI_AGENT, sessionFile, nextSeq());
	} catch {
		// Display is best-effort.
	}
}

/**
 * Read the specialist name from a Run's `run.json` sidecar.
 *
 * The sidecar is written best-effort and is missing from some Run
 * directories, so every failure degrades to `subagent` — the pane must open
 * anyway, because the re-open is addressed by Task ID, not by name
 * (docs/adr/0026, docs/adr/0028).
 */
async function readRunAgentFile(runDir: string): Promise<string> {
	try {
		const meta = JSON.parse(
			await readFile(path.join(runDir, "run.json"), "utf-8"),
		) as { agent?: unknown };
		return typeof meta.agent === "string" && meta.agent !== ""
			? meta.agent
			: "subagent";
	} catch {
		return "subagent";
	}
}

/**
 * **Resume** every Run of a finished Task in real `pi` sessions (docs/adr/0044).
 *
 * This replaces `reopenTask`. **Reopen** meant *read a finished transcript* and
 * is retired: there is deliberately no read-only path any more, so revisiting a
 * Run means continuing it. Each Run is opened as a real interactive `pi` on its
 * own session file, which **appends** new turns to that transcript. ADR 0021
 * measured exactly this append and treated it as corruption to be avoided; it is
 * now the intended behaviour, which is why a Run's **Transcript** is a living
 * document rather than a record.
 *
 * The consequence to hold onto: a resumed Run can no longer be *merely looked
 * at*. A stray keystroke becomes a turn in that Run's history, and there is no
 * pristine copy to fall back to.
 *
 * The shared resolver: the `subagent_tasks` `open` action and the `/run`
 * command are thin callers of this, so the two surfaces cannot drift.
 *
 * Resuming is addressed by Task ID and resolves the Task's whole family of
 * Runs from disk — `sub-6748` → `sub-6748-1`, `-2`, … — because the registry
 * is memory-only and cannot see past sessions. A Run that already has a pane
 * is focused, not opened twice; an archived Run is **Thawed** first, so age is
 * invisible to the reader (docs/adr/0022).
 *
 * Best-effort throughout: resuming must never throw into its caller, so
 * every failure is reported as an `error` string.
 *
 * @param taskId - The Task ID to resume (e.g. `sub-6748`).
 * @returns How many Runs were newly opened and how many were already open,
 *          plus an error when not all Runs could be shown.
 */
async function resumeTask(
	taskId: string,
): Promise<{ opened: number; alreadyOpen: number; error?: string }> {
	try {
		if (!herdrAvailable()) {
			return {
				opened: 0,
				alreadyOpen: 0,
				error: "herdr is unavailable, so no pane can be opened",
			};
		}

		const root = path.join(getAgentDir(), "subagent-sessions");
		let names: string[];
		try {
			const dirents = await readdir(root, { withFileTypes: true });
			names = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
		} catch {
			return {
				opened: 0,
				alreadyOpen: 0,
				error: `unknown task ${taskId}: no run directories on disk`,
			};
		}

		const runDirs = matchTaskRunDirs(names, taskId);
		if (runDirs.length === 0) {
			return {
				opened: 0,
				alreadyOpen: 0,
				error: `unknown task ${taskId}: no run directories on disk`,
			};
		}

		// A Run whose pane already carries the label a fresh open would give
		// it is focused, not duplicated (docs/adr/0028).
		const multiRun = runDirs.length > 1;
		let tabAgent: string | undefined;
		let alreadyOpen = 0;
		const toOpen: {
			runId: string;
			sessionDir: string;
			agent: string;
		}[] = [];

		for (const runDirName of runDirs) {
			const sessionDir = path.join(root, runDirName);
			const agent = await readRunAgentFile(sessionDir);
			tabAgent ??= agent;
			const label = mirrorPaneLabel({ runId: runDirName, agent, multiRun });
			if (await findPaneByLabel(label)) {
				alreadyOpen++;
				continue;
			}
			toOpen.push({ runId: runDirName, sessionDir, agent });
		}

		// One Tab per Task, named as a live Task's Tab is: the specialist in
		// the bar, the Runs told apart in their own pane labels.
		const paneIds: (string | null)[] = [];
		if (toOpen.length > 0) {
			const tab = await createTab(`${tabAgent} (#${shortId(taskId)})`);
			if (tab) {
				paneIds.push(tab.paneId); // the root pane hosts the first Run
				for (let i = 1; i < toOpen.length; i++) {
					// Stack Runs vertically, exactly as runTask does: a fan-out
					// of narrow columns is unreadable.
					paneIds.push(
						await splitPane({
							target: tab.paneId,
							direction: "down",
							cwd: process.cwd(),
						}),
					);
				}
			}
		}

		// Each Run is resumed as a real `pi` on its own session file. Thaw first:
		// `pi --session` cannot read a zstd-compressed transcript, and age must be
		// invisible to the reader (docs/adr/0022).
		let opened = 0;
		for (let i = 0; i < toOpen.length; i++) {
			const paneId = paneIds[i];
			const entry = toOpen[i];
			if (!paneId || !entry) continue; // herdr refused this pane; skip

			const sessionFile = await thawRun(entry.sessionDir);
			if (!sessionFile) continue; // Nothing to resume: no transcript on disk.

			await renamePane(
				paneId,
				mirrorPaneLabel({ runId: entry.runId, agent: entry.agent, multiRun }),
			);
			// `pi --session <file>` continues that session in place, appending. No
			// `--fork`: a fork would show a *copy*, which is a different Run wearing
			// this one's clothes and would not be the transcript the Board and Run
			// Index read (docs/adr/0044).
			const invocation = getPiInvocation(["--session", sessionFile]);
			const command = [invocation.command, ...invocation.args]
				.map((a) => `'${a.replaceAll("'", `'\\''`)}'`)
				.join(" ");
			if (await runInPane(paneId, command)) opened++;
		}

		if (opened + alreadyOpen < runDirs.length) {
			return {
				opened,
				alreadyOpen,
				error: `only ${opened + alreadyOpen} of ${runDirs.length} run(s) of ${taskId} are open; herdr refused the rest`,
			};
		}
		return { opened, alreadyOpen };
	} catch {
		// Resuming must never take its caller down with it.
		return {
			opened: 0,
			alreadyOpen: 0,
			error: `could not resume ${taskId}`,
		};
	}
}

/**
 * One resumed Task's outcome, worded the way its callers report it.
 */
function describeResume(
	id: string,
	r: { opened: number; alreadyOpen: number; error?: string },
): string {
	if (r.error) return `${id}: ${r.error}`;
	if (r.opened === 0 && r.alreadyOpen > 0)
		return `${id}: all ${r.alreadyOpen} run(s) already open`;
	return `${id}: ${r.opened} run(s) opened${
		r.alreadyOpen > 0 ? `, ${r.alreadyOpen} already open` : ""
	}`;
}

/**
 * Tell herdr a Run has finished, leaving its pane open to inspect.
 *
 * The pane lingers so the evidence survives (docs/adr/0016), but it must stop
 * claiming to be a live agent, so our agent claim is released.
 */
async function closeMirrorReporting(run: RunResult): Promise<void> {
	if (!run.mirrorPaneId) return;
	try {
		const failed = run.exitCode !== 0 || run.stopReason === "error";
		await reportAgent(run.mirrorPaneId, HERDR_PI_AGENT, "idle", {
			sessionPath: run.sessionFile,
			message: `${run.agent}: ${failed ? "failed" : "done"}`,
			seq: nextSeq(),
		});
		await releaseAgent(run.mirrorPaneId, HERDR_PI_AGENT);
	} catch {
		// Best-effort.
	}
}

/**
 * Close the Tab hosting a finished Task's Mirror Panes.
 *
 * Called when the Reminder lands, not when the Runs end: the Reminder is
 * where the user learns the Task finished and how to resume it, so the Tab
 * survives until that hint is in hand (docs/adr/0028). Best-effort — a Tab
 * that will not close must never affect the Task.
 */
async function closeTaskTab(task: Task): Promise<void> {
	const tabId = task.tabId;
	if (!tabId) return;

	// A Task whose Runs hosted themselves keeps its Tab when anything went wrong.
	// ADR 0028 could close unconditionally because a pane was only a viewport, so
	// closing cost nothing; a **Run Pane** holds the failure's own output, and
	// herdr destroys a pane's scrollback with it — so closing here would delete the
	// only readable evidence, and **Reopen** no longer exists to get it back
	// (docs/adr/0044). Successes still close: nobody needs to dismiss a Run that
	// worked.
	const nativeTask = task.runs.some((r) => r.runPaneId);
	// A **Dismissed** Run is excluded deliberately. It counts as failed for the
	// purposes of "did this produce a Result?", but it leaves *nothing to read*:
	// the user closed that pane themselves, so herdr has already destroyed it.
	// Holding the Tab open for it strands an empty shell the user must close by
	// hand — evidence preservation with no evidence (docs/adr/0044).
	const hasReadableFailure = task.runs.some(
		(r) => runFailed(r) && !r.dismissed,
	);
	if (nativeTask && hasReadableFailure) {
		// Released, not closed: the user closes it when they have read it. Cleared so
		// no later collection path closes it behind their back.
		task.tabId = undefined;
		return;
	}

	// Claim the Tab *before* awaiting. It is now closed from several places — the
	// Reminder, and each of the three Result-collection paths — which can overlap
	// in one turn; clearing after the await let two callers both call closeTab.
	task.tabId = undefined;
	try {
		await closeTab(tabId);
	} catch {
		// Display teardown is best-effort, and deliberately not retried: a Tab that
		// refuses to close is a herdr problem, not the Task's.
	}
}

/**
 * Run one attempt of a subagent by spawning a child `pi` process in JSON mode.
 *
 * Mutates `runResult` in place as events stream in, so the TUI and any status
 * query see live progress without the caller holding a separate copy.
 *
 * @param defaultCwd - Fallback working directory.
 * @param agent - The resolved agent to run.
 * @param model - Model for this attempt, overriding the agent's default.
 * @param runResult - The record to populate (already registered on the Task).
 * @param skillNames - Skills to preload into the agent's system prompt.
 * @param cwd - Optional working directory for this Run.
 * @param signal - Abort signal from the owning Task.
 * @param onProgress - Called after each streamed message.
 * @param planKey - Plan file key for this Run, exported to the child as
 *                  PI_PLAN_KEY so the child's plan tool writes to it (docs/adr/0012).
 */
async function executeAttempt(
	defaultCwd: string,
	agent: AgentConfig,
	model: string | undefined,
	runResult: RunResult,
	skillNames: string[] | undefined,
	cwd: string | undefined,
	signal: AbortSignal,
	onProgress: () => void,
	planKey: string,
): Promise<void> {
	// Claim a slot from the shared cap before anything else, synchronously, so the
	// check and the claim cannot be separated by an await (docs/adr/0040).
	//
	// The cap belongs HERE, at the one place a child is actually spawned, and not
	// at Task admission where MAX_ACTIVE_TASKS sits. A Task is not a process: a
	// parallel Task runs up to MAX_CONCURRENCY Runs at once, so six admitted Tasks
	// could mean twenty-four children, plus plan reviews on top — while every
	// individual cap reported healthy. Counting Runs is counting processes.
	const claim = claimSlot("task");
	if (!claim.ok) {
		runResult.stopReason = "error";
		runResult.errorMessage = claim.reason;
		return;
	}
	try {
		await executeAttemptWithSlot(
			defaultCwd,
			agent,
			model,
			runResult,
			skillNames,
			cwd,
			signal,
			onProgress,
			planKey,
		);
	} finally {
		claim.slot.release();
	}
}

/**
 * Run one attempt as a **Native Run**: a real interactive `pi` TUI in a herdr
 * **Run Pane** the user can watch and type into (docs/adr/0044).
 *
 * Returns `false` rather than throwing when the pane cannot be opened, so the
 * caller falls through to the **Fallback path**. Throwing is reserved for
 * unexpected faults, which the caller also treats as a reason to fall back — the
 * rule is that no failure of this function may fail the Run outright, because the
 * old path can always still run it.
 *
 * The differences from the fallback are all consequences of losing the pipes:
 * there is no `--mode json`, so no NDJSON to parse; the **Result** comes from the
 * child's own transcript via the **Done signal**; and termination is observed from
 * herdr's socket plus sidecars rather than from a process handle.
 *
 * @returns Whether the Run was executed natively.
 */
async function executeNativeAttempt(
	defaultCwd: string,
	agent: AgentConfig,
	model: string | undefined,
	runResult: RunResult,
	skillNames: string[] | undefined,
	cwd: string | undefined,
	signal: AbortSignal,
	onProgress: () => void,
	planKey: string,
	sessionDir: string,
): Promise<boolean> {
	// Skills resolve exactly as they do on the fallback path: they were validated
	// before the Task was created, and a late failure is reported, not ignored.
	const resolution = skillNames?.length
		? resolveSkills(cwd ?? defaultCwd, skillNames)
		: null;
	if (resolution) {
		runResult.skills = resolution.loaded.map((s) => s.name);
		if (resolution.missing.length > 0)
			runResult.missingSkills = resolution.missing.map((m) => m.name);
		if (resolution.skipped.length > 0)
			runResult.skippedSkills = resolution.skipped;
	}

	// No RESULT_CONTRACT. The <result> tag existed so a Result could be scraped
	// out of prose; a Native Run's payload is its last assistant message, read
	// from the transcript, so the contract is no longer load-bearing (docs/adr/0044).
	const promptParts = [
		agent.systemPrompt.trim(),
		resolution ? formatPreloadedSkills(resolution.loaded).trim() : "",
	].filter(Boolean);

	let tmpPromptDir: string | null = null;
	let paneOpened = false;
	try {
		const tmp = await writePromptToTempFile(
			agent.name,
			promptParts.join("\n\n---\n\n"),
		);
		tmpPromptDir = tmp.dir;

		const piInvocation = nativePiCommand();
		const plan = buildLaunchPlan({
			runId: runResult.runId,
			sessionDir,
			cwd: cwd ?? defaultCwd,
			piCommand: piInvocation,
			doneExtensionPath: path.join(
				path.dirname(new URL(import.meta.url).pathname),
				"child-done.ts",
			),
			// Always includes the done tool, so no agent file needs editing and a
			// tool-restricted child can still report completion.
			tools: buildSubagentToolAllowlist(agent.tools, DONE_TOOL_NAME) ?? [],
			model,
			systemPromptPath: tmp.filePath,
			task: runResult.task,
			planKey,
		});

		await fs.promises.mkdir(sessionDir, { recursive: true });
		await fs.promises.writeFile(plan.wrapperPath, plan.wrapperSource, {
			encoding: "utf-8",
			mode: 0o700,
		});

		const pane = await openPluginPane({
			pluginId: RUN_PLUGIN_ID,
			entrypoint: RUN_ENTRYPOINT,
			placement: "split",
			// The Task's Tab when it has one (one Tab per Task), else beside the
			// orchestrator so a Run still gets a pane when Tab creation failed.
			targetPaneId: runResult.paneTarget ?? herdrContext()?.paneId,
			direction: "right",
			// Never steal focus: a Run starting must not yank the user out of whatever
			// they are typing (docs/adr/0044).
			focus: false,
			cwd: cwd ?? defaultCwd,
			env: plan.paneEnv,
		});
		if (!pane) return false; // No pane: let the fallback run it.
		paneOpened = true;
		runResult.runPaneId = pane.paneId;
		onProgress();

		// Cancelling a Native Run means closing its pane: the pane *is* the process's
		// home, so there is no other handle to kill it by. The parent still owns
		// termination — only its instrument changed (docs/adr/0033, docs/adr/0044).
		const closeOnCancel = () => {
			void closePane(pane.paneId);
		};
		if (signal.aborted) closeOnCancel();
		else signal.addEventListener("abort", closeOnCancel, { once: true });

		const result = await watchNativeRun({
			runId: runResult.runId,
			sessionDir,
			paneId: pane.paneId,
			signal,
		});
		signal.removeEventListener("abort", closeOnCancel);

		// Map the watcher's verdict onto the shape every downstream reader already
		// understands, so the Board, Run Index, Reminders and chains need no special
		// case for a Native Run.
		runResult.exitCode =
			result.exitCode ?? (result.outcome === "completed" ? 0 : 1);
		runResult.stopReason =
			result.outcome === "completed"
				? "stop"
				: signal.aborted
					? "aborted"
					: "error";
		if (result.outcome === "dismissed") {
			runResult.dismissed = true;
			runResult.stopReason = "aborted";
		}
		if (result.outcome !== "completed") runResult.errorMessage = result.detail;
		if (result.stopReason === "error" && result.errorMessage)
			runResult.errorMessage = result.errorMessage;

		// The transcript's last assistant message *is* the Result. Synthesised into
		// the messages array so `getFinalOutput`/chain interpolation keep working
		// unchanged, rather than teaching every consumer a second shape.
		if (result.lastAssistantText) {
			runResult.messages.push({
				role: "assistant",
				content: [{ type: "text", text: result.lastAssistantText }],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: result.outcome === "completed" ? "stop" : "error",
				timestamp: Date.now(),
			} as unknown as Message);
		}
		return true;
	} finally {
		if (paneOpened) {
			// Record the outcome for readers with no handle on the child, exactly as
			// the fallback does — and in a `finally` for the same reason: a thrown Run
			// must not be left reading "running" forever (docs/adr/0036).
			void writeRunMeta(
				sessionDir,
				runResult,
				runResult.dismissed
					? "dismissed"
					: runFailed(runResult)
						? "failed"
						: "completed",
			);
			onProgress();
		}
		if (tmpPromptDir)
			await fs.promises.rm(tmpPromptDir, { recursive: true, force: true });
	}
}

/** The body of {@link executeAttempt}, running with a spawn slot already held. */
async function executeAttemptWithSlot(
	defaultCwd: string,
	agent: AgentConfig,
	model: string | undefined,
	runResult: RunResult,
	skillNames: string[] | undefined,
	cwd: string | undefined,
	signal: AbortSignal,
	onProgress: () => void,
	planKey: string,
): Promise<void> {
	// Runs get a real session file so herdr's sidebar can show a browsable live
	// session, and so the Mirror Pane has something to render (docs/adr/0019,
	// docs/adr/0020). Sessions live in a per-Run directory under the agent dir so
	// they are trivially reapable and cannot collide with the user's own.
	const sessionDir = path.join(getAgentDir(), "subagent-sessions", runResult.runId);
	// Record which specialist this Run is, next to its session. The session file
	// itself never names the agent, and the Board reads these directories without
	// any access to the Task's in-memory state (docs/adr/0026).
	void writeRunMeta(sessionDir, runResult);

	// A Native Run is preferred whenever herdr can host one: a real interactive pi
	// TUI the user can watch and steer (docs/adr/0044). Any failure here — no herdr,
	// the plugin not linked, a pane that would not open — falls through to the
	// Fallback path below, which is retained permanently for exactly these cases and
	// is left byte-for-byte as it was. The fallback must never become unreachable,
	// so this branch returns only on success.
	if (herdrSocketAvailable()) {
		try {
			const ran = await executeNativeAttempt(
				defaultCwd,
				agent,
				model,
				runResult,
				skillNames,
				cwd,
				signal,
				onProgress,
				planKey,
				sessionDir,
			);
			if (ran) return;
		} catch (err) {
			// Deliberately swallowed: a native launch that fails is a reason to run the
			// Run the old way, not a reason to fail it. Recorded on the Run so the
			// silent-downgrade case is diagnosable rather than invisible.
			runResult.nativeFallbackReason =
				err instanceof Error ? err.message : String(err);
		}
	}
	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--session-dir",
		sessionDir,
		"--session-id",
		runResult.runId,
	];
	if (model) args.push("--model", model);
	if (agent.tools && agent.tools.length > 0)
		args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	// Skills were validated before the Task was created, so resolution here is
	// expected to succeed; a late failure is still reported rather than ignored.
	const resolution = skillNames?.length
		? resolveSkills(cwd ?? defaultCwd, skillNames)
		: null;
	if (resolution) {
		runResult.skills = resolution.loaded.map((s) => s.name);
		if (resolution.missing.length > 0)
			runResult.missingSkills = resolution.missing.map((m) => m.name);
		if (resolution.skipped.length > 0)
			runResult.skippedSkills = resolution.skipped;
	}

	try {
		const promptParts = [
			agent.systemPrompt.trim(),
			resolution ? formatPreloadedSkills(resolution.loaded).trim() : "",
			// Skip when the agent file already states the contract: showing the
			// fenced example twice raises the odds the model reproduces it inside
			// its own write-up.
			agent.systemPrompt.includes("<result>") ? "" : RESULT_CONTRACT,
		].filter(Boolean);
		const tmp = await writePromptToTempFile(
			agent.name,
			promptParts.join("\n\n---\n\n"),
		);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);

		args.push(`Task: ${runResult.task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				// The child loads the same user extensions (no flag suppresses
				// them), so its plan tool is present; the env var tells it which
				// plan file is its own (docs/adr/0012).
				env: { ...process.env, PI_PLAN_KEY: planKey },
			});
			let buffer = "";
			/** Set only when the child has actually exited. */
			let exited = false;
			let stallTimer: ReturnType<typeof setInterval> | undefined;
			/** Last time the child produced ANY output, on either stream. */
			let lastOutputAt = Date.now();
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let reaping = false;

			/**
			 * Reap a child that reported a terminal error but is still alive.
			 *
			 * Mirrors the cancellation path's TERM-then-KILL escalation, and for the
			 * same reason: a child ignoring SIGTERM would otherwise wedge this
			 * promise, and with it the Task, forever. `close` still resolves the
			 * promise, so the child is always reaped rather than abandoned.
			 */
			const reapAfterError = () => {
				if (reaping) return; // Several errored messages must not stack timers.
				reaping = true;
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!exited) proc.kill("SIGKILL");
				}, ERROR_REAP_GRACE_MS);
			};

			// Start the Mirror Pane alongside the child, not before it: the viewer
			// needs a session file to render, and only the running child creates one.
			if (runResult.mirrorPaneId)
				void openMirrorPane(runResult, runResult.mirrorPaneId, sessionDir);

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: unknown;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (typeof event !== "object" || event === null) return;
				const eventObj = event as Record<string, unknown>;

				if (eventObj.type === "message_end" && eventObj.message) {
					const msg = eventObj.message as Message;
					runResult.messages.push(msg);

					if (msg.role === "assistant") {
						runResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							runResult.usage.input += usage.input || 0;
							runResult.usage.output += usage.output || 0;
							runResult.usage.cacheRead += usage.cacheRead || 0;
							runResult.usage.cacheWrite += usage.cacheWrite || 0;
							runResult.usage.cost += usage.cost?.total || 0;
							runResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!runResult.model && msg.model) runResult.model = msg.model;
						if (msg.stopReason) runResult.stopReason = msg.stopReason;

						// The Run's outcome is its LAST assistant message, not the worst
						// one it ever saw. A latching errorMessage reported every Run
						// that survived a retry as failed — which, now that litellm 400s
						// retry, is the common case: three oracle reviews errored three
						// times each, recovered, delivered, and would all have been
						// reported failures (docs/adr/0033).
						if (msg.errorMessage) runResult.errorMessage = msg.errorMessage;
						else if (msg.stopReason) runResult.errorMessage = undefined;

						// A child that hits an unretryable provider error keeps its
						// process alive, so waiting for `close` waits forever: the Run
						// never reaches a terminal state, no Reminder fires, and the
						// Task holds one of MAX_ACTIVE_TASKS slots for the session's
						// life. Observed twice on litellm 400s, both times with three
						// Runs still "running" 900s after they died (docs/adr/0033).
						//
						// So the parent owns termination: an errored assistant message
						// is the Run's outcome, and the child is reaped rather than
						// awaited. Retries are invisible here — pi retries *inside* a
						// turn and only emits message_end once it has given up — so
						// this cannot cut a recoverable attempt short.
						if (msg.stopReason === "error" && !exited) reapAfterError();
					}
					onProgress();
				}

				if (eventObj.type === "tool_result_end" && eventObj.message) {
					runResult.messages.push(eventObj.message as Message);
					onProgress();
				}
			};

			proc.stdout.on("data", (data) => {
				lastOutputAt = Date.now();
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				lastOutputAt = Date.now();
				runResult.stderr += data.toString();
				// Only the tail is ever reported, so keep the tail and drop the rest.
				if (runResult.stderr.length > MAX_STDERR_BYTES)
					runResult.stderr = runResult.stderr.slice(-MAX_STDERR_BYTES);
			});

			proc.on("close", (code) => {
				exited = true;
				// Otherwise a clean finish still pins the event loop for 5s.
				if (killTimer) clearTimeout(killTimer);
				if (stallTimer) clearInterval(stallTimer);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", (err) => {
				exited = true;
				if (killTimer) clearTimeout(killTimer);
				if (stallTimer) clearInterval(stallTimer);
				runResult.errorMessage = `Failed to spawn subagent process: ${err.message}`;
				resolve(1);
			});

			// A child can also wedge *silently* — no error message, no exit, no
			// output at all. Reaping on an errored message cannot catch that, since
			// there is no message. So the parent also watches for total silence:
			// pi's own retry ladder tops out around 10.6 minutes, so a child that
			// has produced nothing for appreciably longer than that is not thinking,
			// it is stuck (docs/adr/0033).
			stallTimer = setInterval(() => {
				if (exited || reaping) return;
				if (Date.now() - lastOutputAt < STALL_TIMEOUT_MS) return;
				runResult.errorMessage =
					`Run produced no output for ${Math.round(STALL_TIMEOUT_MS / 60000)} minutes and was terminated as stalled.`;
				runResult.stopReason = "error";
				reapAfterError();
			}, STALL_CHECK_MS);

			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				// Escalate on "still alive", not on `proc.killed` — that flag only
				// reports that a signal was delivered, so it is already true here and
				// a child ignoring SIGTERM would never be killed. Leaving it alive
				// would wedge this promise, and with it the Task, forever.
				killTimer = setTimeout(() => {
					if (!exited) proc.kill("SIGKILL");
				}, 5000);
			};
			if (signal.aborted) killProc();
			else signal.addEventListener("abort", killProc, { once: true });
		});

		runResult.exitCode = exitCode;
		if (wasAborted) {
			runResult.stopReason = "aborted";
			runResult.errorMessage ??= "Run was canceled.";
		}

		// Record contract violations at Run level so status/result can report them
		// even when the caller only looks at the summary.
		if (!wasAborted && exitCode === 0) {
			const extracted = extractResult(runResult.messages);
			if (!extracted.conformant) runResult.resultWarning = extracted.warning;
		}
	} catch (err) {
		runResult.exitCode = 1;
		runResult.stopReason = "error";
		runResult.errorMessage =
			err instanceof Error ? err.message : "Unknown error running subagent.";
	} finally {
		// Record the outcome in Run Meta so a reader with no handle on the child — a
		// Mirror Pane, the Board — can tell a Run that never started from one that
		// died before writing a session. In `finally` so a thrown Run is recorded as
		// failed rather than left reading "running" forever (docs/adr/0036).
		void writeRunMeta(
			sessionDir,
			runResult,
			runFailed(runResult) ? "failed" : "completed",
		);
		onProgress();
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

/**
 * Frames of the status-bar spinner, in Braille so it reads as motion at one cell.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Format the active Tasks into a status-bar string, or undefined when idle.
 *
 * A single Task is named and quantified (`⠼ explorer 3 turns · $0.02`) because
 * the whole point is to reveal a Run that has silently stalled — a bare count
 * cannot show that. Several Tasks collapse to `⠼ 3 tasks`: at 80 columns the
 * footer cannot hold three names, and the orchestrator can always ask
 * `subagent_tasks status` for the breakdown.
 *
 * The spinner frame is derived from the clock rather than a counter so it
 * animates even when this is called irregularly by stream events.
 *
 * @param active - Tasks currently in a non-terminal state.
 * @returns Status text, or undefined to clear the status entirely.
 */
function formatActiveStatus(active: Task[]): string | undefined {
	if (active.length === 0) return undefined;

	const frame =
		SPINNER_FRAMES[
			Math.floor(Date.now() / 100) % SPINNER_FRAMES.length
		];

	if (active.length > 1) return `${frame} ${active.length} tasks`;

	const task = active[0];
	const usage = aggregateUsage(task.runs);
	// The running Run is the one worth naming; in a chain that is the current
	// step, and in parallel mode the first still in flight.
	const running = task.runs.find((r) => r.exitCode === -1) ?? task.runs[0];
	const name = running?.agent ?? task.agentNames[0] ?? "subagent";

	// Detail after the name is dot-separated; the name itself is not, so a
	// just-started Task reads "⠼ explorer" rather than "⠼ explorer ·".
	const detail: string[] = [];
	if (usage.turns > 0)
		detail.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.cost > 0) detail.push(`$${usage.cost.toFixed(2)}`);
	// Only surface a downgrade once it has actually happened, matching the
	// silent-when-unused rule the fallback feature already follows. A bare glyph
	// keeps the footer inside its share of 80 columns; the full chain is already
	// spelled out inline in the Task's Results and in `subagent_tasks status`.
	if (running?.modelAttempts && running.modelAttempts.length > 1)
		detail.push("⚠");

	return detail.length > 0
		? `${frame} ${name} ${detail.join(" · ")}`
		: `${frame} ${name}`;
}

// `runFailed` lives in tasks.ts beside RunResult: index.ts imports tasks.ts and
// not the reverse, and three hand-copied copies of this predicate had already
// drifted apart once (docs/adr/0033).

// ---------------------------------------------------------------------------
// Skill pre-validation
// ---------------------------------------------------------------------------

/**
 * Validate every skill request before a Task is created.
 *
 * A subagent missing a skill it was told to use does not fail loudly — it
 * silently does the work with the wrong methodology. This is a malformed
 * *request*, not a failed Task, so it is reported synchronously and no Task ID
 * is minted (docs/adr/0003).
 *
 * @returns An error message, or null when every request resolves.
 */
function validateSkillRequests(
	defaultCwd: string,
	items: { agent: string; skills?: string[]; cwd?: string }[],
): string | null {
	for (const item of items) {
		if (!item.skills?.length) continue;
		const resolution = resolveSkills(item.cwd ?? defaultCwd, item.skills);
		const problems: string[] = [];

		if (resolution.missing.length > 0) {
			const details = resolution.missing
				.map((m) =>
					m.suggestion
						? `"${m.name}" (did you mean "${m.suggestion}"?)`
						: `"${m.name}"`,
				)
				.join(", ");
			problems.push(`Unknown skill(s): ${details}.`);
		}
		if (resolution.skipped.length > 0) {
			const onlyRequest =
				resolution.loaded.length === 0 && resolution.skipped.length === 1;
			problems.push(
				onlyRequest
					? `Skill "${resolution.skipped[0]}" is by itself larger than the ${MAX_SKILL_BYTES}-byte preload budget and cannot be preloaded. Delegate to an agent with a read tool and point it at the file instead.`
					: `Skill(s) too large to fit the ${MAX_SKILL_BYTES}-byte preload budget alongside the others: ${resolution.skipped.join(", ")}. Request fewer skills, or split the work across separate delegations.`,
			);
		}

		if (problems.length > 0) {
			const loadedNote =
				resolution.loaded.length > 0
					? ` Skills that did resolve: ${resolution.loaded.map((s) => s.name).join(", ")}.`
					: "";
			return `Not delegated to "${item.agent}": requested skills could not be preloaded. ${problems.join(" ")}${loadedNote} Available skills: ${resolution.available.join(", ") || "none"}. Fix the skills list and call again.`;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const SkillsSchema = Type.Array(Type.String(), {
	description:
		'Names of skills to preload into the subagent\'s system prompt (e.g. ["tdd", "python-style"]). The full SKILL.md content is injected, so the subagent starts with that knowledge already in context. Use this whenever the task should follow a skill\'s methodology — subagents cannot discover skills on their own.',
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	skills: Type.Optional(SkillsSchema),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	skills: Type.Optional(SkillsSchema),
	cwd: Type.Optional(
		Type.String({ description: "Working directory for the agent process" }),
	),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description: "Name of the agent to invoke (for single mode)",
		}),
	),
	task: Type.Optional(
		Type.String({ description: "Task to delegate (for single mode)" }),
	),
	skills: Type.Optional(SkillsSchema),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
});

const TasksParams = Type.Object({
	action: StringEnum(
		["list", "status", "result", "wait", "cancel", "open"] as const,
		{
			description:
			"list = all tasks and their state, plus earlier sessions from disk; status = per-run state/turns/cost for one or more tasks; result = the finished results; wait = block until the given tasks finish; cancel = kill running tasks; open = resume a finished task in a live pi pane (this CONTINUES it, appending to its transcript — there is no read-only view).",
		},
	),
	taskIds: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Task IDs (e.g. ["sub-a3f1"]). Required for status, result, wait, cancel, and open. Ignored by list.',
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description:
				"For wait: give up after this many seconds and report what is still running. Omit to wait indefinitely.",
		}),
	),
});

/** Details attached to a `subagent` launch receipt. */
interface LaunchDetails {
	taskId: string;
	mode: TaskMode;
	agentNames: string[];
	agentScope: AgentScope;
}

/** Details attached to a `subagent_tasks` result. Transcript-free: `details` is
 * persisted to the session file, so Transcripts are looked up from the live
 * registry at render time instead. */
interface TasksToolDetails {
	action: string;
	tasks: {
		id: string;
		mode: TaskMode;
		state: string;
		runs: RunSummary[];
	}[];
}

/** Payload of a completion Reminder message. Transcript-free: `details` is
 * persisted to the session file. */
interface ReminderDetails {
	taskId: string;
	mode: TaskMode;
	state: string;
	runs: RunSummary[];
	cost: number;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Point the spawn cap at the shared token directory before anything can claim a
	// slot. Tree-wide rather than per-process because a Native Run is a full pi that
	// can itself spawn, so a module-level counter would mean six children *per
	// process*, recursively (docs/adr/0044, amending 0040).
	setSpawnCapRoot(runsRoot(getAgentDir()));

	const registry = new TaskRegistry();
	/** Captured so background progress can update the footer outside a tool call. */
	let ui: ExtensionUIContext | undefined;
	let uiAvailable = false;
	/**
	 * Whether a turn is in flight.
	 *
	 * Reminder delivery is gated on this. A Task that lands mid-turn must wait for
	 * `agent_settled`, because a followUp queued now cannot be recalled if the
	 * orchestrator collects the Results itself before the turn ends; a Task that
	 * lands while already idle must be delivered immediately, because no further
	 * settle event is coming (docs/adr/0027).
	 */
	let turnInFlight = false;

	/** Reflect active Task progress in the status bar, since a backgrounded Task's
	 * tool call has already returned and can no longer render live progress.
	 *
	 * One active Task gets named detail (agent, turns, cost) because that is the
	 * common case and the useful one: a stalled Run is only visible if you can
	 * see its turn count sitting still. Several Tasks degrade to a count, since
	 * naming them all would blow the width budget at 80 columns.
	 *
	 * Never throws: this runs from unsupervised child-process stream handlers,
	 * where an exception would be an uncaughtException and take down pi. */
	const refreshStatus = () => {
		try {
			if (!ui) return;
			ui.setStatus("subagent", formatActiveStatus(registry.active()));
		} catch {
			// A torn-down or reloaded TUI must not kill in-flight Tasks.
		}
	};

	// A finished Task wakes the orchestrator with its Results inline. This is a
	// custom message, not a simulated user message (docs/adr/0006).
	/**
	 * Wake the orchestrator with a finished Task's Results.
	 *
	 * A custom message, not a simulated user message (docs/adr/0006).
	 *
	 * @returns True when the Reminder was delivered.
	 */
	const deliverReminder = (task: Task): boolean => {
		if (task.notified) return true;

		// A canceled Task was canceled *by* the orchestrator; telling it what it
		// already knows would burn a turn for nothing.
		if (task.state === "canceled") {
			task.notified = true;
			// Close the Tab too: the Reminder is delivered, so its pane can go (docs/adr/0028).
			void closeTaskTab(task);
			return true;
		}

		const usage = aggregateUsage(task.runs);
		try {
			pi.sendMessage<ReminderDetails>(
				{
					customType: "subagent_done",
					content: [
						{
							type: "text",
							text: [
								`Background task ${task.id} finished (${task.state}).`,
								"",
								formatTaskResults(task),
								"",
								`Resume it with /run ${task.id}`,
							].join("\n"),
						},
					],
					display: true,
					details: {
						taskId: task.id,
						mode: task.mode,
						state: task.state,
						// Deliberately excludes Transcripts: `details` is persisted to
						// the session file, and full child message streams would grow it
						// without bound for data only the TUI reads.
						runs: task.runs.map(summarizeRun),
						cost: usage.cost,
					},
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			// Only now is the Reminder truly delivered. Marking earlier would
			// strand the Task as "notified" if the send threw.
			task.notified = true;
			void closeTaskTab(task);
		} catch {
			// Stale runtime (e.g. mid-reload). Leave `notified` false so the next
			// completion or turn can retry.
			return false;
		}

		// Small, transcript-free record of what this session spent on delegation.
		try {
			pi.appendEntry("subagent_task_summary", {
				id: task.id,
				mode: task.mode,
				state: task.state,
				agents: task.agentNames,
				cost: usage.cost,
				turns: usage.turns,
			});
		} catch {
			// Bookkeeping only.
		}
		return true;
	};

	registry.onCompletion((task) => {
		refreshStatus();
		// Delivery is deliberately *not* attempted here. A Task usually lands while
		// the orchestrator is mid-turn, and sending now would queue a followUp that
		// cannot be recalled even if the orchestrator collects the Results itself a
		// moment later. The `agent_settled` handler below delivers once idle, by
		// which time `wait`/`result` has had its chance to claim the Task
		// (docs/adr/0027).
		//
		// Headless has no settle event to wait for, so a drained Task there is
		// already marked notified at spawn time (docs/adr/0005).
		// A Task that lands while the orchestrator is already idle gets its Reminder
		// now: no further `agent_settled` is coming to carry it.
		if (!uiAvailable || !turnInFlight) deliverReminder(task);
	});

	// A Reminder sent while the orchestrator is mid-turn is *queued*, not dropped:
	// `deliverAs: "followUp"` is delivered only once the agent stops. So a Task
	// that lands mid-turn and is then collected by `wait` in that same turn has
	// already had its Reminder queued, and revoking it is impossible — there is no
	// unsend. The queued copy surfaces after the turn ends, re-injecting Results
	// the orchestrator already read (docs/adr/0027).
	//
	// So delivery waits for idle instead: on `agent_settled` every Task whose
	// Results are still unread gets its Reminder, and anything already collected
	// in the meantime is silently dropped by the `notified` guard.
	pi.on("agent_start", () => {
		turnInFlight = true;
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx?.isIdle?.() !== true) return;
		turnInFlight = false;
		for (const pending of registry.pendingNotification())
			deliverReminder(pending);
	});

	/** Drive a Task's Runs to completion, then mark it terminal. */
	const runTask = async (
		task: Task,
		defaultCwd: string,
		agents: AgentConfig[],
		items: { agent: string; task: string; skills?: string[]; cwd?: string }[],
	): Promise<void> => {
		const onProgress = () => refreshStatus();

		/** Plan file key for a Run (docs/adr/0012): a single-run Task uses the
		 * bare Task ID; multi-run Tasks suffix the run ordinal so parallel
		 * siblings never write into each other's plan files. */
		const planKeyFor = (index: number) =>
			task.runs.length === 1 ? task.id : `${task.id}.r${index + 1}`;

		// One Tab per Task, one Mirror Pane per Run (docs/adr/0016). Only top-level
		// Runs get panes: subagent children inherit no pane identity, so the gate
		// closes for nested delegations automatically. Failure to build any of this
		// leaves the Task completely unaffected.
		//
		// A **Native Run** hosts itself, so it must NOT be given a pre-allocated
		// Mirror Pane: that pane would sit empty while the real work ran in the Run
		// Pane herdr opens later. The Tab is still created — one Tab per Task holds
		// either kind of pane — and native Runs split into it from its root
		// (docs/adr/0044).
		const nativeRuns = herdrSocketAvailable();
		if (herdrAvailable()) {
			try {
				// The Tab names the Task by the agent doing the work, not the bare ID:
				// `explorer (#6748)` is readable in a tab bar where `sub-6748` is not.
				// Runs disambiguate themselves in their own pane labels.
				const tabName = `${items[0]?.agent ?? "subagent"} (#${shortId(task.id)})`;
				const tab = await createTab(tabName);
				if (tab) {
					// Retained so the Reminder can close the Tab once it lands (docs/adr/0028).
					task.tabId = tab.tabId;
					// Every Run needs somewhere to be split from; native Runs open their
					// own pane against this root rather than adopting it.
					task.tabRootPaneId = tab.paneId;
					// Tell every Run where its pane belongs, so a Native Run opens inside
					// its Task's Tab instead of splitting the orchestrator's own pane.
					for (const run of task.runs) run.paneTarget = tab.paneId;
					if (!nativeRuns) {
						task.runs[0].mirrorPaneId = tab.paneId;
						// The tab's root pane hosts run 1; each further Run splits off it.
						for (let i = 1; i < task.runs.length; i++) {
							const paneId = await splitPane({
								target: tab.paneId,
								// Stack runs vertically: a fan-out of narrow columns is
								// unreadable, and herdr's own guidance warns against repeated
								// same-direction splits.
								direction: "down",
								cwd: items[i]?.cwd ?? defaultCwd,
							});
							if (paneId) task.runs[i].mirrorPaneId = paneId;
						}
					}
				}
			} catch {
				// No panes; the Task proceeds exactly as it would headless.
			}
		}

		try {
			if (task.mode === "chain") {
				let previousOutput = "";
				for (let i = 0; i < items.length; i++) {
					const run = task.runs[i];
					// {previous} interpolates the *extracted* Result, so a chain step
					// never reads the previous agent's throat-clearing as instructions.
					// The replacer is a function so `$&`, `$'` and friends inside a
					// Result are inserted literally instead of being expanded.
					run.task = items[i].task.replace(
						/\{previous\}/g,
						() => previousOutput,
					);

					await executeRun(
						defaultCwd,
						agents,
						run,
						items[i].skills,
						items[i].cwd,
						task.abort.signal,
						onProgress,
						planKeyFor(i),
					);

					if (runFailed(run)) {
						// Cancellation is decided by the Task's own signal, not by a
						// Run's stopReason: providers emit "aborted" for their own
						// reasons, and misreading that as a user cancel would suppress
						// the Reminder for a Task nobody canceled.
						const canceled = task.abort.signal.aborted;
						registry.finish(
							task.id,
							canceled ? "canceled" : "failed",
							canceled
								? `Canceled during step ${i + 1} (${run.agent}).`
								: `Chain stopped at step ${i + 1} (${run.agent}).`,
						);
						return;
					}
					previousOutput = extractResult(run.messages).text;
				}
				registry.finish(task.id, "completed", `Chain completed ${items.length} steps.`);
				return;
			}

			await mapWithConcurrencyLimit(items, MAX_CONCURRENCY, async (item, index) =>
				executeRun(
					defaultCwd,
					agents,
					task.runs[index],
					item.skills,
					item.cwd,
					task.abort.signal,
					onProgress,
					planKeyFor(index),
				),
			);

			const failures = task.runs.filter(runFailed);
			if (task.abort.signal.aborted) {
				registry.finish(task.id, "canceled", "Task was canceled.");
			} else if (failures.length === task.runs.length) {
				registry.finish(task.id, "failed", `All ${task.runs.length} run(s) failed.`);
			} else {
				registry.finish(
					task.id,
					"completed",
					`${task.runs.length - failures.length}/${task.runs.length} run(s) succeeded.`,
				);
			}
		} catch (err) {
			// Never leave a Task wedged in "running": a waiter would hang forever.
			registry.finish(
				task.id,
				"failed",
				err instanceof Error ? err.message : "Task crashed.",
			);
		}
	};

	pi.registerTool<typeof SubagentParams, LaunchDetails>({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to specialized subagents with isolated context, as a background task.",
			"Returns a task id immediately and does NOT wait for the result — the task keeps running even if your turn ends or fails.",
			"You will be notified automatically when it finishes; to block on it instead, call subagent_tasks with action wait.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
			'Pass skills: ["name", ...] to preload skill content into the subagent\'s system prompt — subagents cannot discover skills themselves, so name them explicitly when the task should follow a skill.',
			"If any requested skill cannot be preloaded the delegation fails immediately without starting a task: fix the list and call again.",
			`At most ${MAX_ACTIVE_TASKS} tasks may be active at once, and at most ${MAX_SPAWNED_CHILDREN} child processes may run at once across every kind of spawn (a parallel task uses one per concurrent run, and autonomous plan reviews draw from the same budget). A run refused for lack of a slot fails with a message saying so, and is worth retrying once something finishes.`,
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			uiAvailable = ctx.hasUI;
			if (ctx.hasUI) {
				ui = ctx.ui;
			}

			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const fail = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: {
					taskId: "",
					mode: (hasChain ? "chain" : hasTasks ? "parallel" : "single") as TaskMode,
					agentNames: [],
					agentScope,
				},
				isError: true,
			});

			if (modeCount !== 1) {
				const available =
					agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return fail(
					`Invalid parameters. Provide exactly one mode (agent+task, tasks, or chain).\nAvailable agents: ${available}`,
				);
			}

			if (params.tasks && params.tasks.length > MAX_PARALLEL_TASKS)
				return fail(
					`Too many parallel runs (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
				);

			const activeCount = registry.active().length;
			if (activeCount >= MAX_ACTIVE_TASKS) {
				const ids = registry
					.active()
					.map((t) => t.id)
					.join(", ");
				return fail(
					`Too many active background tasks (${activeCount}/${MAX_ACTIVE_TASKS}). Wait for or cancel some first via subagent_tasks. Active: ${ids}`,
				);
			}
			const mode: TaskMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const items = hasChain
				? params.chain!
				: hasTasks
					? params.tasks!
					: [
							{
								agent: params.agent!,
								task: params.task!,
								skills: params.skills,
								cwd: params.cwd,
							},
						];

			// Unknown agents are a malformed request too — catch them before
			// minting an ID rather than reporting a born-dead Task.
			const unknown = items
				.map((i) => i.agent)
				.filter((name) => !agents.some((a) => a.name === name));
			if (unknown.length > 0) {
				const available =
					agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return fail(
					`Unknown agent(s): ${unknown.map((n) => `"${n}"`).join(", ")}. Available agents: ${available}`,
				);
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI
			) {
				const projectAgentsRequested = Array.from(
					new Set(items.map((i) => i.agent)),
				)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return fail("Canceled: project-local agents not approved.");
				}
			}

			const skillError = validateSkillRequests(ctx.cwd, items);
			if (skillError) return fail(skillError);

			let task: Task;
			try {
				task = registry.create({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					agentNames: items.map((i) => i.agent),
					runs: items.map((item, index) => ({
						agent: item.agent,
						// Placeholder: the Task ID does not exist until create() returns,
						// and a Run's id is derived from it. Filled in immediately below.
						runId: "",
						agentSource: "unknown" as const,
						task: item.task,
						exitCode: -1,
						messages: [],
						stderr: "",
						usage: emptyUsage(),
						step: mode === "chain" ? index + 1 : undefined,
						multiRun: items.length > 1,
					})),
				});
				// A Run's identity is its Task's id plus its ordinal, so a session file
				// and a Mirror Pane can be addressed per Run (docs/adr/0019).
				task.runs.forEach((run, index) => {
					run.runId = `${task!.id}-${index + 1}`;
				});
			} catch (err) {
				// The ceiling is enforced inside create(), so a concurrent call that
				// slipped past the earlier check still lands here.
				if (err instanceof TooManyTasksError) return fail(err.message);
				throw err;
			}

			refreshStatus();

			// Headless has no user to unblock and the process exits when the turn
			// ends, so a background Task there would be killed before finishing.
			// Drain it inline instead (docs/adr/0005). Suppress the Reminder up
			// front: returning the Results *and* announcing them would cost the
			// orchestrator an extra turn to be told what it just read.
			if (!ctx.hasUI) task.notified = true;

			// Fire and forget: the Task must outlive this tool call, this turn, and
			// any error the orchestrator hits afterwards (docs/adr/0003).
			// runTask has its own catch-all, but an unhandled rejection would take
			// down the host process, so the promise is never left bare.
			const running = runTask(task, ctx.cwd, agents, items).catch((err) => {
				// Keep the reason: a bare "crashed unexpectedly" makes a pre-spawn
				// throw indistinguishable from every other failure.
				const detail =
					err instanceof Error ? err.message : String(err ?? "unknown error");
				registry.finish(task.id, "failed", `Task crashed unexpectedly: ${detail}`);
			});

			if (!ctx.hasUI) {
				await running;
				const failedRuns = task.runs.filter(runFailed);
				return {
					content: [{ type: "text", text: formatTaskResults(task) }],
					details: {
						taskId: task.id,
						mode,
						agentNames: task.agentNames,
						agentScope,
					},
					isError: failedRuns.length === task.runs.length ? true : undefined,
				};
			}

			void running;

			const what =
				mode === "single"
					? `agent "${items[0].agent}"`
					: mode === "parallel"
						? `${items.length} parallel runs (${task.agentNames.join(", ")})`
						: `${items.length}-step chain (${task.agentNames.join(" → ")})`;

			return {
				content: [
					{
						type: "text",
						text: [
							`Started background task ${task.id}: ${what}.`,
							"It is running now and will keep running after this turn ends.",
							`You will be notified when it finishes. To block on it: subagent_tasks { action: "wait", taskIds: ["${task.id}"] }.`,
						].join("\n"),
					},
				],
				details: {
					taskId: task.id,
					mode,
					agentNames: task.agentNames,
					agentScope,
				},
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview =
						cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						(step.skills?.length
							? theme.fg("muted", ` +${step.skills.join(",")}`)
							: "") +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} runs)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview =
						t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					const skillTag = t.skills?.length
						? theme.fg("muted", ` +${t.skills.join(",")}`)
						: "";
					text += `\n  ${theme.fg("accent", t.agent)}${skillTag}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3)
					text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task
				? args.task.length > 60
					? `${args.task.slice(0, 60)}...`
					: args.task
				: "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			if (args.skills?.length)
				text += theme.fg("muted", ` +skills: ${args.skills.join(", ")}`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme, _context) {
			const details = result.details as LaunchDetails | undefined;
			const text = result.content[0];
			const body = text?.type === "text" ? text.text : "";

			if (!details?.taskId)
				return new Text(theme.fg("error", body || "(no output)"), 0, 0);

			// A launched Task shows only its receipt here; live progress appears in
			// the status bar, and the outcome arrives as a Reminder.
			return new Text(
				`${theme.fg("warning", "⏳ ")}${theme.fg("toolTitle", theme.bold(details.taskId))} ${theme.fg("muted", `${details.mode}: ${details.agentNames.join(", ")}`)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool<typeof TasksParams, TasksToolDetails>({
		name: "subagent_tasks",
		label: "Subagent Tasks",
		description: [
			"Inspect and control background subagent tasks started with the subagent tool.",
			'Actions: list (all tasks and their state, including earlier sessions from disk), status (per-run state, turns and cost for given task ids), result (the finished write-ups), wait (block until the given tasks finish, with optional timeoutSeconds), cancel (kill running tasks), open (resume a finished task in a live pi pane — this CONTINUES the session and appends to its transcript; there is no read-only view).',
			"Task ids look like sub-a3f1 and are returned when you start a task.",
		].join(" "),
		parameters: TasksParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			uiAvailable = ctx.hasUI;
			if (ctx.hasUI) ui = ctx.ui;

			const detailsFor = (tasks: Task[]): TasksToolDetails => ({
				action: params.action,
				tasks: tasks.map((t) => ({
					id: t.id,
					mode: t.mode,
					state: t.state,
					runs: t.runs.map(summarizeRun),
				})),
			});

			if (params.action === "list") {
				const all = registry.all();
				// The index spans sessions (docs/adr/0028): registry rows are
				// authoritative for this session (mode, exact state, cost), and the
				// disk supplies what the registry cannot — Run dirs from earlier
				// sessions. A Run present in both appears once, registry winning.
				const disk = await scanRunDirs(getAgentDir());
				const liveIds = new Set(all.map((t) => t.id));
				const earlier = disk.filter((d) => !liveIds.has(d.taskId));
				if (all.length === 0 && earlier.length === 0)
					return {
						content: [{ type: "text", text: "No subagent tasks in this session." }],
						details: detailsFor([]),
					};
				const lines = all.map((t) => {
					const usage = aggregateUsage(t.runs);
					const elapsed = Math.round(
						((t.endedAt ?? Date.now()) - t.startedAt) / 1000,
					);
					return `${t.id} [${t.mode}] ${t.state} — ${t.agentNames.join(", ")} — ${elapsed}s, $${usage.cost.toFixed(4)}`;
				});
				if (earlier.length > 0) {
					if (lines.length > 0) lines.push("");
					lines.push("Earlier sessions:", formatRunIndex(earlier));
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: detailsFor(all),
				};
			}

			if (params.action === "open") {
				// The re-open resolves from disk, not the registry: a finished
				// Task from an earlier session has no registry entry at all
				// (docs/adr/0028).
				const openIds = params.taskIds ?? [];
				if (openIds.length === 0)
					return {
						content: [
							{
								type: "text",
								text: 'action "open" requires taskIds — the Task ID as /runs shows it (e.g. ["sub-6748"]).',
							},
						],
						details: detailsFor([]),
						isError: true,
					};
				const lines: string[] = [];
				for (const id of openIds) {
					lines.push(describeResume(id, await resumeTask(id)));
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: detailsFor([]),
				};
			}

			const ids = params.taskIds ?? [];
			if (ids.length === 0)
				return {
					content: [
						{
							type: "text",
							text: `action "${params.action}" requires taskIds. Use action "list" to see the tasks in this session.`,
						},
					],
					details: detailsFor([]),
					isError: true,
				};

			const found: Task[] = [];
			const missing: string[] = [];
			for (const id of ids) {
				const task = registry.get(id);
				if (task) found.push(task);
				else missing.push(id);
			}

			if (found.length === 0)
				return {
					content: [
						{
							type: "text",
							text: `Unknown task id(s): ${missing.join(", ")}. Use action "list" to see the tasks in this session.`,
						},
					],
					details: detailsFor([]),
					isError: true,
				};

			const missingNote =
				missing.length > 0 ? `\n\n(unknown task id(s): ${missing.join(", ")})` : "";

			if (params.action === "status") {
				const text = found.map(formatTaskStatus).join("\n\n");
				return {
					content: [{ type: "text", text: text + missingNote }],
					details: detailsFor(found),
				};
			}

			if (params.action === "cancel") {
				const canceled: string[] = [];
				const already: string[] = [];
				for (const task of found) {
					if (registry.cancel(task.id)) canceled.push(task.id);
					else already.push(`${task.id} (${task.state})`);
				}
				const parts: string[] = [];
				if (canceled.length > 0)
					parts.push(`Canceled: ${canceled.join(", ")}.`);
				if (already.length > 0)
					parts.push(`Already finished: ${already.join(", ")}.`);
				return {
					content: [{ type: "text", text: parts.join(" ") + missingNote }],
					details: detailsFor(found),
				};
			}

			if (params.action === "wait") {
				const timeoutMs =
					params.timeoutSeconds !== undefined
						? Math.max(0, params.timeoutSeconds) * 1000
						: undefined;

				// Claim notification *before* awaiting. `finish` fires completion
				// listeners before it wakes waiters, so a Task that lands during the
				// wait would otherwise send a Reminder carrying the very Results this
				// call is about to return — duplicating them in context and burning a
				// turn to re-announce what the orchestrator just read.
				for (const task of found) task.notified = true;

				const settled = await registry.waitFor(
					found.map((t) => t.id),
					timeoutMs,
					signal,
				);

				if (!settled) {
					const stillRunning = found.filter((t) => !isTerminal(t.state));
					const done = found.filter((t) => isTerminal(t.state));
					// Hand the un-landed Tasks back to the Reminder path: this call is
					// no longer going to deliver their Results.
					for (const task of stillRunning) task.notified = false;
					// The Tasks that DID land are reported right here, so their Tabs are
					// closed here too. Claiming `notified` suppresses the Reminder, and
					// the Reminder was the only thing that closed a Tab — so collecting
					// a Task leaked its Tab for the life of the session (docs/adr/0028).
					for (const task of done) void closeTaskTab(task);
					const parts = [
						`Timed out after ${params.timeoutSeconds}s. Still running: ${stillRunning.map((t) => t.id).join(", ")}.`,
					];
					if (done.length > 0)
						parts.push("", done.map(formatTaskResults).join("\n\n"));
					return {
						content: [{ type: "text", text: parts.join("\n") + missingNote }],
						details: detailsFor(found),
					};
				}

				// Every Task landed and its Results are returned inline, so nothing
				// else will ever close these Tabs (see the timeout branch above).
				for (const task of found) void closeTaskTab(task);

				return {
					content: [
						{
							type: "text",
							text: found.map(formatTaskResults).join("\n\n") + missingNote,
						},
					],
					details: detailsFor(found),
					isError: found.every((t) => t.state === "failed") ? true : undefined,
				};
			}

			// action === "result"
			const unfinished = found.filter((t) => !isTerminal(t.state));
			const finished = found.filter((t) => isTerminal(t.state));
			const parts: string[] = [];
			if (finished.length > 0)
				parts.push(finished.map(formatTaskResults).join("\n\n"));
			if (unfinished.length > 0)
				parts.push(
					`Still running (no result yet): ${unfinished.map((t) => t.id).join(", ")}. Use action "wait" to block, or "status" to check progress.`,
				);
			// Same as the `wait` paths: reporting a Task's Results here claims its
			// notification, which suppresses the Reminder that would have closed its
			// Tab — so close it here instead (docs/adr/0028).
			for (const task of finished) {
				task.notified = true;
				void closeTaskTab(task);
			}
			return {
				content: [{ type: "text", text: parts.join("\n\n") + missingNote }],
				details: detailsFor(found),
			};
		},

		renderCall(args, theme, _context) {
			const ids = args.taskIds?.length ? ` ${args.taskIds.join(", ")}` : "";
			const timeout =
				args.action === "wait" && args.timeoutSeconds !== undefined
					? theme.fg("dim", ` (timeout ${args.timeoutSeconds}s)`)
					: "";
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent_tasks ")) +
					theme.fg("accent", args.action) +
					theme.fg("muted", ids) +
					timeout,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TasksToolDetails | undefined;
			const text = result.content[0];
			const body = text?.type === "text" ? text.text : "(no output)";

			if (!expanded || !details || details.tasks.length === 0)
				return new Text(theme.fg("toolOutput", body), 0, 0);

			// Expanded view is the human's window into the Transcript the
			// orchestrator never sees. Transcripts are looked up from the live
			// registry so nothing large is persisted to the session file.
			const container = new Container();
			const mdTheme = getMarkdownTheme();
			for (const t of details.tasks) {
				const icon =
					t.state === "completed"
						? theme.fg("success", "✓")
						: t.state === "running"
							? theme.fg("warning", "⏳")
							: theme.fg("error", "✗");
				container.addChild(
					new Text(
						`${icon} ${theme.fg("toolTitle", theme.bold(t.id))} ${theme.fg("muted", `${t.mode} · ${t.state}`)}`,
						0,
						0,
					),
				);
				const live = registry.get(t.id);
				for (let i = 0; i < t.runs.length; i++) {
					const run = t.runs[i];
					const label = run.step ? `step ${run.step}: ${run.agent}` : run.agent;
					container.addChild(
						new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", label)}`, 0, 0),
					);
					// Transcripts come from the live registry, never from `details`.
					const messages = live?.runs[i]?.messages;
					if (messages) {
						for (const item of getDisplayItems(messages)) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") +
											formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
					}
					if (run.warning)
						container.addChild(new Text(theme.fg("warning", run.warning), 0, 0));
					if (run.text) {
						container.addChild(new Spacer(1));
						if (run.state === "failed")
							container.addChild(new Text(theme.fg("error", run.text), 0, 0));
						else container.addChild(new Markdown(run.text, 0, 0, mdTheme));
					}
					const usageStr = formatUsageStats(
						{
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							cost: run.cost,
							turns: run.turns,
						},
						run.model,
					);
					// Surface the downgrade in the TUI too: the user should not have to
					// dig to learn the Result came from a fallback model.
					if (run.modelAttempts && run.modelAttempts.length > 1) {
						const tried = run.modelAttempts
							.slice(0, -1)
							.map((a) => `${a.model ?? "default"} (${a.error ?? "failed"})`)
							.join(", ");
						container.addChild(
							new Text(
								theme.fg("warning", `↳ fell back from ${tried}`),
								0,
								0,
							),
						);
					}
					if (usageStr)
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				}
				container.addChild(new Spacer(1));
			}
			return container;
		},
	});

	// The Reminder gets its own renderer so it is visibly machine-generated and
	// never mistaken for something the user typed.
	pi.registerMessageRenderer<ReminderDetails>(
		"subagent_done",
		(message, { expanded }, theme) => {
			const d = message.details;
			if (!d) return undefined;

			const icon =
				d.state === "completed"
					? theme.fg("success", "✓")
					: theme.fg("error", "✗");
			const header =
				`${icon} ${theme.fg("toolTitle", theme.bold(`task ${d.taskId} ${d.state}`))}` +
				theme.fg("muted", ` · ${d.mode} · $${d.cost.toFixed(4)}`);

			if (!expanded) {
				const agentNames = d.runs.map((r) => r.agent).join(", ");
				return new Text(`${header}\n${theme.fg("dim", agentNames)}`, 0, 0);
			}

			const container = new Container();
			container.addChild(new Text(header, 0, 0));
			const mdTheme = getMarkdownTheme();
			for (const run of d.runs) {
				const label = run.step ? `step ${run.step}: ${run.agent}` : run.agent;
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", label)}`, 0, 0),
				);
				if (run.warning)
					container.addChild(new Text(theme.fg("warning", run.warning), 0, 0));
				if (run.state === "failed")
					container.addChild(new Text(theme.fg("error", run.text), 0, 0));
				else if (run.text)
					container.addChild(new Markdown(run.text, 0, 0, mdTheme));
			}
			return container;
		},
	);

	pi.registerCommand("tasks", {
		description: "List background subagent tasks",
		async handler(_args, ctx) {
			const all = registry.all();
			if (all.length === 0) {
				ctx.ui?.notify("No subagent tasks in this session.", "info");
				return;
			}
			ctx.ui?.notify(all.map(formatTaskStatus).join("\n\n"), "info");
		},
	});

	/**
	 * `/run <taskId>` — resume a finished Task's Runs in live pi panes (docs/adr/0044).
	 *
	 * Thin over the shared `resumeTask` resolver: the completion Reminder tells
	 * the user exactly this command with a bare Task ID, and the tool's
	 * `open` action is the same resolver, so all three surfaces agree.
	 */
	pi.registerCommand("run", {
		description: "Resume a finished task in a live pi pane: /run sub-a3f1",
		async handler(args, ctx) {
			const id = (args ?? "").trim();
			if (!id) {
				ctx.ui?.notify("Usage: /run <taskId> — list runs with /runs", "info");
				return;
			}
			const r = await resumeTask(id);
			ctx.ui?.notify(describeResume(id, r), r.error ? "warning" : "info");
		},
	});

	/**
	 * `/runs` — the disk-wide Run Index (docs/adr/0028).
	 *
	 * Not a duplicate of `/tasks`: that one is the in-memory registry — this
	 * session's Tasks with mode, state, and cost — while `/runs` reads
	 * subagent-sessions/ from disk, so it spans sessions. Two answers to two
	 * questions; do not merge them.
	 */
	pi.registerCommand("runs", {
		description: "List tasks on disk, newest first (Run Index)",
		async handler(_args, ctx) {
			const entries = await scanRunDirs(getAgentDir());
			ctx.ui?.notify(
				entries.length === 0 ? "No runs on disk." : formatRunIndex(entries),
				"info",
			);
		},
	});

	// Memory-only storage means a reload drops the registry while child processes
	// are still alive. Killing them is the honest outcome: silent orphans would
	// burn API budget with nothing able to reach them (docs/adr/0001).
	/**
	 * Tidy Run session files in the background at session start.
	 *
	 * Runs are no longer ephemeral (docs/adr/0019), so their sessions accumulate.
	 * Session start is when the cost is invisible: a session that never delegates
	 * pays nothing, and nothing here sits on the path of a waiting delegation.
	 * Fully detached and never surfaced — housekeeping must not narrate itself.
	 */
	pi.on("session_start", (_event, ctx) => {
		if (ctx?.mode !== "tui") return;
		void (async () => {
			try {
				// Runs owned by this process are off-limits; the reaper additionally
				// skips anything recently written, which covers other pi processes.
				const inFlight = new Set<string>();
				for (const task of registry.all())
					for (const run of task.runs)
						if (run.exitCode === -1 && run.runId) inFlight.add(run.runId);
				await reapSessions(getAgentDir(), inFlight);

				// Teach the registry which Task IDs disk already holds, so a new Task
				// cannot mint an ID that reuses a retained Run's directory. Done after
				// reaping so deleted Runs do not keep their IDs reserved forever
				// (docs/adr/0036).
				try {
					const root = path.join(getAgentDir(), "subagent-sessions");
					const names = await readdir(root);
					setKnownDiskTaskIds(
						names
							.map((n) => /^(sub-[^-]+)-\d+$/.exec(n)?.[1])
							.filter((id): id is string => typeof id === "string"),
					);
				} catch {
					// No sessions directory yet: nothing is reserved.
				}
			} catch {
				// Housekeeping failure is never the session's problem.
			}
		})();
	});

	pi.on("session_shutdown", async (event) => {
		const canceled = registry.cancelAll();
		if (canceled.length > 0 && uiAvailable) {
			ui?.notify(
				`Canceled ${canceled.length} running subagent task(s) on ${event.reason}: ${canceled.join(", ")}`,
				"warning",
			);
		}
		// Give the SIGTERMs a moment to land before the process goes away.
		if (canceled.length > 0) await registry.drain(6000);
		ui?.setStatus("subagent", undefined);
	});
}
