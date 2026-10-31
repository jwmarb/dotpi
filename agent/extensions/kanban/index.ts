/**
 * kanban extension — the orchestrator's task board, shown as a herdr side pane.
 *
 * Replaces the `todo` list for the orchestrator (the human's top-level pi). A
 * spawned subagent never loads this: the factory returns at once when
 * `PI_SUBAGENT_RUN_ID` is set, and `todo.ts` is registered only there instead.
 *
 * WHAT IT DOES
 * - Registers the `kanban` tool (add/move/note/rename/link/unlink/drop/
 *   clear_done/show) and the `/kanban` command (the same ops for the user, plus
 *   open/close).
 * - On every new pi session inside herdr's TUI it splits a side pane off the
 *   orchestrator's own pane (no focus steal) and runs the read-only board
 *   process (`board.ts`) in it. Outside herdr — or when the pane is too small or
 *   bun is missing — it falls back to a compact widget below the editor.
 * - Holds the turn open on `agent_before_settle` when cards are left
 *   unaccounted for, except cards waiting on a running linked subagent run.
 *
 * STATE (single writer — read lib.ts's header)
 * Canonical state is a snapshot in the session branch: a successful `kanban`
 * tool result's `details.state`, or a `kanban-state` custom entry from
 * `/kanban`. In memory, `state` is authoritative for the runtime: ops apply to
 * it synchronously before any `await`, so parallel kanban calls in one assistant
 * message compose in call order instead of each replaying the same branch (pi
 * persists a parallel batch's results only after the whole batch; replaying per
 * op is exactly what loses `todo` updates). The branch rebuilds it on every
 * session_start and session_tree, and `turn_end`/`agent_settled` append a
 * repair snapshot if what was persisted differs (compared by full digest).
 *
 * The board pane is a pure viewer of a projection file this extension writes
 * (synchronous temp+rename, so writes cannot reorder) in a private runtime dir
 * under $XDG_RUNTIME_DIR — never under agent/, which Nextcloud syncs.
 *
 * PANE LIFECYCLE
 * A process-global registry (globalThis, survives the fresh module instance
 * pi loads for /reload and for every session replacement) remembers the board
 * pane per owner pane. startup/new/resume/fork open or adopt it; /reload adopts
 * it if it is alive and otherwise respects that the user closed it (bare
 * `/kanban` or `/kanban open` reopens, `/kanban restart` relaunches the
 * process). Only quit closes it
 * and removes the runtime dir — /new, /resume and /fork keep both for the next
 * session to adopt. A remembered runtime dir is re-validated before reuse, and
 * a remembered pane is closed only if it still carries our label. The board
 * also exits by itself when pi's pid or its runtime dir disappears.
 *
 * A /kanban edit typed while the agent is streaming is not persisted at once:
 * a parallel tool batch may be in flight, and its results — persisted only
 * after the whole batch — would land after the edit in the branch while
 * carrying the pre-edit board. The edit lives in memory, the batch's own
 * snapshots already include it (ops apply in order), and the turn_end repair
 * persists it if no tool result did.
 */

import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { agentDir } from "../lib/layout.js";
import { personaDenies } from "../lib/persona.js";
import { BE_BUN_ENV, runningCompiled } from "../lib/runtime.js";
import { cachedByWidth } from "../lib/widget.js";
import { closePane, paneExists, paneLabel, paneRect, renamePane, runInPane, splitPaneOf } from "../subagent-herdr/herdr.js";
import {
	applyOp,
	buildProjection,
	cloneState,
	compactLines,
	decideSplit,
	describeOp,
	emptyState,
	findOnPath,
	formatCardList,
	KANBAN_SUBCOMMANDS,
	KANBAN_USAGE,
	KanbanError,
	linkedRunIds,
	nudgeFor,
	opFromParams,
	parseCommand,
	reconstructFromEntries,
	paneCommand,
	staleRuntimeOwner,
	STATE_ENTRY_TYPE,
	stateDigest,
	summarize,
	TOOL_NAME,
	type KanbanOp,
	type KanbanState,
	type SessionEntryLike,
	type Style,
	type Tone,
	CHANGED_FILES_EVENT,
	type ChangedFileInfo,
	KANBAN_PANE_EVENT,
	parseChangedFiles,
} from "./lib.js";
import { readRunInfos } from "./runs.js";
import { RUN_TODOS_EVENT } from "../lib/todo.js";

