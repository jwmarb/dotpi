/**
 * Autonomous review dispatch: spawning an oracle review and applying its
 * **Verdict** (docs/adr/0032).
 *
 * This module deliberately holds no plan-file logic. It spawns a review, reads
 * a Verdict out of the transcript, and hands the outcome back to the caller,
 * which owns the plan mutation. Keeping the two apart is what lets the whole
 * dispatch path be tested without a plan file, and what stops a review process
 * from becoming a second writer of plan state.
 *
 * The plan extension spawns the review itself rather than asking the
 * orchestrator to, so autonomy does not stop when the orchestrator stops. The
 * cost, recorded in ADR 0032: these reviews are outside the subagent Task
 * registry, so they are invisible to /runs, `subagent_tasks`, Board progress,
 * Mirror Panes and Reminders.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// The shared admission cap: one machine, one budget (docs/adr/0040).
import { closePane, renamePane, renameTab } from "../herdr/client.js";
import { herdrSocketAvailable, openPluginPane } from "../herdr/socket.js";
import { DONE_TOOL_NAME } from "../subagent/child-done.js";
// The launch planner and its pane contract, shared with delegated Runs so a
// review's wrapper cannot drift from theirs (docs/adr/0044).
import {
	buildLaunchPlan,
	buildSubagentToolAllowlist,
	RUN_ENTRYPOINT,
	RUN_PLUGIN_ID,
} from "../subagent/native.js";
import { shortRunId, writePromptToRunDir } from "../subagent/rundir.js";
import { claimSlot } from "../subagent/spawnlimit.js";
import { watchNativeRun } from "../subagent/watcher.js";

/**
 * Environment flag marking a pi process as *being* an autonomous review.
 *
 * A review child loads this same plan extension, so without an interlock it
 * would groom items and dispatch reviews of its own — unbounded recursion at
 * roughly ten minutes per oracle run. Any process carrying this flag refuses to
 * dispatch (see {@link dispatchSuppressed}).
 */
export const REVIEW_ENV_FLAG = "PI_PLAN_IN_REVIEW";

/**
 * How long a single review may run before it is abandoned as wedged.
 *
 * Above pi's own worst-case retry ladder (~10.6 min with `maxRetries` 10 capped
 * at 128s) with room for a genuinely long review: the oracle reviews in this
 * repo's history have run 24 turns over ten minutes. A review that outlives this
 * is treated as a dead review, not a Verdict.
 *
 * Raising `retry.maxRetries` or `retry.maxDelayMs` means raising this too, or
 * long-retrying reviews get killed as wedged — the same coupling ADR 0033
 * records for the subagent stall timer.
 */
export const REVIEW_TIMEOUT_MS = 25 * 60 * 1000;

/**
 * Abandon deadline for a **Rework**, which is longer than a review's.
 *
 * A reviewer reads; a worker reads, edits, builds, tests and commits, so it has
 * strictly more to do. Measured on this repo's own history, a real worker Run
 * took 15.3 minutes — uncomfortably close to the 25-minute review deadline, and
 * that Run was not also running a test suite.
 *
 * Forty minutes is chosen to sit clear of that observed work plus pi's ~10.6
 * minute retry ladder, and it inherits ADR 0033's coupling caveat: raising
 * `retry.maxRetries` or `retry.maxDelayMs` means raising this too.
 */
export const REWORK_TIMEOUT_MS = 40 * 60 * 1000;

/**
 * Grace between SIGTERM and SIGKILL when abandoning a child.
 *
 * Two seconds for a reader, which holds nothing worth flushing — a killed
 * reviewer loses only its own opinion. A writer gets far longer, because SIGKILL
 * during `git commit` can leave `.git/index.lock` behind and a half-staged
 * index, turning the contract's "exactly one commit" into no commit plus a dirty
 * tree that nothing describes. Thirty seconds is not a guarantee — nothing short
 * of not killing it is — but it clears a commit that has actually started.
 */
function killGraceFor(purpose: ChildPurpose): number {
	return purpose === "rework" ? 30_000 : 2_000;
}

// The concurrency cap lives in the shared spawn limit (docs/adr/0040), not here.
// A private counter bounded reviews only, so reviews plus subagent Tasks could
// reach nine children while each cap separately reported healthy — and there is
// one machine, not one per spawner.

