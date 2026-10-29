/**
 * kanban — pure logic for the orchestrator's kanban board.
 *
 * No pi-coding-agent import and no filesystem access: this module is imported by
 * the extension (`index.ts`, loaded by pi through jiti), by the standalone board
 * process (`board.ts`, run by bun in a herdr pane) and by `lib.test.ts`. The only
 * runtime dependency is `@earendil-works/pi-tui`'s width helpers, which resolve
 * through this directory's `tsconfig.json` `paths` in all three.
 *
 * DESIGN (decided with the oracle; see agent/extensions/AGENTS.md)
 *
 * 1. **One writer.** Canonical state is a full snapshot recorded in the session
 *    branch — a `kanban` tool result's `details.state`, or a `custom` entry of
 *    type `kanban-state` written by `/kanban`. `reconstructFromEntries` replays
 *    the branch; there is no state file. The board pane process only *reads* a
 *    disposable projection (`KanbanProjection`) the extension writes. That is
 *    the difference from the deleted `plan` extension, whose board was a second
 *    writer of a plan file and needed a lock that could still lose updates.
 * 2. **Op-based, id-addressed mutation** (same reason as `lib/todo.ts`): an
 *    omitted card cannot be destroyed by a partial rewrite.
 * 3. **Refuse rather than repair.** `applyOp` throws `KanbanError`; a refused op
 *    is visible and retryable, a silently adjusted one teaches a rule that does
 *    not exist.
 * 4. **No WIP limit.** The orchestrator runs subagents in parallel, so several
 *    cards may be in progress at once — the opposite of todo's one-in-flight rule.
 * 5. **Run status is advisory.** A card may link subagent run ids; their status
 *    is shown and feeds the settle guard, but never moves a card. A finished
 *    child means "evidence is available", not "the parent verified it".
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { RunStatus } from "../subagent-herdr/rundir.js";

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export const KANBAN_SCHEMA_VERSION = 1 as const;
export const TOOL_NAME = "kanban";
/** `customType` of the snapshot entries `/kanban` appends. */
export const STATE_ENTRY_TYPE = "kanban-state";

export const KANBAN_COLUMNS = ["backlog", "in_progress", "blocked", "review", "done"] as const;
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];

export const COLUMN_LABEL: Record<KanbanColumn, string> = {
	backlog: "Backlog",
	in_progress: "In progress",
	blocked: "Blocked",
	review: "Review",
	done: "Done",
};

export const COLUMN_GLYPH: Record<KanbanColumn, string> = {
	backlog: "○",
	in_progress: "◐",
	blocked: "▲",
	review: "◇",
	done: "●",
};

export interface KanbanCard {
	/** `k1`-style, never reused (see `nextId`). */
	id: string;
	title: string;
	column: KanbanColumn;
	/** Why it is blocked, what the review found, or how done was confirmed. */
	note?: string;
	/** Linked subagent run ids (`sub-a3f1`), deduplicated, in link order. */
	runIds?: string[];
}

export interface KanbanState {
	schemaVersion: typeof KANBAN_SCHEMA_VERSION;
	cards: KanbanCard[];
	/** Monotonic id counter; survives deletion so ids are never recycled. */
	nextId: number;
	/** +1 per successful mutation. Diagnostic; equal revisions may still differ. */
	revision: number;
}

export const emptyState = (): KanbanState => ({
	schemaVersion: KANBAN_SCHEMA_VERSION,
	cards: [],
	nextId: 1,
	revision: 0,
});

/** The run-id shape `subagent-herdr`'s `makeRunId` mints. Strict: it is joined into a path. */
export const RUN_ID_PATTERN = /^sub-[0-9a-f]{4}$/;
/**
 * The kanban card id shape (`k3`): `k` plus a positive integer, no leading zero.
 * The canonical mint — `subagent-herdr/rundir.ts` keeps its own copy because
 * siblings stay unlinked, and `lib.test.ts` (subagent-herdr) compares the two
 * over a table.
 */
export const CARD_ID_PATTERN = /^k([1-9][0-9]*)$/;

export const MAX_CARDS = 200;
export const MAX_TITLE = 200;
export const MAX_NOTE = 500;
export const MAX_RUNS_PER_CARD = 8;
/**
 * Cards per `add` call. `dynamic-prompt.ts` states this number in prose ("up to 20 titles
 * per call"), and nothing ties the two at test time: that module deliberately does not import
 * a sibling extension's module (board facts reach it through `promptInputs`), which is an
 * architectural choice, not a missing dependency — pi-tui resolves at the repo root and
 * `lib/runtime.test.ts` already imports this file. If you change this cap, change the prose.
 */
export const MAX_ADD_PER_CALL = 20;

export type KanbanOp =
	| { op: "add"; titles: string[]; column?: KanbanColumn }
	| { op: "move"; id: string; column: KanbanColumn; note?: string }
	| { op: "note"; id: string; note: string }
	| { op: "rename"; id: string; title: string }
	| { op: "link"; id: string; runId: string }
	| { op: "unlink"; id: string; runId: string }
	| { op: "drop"; id: string }
	| { op: "clear_done" };

/** A refusal. Thrown by `applyOp`; surfaced as an `isError` tool result or a notice. */
export class KanbanError extends Error {}

/**
 * Collapse to one printable line. Titles and notes come from a model and are
 * drawn into a raw terminal, so control bytes — ESC above all — must not survive:
 * removing ESC degrades any escape sequence to harmless visible text.
 */