const WIDGET_KEY = "kanban";
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const BOARD_SCRIPT = join(SELF_DIR, "board.ts");
/** How long the board gets to come up before a vanished pane counts as a failed launch. */
const LAUNCH_CHECK_MS = 1500;
/** Patience for closing the pane on quit: pi's exit waits for this handler. */
const QUIT_CLOSE_TIMEOUT_MS = 3000;
/**
 * The label the board's pane gets at launch. Recovery metadata only: it is
 * never used to *find* a pane, only to confirm that a pane id remembered from
 * earlier is still ours before closing it.
 */
const BOARD_LABEL = "Kanban";

/**
 * Is `paneId` still the board pane we launched? A pane the user closed by hand
 * frees its id for nothing else in practice (herdr ids are per-workspace
 * counters, measured on 0.9.0), but closing a pane is the one irreversible
 * thing this extension does to the user's layout, so it is checked.
 */
async function isOurBoard(paneId: string, timeoutMs?: number): Promise<boolean> {
	return (await paneLabel(paneId, timeoutMs)) === BOARD_LABEL;
}

/** One owner pane's board, remembered across /reload and session replacement. */
interface BoardRecord {
	ownerPaneId: string;
	runtimeDir?: string;
	projectionFile?: string;
	paneId?: string;
	/** A pane was ever opened in this process (so a vanished one was closed, not never-opened). */
	opened: boolean;
	/** Publication counter for the projection; per process, never reset. */
	seq: number;
	/** Serialises open attempts: session_start and `/kanban open` can race. */
	opening?: Promise<void>;
}

const REGISTRY_KEY = Symbol.for("pi.kanban.boards");
function registry(): Map<string, BoardRecord> {
	const g = globalThis as Record<symbol, Map<string, BoardRecord> | undefined>;
	return (g[REGISTRY_KEY] ??= new Map());
}

const THEME_TONE: Record<Tone, ThemeColor> = {
	accent: "accent",
	muted: "muted",
	dim: "dim",
	text: "text",
	success: "success",
	warning: "warning",
	error: "error",
	heading: "mdHeading",
};

const themeStyle = (theme: Theme): Style => ({
	fg: (tone, text) => (text ? theme.fg(THEME_TONE[tone], text) : text),
	bold: (text) => (text ? theme.bold(text) : text),
});

const KanbanParams = Type.Object({
	op: Type.Union(
		[
			Type.Literal("add"),
			Type.Literal("move"),
			Type.Literal("note"),
			Type.Literal("rename"),
			Type.Literal("link"),
			Type.Literal("unlink"),
			Type.Literal("drop"),
			Type.Literal("clear_done"),
			Type.Literal("show"),
		],
		{ description: "The operation." },
	),
	titles: Type.Optional(
		Type.Array(Type.String(), { description: "For add: one short imperative per card, e.g. ['parse the header', 'write the test']." }),
	),
	id: Type.Optional(Type.String({ description: "The card id, e.g. 'k3' (move/note/rename/link/unlink/drop)." })),
	column: Type.Optional(
		Type.String({ description: "For move (required) and add (optional, default backlog): backlog | in_progress | blocked | review | done." }),
	),
	note: Type.Optional(
		Type.String({
			description: "For move: why it is blocked (required for blocked) or the evidence it is done. For note: the text ('' clears).",
		}),
	),
	title: Type.Optional(Type.String({ description: "For rename: the new title." })),
	run_id: Type.Optional(Type.String({ description: "For link/unlink: the subagent run id (sub-xxxx) the subagent tool returned." })),
});

type KanbanParamsType = {
	op: string;
	titles?: string[];
	id?: string;
	column?: string;
	note?: string;
	title?: string;
	run_id?: string;
};

/**
 * `bun` for the board process, with any env it needs. pi normally runs under node, so search PATH; a bun-hosted pi
 * can use its own binary. A compiled pi (Pi-Bolt) is also bun-hosted, but its executable is pi itself: it becomes
 * the `bun` CLI only under `BUN_BE_BUN=1` — without it, it parses the board's flags as pi's and the pane dies.
 */