/**
 * Sentinel written into a review child's `PI_PLAN_KEY`.
 *
 * It must be a non-empty string. An empty string is falsy, and the plan
 * extension branches on `!process.env.PI_PLAN_KEY` to decide whether it is a
 * main session — so `""` made every review child believe it *was* the main
 * session, restoring and re-injecting the plan and spawning a Board.
 */
export const REVIEW_PLAN_KEY = "__review__";


/**
 * Whether this process must not dispatch reviews.
 *
 * True inside a review child (the recursion interlock). Exported so the caller
 * can explain itself rather than silently doing nothing.
 */
export function dispatchSuppressed(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env[REVIEW_ENV_FLAG] === "1";
}

/** Outcome of a dispatched review, before any plan mutation. */
export interface ReviewOutcome {
	/** Raw transcript, kept whole so a dead review can be diagnosed. */
	output: string;
	/** Why no Verdict was reached, or null when one was. */
	deadReason: string | null;
	/** Exit code, or null when the process was killed. */
	exitCode: number | null;
}

/**
 * Determine how to re-invoke `pi`.
 *
 * Mirrors the subagent extension's resolution rather than importing it: the two
 * extensions are deliberately independent, and this is the one piece of
 * knowledge they must share (docs/adr/0032).
 *
 * **This function caused a fork bomb and is now deliberately paranoid.** The
 * subagent version re-invokes `process.argv[1]`, which is sound *there* because
 * that extension only ever runs inside pi, so argv[1] **is** pi. This module can
 * also be imported by a test harness or any other script — and then argv[1] is
 * that script, so "spawn pi" silently became "re-execute myself", each copy
 * spawning another at roughly four per second until the machine's RAM was gone.
 *
 * So the current script is only reused when it actually looks like pi. When it
 * does not, the bare `pi` on PATH is used, and when even that cannot be found
 * the caller is told rather than a guess being executed.
 *
 * @returns The invocation, or null when no pi could be identified.
 */
export function getPiInvocation(
	args: string[],
): { command: string; args: string[] } | null {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	// The script must be recognisably pi itself, not merely present on disk.
	const looksLikePi =
		!!currentScript && /(^|\/)(pi|pi\.[cm]?[jt]s)$/.test(currentScript);
	if (
		currentScript &&
		!isBunVirtualScript &&
		looksLikePi &&
		fs.existsSync(currentScript)
	) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	// A non-generic execPath means the binary IS pi (a compiled single-file build).
	if (!isGenericRuntime) return { command: process.execPath, args };
	// Generic runtime and no pi-looking script: fall back to pi on PATH, but only
	// if it is actually there. Spawning a command that does not exist would be
	// harmless; spawning the wrong one is what burned the machine.
	const onPath = findPiOnPath();
	return onPath ? { command: onPath, args } : null;
}

/** Locate a `pi` executable on PATH, or null. */
function findPiOnPath(): string | null {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "pi");
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// Keep looking.
		}
	}
	return null;
}

/**
 * Strip YAML frontmatter from an agent file, returning the body and the model.
 *
 * The plan extension cannot import the subagent extension's agent loader, so it
 * reads the standalone agent file directly. Only the two fields a review needs
 * are extracted; everything else in the frontmatter is ignored rather than
 * half-understood.
 *
 * @param raw - Full contents of the agent markdown file.
 */
export function parseAgentFile(raw: string): {
	body: string;
	model: string | null;
	tools: string[] | null;
} {
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
	if (!m) return { body: raw.trim(), model: null, tools: null };
	const fm = m[1];
	const body = raw.slice(m[0].length).trim();
	const modelMatch = /^model:\s*(.+)$/m.exec(fm);
	const toolsMatch = /^tools:\s*(.+)$/m.exec(fm);
	return {
		body,
		model: modelMatch ? modelMatch[1].trim() : null,
		tools: toolsMatch
			? toolsMatch[1]
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: null,
	};
}

/**
 * What a spawned child is for.
 *
 * `review` reads and judges; `rework` edits the repo to address a judgement.
 * They share one spawner (see {@link runReview}) and differ only in their
 * prompt, their spawn-slot kind, and the wording of a failure.
 */
export type ChildPurpose = "review" | "rework";

/**
 * The agent name a purpose runs under.
 *
 * Kept beside {@link ChildPurpose} because it must agree with the `agent` passed
 * to `createRunDir` in `index.ts` — that name is what `/runs` and the Run Index
 * display, so a pane labelled differently from its own Run row would be worse
 * than an unlabelled one.
 */