// The range covers C0 (incl. ESC), DEL and C1 — U+009B is a one-byte CSI on
// terminals that honour 8-bit controls, so C1 is as dangerous as ESC.
export function cleanText(raw: string): string {
	return raw
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function isColumn(value: unknown): value is KanbanColumn {
	return typeof value === "string" && (KANBAN_COLUMNS as readonly string[]).includes(value);
}

const COLUMN_ALIASES: Record<string, KanbanColumn> = {
	todo: "backlog",
	backlog: "backlog",
	progress: "in_progress",
	inprogress: "in_progress",
	in_progress: "in_progress",
	doing: "in_progress",
	wip: "in_progress",
	active: "in_progress",
	blocked: "blocked",
	review: "review",
	done: "done",
};

/** Parse a column name, accepting the aliases a human types (`in-progress`, `wip`, `todo`). */
export function parseColumn(raw: string): KanbanColumn | undefined {
	const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
	return COLUMN_ALIASES[key] ?? COLUMN_ALIASES[key.replace(/_/g, "")];
}

export function cloneState(s: KanbanState): KanbanState {
	return {
		schemaVersion: KANBAN_SCHEMA_VERSION,
		cards: s.cards.map((c) => {
			const card: KanbanCard = { id: c.id, title: c.title, column: c.column };
			if (c.note !== undefined) card.note = c.note;
			if (c.runIds && c.runIds.length > 0) card.runIds = [...c.runIds];
			return card;
		}),
		nextId: s.nextId,
		revision: s.revision,
	};
}

/** Deterministic digest for comparing two states (key order is fixed by `cloneState`). */
export const stateDigest = (s: KanbanState): string => JSON.stringify(cloneState(s));

function findCard(state: KanbanState, id: string): KanbanCard {
	const card = state.cards.find((c) => c.id === id);
	if (!card) {
		const known = state.cards.map((c) => c.id).join(", ") || "none";
		throw new KanbanError(`No card ${id}. Existing ids: ${known}.`);
	}
	return card;
}

function checkTitle(raw: string): string {
	const title = cleanText(raw);
	if (!title) throw new KanbanError("A card title cannot be empty.");
	if (title.length > MAX_TITLE) throw new KanbanError(`A card title is limited to ${MAX_TITLE} characters.`);
	return title;
}

function checkNote(raw: string): string {
	const note = cleanText(raw);
	if (note.length > MAX_NOTE) throw new KanbanError(`A note is limited to ${MAX_NOTE} characters.`);
	return note;
}

/** Move a card to the end of the array, so a column lists cards in arrival order. */
function toEnd(state: KanbanState, card: KanbanCard): void {
	state.cards = [...state.cards.filter((c) => c !== card), card];
}

/**
 * Apply one op, returning a new state. Never mutates `prev` — past snapshots are
 * history recorded in the session, and must stay what they were.
 */
export function applyOp(prev: KanbanState, op: KanbanOp): KanbanState {
	const state = cloneState(prev);

	switch (op.op) {
		case "add": {
			const column = op.column ?? "backlog";
			if (!isColumn(column)) throw new KanbanError(`Unknown column ${String(column)}.`);
			if (column === "blocked") {
				throw new KanbanError("Add the card first, then move it to blocked with a note saying what it waits on.");
			}
			const titles = op.titles.map(cleanText).filter((t) => t.length > 0).map(checkTitle);
			if (titles.length === 0) throw new KanbanError("add needs at least one non-empty title.");
			if (titles.length > MAX_ADD_PER_CALL) throw new KanbanError(`add takes at most ${MAX_ADD_PER_CALL} titles per call.`);
			if (state.cards.length + titles.length > MAX_CARDS) {
				throw new KanbanError(`The board is limited to ${MAX_CARDS} cards. Use clear_done or drop first.`);
			}
			for (const title of titles) state.cards.push({ id: `k${state.nextId++}`, title, column });
			break;
		}

		case "move": {
			if (!isColumn(op.column)) throw new KanbanError(`Unknown column ${String(op.column)}. Columns: ${KANBAN_COLUMNS.join(", ")}.`);
			const card = findCard(state, op.id);
			// A blank note on move means "no note", not "erase the note": models fill
			// optional fields with "" and must not silently wipe recorded evidence.
			// Clearing is the `note` op's job.
			const cleaned = op.note === undefined ? undefined : checkNote(op.note);
			const note = cleaned ? cleaned : undefined;
			if (card.column === op.column) {
				if (note === undefined) throw new KanbanError(`${op.id} is already in ${op.column}.`);
				card.note = note;
				break;
			}
			if (op.column === "blocked" && !note) {
				throw new KanbanError("move to blocked needs a note saying what it waits on.");
			}
			const leavingBlocked = card.column === "blocked";
			card.column = op.column;
			if (note) card.note = note;
			// A blocker note describes a state the card has just left.
			else if (leavingBlocked) delete card.note;
			toEnd(state, card);
			break;
		}

		case "note": {
			const card = findCard(state, op.id);
			const note = checkNote(op.note);
			if (!note && card.column === "blocked") {
				throw new KanbanError("A blocked card keeps its note; move it out of blocked instead.");
			}
			if (note) card.note = note;
			else delete card.note;
			break;
		}

		case "rename": {
			const card = findCard(state, op.id);
			card.title = checkTitle(op.title);
			break;
		}

		case "link": {
			const card = findCard(state, op.id);
			const runId = op.runId.trim();
			if (!RUN_ID_PATTERN.test(runId)) throw new KanbanError(`${runId || "(empty)"} is not a run id (expected sub-xxxx).`);
			const runs = card.runIds ?? [];
			if (runs.includes(runId)) throw new KanbanError(`${runId} is already linked to ${op.id}.`);
			if (runs.length >= MAX_RUNS_PER_CARD) throw new KanbanError(`${op.id} already links ${MAX_RUNS_PER_CARD} runs; unlink one first.`);
			card.runIds = [...runs, runId];
			break;
		}

		case "unlink": {
			const card = findCard(state, op.id);
			const runs = card.runIds ?? [];
			if (!runs.includes(op.runId)) throw new KanbanError(`${op.runId} is not linked to ${op.id}.`);
			const rest = runs.filter((r) => r !== op.runId);
			if (rest.length > 0) card.runIds = rest;
			else delete card.runIds;
			break;
		}

		case "drop": {
			findCard(state, op.id);
			state.cards = state.cards.filter((c) => c.id !== op.id);
			break;
		}

		case "clear_done": {
			const before = state.cards.length;
			state.cards = state.cards.filter((c) => c.column !== "done");
			if (state.cards.length === before) throw new KanbanError("There are no done cards to clear.");
			break;
		}

		default: {
			const unknown: never = op;
			throw new KanbanError(`Unknown op ${(unknown as { op?: string }).op ?? "?"}.`);
		}
	}

	state.revision++;
	return state;
}

// ---------------------------------------------------------------------------
// Validation and branch replay
// ---------------------------------------------------------------------------

/**
 * Validate an untrusted snapshot, returning a normalised copy or `undefined`.
 *
 * Structural only: semantic rules (a blocked card has a note) belong to the
 * reducer. Rejecting a snapshot here makes replay fall back to an *older* one,
 * which is the worse outcome for a merely unusual but well-formed state.
 */
export function parseSnapshot(value: unknown): KanbanState | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	if (v.schemaVersion !== KANBAN_SCHEMA_VERSION) return undefined;
	if (!Array.isArray(v.cards) || v.cards.length > MAX_CARDS) return undefined;
	if (!Number.isInteger(v.nextId) || (v.nextId as number) < 1) return undefined;
	if (!Number.isInteger(v.revision) || (v.revision as number) < 0) return undefined;
	const nextId = v.nextId as number;
	const seen = new Set<string>();
	const cards: KanbanCard[] = [];
	for (const raw of v.cards) {
		if (typeof raw !== "object" || raw === null) return undefined;
		const c = raw as Record<string, unknown>;
		if (typeof c.id !== "string") return undefined;
		const m = CARD_ID_PATTERN.exec(c.id);
		if (!m || Number(m[1]) >= nextId || seen.has(c.id)) return undefined;
		seen.add(c.id);
		if (typeof c.title !== "string" || !c.title || c.title.length > MAX_TITLE) return undefined;
		if (!isColumn(c.column)) return undefined;
		const card: KanbanCard = { id: c.id, title: c.title, column: c.column };
		if (c.note !== undefined) {
			if (typeof c.note !== "string" || c.note.length > MAX_NOTE) return undefined;
			card.note = c.note;
		}
		if (c.runIds !== undefined) {
			if (!Array.isArray(c.runIds) || c.runIds.length > MAX_RUNS_PER_CARD) return undefined;
			const runs = new Set<string>();
			for (const r of c.runIds) {
				if (typeof r !== "string" || !RUN_ID_PATTERN.test(r) || runs.has(r)) return undefined;
				runs.add(r);
			}
			if (runs.size > 0) card.runIds = [...runs];
		}
		cards.push(card);
	}
	return { schemaVersion: KANBAN_SCHEMA_VERSION, cards, nextId, revision: v.revision as number };
}