function findBun(): { bin: string; env: Record<string, string> } | undefined {
	if (runningCompiled()) return { bin: process.execPath, env: { ...BE_BUN_ENV } };
	if (process.versions.bun) return { bin: process.execPath, env: {} };
	const executable = (p: string): boolean => {
		try {
			accessSync(p, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	const found = findOnPath("bun", process.env.PATH, executable, [join(homedir(), ".bun", "bin", "bun")]);
	return found ? { bin: found, env: {} } : undefined;
}

/** Is `pid` a live process? EPERM means it exists but is not ours: alive. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Remove runtime dirs whose owner pid is gone. A pi killed with SIGKILL (or
 * pi's emergency terminal exit) never runs `session_shutdown`; its board
 * notices through the owner-pid watchdog and closes its pane, but nothing else
 * removes the dir. Best effort: a sweep that fails costs a few bytes in tmpfs.
 */
function sweepDeadRuntimeDirs(root: string, prefix: string): void {
	try {
		for (const name of readdirSync(root)) {
			const pid = staleRuntimeOwner(name, prefix);
			if (pid === undefined || pid === process.pid || pidAlive(pid)) continue;
			rmSync(join(root, name), { recursive: true, force: true });
		}
	} catch {
		// best effort
	}
}

/**
 * Install `tmp` as `target`, replacing it. POSIX `rename` replaces an existing
 * target; on Windows `rename` can fail with EPERM while the target exists
 * (build- and environment-dependent — some setups replace it fine), so on
 * retried. The unlink-then-rename window is race-free: this extension is the
 * only writer and `publish` runs synchronously, so nothing else can create
 * `target` between the two calls — the board viewer is the only reader and its
 * `load()` tolerates a missing file ("projection missing" banner).
 */
export function replaceSync(tmp: string, target: string): void {
	try {
		renameSync(tmp, target);
	} catch {
		try {
			unlinkSync(target);
		} catch {
			// target already gone: the retry below installs tmp
		}
		renameSync(tmp, target);
	}
}

/** A private (0700) runtime directory. Never under agent/, which is synced. */
function makeRuntimeDir(): string {
	const xdg = process.env.XDG_RUNTIME_DIR;
	if (xdg) {
		try {
			const root = join(xdg, "pi-kanban");
			mkdirSync(root, { recursive: true, mode: 0o700 });
			sweepDeadRuntimeDirs(root, "");
			return mkdtempSync(join(root, `${process.pid}-`));
		} catch {
			// fall through to tmpdir
		}
	}
	sweepDeadRuntimeDirs(tmpdir(), "pi-kanban-");
	return mkdtempSync(join(tmpdir(), `pi-kanban-${process.pid}-`));
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export default function kanban(pi: ExtensionAPI) {
	// Spawned subagents keep the simple `todo` list and never get a board.
	if (process.env.PI_SUBAGENT_RUN_ID) return;

	let state: KanbanState = emptyState();
	/** Board states already nudged about, so an ignored reminder is never repeated. */
	const nudged = new Set<string>();
	/** The latest context, for the widget after an async pane attempt. */
	let current: ExtensionContext | undefined;
	/** The widget stands in for the pane: plain terminal, tiny pane, no bun, failed launch. */
	let widgetFallback = false;
	let projectionFailureNotified = false;
	/** Latest list from changed-files.ts, shown in the side pane. */
	let changedFiles: ChangedFileInfo[] = [];
	/** Last pane-live value broadcast, so changed-files is told only on change. */
	let lastPaneLive: boolean | undefined;

	const ownerPaneId = (): string | undefined =>
		process.env.HERDR_ENV === "1" && process.env.HERDR_PANE_ID ? process.env.HERDR_PANE_ID : undefined;

	/** Inside herdr's TUI as the human's orchestrator: the only place a pane is wanted. */
	const paneEligible = (ctx: ExtensionContext): boolean => ctx.mode === "tui" && ctx.hasUI && ownerPaneId() !== undefined;

	const record = (): BoardRecord | undefined => {
		const owner = ownerPaneId();
		return owner ? registry().get(owner) : undefined;
	};

	function reconstruct(ctx: ExtensionContext): void {
		state = reconstructFromEntries(ctx.sessionManager.getBranch() as SessionEntryLike[]);
	}

	const runInfos = () => {
		const ids = linkedRunIds(state);
		return ids.length > 0 ? readRunInfos(agentDir(), ids) : {};
	};

	/** Write the projection the board renders. Synchronous, so writes cannot reorder. */
	function publish(ctx: ExtensionContext): void {
		const rec = record();
		if (!rec?.projectionFile) return;
		rec.seq++;
		const projection = buildProjection({
			seq: rec.seq,
			ownerPid: process.pid,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionName: ctx.sessionManager.getSessionName(),
			leafId: ctx.sessionManager.getLeafId(),
			state,
			changedFiles,
		});
		// One fixed temp name: a single synchronous writer cannot collide with
		// itself, and a crash between write and rename leaves one file, not one per seq.
		const tmp = `${rec.projectionFile}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(projection), { mode: 0o600 });
			replaceSync(tmp, rec.projectionFile);
			projectionFailureNotified = false;
		} catch (err) {
			// The canonical mutation already succeeded; only the view is stale.
			try {
				rmSync(tmp, { force: true });
			} catch {
				// nothing to clean
			}
			if (!projectionFailureNotified && ctx.hasUI) {
				projectionFailureNotified = true;
				ctx.ui.notify(`Kanban side pane could not be updated: ${(err as Error).message}`, "warning");
			}
		}
	}

	/** The compact widget, shown only when there is no pane standing in for it. */
	function refreshWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const live = record()?.paneId !== undefined && !widgetFallback;
		if (live !== lastPaneLive) {
			lastPaneLive = live;
			pi.events?.emit(KANBAN_PANE_EVENT, { live });
		}
		const show = state.cards.length > 0 && (widgetFallback || (!live && !paneEligible(ctx)));
		if (!show) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const snapshot = cloneState(state);
		const runs = runInfos();
		ctx.ui.setWidget(
			WIDGET_KEY,
			// Every line leaves through cachedByWidth → fitLines: an over-wide line kills pi's TUI.
			(_tui, theme) => cachedByWidth((width) => compactLines(snapshot, runs, width, themeStyle(theme))) as Component,
			{ placement: "belowEditor" },
		);
	}

	function afterChange(ctx: ExtensionContext): void {
		publish(ctx);
		refreshWidget(ctx);
	}

	/** Persist the in-memory board if the branch's latest snapshot differs from it. */
	function repair(ctx: ExtensionContext): void {
		const persisted = reconstructFromEntries(ctx.sessionManager.getBranch() as SessionEntryLike[]);
		if (stateDigest(persisted) !== stateDigest(state)) pi.appendEntry(STATE_ENTRY_TYPE, { state: cloneState(state) });
	}

	/** Remove the tool where nobody can see a board: print/json runs (e.g. ralph-loop gates). */
	function deactivateTool(): void {
		if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
		try {
			const active = pi.getActiveTools();
			if (active.includes(TOOL_NAME)) pi.setActiveTools(active.filter((t) => t !== TOOL_NAME));
		} catch {
			// a missing capability must not take the session down
		}
	}

	/**
	 * Open the side pane, or adopt the one already open for this owner pane.
	 *
	 * @param policy - `always`: a new pi session or `/kanban open` — open even if
	 *        the user closed it before. `adopt`: /reload — reuse a live pane,
	 *        and treat a vanished one as closed by the user.
	 */
	async function ensureBoard(ctx: ExtensionContext, policy: "always" | "adopt"): Promise<void> {
		const owner = ownerPaneId();
		if (!owner || !paneEligible(ctx)) return;
		let rec = registry().get(owner);
		if (!rec) {
			rec = { ownerPaneId: owner, opened: false, seq: 0 };
			registry().set(owner, rec);
		}
		// Chain unconditionally: each attempt starts only after the previous one
		// settled, however it ended, so a pane is never split twice concurrently.
		const board = rec;
		const attempt: Promise<void> = (board.opening ?? Promise.resolve())
			.catch(() => undefined)
			.then(() => openOrAdopt(ctx, board, policy));
		const tail = attempt.finally(() => {
			if (board.opening === tail) board.opening = undefined;
		});
		board.opening = tail;
		await attempt;
	}

	async function openOrAdopt(ctx: ExtensionContext, rec: BoardRecord, policy: "always" | "adopt"): Promise<void> {
		// Re-validate a remembered dir: tmpfs cleanup (or a user) may have removed it,
		// and publishing into a missing dir would fail for the rest of the process.
		if (!rec.runtimeDir || !existsSync(rec.runtimeDir)) {
			try {
				rec.runtimeDir = makeRuntimeDir();
				rec.projectionFile = join(rec.runtimeDir, "projection.json");
			} catch (err) {
				fallBack(ctx, `no runtime directory (${(err as Error).message})`);
				return;
			}
			// A board left in a pane reads the old dir: it has exited (its dir is
			// gone), so the pane we remember is not worth adopting.
			if (rec.paneId && (await paneExists(rec.paneId)) !== false && (await isOurBoard(rec.paneId))) await closePane(rec.paneId);
			rec.paneId = undefined;
		}
		publish(ctx);

		if (rec.paneId) {
			const alive = await paneExists(rec.paneId);
			// null = herdr could not be asked: assume alive rather than split a second pane.
			if (alive !== false) {
				widgetFallback = false;
				refreshWidget(ctx);
				return;
			}
			rec.paneId = undefined;
		}
		if (policy === "adopt" && rec.opened) {
			// Closed (q, or the pane was closed) earlier in this process: do not fight the user.
			widgetFallback = false;
			refreshWidget(ctx);
			return;
		}

		const bun = findBun();
		if (!bun) return fallBack(ctx, "bun is not on PATH");
		const rect = await paneRect(rec.ownerPaneId);
		// Unknown size: guessing a split could leave pi too narrow to draw (the
		// failure lib/widget.ts exists for); the widget is the designed degradation.
		if (!rect) return fallBack(ctx, "herdr did not report the pane size");
		const split = decideSplit(rect);
		if (split.kind === "none") return fallBack(ctx, undefined);

		const paneId = await splitPaneOf(rec.ownerPaneId, split.kind, split.ratio, ctx.cwd);
		if (!paneId) return fallBack(ctx, "herdr refused to split the pane");
		await renamePane(paneId, BOARD_LABEL);
		const command = paneCommand(
			[bun.bin, BOARD_SCRIPT, "--file", rec.projectionFile!, "--owner-pid", String(process.pid), "--agent-dir", agentDir()],
			process.platform,
			bun.env,
		);
		const ran = await runInPane(paneId, command);
		if (!ran.ok) {
			await closePane(paneId);
			return fallBack(ctx, `could not start the board (${ran.error ?? "herdr refused"})`);
		}
		rec.paneId = paneId;
		rec.opened = true;
		widgetFallback = false;
		refreshWidget(ctx);

		// `exec` (or `; exit` under PowerShell) makes the pane's lifetime the board's: a pane that is gone a
		// moment later means the board died on startup (missing module, bad bun).
		await delay(LAUNCH_CHECK_MS);
		// Still this process's record and pane? A /new or /kanban close in the
		// meantime owns the outcome now; do not demote a newer session to the widget.
		if (rec.paneId !== paneId || registry().get(rec.ownerPaneId) !== rec) return;
		if ((await paneExists(paneId)) === false && rec.paneId === paneId) {
			rec.paneId = undefined;
			fallBack(current ?? ctx, "the board process exited on startup");
		}
	}

	function fallBack(ctx: ExtensionContext, reason: string | undefined): void {
		widgetFallback = true;
		try {
			refreshWidget(ctx);
			if (reason && ctx.hasUI) ctx.ui.notify(`Kanban side pane unavailable: ${reason}. Showing it below the editor.`, "warning");
		} catch {
			// a context from a replaced session; the next event redraws
		}
	}

	async function closeBoard(ctx: ExtensionContext): Promise<boolean> {
		const rec = record();
		if (!rec?.paneId) return false;
		const paneId = rec.paneId;
		rec.paneId = undefined;
		rec.opened = true;
		if (await isOurBoard(paneId)) await closePane(paneId);
		refreshWidget(ctx);
		return true;
	}

	// -------------------------------------------------------------------------
	// The tool
	// -------------------------------------------------------------------------

	pi.registerTool<typeof KanbanParams, { state?: KanbanState }>({
		name: TOOL_NAME,
		label: "Kanban",
		description:
			"The orchestrator's kanban board, shown to the user in a side panel. Columns: backlog, in_progress, blocked, review, done. " +
			"Ops: add (titles, column?), move (id, column, note?), note (id, note), rename (id, title), link/unlink (id, run_id), " +
			"drop (id), clear_done, show. Cards are addressed by id, so you never resend the board.",
		promptSnippet: "Plan and track multi-step work on the kanban board the user sees beside you (add/move/link/show).",
		promptGuidelines: [
			"For work of two or more non-trivial steps, call kanban op 'add' with one card per step before starting. Skip it for a single step or a trivial request.",
			"Move a card to in_progress when you start it — several may be in progress at once while subagents work in parallel. When you delegate a card, call op 'link' with the run id the subagent tool returned, so the board shows the run's live status.",
			"Move finished work to review while it is being verified (reviewer/verifier runs linked), and to done only once it is genuinely verified, with the evidence in the note. If something is in the way, move it to blocked with a note saying what it waits on; drop cards that turned out not to be needed.",
			"Before you end your turn, every card must be done, blocked with a note, dropped, or waiting on a linked running subagent; otherwise the turn is held open with a reminder.",
			"Do not restate the board in your replies — the user sees it in the side panel. Use op 'show' to re-read it (for example after context compaction). The user may edit it with /kanban; follow their changes.",
		],
		parameters: KanbanParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			current = ctx;
			const p = params as KanbanParamsType;
			// Everything up to the return is synchronous: parallel calls in one
			// message apply in call order to the one in-memory board.
			if (p.op === "show") {
				return { content: [{ type: "text", text: formatCardList(state, runInfos()) }], details: { state: cloneState(state) } };
			}
			let op: KanbanOp;
			let next: KanbanState;
			const before = state;
			try {
				op = opFromParams(p);
				next = applyOp(state, op);
			} catch (err) {
				if (err instanceof KanbanError) {
					return { content: [{ type: "text", text: err.message }], details: {}, isError: true };
				}
				throw err;
			}
			state = next;
			afterChange(ctx);
			return {
				content: [{ type: "text", text: `${describeOp(before, next, op)} ${summarize(next)}` }],
				details: { state: cloneState(next) },
			};
		},
	});

	// -------------------------------------------------------------------------
	// /kanban
	// -------------------------------------------------------------------------

	pi.registerCommand("kanban", {
		description: "Reopen the kanban side pane (or list the cards); add/move/… edit it, open/close/restart the pane",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			const items = KANBAN_SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			current = ctx;
			const cmd = parseCommand(args);
			switch (cmd.kind) {
				case "default": {
					// Bare /kanban is what someone types to get the board back after
					// closing it (q, /kanban close, or herdr's own pane close), so it
					// reopens a closed pane; with the pane up it lists the cards.
					const rec = record();
					const live = rec?.paneId !== undefined && (await paneExists(rec.paneId)) !== false;
					if (paneEligible(ctx) && !live) {
						await ensureBoard(ctx, "always");
						return;
					}
					ctx.ui.notify(formatCardList(state, runInfos()), "info");
					return;
				}
				case "show":
					ctx.ui.notify(formatCardList(state, runInfos()), "info");
					return;
				case "help":
					ctx.ui.notify(KANBAN_USAGE, "info");
					return;
				case "error":
					ctx.ui.notify(cmd.message, "error");
					return;
				case "open":
					if (!paneEligible(ctx)) {
						widgetFallback = false;
						refreshWidget(ctx);
						ctx.ui.notify("The side pane needs pi running inside herdr's TUI; the board is shown below the editor instead.", "info");
						return;
					}
					await ensureBoard(ctx, "always");
					return;
				case "close":
					if (!(await closeBoard(ctx))) ctx.ui.notify("The kanban side pane is not open.", "info");
					return;
				case "restart":
					// A fresh board process: how an edit to board.ts takes effect
					// without restarting pi (/reload reloads this module, not the pane).
					if (!paneEligible(ctx)) {
						ctx.ui.notify("The side pane needs pi running inside herdr's TUI.", "info");
						return;
					}
					await closeBoard(ctx);
					await ensureBoard(ctx, "always");
					return;
				case "op": {
					const before = state;
					let next: KanbanState;
					try {
						next = applyOp(state, cmd.op);
					} catch (err) {
						if (err instanceof KanbanError) {
							ctx.ui.notify(err.message, "error");
							return;
						}
						throw err;
					}
					state = next;
					// Idle: persist now. Streaming: a tool batch may be in flight whose
					// results (persisted only after the batch) were computed before this
					// edit, and an entry written now would sit *before* them in the branch.
					// The turn_end/agent_settled repair persists the merged state after them.
					if (ctx.isIdle()) pi.appendEntry(STATE_ENTRY_TYPE, { state: cloneState(next) });
					afterChange(ctx);
					// Tell the model: the snapshot entry is invisible to it by design.
					pi.sendMessage(
						{
							customType: "kanban-user-edit",
							content: `The user edited the kanban board: ${describeOp(before, next, cmd.op)} Board now: ${summarize(next)}.`,
							display: true,
						},
						{ triggerTurn: false },
					);
					return;
				}
			}
		},
	});

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	pi.events?.on(CHANGED_FILES_EVENT, (data) => {
		changedFiles = parseChangedFiles(data) ?? [];
		if (current) {
			try {
				publish(current);
			} catch {
				// a context from a replaced session; the next event republishes
			}
		}
	});
	// A child's todo list moved (or a run's state changed, via the liveness tick):
	// re-read the run infos and re-render. The read is cheap (size/mtime-stamped
	// cache, bounded tail), so the event carries no payload.
	//
	// `refreshWidget` only — no `publish`: the board pane polls the runs itself
	// (`board.ts` re-reads `readRunInfos` on every projection refresh), so a
	// projection write here would bump the seq for a board that re-reads on its
	// own cadence anyway. The widget, by contrast, renders its runs inline and
	// only learns of the change here.
	pi.events?.on(RUN_TODOS_EVENT, () => {
		if (current) {
			try {
				refreshWidget(current);
			} catch {
				// a context from a replaced session; the next event redraws
			}
		}
	});
	// changed-files may ask (e.g. after a /reload) whether the pane is showing its list.
	pi.events?.on(`${KANBAN_PANE_EVENT}:query`, () => {
		if (lastPaneLive !== undefined) pi.events?.emit(KANBAN_PANE_EVENT, { live: lastPaneLive });
	});

	pi.on("session_start", async (event, ctx) => {
		current = ctx;
		reconstruct(ctx);
		nudged.clear();
		if (!ctx.hasUI) {
			deactivateTool();
			return;
		}
		widgetFallback = false;
		// changed-files may have broadcast before `current` was set; ask again.
		pi.events?.emit(`${CHANGED_FILES_EVENT.split(":")[0]}:query`, undefined);
		if (paneEligible(ctx)) {
			// Fire and forget: herdr round-trips must not delay pi's first frame.
			void ensureBoard(ctx, event.reason === "reload" ? "adopt" : "always").catch(() => fallBack(ctx, undefined));
		}
		refreshWidget(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		current = ctx;
		reconstruct(ctx);
		// A rewind can land on a state already nudged about; let the guard re-arm.
		nudged.clear();
		afterChange(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		// The batch's tool results are persisted by now (agent-loop emits turn_end
		// after them): make sure the branch's latest snapshot is what we hold.
		repair(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		current = ctx;
		repair(ctx);
		refreshWidget(ctx);
	});

	/**
	 * The guard: refuse to let the orchestrator stop while cards are unaccounted
	 * for. Same contract as the todo guard it replaces — `custom_message` draft +
	 * `continue: true`, once per board state, only on a completed run, and never
	 * gated on `context.canContinue` (it reads false at handler time; see
	 * agent/extensions/AGENTS.md). Stands down while the active persona denies the
	 * `kanban` tool: a profile that withholds the board withholds its enforcement
	 * with it, so an unaccounted board no longer holds the turn open.
	 */
	pi.on("agent_before_settle", async (event) => {
		if (event.outcome !== "completed") return;
		if (personaDenies(TOOL_NAME)) return;
		const nudge = nudgeFor(state, runInfos());
		if (!nudge || nudged.has(nudge.signature)) return;
		nudged.add(nudge.signature);
		return {
			entries: [
				...event.entries,
				{ type: "custom_message" as const, customType: "kanban-reminder", content: nudge.text, display: true },
			],
			continue: true,
		};
	});

	pi.on("session_shutdown", async (event, ctx) => {
		// Repair only where the session outlives this handler. /new, /resume and
		// /fork dispose it a statement later, and appending there would write into
		// the branch the user just left (on /fork, the one forked *from*); turn_end
		// and agent_settled already persisted every mutation that ran.
		if (event.reason === "quit" || event.reason === "reload") repair(ctx);
		// Not quitting: the next session_start in this process adopts the pane
		// and the runtime dir (re-validated there), so keep both.
		if (event.reason !== "quit") return;
		const owner = ownerPaneId();
		const rec = owner ? registry().get(owner) : undefined;
		if (!rec) return;
		registry().delete(rec.ownerPaneId);
		// Removing the runtime dir alone makes the board exit (it polls for it);
		// closing the pane as well makes it immediate.
		if (rec.runtimeDir) {
			try {
				rmSync(rec.runtimeDir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		}
		if (rec.paneId && (await isOurBoard(rec.paneId, QUIT_CLOSE_TIMEOUT_MS))) await closePane(rec.paneId, QUIT_CLOSE_TIMEOUT_MS);
	});
}