export function agentForPurpose(purpose: ChildPurpose): string {
	return purpose === "rework" ? "worker" : "oracle";
}

/**
 * The instruction appended to the worker's own prompt for an autonomous Rework.
 *
 * The worker gets the Item's text and oracle's findings and nothing else — no
 * session history, no memory of how the rejected attempt was reasoned about.
 * That absence is the point (docs/adr/0032): the agent whose work was rejected
 * already believed it was correct, so a fresh Run is asked to satisfy the
 * findings rather than to defend the approach.
 *
 * It is told to commit, because an autonomous edit that is not a commit is an
 * unattributable change in the working tree, and one commit per Rework is what
 * makes a bad one revertable on its own.
 */
export function reworkContract(
	itemText: string,
	findings: string | undefined,
): string {
	return [
		"## Autonomous rework",
		"",
		"A reviewer rejected the previous attempt at this task. You are a fresh",
		"run: you did not write it, and you are not being asked to defend it.",
		"Address the findings below and leave the work in a state a reviewer would",
		"pass.",
		"",
		"### The task",
		"",
		itemText,
		"",
		"### What the reviewer found",
		"",
		findings?.trim()
			? findings.trim()
			: "(no findings were recorded — treat the task as not yet done)",
		"",
		"### How to work",
		"",
		"- Fix the cause, not the symptom. The findings say what was wrong; they",
		"  are not necessarily a complete specification of the fix.",
		"- Verify your change by running it. You have `bash`: build it, test it,",
		"  execute the thing you changed. An unverified fix is what got rejected.",
		"- Commit your work when it is done, as ONE commit, with a message saying",
		"  what you changed and why. Do not amend or rebase existing commits, and",
		"  do not commit unrelated files that were already dirty.",
		"- If the findings are wrong or impossible, say so plainly in your reply",
		"  and change nothing rather than forcing a fix you cannot defend.",
	].join("\n");
}

/**
 * The instruction appended to oracle's own prompt for an autonomous review.
 *
 * States the Verdict contract in the exact form {@link parseVerdict} accepts.
 * The parser has no prose fallback, so this contract is the only thing standing
 * between a thoughtful review and a dead one.
 */
export function reviewContract(itemText: string, note: string | undefined): string {
	return [
		"## Autonomous review",
		"",
		"You are reviewing one completed Plan Item. Decide whether the work it",
		"describes is actually correct and complete as claimed. Read the code; do",
		"not take the claim on trust.",
		"",
		`**The Item:** ${itemText}`,
		...(note ? ["", `**What the implementer reported:**`, "", note] : []),
		"",
		"### Verdict contract (required)",
		"",
		"End your reply with a verdict as the LAST line, exactly:",
		"",
		"```",
		"VERDICT: pass",
		"```",
		"",
		"Use `pass` if the work is correct and complete, `fail` if it is not, or",
		"`unsure` if you could not establish either way. Nothing may follow that",
		"line — no sign-off, no summary. A missing or malformed verdict is",
		"discarded as a dead review and the work is reviewed again, wasting the",
		"whole run, so put your reasoning ABOVE the line.",
		"",
		"**This overrides your agent file's output format.** If your instructions",
		"tell you to wrap your write-up in `<result>` tags, or to state your",
		"conclusion under a `## Verdict` heading, do NOT do so here. Write your",
		"findings as plain prose and end with the bare verdict line. A closing",
		"`</result>` tag after the verdict discards it just as surely as omitting",
		"the verdict altogether, because only the last non-empty line is read.",
		"",
		"Before the verdict, state your findings plainly: if you fail the Item,",
		"what you write is the only thing a fresh implementer will receive."
	].join("\n");
}

/**
 * Run a review or rework as a **Native Run** — a real `pi` TUI in a herdr pane.
 *
 * Returns null when a pane could not be opened, so the caller falls through to
 * the piped path. Never throws for an expected failure, for the same reason the
 * subagent extension's native branch does not: no failure of the *display*
 * mechanism may cost a review its chance to run.
 *
 * ## Why the Verdict can come from the transcript
 *
 * ADR 0037 made the Verdict contract strict — the token must be the last
 * non-empty line, with no prose fallback, because "guessing a conclusion gets
 * read as one". That contract is about *parsing*, not about the channel, so it
 * survives the move: this returns the child's last assistant text as `output`,
 * and `parseVerdict` applies exactly the same rule to it. A child that never
 * emits a token still yields no Verdict, which is still a **Dead review**.
 *
 * One hazard is inherited from the delegated path and must not be re-learned
 * here: a child often states its conclusion *in the same turn* as its
 * `subagent_done` call, and pi may then add a courtesy turn. Reading "the last
 * thing said" would therefore capture the epilogue and lose the token — so the
 * transcript reader treats the turn carrying the **Done signal** as
 * authoritative, and the done tool is injected here for that reason as much as
 * for termination.
 *
 * @returns The outcome, or null to fall back to the piped path.
 */