/** The structural subset of a pi `SessionEntry` replay needs. */
export interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; toolName?: string; isError?: boolean; details?: unknown };
}

/** The snapshot an entry carries, if it is a valid kanban snapshot at all. */
export function snapshotOf(entry: SessionEntryLike): KanbanState | undefined {
	if (entry.type === "message") {
		const m = entry.message;
		if (m?.role !== "toolResult" || m.toolName !== TOOL_NAME || m.isError) return undefined;
		return parseSnapshot((m.details as { state?: unknown } | undefined)?.state);
	}
	if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
		return parseSnapshot((entry.data as { state?: unknown } | undefined)?.state);
	}
	return undefined;
}

/**
 * Rebuild the board from the current branch: the latest valid snapshot wins.
 * A malformed newest snapshot is skipped in favour of the one before it.
 */
export function reconstructFromEntries(entries: readonly SessionEntryLike[]): KanbanState {
	let found: KanbanState | undefined;
	for (const entry of entries) found = snapshotOf(entry) ?? found;
	return found ?? emptyState();
}

// ---------------------------------------------------------------------------
// Projection (extension → board process)
// ---------------------------------------------------------------------------

/**
 * What the board process renders. Disposable: rewritten from session state on
 * every change and never read back by the extension.
 *
 * `seq` is a per-process publication counter, distinct from `state.revision`:
 * a rewind legitimately *lowers* the revision, so the board must not treat a
 * lower revision as stale — only a lower `seq` would be (and a single
 * synchronous writer cannot produce one; the guard is belt and braces).
 */
export interface KanbanProjection {
	schemaVersion: typeof KANBAN_SCHEMA_VERSION;
	seq: number;
	ownerPid: number;
	sessionId: string;
	sessionName?: string;
	leafId: string | null;
	generatedAt: string;
	state: KanbanState;
	/** Files changed this session, from `changed-files.ts` (via `pi.events`). */
	changedFiles?: ChangedFileInfo[];
}

/** One changed file as `changed-files.ts` broadcasts it on {@link CHANGED_FILES_EVENT}. */
export interface ChangedFileInfo {
	path: string;
	status: string;
	/** -1 = unknown. */
	added: number;
	removed: number;
	binary: boolean;
}

/** `pi.events` channel: changed-files → kanban, payload `ChangedFileInfo[]`. */
export const CHANGED_FILES_EVENT = "changed-files:update";
/** `pi.events` channel: kanban → changed-files, payload `{ live: boolean }` (side pane shown). */
export const KANBAN_PANE_EVENT = "kanban:pane";

/** Validate a changed-files list from an untrusted source; drops malformed entries. */
export function parseChangedFiles(value: unknown): ChangedFileInfo[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: ChangedFileInfo[] = [];
	for (const f of value) {
		if (typeof f !== "object" || f === null) continue;
		const v = f as Record<string, unknown>;
		if (typeof v.path !== "string" || typeof v.status !== "string") continue;
		out.push({
			path: v.path,
			status: v.status,
			added: typeof v.added === "number" ? v.added : -1,
			removed: typeof v.removed === "number" ? v.removed : -1,
			binary: v.binary === true,
		});
	}
	return out;
}

export function buildProjection(args: {
	seq: number;
	ownerPid: number;
	sessionId: string;
	sessionName?: string;
	leafId: string | null;
	state: KanbanState;
	generatedAt?: string;
	changedFiles?: readonly ChangedFileInfo[];
}): KanbanProjection {
	const p: KanbanProjection = {
		schemaVersion: KANBAN_SCHEMA_VERSION,
		seq: args.seq,
		ownerPid: args.ownerPid,
		sessionId: args.sessionId,
		leafId: args.leafId,
		generatedAt: args.generatedAt ?? new Date().toISOString(),
		state: cloneState(args.state),
	};
	if (args.sessionName) p.sessionName = args.sessionName;
	if (args.changedFiles && args.changedFiles.length > 0) p.changedFiles = args.changedFiles.map((f) => ({ ...f }));
	return p;
}

export function parseProjection(value: unknown): KanbanProjection | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	if (v.schemaVersion !== KANBAN_SCHEMA_VERSION) return undefined;
	if (!Number.isInteger(v.seq) || !Number.isInteger(v.ownerPid)) return undefined;
	if (typeof v.sessionId !== "string" || typeof v.generatedAt !== "string") return undefined;
	if (v.leafId !== null && typeof v.leafId !== "string") return undefined;
	if (v.sessionName !== undefined && typeof v.sessionName !== "string") return undefined;
	const state = parseSnapshot(v.state);
	if (!state) return undefined;
	const p: KanbanProjection = {
		schemaVersion: KANBAN_SCHEMA_VERSION,
		seq: v.seq as number,
		ownerPid: v.ownerPid as number,
		sessionId: v.sessionId,
		leafId: v.leafId as string | null,
		generatedAt: v.generatedAt,
		state,
	};
	if (v.sessionName) p.sessionName = v.sessionName as string;
	const files = parseChangedFiles(v.changedFiles);
	if (files && files.length > 0) p.changedFiles = files;
	return p;
}

// ---------------------------------------------------------------------------
// Linked runs and the settle guard
// ---------------------------------------------------------------------------

/** A run's status as the board sees it; `unknown` when its record cannot be read. */
export type EffectiveRunStatus = RunStatus | "unknown";

