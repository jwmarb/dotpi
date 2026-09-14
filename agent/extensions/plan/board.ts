#!/usr/bin/env bun
/**
 * Board — the kanban view of a Plan, drawn in its own herdr Pane.
 *
 * A standalone process, not part of the pi extension host: it is spawned into a
 * herdr pane by the plan extension and watches one plan file (docs/adr/0015).
 * The columns *are* the Plan Item states (docs/adr/0018), so a card's column is
 * never stored separately from its status.
 *
 * Read-only for now. ADR 0015 permits this process to write the plan file
 * directly under the shared lock, but card *movement* is not yet implemented —
 * see the writer stub at the end of this file.
 *
 * Usage: board.ts <plan-file>
 *
 * @module board
 */

import { watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

/** Item states, mirroring plan/index.ts. */
type PlanState =
	| "pending"
	| "backlog"
	| "ready"
	| "active"
	| "blocked"
	| "review"
	| "done"
	| "failed"
	| "dropped";

interface PlanItem {
	id: string;
	text: string;
	status: PlanState;
	note?: string;
	taskId?: string;
	/** Who may clear this item; absent means `user` (docs/adr/0023, 0024). */
	route?: "user" | "oracle" | "skip";
}

/**
 * Per-route card glyph.
 *
 * Shown in every column, not only `review`, so a `skip` is visible while the
 * item is still being groomed — early enough for the user to object before the
 * work is done (docs/adr/0024).
 *
 * `user` deliberately has no glyph: it is the default and the overwhelming
 * majority, so marking it would add noise to every card to say "nothing
 * unusual". The glyphs flag the two routes that clear *without* the user.
 */
const ROUTE_GLYPH: Record<string, string> = {
	oracle: "◇",
	skip: "⇢",
};

/**
 * The Board's columns, in order.
 *
 * Kept in sync with `BOARD_COLUMNS` in plan/index.ts by hand: this process is
 * deliberately dependency-free so it can run in a bare pane, which rules out
 * importing the extension (it would pull in the whole pi host).
 */
const COLUMNS: readonly PlanState[] = [
	"backlog",
	"ready",
	"active",
	"blocked",
	"review",
	"done",
];

/** Terminal outcomes, shown as a footer rather than as columns. */
const OUTCOMES: readonly PlanState[] = ["failed", "dropped"];

const GLYPH: Record<PlanState, string> = {
	pending: "·",
	backlog: "·",
	ready: "○",
	active: "▸",
	blocked: "⊗",
	review: "?",
	done: "✓",
	failed: "✗",
	dropped: "⊘",
};

/** 256-colour codes, chosen to survive on both light and dark terminals. */
const COLOR: Record<PlanState, string> = {
	pending: "244",
	backlog: "244",
	ready: "252",
	active: "45",
	blocked: "203",
	review: "221",
	done: "78",
	failed: "203",
	dropped: "240",
};

const HEADING: Record<PlanState, string> = {
	pending: "backlog",
	backlog: "backlog",
	ready: "ready",
	active: "active",
	blocked: "blocked",
	review: "review · awaiting a reviewer",
	done: "done · accepted",
	failed: "failed",
	dropped: "dropped",
};

/**
 * Assistant stop reasons that actually END a Run.
 *
 * `toolUse` is deliberately absent: it is the stop reason of every intermediate
 * tool call, so treating it as terminal reports a working Run as finished. Real
 * sessions here contain exactly three values — `toolUse` (234), `error` (41) and
 * `stop` (13) — plus `aborted`, which the cancel path stamps on a Run it killed.
 */
const TERMINAL_STOP_REASONS: readonly string[] = ["stop", "error", "aborted"];

const ESC = "\x1b";
const fg = (code: string, s: string) => `${ESC}[38;5;${code}m${s}${ESC}[0m`;
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;
const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`;

/** Collapse the legacy `pending` alias onto its modern column. */
function canonical(status: string): PlanState {
	if (status === "pending") return "backlog";
	return (GLYPH as Record<string, string>)[status]
		? (status as PlanState)
		: // A state this build does not know comes from a newer writer. Show it in
			// backlog rather than dropping the card: losing a step is worse than
			// misfiling it.
			"backlog";
}

/**
 * Live progress of the subagent Task attached to a Plan Item.
 *
 * Read from the Run's session directory, not from the plan file: the plan
 * records which Task owns an Item, and the Run's own session records how far it
 * has got (docs/adr/0026).
 */
interface RunProgress {
	agent: string;
	turns: number;
	finished: boolean;
}

/**
 * Read a Task's progress by inspecting its Runs' session directories.
 *
 * A Task ID maps to one or more Run directories (`<taskId>-1`, `-2`, ...), so
 * the reported turn count is the sum across the Task's Runs and the agent name
 * comes from the first. Everything is best-effort: the Board must render a card
 * whether or not the Run left anything readable behind.
 *
 * @param agentDir - The pi agent directory holding `subagent-sessions`.
 * @param taskId - The Task ID recorded on the Plan Item.
 * @returns Progress, or null when nothing about this Task is on disk yet.
 */
async function readRunProgress(
	agentDir: string,
	taskId: string,
): Promise<RunProgress | null> {
	const root = path.join(agentDir, "subagent-sessions");
	let dirs: string[];
	try {
		dirs = (await readdir(root)).filter(
			(d) => d === taskId || d.startsWith(`${taskId}-`),
		);
	} catch {
		return null;
	}
	if (!dirs.length) return null;

	let agent = "";
	let turns = 0;
	// A Task is finished only when every one of its Runs is: a parallel Task with
	// one Run still working is still working.
	let unfinished = 0;
	for (const dir of dirs.sort()) {
		const runDir = path.join(root, dir);
		// The sidecar's outcome, when terminal, is the parent's record of the
		// Run's lifecycle and wins over the session scan: a dismissed Run (its
		// pane closed mid-Run, docs/adr/0044) never settles, so the session
		// alone would keep reporting it in flight.
		let outcome: string | undefined;
		try {
			const meta = JSON.parse(
				await readFile(path.join(runDir, "run.json"), "utf-8"),
			) as { agent?: unknown; outcome?: unknown };
			if (!agent && typeof meta.agent === "string") agent = meta.agent;
			if (typeof meta.outcome === "string") outcome = meta.outcome;
		} catch {
			// Older Runs predate the sidecar; the session scan still works.
		}
		const finished =
			outcome === "completed" ||
			outcome === "failed" ||
			outcome === "dismissed";
		try {
			const names = (await readdir(runDir))
				.filter((n) => n.endsWith(".jsonl"))
				.sort();
			if (!names.length) {
				// A terminal outcome settles a Run with no transcript; nothing else does.
				if (!finished) unfinished++;
				continue;
			}
			const raw = await readFile(
				path.join(runDir, names[names.length - 1]),
				"utf-8",
			);
			// The Run's state is its LAST assistant stop reason, and "toolUse" is
			// not terminal. Treating any truthy stopReason as finished called a
			// 9-turn Run finished at turn 1 — a real oracle session runs
			// toolUse x5, error x3, stop — which also cleared tasksInFlight and
			// stopped the poll while the Run was still working (docs/adr/0033).
			let lastStopReason: string | undefined;
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					const entry = JSON.parse(line) as {
						type?: string;
						message?: { role?: string; stopReason?: string };
					};
					if (entry.type !== "message" || entry.message?.role !== "assistant")
						continue;
					turns++;
					// Overwritten unconditionally: a final message with no stop reason
					// means the Run never settled, even if an earlier one did.
					lastStopReason = entry.message.stopReason;
				} catch {
					// The child appends as it goes: the last line can be half-written.
				}
			}
			// Only a settled outcome finishes a Run. "toolUse" means the child is
			// mid-turn, and an absent stop reason means it never settled at all.
			// A terminal outcome in run.json overrides this session derivation:
			// it is the parent's word, and the session cannot express a dismissal
			// (docs/adr/0036 promoted run.json to real state; docs/adr/0044 adds
			// the dismissed case).
			if (
				!finished &&
				(lastStopReason === undefined ||
					!TERMINAL_STOP_REASONS.includes(lastStopReason))
			)
				unfinished++;
		} catch {
			// A Run must never be *assumed* finished: a directory that is briefly
			// unreadable, removed mid-scan, or fails to read counts as unfinished,
			// because its terminal state was never positively established — unless
			// the sidecar already recorded one (docs/adr/0036).
			if (!finished) unfinished++;
		}
	}
	return { agent, turns, finished: unfinished === 0 };
}

/**
 * Read and parse the plan file.
 *
 * A corrupt line is skipped, never fatal — the Board must keep rendering even
 * while another writer is mid-rewrite.
 */
/**
 * Whether the plan is in Autonomous Mode, read from its plan-meta line.
 *
 * Module-level because `render` needs it but the Board's load returns items
 * only; it is refreshed on every load, so a mode change shows on the next draw.
 */
let autonomous = false;

async function load(file: string): Promise<PlanItem[]> {
	let raw: string;
	try {
		raw = await readFile(file, "utf-8");
	} catch {
		return [];
	}
	const items: PlanItem[] = [];
	// Recomputed per load so turning the mode off clears the banner.
	autonomous = false;
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line) as Partial<PlanItem> & {
				kind?: unknown;
				autonomous?: unknown;
			};
			// The plan-meta line carries per-plan settings, not an item.
			if (obj.kind === "plan-meta") {
				autonomous = obj.autonomous === true;
				continue;
			}
			if (
				typeof obj.id === "string" &&
				typeof obj.text === "string" &&
				typeof obj.status === "string"
			)
				items.push({
					id: obj.id,
					text: obj.text,
					status: canonical(obj.status),
					note: typeof obj.note === "string" ? obj.note : undefined,
					taskId: typeof obj.taskId === "string" ? obj.taskId : undefined,
					// Unknown routes are dropped, matching the tool: a route this build
					// does not know must not be rendered as though it were understood.
					route:
						obj.route === "user" ||
						obj.route === "oracle" ||
						obj.route === "skip"
							? obj.route
							: undefined,
				});
		} catch {
			// Mid-write or corrupt: skip this line.
		}
	}
	return items;
}

/** Wrap text to a width, breaking on spaces where possible. */
function wrap(text: string, width: number): string[] {
	if (width < 8) return [text];
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let cur = "";
	for (const w of words) {
		if (!cur) cur = w;
		else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
		else {
			lines.push(cur);
			cur = w;
		}
	}
	if (cur) lines.push(cur);
	return lines;
}

/** Render the whole board as a string. */
function render(
	items: PlanItem[],
	file: string,
	cols: number,
	archived = false,
	progress: Map<string, RunProgress> = new Map(),
): string {
	const out: string[] = [];
	const width = Math.max(28, Math.min(cols, 100));

	const byState = (s: PlanState) => items.filter((i) => i.status === s);
	const dropped = byState("dropped").length;
	const doneCount = byState("done").length;
	const tracked = items.length - dropped;
	const accent = archived ? "78" : "212";

	out.push(
		bold(fg(accent, `╭─ ${archived ? "Board · complete" : "Board"}`)) +
			dim(`  ${path.basename(file)}`),
	);
	out.push(
		bold(fg(accent, "│ ")) +
			(archived
				? fg("78", `all ${tracked} accepted — archived`)
				: dim(`${doneCount}/${tracked} accepted`)) +
			// Counts only what genuinely needs the user: an oracle-routed Item in
			// review is waiting on a machine, and claiming it needs you would make the
			// number meaningless in Autonomous Mode.
			(byState("review").filter((i) => (i.route ?? "user") === "user").length
				? fg(
						"221",
						`  ${
							byState("review").filter((i) => (i.route ?? "user") === "user")
								.length
						} awaiting you`,
					)
				: "") +
			// Autonomous Mode is shown on the Board because it changes who clears
			// work without asking; a mode you cannot see is a mode you forget is on.
			(autonomous ? fg("213", "  ◇ autonomous") : ""),
	);
	out.push(bold(fg(accent, "╰─")));
	out.push("");

	if (items.length === 0) {
		out.push(dim("  No plan yet."));
		out.push(dim("  Items appear here as the agent adds them."));
		return out.join("\n");
	}

	for (const col of COLUMNS) {
		const inCol = byState(col);
		const c = COLOR[col];
		out.push(
			`  ${fg(c, GLYPH[col])} ${fg(c, HEADING[col].padEnd(20))}${dim(`(${inCol.length})`)}`,
		);
		if (inCol.length === 0) {
			out.push(dim("      —"));
		} else {
			for (const item of inCol) {
				const lines = wrap(item.text, width - 10);
				// The route glyph rides between the state glyph and the id, so the
				// column tells you where the work is and the glyph who will clear it.
				const routeMark = item.route ? ROUTE_GLYPH[item.route] : undefined;
				// The whole text is the card's title: every wrapped line keeps
				// title styling, so a long or multi-line title is never half-dimmed
				// (docs/adr/0043).
				const title = (s: string) => (col === "active" ? bold(fg(c, s)) : s);
				out.push(
					`      ${fg(c, GLYPH[col])} ${
						routeMark ? `${fg("221", routeMark)} ` : ""
					}${dim(item.id)} ${title(lines[0])}`,
				);
				for (const extra of lines.slice(1)) out.push(`         ${title(extra)}`);
				// A card with a Task shows that Task's live progress: which specialist
				// is on it and how far it has got. The Task ID alone tells the user
				// nothing about whether anything is happening (docs/adr/0026).
				if (item.taskId) {
					const p = progress.get(item.taskId);
					const detail = p
						? `${p.agent || "subagent"} · ${p.turns} turn${p.turns === 1 ? "" : "s"}${p.finished ? "" : " …"}`
						: "waiting to start";
					out.push(
						`         ${fg("221", `[${item.taskId}]`)} ${dim(detail)}`,
					);
				}
				if (item.note)
					for (const nl of wrap(item.note, width - 14))
						out.push(`         ${dim(`· ${nl}`)}`);
			}
		}
		out.push("");
	}

	const outcomes = OUTCOMES.filter((s) => byState(s).length > 0);
	if (outcomes.length) {
		out.push(dim("  ─── outcomes ───"));
		for (const s of outcomes) {
			for (const item of byState(s))
				out.push(
					`  ${fg(COLOR[s], GLYPH[s])} ${dim(item.id)} ${dim(item.text)}`,
				);
		}
		out.push("");
	}

	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const file = process.argv[2];
if (!file) {
	console.error("usage: board.ts <plan-file>");
	process.exit(2);
}

/**
 * Find the archived form of a plan whose live file is gone.
 *
 * A completed plan self-archives, so the live path stops existing at the exact
 * moment the work finishes. Showing "No plan yet" then is actively misleading:
 * it reads as though the work vanished rather than completed. The archive is
 * named `<date>-<key>.jsonl`, optionally with a `.2`, `.3` collision suffix, so
 * the newest match for this plan's key is the one just archived.
 *
 * @param file - The (now absent) live plan file path.
 * @returns Newest archived file for the same plan key, or null.
 */
async function findArchived(file: string): Promise<string | null> {
	const dir = path.dirname(file);
	const key = path.basename(file, ".jsonl");
	const archiveDir = path.join(dir, "archive");
	try {
		const names = await readdir(archiveDir);
		const mine = names.filter(
			(n) => n.includes(key) && n.endsWith(".jsonl"),
		);
		if (!mine.length) return null;
		// Pick by mtime rather than by name: the collision suffix (.2, .3) does not
		// sort lexicographically in recency order.
		let newest: { name: string; at: number } | null = null;
		for (const n of mine) {
			try {
				const info = await stat(path.join(archiveDir, n));
				if (!newest || info.mtimeMs > newest.at)
					newest = { name: n, at: info.mtimeMs };
			} catch {
				// Skip unreadable entries.
			}
		}
		return newest ? path.join(archiveDir, newest.name) : null;
	} catch {
		return null;
	}
}

/**
 * Whether any Task on the board is still working.
 *
 * Set by each redraw and read by the poll loop: an unfinished Task means the
 * next tick must redraw even if the plan file has not changed, because progress
 * lives in the Runs' session files (docs/adr/0026).
 */
let tasksInFlight = false;

/**
 * First rendered line shown at the top of the pane.
 *
 * A long plan renders taller than any pane — a 23-item plan is ~140 lines — so
 * the Board keeps a scroll offset rather than clipping to the newest content the
 * way a log would. The alternate screen means the terminal's own wheel is
 * unavailable, so the keys below are the only way to move (docs/adr/0031).
 */
let scroll = 0;
/** Largest useful `scroll`, recomputed each draw from the frame and pane height. */
let maxScroll = 0;

/**
 * Redraw, clearing the screen and homing the cursor.
 */
async function draw(): Promise<void> {
	let items = await load(file);
	let shownFile = file;
	let archived = false;

	// The live plan is gone: it either never existed, or it just completed and
	// archived itself. Prefer showing the finished board over an empty one.
	if (items.length === 0) {
		const archive = await findArchived(file);
		if (archive) {
			const archivedItems = await load(archive);
			if (archivedItems.length > 0) {
				items = archivedItems;
				shownFile = archive;
				archived = true;
			}
		}
	}

	// Gather live progress for every Task on the board. Failures are per-Task and
	// already swallowed, so a missing Run just renders as "waiting to start".
	const progress = new Map<string, RunProgress>();
	const agentDir = path.resolve(path.dirname(file), "..");
	await Promise.all(
		[...new Set(items.map((i) => i.taskId).filter((t): t is string => !!t))].map(
			async (taskId) => {
				const p = await readRunProgress(agentDir, taskId);
				if (p) progress.set(taskId, p);
			},
		),
	);
	tasksInFlight = [...progress.values()].some((p) => !p.finished);

	const cols = process.stdout.columns ?? 80;
	const rows = process.stdout.rows ?? 40;

	// Render the whole board, then show the slice that fits.
	//
	// The Board runs on the alternate screen (see the entry code at the bottom),
	// so clearing here can never touch the pane's real scrollback — which is why
	// `3J` is neither needed nor wanted (docs/adr/0031). Home-and-clear alone was
	// not enough on the normal screen: a frame taller than the pane scrolls the
	// buffer, `2J` only clears the viewport, and the scrolled-off remains stacked
	// up behind each new frame.
	const full = render(items, shownFile, cols, archived, progress).split("\n");
	const footer = archived
		? "  archived · a new plan will appear here"
		: "  watching · ↑↓/PgUp/PgDn to scroll · ctrl+c to close";

	// One row for the footer, one spare so the last line never sits under it.
	const room = Math.max(1, rows - 2);
	maxScroll = Math.max(0, full.length - room);
	if (scroll > maxScroll) scroll = maxScroll;
	const shown = full.slice(scroll, scroll + room);

	const more =
		maxScroll > 0
			? dim(`  [${scroll + 1}-${scroll + shown.length}/${full.length}]`)
			: "";

	process.stdout.write(`${ESC}[H${ESC}[2J`);
	process.stdout.write(shown.join("\n"));
	process.stdout.write(`\n${dim(footer)}${more}\n`);
}

/** Coalesce bursts of fs events into one redraw. */
let pending: ReturnType<typeof setTimeout> | undefined;
/** True while a draw is in flight; a second draw must not interleave with it. */
let drawing = false;
/** Set when a draw was requested while one was already running. */
let redrawRequested = false;

/**
 * Run one draw at a time, and never let a rejected draw escape.
 *
 * `draw` awaits filesystem reads partway through, so an fs event, a resize, a
 * keypress or the poll tick could start a second draw while the first is
 * suspended. Both then commit `maxScroll` and `tasksInFlight`, and whichever
 * finishes last wins — so an older draw could publish stale scroll bounds or
 * stop the poll while a Task is still running (docs/adr/0036).
 *
 * Catching here also matters more than it looks: a `void draw()` rejection
 * reaches neither `uncaughtException` nor any caller, so a failing draw would
 * silently freeze the Board rather than restore the terminal and exit.
 */
async function drawOnce(): Promise<void> {
	if (drawing) {
		redrawRequested = true;
		return;
	}
	drawing = true;
	try {
		await draw();
		// Coalesce everything requested during the draw into a single follow-up.
		while (redrawRequested) {
			redrawRequested = false;
			await draw();
		}
	} catch (err) {
		restoreScreen();
		console.error(err);
		process.exit(1);
	} finally {
		drawing = false;
	}
}

function scheduleDraw(): void {
	if (pending) clearTimeout(pending);
	pending = setTimeout(() => {
		pending = undefined;
		void drawOnce();
	}, 60);
}

/**
 * Restore the terminal: leave raw mode, show the cursor, leave the alternate
 * screen.
 *
 * Must run on every exit path, or the pane is left on a blank alternate buffer
 * with a hidden cursor and the user's shell appears dead. Leaving *raw mode* is
 * just as load-bearing and was missed at first: the pane's shell inherits the
 * PTY, so a raw-mode exit leaves it with no echo and no line editing — the shell
 * looks broken even though the Board is gone (docs/adr/0031).
 *
 * Idempotent: several exit paths can fire (a signal handler *and* `exit`), and
 * writing to a closed stdout must not throw from inside a handler.
 */
let restored = false;
function restoreScreen(): void {
	if (restored) return;
	restored = true;
	try {
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
			process.stdin.pause();
		}
	} catch {
		// stdin may already be torn down; the screen restore below still matters.
	}
	try {
		process.stdout.write(`${ESC}[?25h${ESC}[?1049l`);
	} catch {
		// Nothing left to restore to.
	}
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
	process.on(sig, () => {
		restoreScreen();
		process.exit(0);
	});
process.on("exit", restoreScreen);
// A crash must not strand the pane on the alternate screen either.
process.on("uncaughtException", (err) => {
	restoreScreen();
	console.error(err);
	process.exit(1);
});
// `void draw()` means a rejected draw never reaches `uncaughtException`, so the
// terminal would be stranded by the one failure mode most likely to happen.
process.on("unhandledRejection", (err) => {
	restoreScreen();
	console.error(err);
	process.exit(1);
});

/**
 * Scroll keys.
 *
 * The Board owns a full frame that is usually taller than the pane, and the
 * alternate screen means the terminal's own wheel and scrollback do not apply
 * (docs/adr/0031) — so movement has to be explicit. Raw mode is required to see
 * individual keypresses; without it stdin stays line-buffered and nothing
 * arrives until Enter.
 */
if (process.stdin.isTTY) {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (key: string) => {
		const page = Math.max(1, (process.stdout.rows ?? 40) - 3);
		const before = scroll;
		switch (key) {
			case "\x03": // ctrl+c: raw mode swallows the signal, so handle it here
				restoreScreen();
				process.exit(0);
			case "\x1b[A": // up
			case "k":
				scroll = Math.max(0, scroll - 1);
				break;
			case "\x1b[B": // down
			case "j":
				scroll = Math.min(maxScroll, scroll + 1);
				break;
			case "\x1b[5~": // page up
				scroll = Math.max(0, scroll - page);
				break;
			case "\x1b[6~": // page down
				scroll = Math.min(maxScroll, scroll + page);
				break;
			case "g":
			case "\x1b[H": // home
				scroll = 0;
				break;
			case "G":
			case "\x1b[F": // end
				scroll = maxScroll;
				break;
			default:
				return;
		}
		if (scroll !== before) scheduleDraw();
	});
}

/**
 * Enter the alternate screen and hide the cursor.
 *
 * Separate from the escape write so ordering is explicit: the cleanup handlers
 * above are already installed by the time this runs, so a failure between here
 * and the first frame still restores the terminal.
 */
function enterAltScreen(): void {
	process.stdout.write(`${ESC}[?1049h${ESC}[?25l`);
}

// Enter the alternate screen BEFORE the first frame is drawn. Drawing first was
// the bug ADR 0031 was meant to fix: a 141-line frame rendered on the normal
// screen scrolls the pane's real scrollback exactly once, then the process
// switches to a blank alternate screen and waits up to 2s to redraw there.
// The alternate screen is what makes a full-frame redraw safe — it is a separate
// buffer, so no frame can scroll real history and no clear can destroy it.
// Cleanup handlers are installed by enterAltScreen() *before* the escape is
// written, so any failure from here on still restores the terminal.
enterAltScreen();

await drawOnce();

// Watch the *directory*, not the file: the plan is replaced by atomic rename,
// which breaks a watch bound to the original inode. The directory sees the
// rename regardless.
const dir = path.dirname(file);
const base = path.basename(file);
try {
	watch(dir, (_event, changed) => {
		if (!changed || changed === base || changed.startsWith(base))
			scheduleDraw();
	});
} catch {
	// No inotify: fall back to polling below.
}

// Belt and braces: a slow poll catches anything the watcher misses (network
// filesystems, editors that write via a temp dir, an archived plan vanishing).
//
// The poll also carries live Task progress. A Run writes its own session file
// and never touches the plan, so watching the plan alone would leave turn
// counts frozen while a subagent works (docs/adr/0026): whenever any Task is
// unfinished, redraw on the tick regardless of the plan's own mtime.
let lastStamp = "";
setInterval(() => {
	void (async () => {
		if (tasksInFlight) {
			scheduleDraw();
			return;
		}
		try {
			const info = await stat(file);
			const stamp = `${info.mtimeMs}:${info.size}`;
			if (stamp !== lastStamp) {
				lastStamp = stamp;
				scheduleDraw();
			}
		} catch {
			// File gone (archived): redraw once to show the empty state.
			if (lastStamp !== "gone") {
				lastStamp = "gone";
				scheduleDraw();
			}
		}
	})();
}, 2000);

process.stdout.on("resize", scheduleDraw);


// ---------------------------------------------------------------------------
// Writer (not yet implemented)
// ---------------------------------------------------------------------------

/**
 * ADR 0015 grants this process the right to write the plan file directly, under
 * the same lock and schema rules the plan tool uses, so a user can move a card
 * by hand. That is deliberately not implemented yet: the lock protocol and its
 * stale-breaking rules would have to be duplicated here, which is precisely the
 * drift ADR 0015 names as its own cost. Until a card can actually be dragged,
 * the Board stays a pure projection and there is nothing to duplicate.
 */