async function runReviewNatively(opts: {
	purpose: ChildPurpose;
	cwd: string;
	runDir: string;
	runId: string;
	promptPath: string;
	task: string;
	model?: string;
	tools?: string[];
	timeoutMs: number;
}): Promise<ReviewOutcome | null> {
	// Reuse this module's own hardened resolution rather than re-deriving it: it
	// refuses to guess, which is the guard ADR 0037 added after a guessed target
	// re-ran the calling script and exhausted the machine. Prefer a `pi` on PATH,
	// because that launcher carries its own shebang and so is a single word that
	// cannot be split from its script inside a wrapper another process runs later
	// (docs/adr/0044).
	const onPath = findPiOnPath();
	const invocation = onPath ? { command: onPath, args: [] } : getPiInvocation([]);
	if (!invocation) return null;
	const piCommand = [invocation.command, ...invocation.args];

	const doneExtension = path.join(
		path.dirname(new URL(import.meta.url).pathname),
		"..",
		"subagent",
		"child-done.ts",
	);

	const plan = buildLaunchPlan({
		runId: opts.runId,
		sessionDir: opts.runDir,
		cwd: opts.cwd,
		piCommand,
		doneExtensionPath: doneExtension,
		// allowNesting=false: an autonomous child must not be able to delegate
		// (docs/adr/0037). The flag both withholds the nesting tools and strips any an
		// agent file declares, so the boundary does not depend on agent configuration.
		//
		// The `??` fallback is the other half of that boundary. A null allowlist means
		// "unrestricted", which for a Native Run means no `--tools` flag at all — i.e.
		// *every* tool, `subagent` included. So an agent file that merely omitted its
		// `tools:` line would silently hand a review the delegation it was just denied.
		// Falling back to the done tool alone keeps the Run restricted by construction:
		// a review that cannot be described in tools is given the minimum, never the
		// maximum. Every agent file declares tools today; this does not rely on that.
		tools: buildSubagentToolAllowlist(opts.tools, DONE_TOOL_NAME, false) ?? [
			DONE_TOOL_NAME,
		],
		model: opts.model,
		systemPromptPath: opts.promptPath,
		// The brief crosses as the child's first user message, mirroring the
		// delegated sub- mechanism: the pane and the Transcript record what the
		// Run was asked, instead of a pointer into a system prompt no one can
		// see (docs/adr/0047).
		task: opts.task,
		// NOT the reviewed plan's key. A review must not load that plan — including
		// its autonomous mode — as its own, and the sentinel must stay non-empty or
		// the plan extension treats the child as a main session and spawns a Board
		// inside it (docs/adr/0037).
		planKey: REVIEW_PLAN_KEY,
	});

	// The recursion interlock has to reach the child through the pane's env, since
	// a herdr-launched process inherits the herdr *server's* environment and not
	// this one's (docs/adr/0044). Without it a review could dispatch reviews of its
	// own, which is the fork bomb ADR 0037 exists to prevent.
	const paneEnv = { ...plan.paneEnv, [REVIEW_ENV_FLAG]: "1" };

	await fs.promises.mkdir(opts.runDir, { recursive: true });
	await fs.promises.writeFile(plan.wrapperPath, plan.wrapperSource, {
		encoding: "utf-8",
		mode: 0o700,
	});

	const pane = await openPluginPane({
		pluginId: RUN_PLUGIN_ID,
		entrypoint: RUN_ENTRYPOINT,
		// Its own Tab, not a split: a review is not part of any Task's pane family,
		// and splitting the orchestrator's pane would shrink the window the user is
		// working in every time an item reached review. Deliberately NO `direction`
		// — a Tab has no pane to split from, and herdr rejects the combination
		// outright (measured: `placement:"tab"` with a direction returns null, which
		// silently sent every native review down the piped fallback).
		placement: "tab",
		// Never steal focus: a review starting must not pull the user out of what
		// they are typing.
		focus: false,
		cwd: opts.cwd,
		env: paneEnv,
	});
	if (!pane) return null;

	// Name the Tab and pane herdr just made. Without this both carry defaults — an
	// ordinal in the tab bar and no pane label at all — so an autonomous review
	// appearing unbidden is indistinguishable from any other session, which is
	// exactly when knowing what it is matters most.
	//
	// The format matches a delegated Run's (`oracle (#44da80f1)`) rather than
	// inventing a second convention: the two kinds of Run sit side by side in the
	// same tab bar, and `plan-review 44da80f1` next to `explorer (#6748)` would
	// read as a different kind of thing when it is not.
	//
	// Best-effort by design: a rename failing must not abandon a review that has
	// already been spawned and is about to be watched.
	const paneLabel = `${agentForPurpose(opts.purpose)} (#${shortRunId(opts.runId)})`;
	try {
		await renameTab(pane.tabId, paneLabel);
		await renamePane(pane.paneId, paneLabel);
	} catch {
		// A label is cosmetic; the review is not.
	}

	const abort = new AbortController();
	const deadline = setTimeout(() => abort.abort(), opts.timeoutMs);
	let result: Awaited<ReturnType<typeof watchNativeRun>>;
	try {
		result = await watchNativeRun({
			runId: opts.runId,
			sessionDir: opts.runDir,
			paneId: pane.paneId,
			signal: abort.signal,
			// Match the purpose's own deadline. Left unset, the watcher applies its
			// default 20-minute stall threshold, which would abandon a rework at 20
			// minutes despite the 40 it was promised — and a rework can legitimately
			// sit silent inside one long build or test.
			stallTimeoutMs: opts.timeoutMs,
		});
	} finally {
		clearTimeout(deadline);
	}

	// A review is transient: it has no findings worth leaving on screen once its
	// Verdict is recorded on the Plan Item, so its pane closes either way. This
	// differs deliberately from a delegated Run, whose failure pane is held open
	// because its error text is the only diagnosis available.
	void closePane(pane.paneId);

	if (result.outcome === "completed") {
		return {
			output: result.lastAssistantText ?? "",
			deadReason: null,
			exitCode: result.exitCode ?? 0,
		};
	}

	// Everything else is a Dead review: no Verdict, no Review Budget spent, and
	// worth simply running again (docs/adr/0037, docs/adr/0040).
	const reason =
		result.outcome === "dismissed"
			? `the ${opts.purpose}'s pane was closed before it reached a verdict`
			: result.outcome === "stalled"
				? `the ${opts.purpose} ${result.detail} and was abandoned as wedged`
				: `the ${opts.purpose} ${result.detail}`;
	return {
		output: result.lastAssistantText ?? "",
		deadReason: reason,
		exitCode: result.exitCode ?? null,
	};
}