/** A run's todo progress, as the board reads it off the child's session file. */
export interface RunTodoCounts {
	/** Items marked done. */
	done: number;
	/** The list's length. */
	total: number;
	/** Items in progress. */
	inProgress: number;
	/** Items blocked (with a note) — surfaced separately, not counted as open. */
	blocked: number;
}

export interface RunInfo {
	status: EffectiveRunStatus;
	agent?: string;
	/**
	 * The child's todo progress, read live from the child's session file. Advisory
	 * only: it is rendered under the run line while the run is live, and it never
	 * moves a card — run status is the only thing that does.
	 */
	todos?: RunTodoCounts;
}

export type RunInfos = Readonly<Record<string, RunInfo>>;

/** Every run id linked from a card that is not done, deduplicated. */
export function linkedRunIds(state: KanbanState): string[] {
	const ids = new Set<string>();
	for (const card of state.cards) {
		if (card.column === "done") continue;
		for (const r of card.runIds ?? []) ids.add(r);
	}
	return [...ids];
}

const statusOf = (runs: RunInfos, id: string): EffectiveRunStatus => runs[id]?.status ?? "unknown";

/** A card waiting on delegated work: at least one linked run positively `running`. */
export const isWaiting = (card: KanbanCard, runs: RunInfos): boolean =>
	(card.runIds ?? []).some((r) => statusOf(runs, r) === "running");

/** A card whose linked runs have all finished: their evidence is ready to collect. */
export const needsAttention = (card: KanbanCard, runs: RunInfos): boolean =>
	(card.column === "in_progress" || card.column === "review") &&
	(card.runIds ?? []).length > 0 &&
	(card.runIds ?? []).every((r) => {
		const s = statusOf(runs, r);
		return s === "done" || s === "failed" || s === "cancelled";
	});

/**
 * Cards that still owe the orchestrator an action when it is about to stop.
 *
 * Exempt: done, blocked (accounted for, with a note), and any card waiting on a
 * running linked run — ending the turn *is* how the orchestrator waits for a
 * subagent. Backlog and review are also exempt while anything on the board is
 * waiting: they are plausibly queued behind that work, and nagging about them
 * on every delegation trains the model to shuffle cards to silence the guard.
 * An in-progress card with no running run is never exempt — that is the
 * abandoned card this guard exists for.
 */
export function actionableCards(state: KanbanState, runs: RunInfos): KanbanCard[] {
	const anyWaiting = state.cards.some((c) => c.column !== "done" && isWaiting(c, runs));
	return state.cards.filter((c) => {
		if (c.column === "done" || c.column === "blocked") return false;
		if (isWaiting(c, runs)) return false;
		if (c.column === "in_progress") return true;
		return !anyWaiting;
	});
}

/**
 * Fingerprint of everything the guard looks at: columns *and* linked-run
 * statuses. Without the statuses, a card whose child went from running to done
 * would keep its signature and the guard would never re-arm for it.
 *
 * Unique only *within one session*: it names cards, not the session. The
 * extension's dedupe set is per runtime and cleared on session_start and
 * session_tree; moving that set somewhere longer-lived (the globalThis pane
 * registry) would need the session id folded in here.
 */
export function settleSignature(state: KanbanState, runs: RunInfos): string {
	return state.cards
		.filter((c) => c.column !== "done")
		.map((c) => `${c.id}:${c.column}:${(c.runIds ?? []).map((r) => `${r}=${statusOf(runs, r)}`).join("+")}`)
		.join(",");
}

const NUDGE_MAX_LISTED = 8;

export interface KanbanNudge {
	text: string;
	signature: string;
}

/** The reminder injected when the orchestrator stops with cards unaccounted for. */
export function nudgeFor(state: KanbanState, runs: RunInfos): KanbanNudge | undefined {
	const open = actionableCards(state, runs);
	if (open.length === 0) return undefined;
	const shown = open.slice(0, NUDGE_MAX_LISTED).map((c) => {
		const extra = needsAttention(c, runs) ? " — its linked runs have finished; collect their results" : "";
		return `${c.id} (${COLUMN_LABEL[c.column].toLowerCase()}) ${c.title}${extra}`;
	});
	const more = open.length > shown.length ? `; … ${open.length - shown.length} more` : "";
	const subject = open.length === 1 ? "1 kanban card still needs" : `${open.length} kanban cards still need`;
	return {
		signature: settleSignature(state, runs),
		text:
			`Not done yet: ${subject} you — ${shown.join("; ")}${more}. ` +
			"For each one do exactly one of: keep working on it; kanban op 'move' to done once it " +
			"is genuinely verified (put the evidence in the note); op 'move' to review only while another " +
			"card is waiting on a running subagent — a review card is counted otherwise, so it does not " +
			"settle this (a card linked to its own running run is the exempt case); op 'move' to blocked with a note " +
			"saying what it waits on (including the user); op 'link' with the run id if a running subagent " +
			"is doing it; or op 'drop' if it is not needed. Never move a card just to clear this message.",
	};
}

// ---------------------------------------------------------------------------
// Text summaries
// ---------------------------------------------------------------------------

export function columnCounts(state: KanbanState): Record<KanbanColumn, number> {
	const counts = { backlog: 0, in_progress: 0, blocked: 0, review: 0, done: 0 };
	for (const c of state.cards) counts[c.column]++;
	return counts;
}

/** One terse line, for tool results: the user sees the board, so do not restate it. */
export function summarize(state: KanbanState): string {
	const n = columnCounts(state);
	if (state.cards.length === 0) return "Board is empty.";
	const parts = [`${n.done}/${state.cards.length} done`];
	if (n.in_progress) parts.push(`${n.in_progress} in progress`);
	if (n.review) parts.push(`${n.review} in review`);
	if (n.blocked) parts.push(`${n.blocked} blocked`);
	if (n.backlog) parts.push(`${n.backlog} backlog`);
	return parts.join(" · ");
}

/** What an op did, in one line — names new ids, which the model cannot otherwise know. */
export function describeOp(before: KanbanState, after: KanbanState, op: KanbanOp): string {
	switch (op.op) {
		case "add": {
			const added = after.cards.filter((c) => !before.cards.some((b) => b.id === c.id));
			return `Added ${added.map((c) => `${c.id} "${c.title}"`).join(", ")} to ${op.column ?? "backlog"}.`;
		}
		case "move":
			return `Moved ${op.id} to ${op.column}.`;
		case "note":
			return cleanText(op.note) ? `Noted on ${op.id}.` : `Cleared the note on ${op.id}.`;
		case "rename":
			return `Renamed ${op.id}.`;
		case "link":
			return `Linked ${op.runId.trim()} to ${op.id}.`;
		case "unlink":
			return `Unlinked ${op.runId} from ${op.id}.`;
		case "drop":
			return `Dropped ${op.id}.`;
		case "clear_done":
			return `Cleared ${before.cards.length - after.cards.length} done card(s).`;
	}
}