/**
 * Spawn one oracle review and collect its transcript.
 *
 * Never throws: a failure to spawn, a timeout and a crash all come back as a
 * dead review, because the caller's job is to decide whether to retry, and an
 * exception here would leave a plan Item stuck in `review` with nothing said.
 *
 * @param opts.agentFile - Absolute path to the standalone oracle agent file.
 * @param opts.itemText - The Item under review.
 * @param opts.note - What the implementer reported, if anything.
 * @param opts.cwd - Working directory for the review.
 * @param opts.timeoutMs - Override the abandon deadline (tests use a short one).
 * @param opts.runDir - Where the child should write its session, making the
 *        review observable in `/runs`, on the Board and in a Mirror Pane. Both
 *        this and `runId` must be given, or the review runs unobserved as before.
 * @param opts.runId - The Run ID, which is also the run directory's name.
 * @param opts.spawnFn - Injectable spawn, so the dispatch path is testable
 *        without paying for a real oracle run.
 */
export async function runReview(opts: {
	agentFile: string;
	itemText: string;
	note?: string;
	cwd: string;
	timeoutMs?: number;
	runDir?: string;
	runId?: string;
	spawnFn?: typeof spawn;
	/**
	 * What this child is for, which decides its prompt, its slot kind and how a
	 * failure is worded. Defaults to a review.
	 *
	 * A **Rework** child is a *writer* — it edits the repo — while a review is
	 * read-only, so it would be reasonable to give it its own spawner. It
	 * deliberately does not get one. Everything dangerous here is shared: proving
	 * the spawn target is really pi, the recursion interlock enforced at the
	 * spawner rather than the caller, claiming a slot synchronously before any
	 * await, the non-empty plan-key sentinel, the abandon deadline and the
	 * SIGTERM/SIGKILL escalation. Each of those was a bug once (docs/adr/0037,
	 * 0040), and a second copy of this function is exactly how the first one got
	 * bypassed — a harness called the spawner directly and never met the caller's
	 * guard. One spawner, two prompts.
	 */
	purpose?: ChildPurpose;
}): Promise<ReviewOutcome> {
	const purpose = opts.purpose ?? "review";
	const timeoutMs =
		opts.timeoutMs ??
		(purpose === "rework" ? REWORK_TIMEOUT_MS : REVIEW_TIMEOUT_MS);
	const spawnImpl = opts.spawnFn ?? spawn;

	// The interlock is enforced HERE, at the only place that actually spawns, not
	// merely in dispatchReview. A guard the spawner does not itself apply is a
	// guard any new caller can bypass — which is exactly how the fork bomb got
	// out: a harness called runReview directly and never saw dispatchReview's check.
	if (dispatchSuppressed()) {
		return {
			output: "",
			deadReason:
				`refused to spawn: this process is itself an autonomous child, so it must not spawn a ${purpose}`,
			exitCode: null,
		};
	}
	// Claim a slot from the shared cap BEFORE any await. claimSlot is synchronous
	// precisely so the check and the claim cannot be separated: the previous
	// version incremented at the spawn, three awaits later, and 12 concurrent
	// callers all passed a cap of 3 (docs/adr/0040).
	const claim = claimSlot(purpose);
	if (!claim.ok) {
		return { output: "", deadReason: claim.reason, exitCode: null };
	}
	const releaseSlot = () => claim.slot.release();

	let raw: string;
	try {
		raw = await readFile(opts.agentFile, "utf-8");
	} catch (err) {
		// Outside the try/finally below, so this path must release its own slot.
		releaseSlot();
		return {
			output: "",
			deadReason: `could not read the ${purpose} agent file at ${opts.agentFile}: ${
				(err as Error).message
			}`,
			exitCode: null,
		};
	}
	const agent = parseAgentFile(raw);

	// The brief — what the child is asked to do — crosses as the child's
	// first user message, not through the system prompt (docs/adr/0047):
	// the pane and the Transcript then record what the Run was asked.
	const brief =
		purpose === "rework"
			? reworkContract(opts.itemText, opts.note)
			: reviewContract(opts.itemText, opts.note);

	// The system-prompt channel carries the agent definition alone. It goes
	// through a file because it is far past any safe argv length.
	let tmpDir: string | null = null;
	try {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), `pi-plan-${purpose}-`));
		const promptPath = path.join(tmpDir, "prompt.md");
		await writeFile(promptPath, agent.body, "utf-8");

		// The Run directory records the whole delegation payload — the agent
		// definition plus the brief marked as the first user message — so the
		// directory answers "what was this Run asked" on its own (ADR 0045,
		// ADR 0047). A delegated Run's `prompt.md` is its `--append-system-prompt`
		// content byte-for-byte; a plan-spawned Run's brief no longer crosses
		// that flag, so its record marks the channel instead.
		if (opts.runDir && opts.runId) {
			await writePromptToRunDir(
				opts.runDir,
				[agent.body, "## First user message", brief].join("\n\n---\n\n"),
			);
		}
		const args = ["--mode", "text", "-p", "--append-system-prompt", promptPath];
		// Write the transcript where every existing viewer already looks. Without
		// --session-dir the child writes its session nowhere discoverable, which is
		// the entire reason autonomous reviews were invisible: no /runs row, no Board
		// progress, and a Mirror Pane stuck on "waiting for the run to start…".
		// Verified that a --mode text child does write a readable .jsonl here
		// (docs/adr/0039).
		if (opts.runDir && opts.runId) {
			args.push("--session-dir", opts.runDir, "--session-id", opts.runId);
		}
		if (agent.model) args.push("--model", agent.model);
		if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
		// The brief is the child's first user message — bare, no prefix: the
		// contract opens with its own heading (docs/adr/0047).
		args.push(brief);

		// A **Native Run** for the review, when herdr can host one: the same real
		// interactive `pi` TUI a delegated Run gets, in its own pane, watchable and
		// steerable (docs/adr/0044). ADR 0044 originally scoped reviews out of the
		// native path, and the consequence was exactly the invisibility this whole
		// change set out to remove: an autonomous review left no pane and no tab, so
		// the one Run type that runs *without a human* was the one a human could not
		// watch.
		//
		// The **Verdict** now comes from the child's own transcript rather than its
		// stdout, because a TUI has none. `parseVerdict` and `reviewFindings` are
		// unchanged: this fills the same `output` field they already read, so the
		// strict trailing-token contract of ADR 0037 still decides the Verdict and a
		// missing token is still a **Dead review** rather than a guess.
		//
		// Every guard above is upstream of this branch by construction — the
		// recursion interlock, the synchronous slot claim, the non-empty sentinel plan
		// key — so going native cannot bypass one. On any failure here we fall through
		// to the piped path below, which is retained permanently.
		if (herdrSocketAvailable() && opts.runDir && opts.runId) {
			try {
				const native = await runReviewNatively({
					purpose,
					cwd: opts.cwd,
					runDir: opts.runDir,
					runId: opts.runId,
					promptPath,
					task: brief,
					model: agent.model,
					tools: agent.tools,
					timeoutMs,
				});
				if (native) return native;
			} catch {
				// Deliberately swallowed: a pane that would not open is a reason to run
				// the review the old way, never a reason to fail it.
			}
		}

		const invocation = getPiInvocation(args);
		// No identifiable pi: report it instead of executing a guess. Executing the
		// guess is what re-ran the calling script and exhausted the machine.
		if (!invocation) {
			return {
				output: "",
				deadReason:
					"refused to spawn: could not identify the pi executable to run (not the current script, not the runtime, not on PATH)",
				exitCode: null,
			};
		}
		return await new Promise<ReviewOutcome>((resolve) => {
			let output = "";
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const child = spawnImpl(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					// The interlock: this child must not dispatch reviews of its own.
					[REVIEW_ENV_FLAG]: "1",
					// Not the reviewed plan's key: a review must not load that plan —
					// including its autonomous mode — as its own. It must still be a
					// NON-EMPTY sentinel, because the plan extension treats a falsy
					// PI_PLAN_KEY as "I am the main session" and would then restore the
					// plan, re-inject it and spawn a Board inside every review child.
					PI_PLAN_KEY: REVIEW_PLAN_KEY,
				},
			});

			const finish = (outcome: ReviewOutcome) => {
				if (settled) return;
				settled = true;
				// The slot is released by the `finally` below, which covers every exit
				// including the ones that never reach here (a failed spawn, a throw
				// while writing the prompt) — one release path, not several.
				clearTimeout(timer);
				if (killTimer) clearTimeout(killTimer);
				resolve(outcome);
			};

			const timer = setTimeout(() => {
				// Abandon rather than wait: a wedged review is invisible (it has no
				// Mirror Pane and no Reminder), so the deadline is the only thing that
				// can end it.
				try {
					child.kill("SIGTERM");
				} catch {
					// Already gone.
				}
				killTimer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						// Already gone.
					}
				}, killGraceFor(purpose));
				finish({
					output,
					deadReason: `the ${purpose} did not finish within ${
						timeoutMs >= 60000
							? `${Math.round(timeoutMs / 60000)} minutes`
							: `${timeoutMs}ms`
					} and was abandoned as wedged`,
					exitCode: null,
				});
			}, timeoutMs);

			child.stdout?.on("data", (d: Buffer) => {
				output += d.toString();
			});
			// stderr is captured into the same transcript: when a review dies, its
			// error text is the only diagnosis available.
			child.stderr?.on("data", (d: Buffer) => {
				output += d.toString();
			});
			child.on("error", (err) => {
				finish({
					output,
					deadReason: `the review could not be started: ${err.message}`,
					exitCode: null,
				});
			});
			child.on("close", (code) => {
				finish({
					output,
					deadReason:
						code === 0
							? null
							: `the review exited with code ${code} before reaching a verdict`,
					exitCode: code,
				});
			});
		});
	} catch (err) {
		return {
			output: "",
			deadReason: `the review could not be prepared: ${(err as Error).message}`,
			exitCode: null,
		};
	} finally {
		// One release path for every outcome: success, dead review, unidentifiable
		// pi, or a throw. A leaked slot would silently shrink the cap toward zero
		// until no review could ever run again — a quiet failure worse than the
		// noisy one it guards against.
		releaseSlot();
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}