/** The whole board as plain text — for op `show` and a bare `/kanban`. */
export function formatCardList(state: KanbanState, runs: RunInfos = {}): string {
	if (state.cards.length === 0) return "Kanban board is empty.";
	const lines = [`Kanban — ${summarize(state)}`];
	for (const column of KANBAN_COLUMNS) {
		const cards = state.cards.filter((c) => c.column === column);
		if (cards.length === 0) continue;
		lines.push(`${COLUMN_LABEL[column]} (${cards.length})`);
		for (const c of cards) {
			const linked = (c.runIds ?? []).map((r) => `${r}${runs[r] ? ` ${runs[r].status}` : ""}`).join(", ");
			lines.push(
				`  ${COLUMN_GLYPH[column]} ${c.id}  ${c.title}${linked ? `  [${linked}]` : ""}${c.note ? ` — ${c.note}` : ""}`,
			);
		}
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type Tone = "accent" | "muted" | "dim" | "text" | "success" | "warning" | "error" | "heading";

/** Colouring is injected: the board uses raw ANSI, the widget pi's theme, tests nothing. */
export interface Style {
	fg(tone: Tone, text: string): string;
	bold(text: string): string;
}

export const PLAIN_STYLE: Style = { fg: (_t, s) => s, bold: (s) => s };

export const COLUMN_TONE: Record<KanbanColumn, Tone> = {
	backlog: "muted",
	in_progress: "accent",
	blocked: "error",
	review: "warning",
	done: "success",
};

const RUN_GLYPH: Record<EffectiveRunStatus, string> = {
	running: "◌",
	done: "✓",
	failed: "✗",
	cancelled: "⊘",
	unknown: "?",
};

const RUN_TONE: Record<EffectiveRunStatus, Tone> = {
	running: "accent",
	done: "success",
	failed: "error",
	cancelled: "muted",
	unknown: "dim",
};

/** Truncate (never pad) to `width` visible columns, ANSI-aware. */
export function fit(line: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line;
}

/** Pad or truncate to exactly `width` visible columns. */
export function padTo(line: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(line);
	if (w > width) return truncateToWidth(line, width, "…");
	return line + " ".repeat(width - w);
}

function wrapPlain(text: string, width: number, maxLines: number): string[] {
	if (width <= 0) return [];
	const lines = wrapTextWithAnsi(text, width).map((l) => fit(l, width));
	if (lines.length <= maxLines) return lines;
	const kept = lines.slice(0, maxLines);
	kept[maxLines - 1] = fit(`${kept[maxLines - 1]}…`, width);
	return kept;
}

/** The lines of one card, `width` wide at most, uncoloured text coloured by `style`. */
function cardLines(card: KanbanCard, runs: RunInfos, width: number, style: Style, glyph: boolean): string[] {
	const lead = glyph ? `${COLUMN_GLYPH[card.column]} ` : "";
	const idTag = `${card.id} `;
	const indent = visibleWidth(lead) + visibleWidth(idTag);
	const bodyWidth = Math.max(4, width - indent);
	const title = wrapPlain(cleanText(card.title), bodyWidth, 3);
	const out: string[] = [];
	title.forEach((t, i) => {
		const head = i === 0 ? style.fg(COLUMN_TONE[card.column], lead) + style.fg("dim", idTag) : " ".repeat(indent);
		const body = card.column === "done" ? style.fg("muted", t) : style.fg("text", t);
		out.push(fit(head + body, width));
	});
	const pad = " ".repeat(indent);
	for (const r of card.runIds ?? []) {
		const info = runs[r];
		const s = info?.status ?? "unknown";
		// `agent` comes from a file on disk: clean it like any other foreign text.
		const agent = info?.agent ? cleanText(info.agent).slice(0, 40) : "";
		const label = `${RUN_GLYPH[s]} ${r}${agent ? ` ${agent}` : ""} ${s}`;
		out.push(fit(pad + style.fg(RUN_TONE[s], label), width));
		// The child's live todo progress: one indented line under its run line,
		// for live work only (the board is about work in flight, not history).
		const t = info?.todos;
		if (t && s !== "done" && s !== "failed" && s !== "cancelled") {
			const parts = [`${t.done}/${t.total}`];
			if (t.blocked > 0) parts.push(`▲${t.blocked}`);
			if (t.inProgress > 0) parts.push("◐");
			out.push(fit(pad + "  " + style.fg(RUN_TONE[s], parts.join(" ")), width));
		}
	}
	if (needsAttention(card, runs)) out.push(fit(pad + style.fg("warning", "⚑ runs finished — collect results"), width));
	if (card.note) {
		for (const l of wrapPlain(cleanText(card.note), bodyWidth, 2)) out.push(fit(pad + style.fg("dim", l), width));
	}
	return out;
}

/** Done cards shown per column before collapsing the rest into a count. */
export const DONE_SHOWN = 6;
/** Minimum width of one column in the side-by-side layout. */
export const MIN_COLUMN_WIDTH = 22;
const GAP = " │ ";

/** Side-by-side columns need `MIN_COLUMN_WIDTH` each; otherwise sections stack. */
export const fitsColumns = (width: number): boolean =>
	width >= MIN_COLUMN_WIDTH * KANBAN_COLUMNS.length + visibleWidth(GAP) * (KANBAN_COLUMNS.length - 1);

function columnCards(state: KanbanState, column: KanbanColumn): { cards: KanbanCard[]; hidden: number } {
	const all = state.cards.filter((c) => c.column === column);
	if (column !== "done" || all.length <= DONE_SHOWN) return { cards: all, hidden: 0 };
	return { cards: all.slice(all.length - DONE_SHOWN), hidden: all.length - DONE_SHOWN };
}

function columnHeading(column: KanbanColumn, count: number, style: Style): string {
	return style.fg(COLUMN_TONE[column], `${COLUMN_GLYPH[column]} `) + style.bold(COLUMN_LABEL[column].toUpperCase()) + style.fg("dim", ` ${count}`);
}

function stackedBody(state: KanbanState, runs: RunInfos, width: number, style: Style): string[] {
	const out: string[] = [];
	for (const column of KANBAN_COLUMNS) {
		const total = state.cards.filter((c) => c.column === column).length;
		if (total === 0) continue;
		if (out.length > 0) out.push("");
		out.push(fit(columnHeading(column, total, style), width));
		const { cards, hidden } = columnCards(state, column);
		if (hidden > 0) out.push(fit(style.fg("dim", `  … ${hidden} earlier`), width));
		for (const card of cards) for (const l of cardLines(card, runs, width - 2, style, false)) out.push(fit(`  ${l}`, width));
	}
	return out;
}

function columnsBody(state: KanbanState, runs: RunInfos, width: number, style: Style): string[] {
	const n = KANBAN_COLUMNS.length;
	const colWidth = Math.floor((width - visibleWidth(GAP) * (n - 1)) / n);
	const cols = KANBAN_COLUMNS.map((column) => {
		const total = state.cards.filter((c) => c.column === column).length;
		const lines = [fit(columnHeading(column, total, style), colWidth), style.fg("dim", "─".repeat(colWidth))];
		const { cards, hidden } = columnCards(state, column);
		if (hidden > 0) lines.push(fit(style.fg("dim", `… ${hidden} earlier`), colWidth));
		cards.forEach((card, i) => {
			if (i > 0) lines.push("");
			lines.push(...cardLines(card, runs, colWidth, style, false));
		});
		if (total === 0) lines.push(style.fg("dim", "—"));
		return lines;
	});
	const height = Math.max(...cols.map((c) => c.length));
	const out: string[] = [];
	for (let i = 0; i < height; i++) {
		out.push(fit(cols.map((c) => padTo(c[i] ?? "", colWidth)).join(style.fg("dim", GAP)), width));
	}
	return out;
}

/** The board body (unclipped vertically, every line ≤ `width`). */
export function renderBody(state: KanbanState, runs: RunInfos, width: number, style: Style = PLAIN_STYLE): string[] {
	if (width <= 0) return [];
	if (state.cards.length === 0) {
		return [
			fit(style.fg("dim", "No cards yet."), width),
			fit(style.fg("dim", "The orchestrator adds them with the kanban tool;"), width),
			fit(style.fg("dim", "you can with /kanban add <title>."), width),
		];
	}
	return fitsColumns(width) ? columnsBody(state, runs, width, style) : stackedBody(state, runs, width, style);
}

export interface FrameInput {
	state: KanbanState | undefined;
	runs: RunInfos;
	width: number;
	height: number;
	scroll: number;
	/** Shown under the title in the warning tone (stale/unreadable projection). */
	banner?: string;
	/** Shown in the title line (session name or id). */
	label?: string;
	/** Rendered as a section under the cards. */
	changedFiles?: readonly ChangedFileInfo[];
}

const FILE_TONE: Record<string, Tone> = {
	created: "success",
	modified: "warning",
	deleted: "error",
	renamed: "muted",
	copied: "muted",
	untracked: "dim",
};

/** The "Changed Files" section of the board body. Empty when there are none. */
export function changedFilesBody(files: readonly ChangedFileInfo[] | undefined, width: number, style: Style = PLAIN_STYLE): string[] {
	if (!files || files.length === 0 || width <= 0) return [];
	const lines = ["", fit(style.bold(style.fg("heading", "Changed Files")) + style.fg("dim", ` (${files.length})`), width)];
	for (const f of files) {
		const glyph = style.fg(FILE_TONE[f.status] ?? "warning", f.status === "untracked" ? "○" : "●");
		const counts = f.binary
			? style.fg("muted", "bin")
			: f.added < 0 && f.removed < 0
				? style.fg("dim", "+? -?")
				: `${style.fg("success", `+${Math.max(f.added, 0)}`)} ${style.fg("error", `-${Math.max(f.removed, 0)}`)}`;
		const tail = ` ${counts}`;
		const room = Math.max(1, width - 2 - visibleWidth(tail));
		const path = cleanText(f.path);
		const shown = visibleWidth(path) > room ? `…${path.slice(-(room - 1))}` : path;
		lines.push(fit(`${glyph} ${style.fg("text", shown)}${tail}`, width));
	}
	return lines;
}

export interface Frame {
	lines: string[];
	/** The scroll actually applied (clamped). */
	scroll: number;
	maxScroll: number;
	/** Body rows on screen: one page, for PgUp/PgDn (the head is 2 or 3 rows). */
	room: number;
}

/**
 * A whole screen: fixed title (+ banner), scrollable body, fixed footer.
 * Exactly `height` lines or fewer, none wider than `width`.
 */
export function renderFrame(input: FrameInput, style: Style = PLAIN_STYLE): Frame {
	const { width, height } = input;
	if (!(width > 0) || !(height > 0)) return { lines: [], scroll: 0, maxScroll: 0, room: 0 };
	const state = input.state;
	const head: string[] = [];
	const title = style.bold(style.fg("heading", "▦ Kanban"));
	const stats = state ? style.fg("dim", ` · ${summarize(state)}`) : "";
	// The session name is user-typed (`/name`) and pi strips only newlines from it.
	const cleanLabel = input.label ? cleanText(input.label) : "";
	const label = cleanLabel ? style.fg("dim", ` · ${cleanLabel}`) : "";
	head.push(fit(title + stats + label, width));
	if (input.banner) head.push(fit(style.fg("warning", `⚠ ${input.banner}`), width));
	head.push(style.fg("dim", "─".repeat(width)));

	const body = state ? [...renderBody(state, input.runs, width, style), ...changedFilesBody(input.changedFiles, width, style)] : [fit(style.fg("dim", "Waiting for pi to publish the board…"), width)];
	const footerRows = height - head.length >= 3 ? 1 : 0;
	const room = Math.max(0, height - head.length - footerRows);
	const maxScroll = Math.max(0, body.length - room);
	const scroll = Number.isFinite(input.scroll) ? Math.min(Math.max(0, Math.trunc(input.scroll)), maxScroll) : 0;
	const shown = body.slice(scroll, scroll + room);
	const lines = [...head.slice(0, height), ...shown];
	if (footerRows) {
		const pos = maxScroll > 0 ? `  [${scroll + 1}-${scroll + shown.length}/${body.length}]` : "";
		const keys = maxScroll > 0 ? "↑↓ PgUp PgDn g G scroll · q close" : "q close · /kanban reopens";
		lines.push(fit(style.fg("dim", keys + pos), width));
	}
	return { lines: lines.slice(0, height), scroll, maxScroll, room };
}

/**
 * The compact fallback shown below pi's editor when there is no side pane
 * (plain terminal, narrow pane, no bun). Open cards first, done collapsed.
 */
export function compactLines(state: KanbanState, runs: RunInfos, width: number, style: Style, maxCards = 8): string[] {
	if (state.cards.length === 0 || width <= 0) return [];
	const lines = [fit(style.bold(style.fg("heading", " Kanban")) + style.fg("dim", ` ${summarize(state)}`), width)];
	const order: KanbanColumn[] = ["in_progress", "review", "blocked", "backlog"];
	const open = order.flatMap((col) => state.cards.filter((c) => c.column === col));
	for (const card of open.slice(0, maxCards)) {
		const runsTag = (card.runIds ?? [])
			.map((r) => {
				const s = runs[r]?.status ?? "unknown";
				const t = runs[r]?.todos;
				const tds = t && s !== "done" && s !== "failed" && s !== "cancelled" ? ` ${t.done}/${t.total}` : "";
				return style.fg(RUN_TONE[s], ` ${RUN_GLYPH[s]}${r}${tds}`);
			})
			.join("");
		const note = card.note ? style.fg("dim", `  ${cleanText(card.note)}`) : "";
		lines.push(
			fit(
				`  ${style.fg(COLUMN_TONE[card.column], COLUMN_GLYPH[card.column])} ${style.fg("dim", card.id)} ${style.fg("text", cleanText(card.title))}${runsTag}${note}`,
				width,
			),
		);
	}
	if (open.length > maxCards) lines.push(fit(style.fg("dim", `  … ${open.length - maxCards} more`), width));
	return lines;
}

// ---------------------------------------------------------------------------
// Pane geometry and launch
// ---------------------------------------------------------------------------

export type SplitDecision =
	| { kind: "right"; ratio: number }
	| { kind: "down"; ratio: number }
	| { kind: "none" };

/** Columns pi must keep beside a right-hand board, and the board's own range. */
export const MIN_PI_COLUMNS = 80;
export const MIN_BOARD_COLUMNS = 36;
export const MAX_BOARD_COLUMNS = 90;
export const MIN_BOARD_ROWS = 10;
export const MIN_PI_ROWS = 16;

/**
 * The owner pid encoded in a runtime dir name (`<pid>-<random>` under
 * `$XDG_RUNTIME_DIR/pi-kanban/`, or `pi-kanban-<pid>-<random>` in the tmpdir
 * fallback), or undefined for any name that is not one of ours — the sweep
 * must never touch a stranger's directory in a shared tmpdir.
 */
export function staleRuntimeOwner(name: string, prefix: string): number | undefined {
	if (!name.startsWith(prefix)) return undefined;
	const m = /^(\d+)-[A-Za-z0-9]{6}$/.exec(name.slice(prefix.length));
	if (!m) return undefined;
	const pid = Number(m[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Where the board pane goes, as a herdr `--ratio` (the fraction the ORIGINAL pane
 * keeps — measured on herdr 0.9.0). Right of pi when pi keeps ≥ 80 columns and
 * the board gets ≥ 36; else below when both get usable heights; else nowhere.
 */
export function decideSplit(size: { width: number; height: number }): SplitDecision {
	const { width, height } = size;
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { kind: "none" };
	const board = Math.min(MAX_BOARD_COLUMNS, Math.max(MIN_BOARD_COLUMNS, Math.round(width * 0.3)));
	if (width - board >= MIN_PI_COLUMNS) {
		return { kind: "right", ratio: Math.round(((width - board) / width) * 100) / 100 };
	}
	const rows = Math.max(MIN_BOARD_ROWS, Math.round(height * 0.35));
	if (height - rows >= MIN_PI_ROWS) {
		return { kind: "down", ratio: Math.round(((height - rows) / height) * 100) / 100 };
	}
	return { kind: "none" };
}

/** POSIX single-quote quoting: safe in bash, zsh, dash and fish for any string. */
export function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const shellJoin = (argv: readonly string[]): string => argv.map(shellQuote).join(" ");

/** PowerShell single-quote quoting: inside '...' only ' is special, doubled as ''. */
export function powershellQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The command a pane runs to become `argv`, closing when it exits. POSIX
 * shells `exec`; on Windows the pane shell is PowerShell, which has no `exec`,
 * so call the program with `&` and exit with its status.
 *
 * `env` is set for the program only: through `env(1)` under POSIX, and as
 * `$env:` assignments in the pane's own PowerShell (which the pane closes with).
 * Pi-Bolt needs it: its compiled executable is the `bun` CLI only with
 * `BUN_BE_BUN=1` (see `lib/runtime.ts`).
 */
export function paneCommand(
	argv: readonly string[],
	platform: NodeJS.Platform = process.platform,
	env: Readonly<Record<string, string>> = {},
): string {
	const pairs = Object.entries(env);
	if (platform !== "win32") {
		const prefix = pairs.length > 0 ? ["env", ...pairs.map(([k, v]) => `${k}=${v}`)] : [];
		return shellJoin(["exec", ...prefix, ...argv]);
	}
	const sets = pairs.map(([k, v]) => `$env:${k} = ${powershellQuote(v)}; `).join("");
	return `${sets}& ${argv.map(powershellQuote).join(" ")}; exit $LASTEXITCODE`;
}

/**
 * Locate an executable on a PATH string. Pure: the filesystem check is injected,
 * so the search order is testable without a filesystem.
 */
export function findOnPath(
	name: string,
	pathEnv: string | undefined,
	isExecutable: (path: string) => boolean,
	extra: readonly string[] = [],
	platform: NodeJS.Platform = process.platform,
	pathExt: string | undefined = process.env.PATHEXT,
): string | undefined {
	const win = platform === "win32";
	// Windows: PATH is ';'-separated (':' would split drive letters), and
	// executables carry a PATHEXT suffix such as .exe.
	const dirs = (pathEnv ?? "").split(win ? ";" : ":").filter((d) => d.length > 0);
	const exts = win
		? ["", ...(pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e.length > 0).map((e) => e.toLowerCase())]
		: [""];
	const bases = [
		...dirs.map((d) => (win ? `${d.replace(/[\\/]+$/, "")}\\${name}` : `${d.replace(/\/+$/, "")}/${name}`)),
		...extra,
	];
	for (const base of bases) {
		for (const ext of exts) {
			if (isExecutable(base + ext)) return base + ext;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// /kanban argument parsing
// ---------------------------------------------------------------------------

export type KanbanCommand =
	/** Bare `/kanban`: bring the board back — reopen the pane if it is closed, else list the cards. */
	| { kind: "default" }
	| { kind: "show" }
	| { kind: "open" }
	| { kind: "close" }
	| { kind: "restart" }
	| { kind: "help" }
	| { kind: "op"; op: KanbanOp }
	| { kind: "error"; message: string };

export const KANBAN_SUBCOMMANDS = [
	"show",
	"open",
	"close",
	"restart",
	"add",
	"move",
	"note",
	"rename",
	"link",
	"unlink",
	"drop",
	"clear-done",
	"help",
] as const;

export const KANBAN_USAGE =
	"/kanban (reopen the board) · show · open · close · restart · add <title> · move <id> <column> [note] · note <id> <text> · " +
	"rename <id> <title> · link <id> <run> · unlink <id> <run> · drop <id> · clear-done";

/** Parse `/kanban` arguments. Pure; refusals of the op itself come from `applyOp`. */
export function parseCommand(args: string): KanbanCommand {
	const trimmed = args.trim();
	if (!trimmed) return { kind: "default" };
	const [sub = "", ...rest] = trimmed.split(/\s+/);
	const tail = trimmed.slice(sub.length).trim();
	const need = (n: number, usage: string): KanbanCommand | undefined =>
		rest.length < n ? { kind: "error", message: `Usage: /kanban ${usage}` } : undefined;
	switch (sub.toLowerCase()) {
		case "show":
		case "list":
			return { kind: "show" };
		case "open":
			return { kind: "open" };
		case "close":
		case "hide":
			return { kind: "close" };
		case "restart":
			return { kind: "restart" };
		case "help":
			return { kind: "help" };
		case "add":
			return need(1, "add <title>") ?? { kind: "op", op: { op: "add", titles: [tail] } };
		case "move": {
			const bad = need(2, "move <id> <column> [note]");
			if (bad) return bad;
			const column = parseColumn(rest[1] ?? "");
			if (!column) return { kind: "error", message: `Unknown column ${rest[1]}. Columns: ${KANBAN_COLUMNS.join(", ")}.` };
			const note = rest.slice(2).join(" ");
			return { kind: "op", op: { op: "move", id: rest[0]!, column, ...(note ? { note } : {}) } };
		}
		case "note":
			return need(1, "note <id> [text]") ?? { kind: "op", op: { op: "note", id: rest[0]!, note: rest.slice(1).join(" ") } };
		case "rename":
			return need(2, "rename <id> <title>") ?? { kind: "op", op: { op: "rename", id: rest[0]!, title: rest.slice(1).join(" ") } };
		case "link":
			return need(2, "link <id> <run-id>") ?? { kind: "op", op: { op: "link", id: rest[0]!, runId: rest[1]! } };
		case "unlink":
			return need(2, "unlink <id> <run-id>") ?? { kind: "op", op: { op: "unlink", id: rest[0]!, runId: rest[1]! } };
		case "drop":
			return need(1, "drop <id>") ?? { kind: "op", op: { op: "drop", id: rest[0]! } };
		case "clear-done":
		case "clear_done":
			return { kind: "op", op: { op: "clear_done" } };
		default:
			return { kind: "error", message: `Unknown subcommand ${sub}. ${KANBAN_USAGE}` };
	}
}

/** Loose tool parameters → a typed op, refusing what cannot be honoured. */
export function opFromParams(p: {
	op: string;
	titles?: string[];
	id?: string;
	column?: string;
	note?: string;
	title?: string;
	run_id?: string;
}): KanbanOp {
	const needId = (): string => {
		if (!p.id) throw new KanbanError(`${p.op} needs \`id\`.`);
		return p.id;
	};
	const column = (): KanbanColumn => {
		if (!p.column) throw new KanbanError(`${p.op} needs \`column\`.`);
		const c = parseColumn(p.column);
		if (!c) throw new KanbanError(`Unknown column ${p.column}. Columns: ${KANBAN_COLUMNS.join(", ")}.`);
		return c;
	};
	switch (p.op) {
		case "add":
			if (!p.titles || p.titles.length === 0) throw new KanbanError("add needs `titles`: one short imperative per card.");
			return { op: "add", titles: p.titles, ...(p.column ? { column: column() } : {}) };
		case "move":
			return { op: "move", id: needId(), column: column(), ...(p.note !== undefined ? { note: p.note } : {}) };
		case "note":
			if (p.note === undefined) throw new KanbanError("note needs `note` (empty clears it).");
			return { op: "note", id: needId(), note: p.note };
		case "rename":
			if (!p.title) throw new KanbanError("rename needs `title`.");
			return { op: "rename", id: needId(), title: p.title };
		case "link":
		case "unlink":
			if (!p.run_id) throw new KanbanError(`${p.op} needs \`run_id\` (the sub-xxxx id the subagent tool returned).`);
			return { op: p.op, id: needId(), runId: p.run_id };
		case "drop":
			return { op: "drop", id: needId() };
		case "clear_done":
			return { op: "clear_done" };
		default:
			throw new KanbanError(`Unknown op ${p.op}.`);
	}
}

// ---------------------------------------------------------------------------
// Board process arguments
// ---------------------------------------------------------------------------

export interface BoardArgs {
	file: string;
	ownerPid: number;
	agentDir: string;
	/** Render one frame to stdout and exit (tests, debugging). */
	once: boolean;
	width?: number;
	height?: number;
}

/** The largest `--width`/`--height` the board accepts; no real terminal is wider. */
export const MAX_TERMINAL_DIM = 10_000;

/** Parse `board.ts` argv (after the script path). Returns a usage error string on failure. */
export function parseBoardArgs(argv: readonly string[]): BoardArgs | string {
	const usage = "usage: board.ts --file <projection.json> --owner-pid <pid> --agent-dir <dir> [--once] [--width N] [--height N]";
	let file: string | undefined;
	let ownerPid: number | undefined;
	let agentDir: string | undefined;
	let once = false;
	let width: number | undefined;
	let height: number | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const value = (): string | undefined => argv[++i];
		switch (a) {
			case "--file":
				file = value();
				break;
			case "--owner-pid":
				ownerPid = Number(value());
				break;
			case "--agent-dir":
				agentDir = value();
				break;
			case "--once":
				once = true;
				break;
			case "--width":
				width = Number(value());
				break;
			case "--height":
				height = Number(value());
				break;
			default:
				return `unknown argument ${a}\n${usage}`;
		}
	}
	if (!file || !agentDir) return usage;
	if (ownerPid === undefined || !Number.isInteger(ownerPid) || ownerPid <= 0) return `--owner-pid must be a positive integer\n${usage}`;
	// Bounded: `--width 1e9` is an integer, and the frame would build a billion-column rule.
	const dim = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n > 0 && n <= MAX_TERMINAL_DIM);
	if (!dim(width)) return `--width must be an integer 1-${MAX_TERMINAL_DIM}\n${usage}`;
	if (!dim(height)) return `--height must be an integer 1-${MAX_TERMINAL_DIM}\n${usage}`;
	return { file, ownerPid, agentDir, once, ...(width ? { width } : {}), ...(height ? { height } : {}) };
}
