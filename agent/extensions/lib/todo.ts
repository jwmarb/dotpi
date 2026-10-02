/**
 * todo — pure state logic for the in-session todo list.
 *
 * Lives in `lib/` because it imports no pi package (house rule: `lib/` is
 * `node:*` only, and this file imports nothing at all), which is also what
 * makes it testable without a session.
 *
 * DESIGN NOTES (the two decisions that cost the most to get wrong)
 *
 * 1. **Mutation is op-based and id-addressed, never a whole-list write.**
 *    Claude Code's `TodoWrite` takes the entire list on every call, so a model
 *    that re-sends a partial list silently destroys the items it omitted —
 *    anthropics/claude-code#2250, filed with a repro and closed as not planned.
 *    Every op here names the item it touches (`id`), so an omission is
 *    impossible rather than merely discouraged.
 *
 * 2. **State is derived from the session branch, not held in a file.**
 *    `applyOp` is a pure reducer over a snapshot; the caller replays the
 *    snapshots recorded in tool-result `details` for the *current* branch. Fork
 *    or rewind the conversation and the list is automatically correct for that
 *    point in history, because there is no second copy to go stale. This is the
 *    storage choice pi's own `examples/extensions/todo.ts` documents, and the
 *    reason the removed `plan` extension's `agent/plans/*.jsonl` could describe
 *    work the agent no longer remembered doing.
 *
 * 3. **An unfinished list is not allowed to settle quietly.**
 *    Forgetting to mark an item done is the dominant failure mode: the work
 *    happens, the list keeps claiming it did not. `nudgeFor` and
 *    `progressSignature` are the pure half of the guard the extension installs
 *    on `agent_before_settle` — one reminder per distinct list state, so real
 *    progress re-arms it while an ignored reminder cannot wedge the session.
 *    `demotedBy` catches the same mistake one step earlier, at the `start` that
 *    silently knocked the previous item back to pending.
 */

/** Lifecycle of a single item. `blocked` needs no WIP rule, so it is uncapped. */
export type TodoStatus = "pending" | "in_progress" | "blocked" | "done";

export interface TodoItem {
	/** Stable id, `t1`-style. Never reused, so a stale reference cannot alias. */
	id: string;
	text: string;
	status: TodoStatus;
	/** Why it is blocked, or how a `done` item was confirmed. */
	note?: string;
}

/** The snapshot recorded in each tool result's `details`. */
export interface TodoState {
	items: TodoItem[];
	/** Monotonic id counter; survives deletion so ids are never recycled. */
	nextId: number;
}

export const emptyState = (): TodoState => ({ items: [], nextId: 1 });

export type TodoOp =
	| { op: "add"; texts: string[] }
	| { op: "start"; id: string }
	| { op: "complete"; id: string; note?: string }
	| { op: "block"; id: string; note: string }
	| { op: "drop"; id: string }
	| { op: "clear" };

/** A refusal. Thrown by `applyOp`; pi turns it into an `isError` tool result. */
export class TodoError extends Error {}

const find = (state: TodoState, id: string): TodoItem => {
	const item = state.items.find((i) => i.id === id);
	if (!item) {
		const known = state.items.map((i) => i.id).join(", ") || "none";
		throw new TodoError(`No todo ${id}. Existing ids: ${known}.`);
	}
	return item;
};

const clone = (state: TodoState): TodoState => ({
	items: state.items.map((i) => ({ ...i })),
	nextId: state.nextId,
});

/**
 * Apply one op, returning a new state. Never mutates the input: the snapshot in
 * a past tool result is history, and history that can be edited in place is not
 * a record of anything.
 *
 * Refuses rather than silently repairing. A refused op is visible and
 * retryable; a quietly-adjusted one teaches the model a rule that does not
 * exist.
 */
export function applyOp(prev: TodoState, op: TodoOp): TodoState {
	const state = clone(prev);

	switch (op.op) {
		case "add": {
			const texts = op.texts.map((t) => t.trim()).filter((t) => t.length > 0);
			if (texts.length === 0) throw new TodoError("add needs at least one non-empty text.");
			for (const text of texts) {
				state.items.push({ id: `t${state.nextId++}`, text, status: "pending" });
			}
			return state;
		}

		case "start": {
			const item = find(state, op.id);
			if (item.status === "done") throw new TodoError(`${op.id} is already done.`);
			// The one invariant worth enforcing in code, and the one every harness
			// states in prose: exactly one item in flight. Demote the incumbent
			// rather than refusing, so switching focus is one call, not two — but
			// say so in the result, because a silent demotion is how a list starts
			// disagreeing with what is actually being worked on.
			for (const other of state.items) {
				if (other.id !== item.id && other.status === "in_progress") other.status = "pending";
			}
			item.status = "in_progress";
			return state;
		}

		case "complete": {
			const item = find(state, op.id);
			if (item.status === "done") throw new TodoError(`${op.id} is already done.`);
			item.status = "done";
			if (op.note) item.note = op.note;
			else delete item.note;
			return state;
		}

		case "block": {
			const item = find(state, op.id);
			if (item.status === "done") throw new TodoError(`${op.id} is done; it cannot be blocked.`);
			const why = op.note.trim();
			if (!why) throw new TodoError("block needs a note saying what it is waiting on.");
			item.status = "blocked";
			item.note = why;
			return state;
		}

		case "drop": {
			find(state, op.id);
			state.items = state.items.filter((i) => i.id !== op.id);
			return state;
		}

		case "clear":
			return { items: [], nextId: state.nextId };
	}
}

export interface TodoCounts {
	total: number;
	done: number;
	inProgress: number;
	blocked: number;
	pending: number;
}

export function counts(state: TodoState): TodoCounts {
	const c: TodoCounts = { total: state.items.length, done: 0, inProgress: 0, blocked: 0, pending: 0 };
	for (const item of state.items) {
		if (item.status === "done") c.done++;
		else if (item.status === "in_progress") c.inProgress++;
		else if (item.status === "blocked") c.blocked++;
		else c.pending++;
	}
	return c;
}

/** The item the widget highlights: whatever is in flight. */
export const activeItem = (state: TodoState): TodoItem | undefined =>
	state.items.find((i) => i.status === "in_progress");

/**
 * The items that still owe an outcome: nothing has been said about whether they
 * happened. `blocked` is excluded deliberately — it has already been accounted
 * for, with a note naming what it is waiting on.
 */
export const unfinished = (state: TodoState): TodoItem[] =>
	state.items.filter((i) => i.status === "pending" || i.status === "in_progress");

/**
 * The item a `start` knocked back to pending, recovered by diffing snapshots.
 *
 * `applyOp` demotes the incumbent silently so switching focus stays one call
 * (see `start`), but the comment there promises the caller *says so* — this is
 * how. A diff rather than a second return value from `applyOp`, so the reducer
 * keeps its one-in-one-out shape and a replayed history cannot disagree with a
 * recomputed advisory.
 *
 * Why this earns a function: "agent starts the next item and never completes the
 * previous one" is the most common way a list drifts out of agreement with
 * reality, and the demotion is the last moment where the fix is one call away.
 */
export function demotedBy(prev: TodoState, next: TodoState): TodoItem | undefined {
	for (const after of next.items) {
		if (after.status !== "pending") continue;
		const before = prev.items.find((i) => i.id === after.id);
		if (before?.status === "in_progress") return after;
	}
	return undefined;
}

/**
 * Fingerprint of every item's status. Two states sharing a signature describe
 * the same unfinished work, which is what makes the settle-time reminder safe to
 * cap: one per signature fires again after real progress, but never twice for a
 * list the agent has not touched.
 */
export const progressSignature = (state: TodoState): string =>
	state.items.map((i) => `${i.id}:${i.status}`).join(",");

/** Cap on items named in a reminder, so a long list cannot dominate the turn. */
const NUDGE_MAX_LISTED = 8;

export interface TodoNudge {
	/** The message injected back into the conversation. */
	text: string;
	/** Signature of the state that produced it; one reminder per signature. */
	signature: string;
}

/**
 * The reminder to inject when the agent tries to finish with work still open, or
 * `undefined` when the list is genuinely settled.
 *
 * Names every open item and spells out all three legitimate exits. A reminder
 * that only said "you forgot" would push the model toward the one wrong repair —
 * marking unfinished work done to clear the warning — so it says not to.
 */
export function nudgeFor(state: TodoState): TodoNudge | undefined {
	const open = unfinished(state);
	if (open.length === 0) return undefined;

	const shown = open.slice(0, NUDGE_MAX_LISTED);
	const listed = shown
		.map((i) => `${i.id} (${i.status === "in_progress" ? "in progress" : "pending"}) ${i.text}`)
		.join("; ");
	const more = open.length > shown.length ? `; … ${open.length - shown.length} more` : "";
	const subject = open.length === 1 ? "1 todo item is" : `${open.length} todo items are`;

	return {
		signature: progressSignature(state),
		text:
			`Not done yet: ${subject} still open — ${listed}${more}. ` +
			"For each one do exactly one of: todo op 'complete' if it is genuinely finished, " +
			"op 'block' with a note if something is in the way, or op 'drop' if it turned out " +
			"not to be needed. If the work itself is unfinished, keep working instead of " +
			"marking it. Never mark an item done just to clear this message.",
	};
}

/**
 * One-line text for the tool result. Deliberately terse: Codex's own
 * instructions tell the model not to restate a plan the harness already
 * displays, and the widget is displaying it. Returning the full list here
 * would re-inject it into context on every single op.
 */
export function summarize(state: TodoState): string {
	const c = counts(state);
	if (c.total === 0) return "Todo list is empty.";
	const active = activeItem(state);
	const parts = [`${c.done}/${c.total} done`];
	if (c.blocked > 0) parts.push(`${c.blocked} blocked`);
	parts.push(active ? `now: ${active.text}` : "nothing in progress");
	return parts.join(" · ");
}

/** Glyph per status, shared by the widget and the `/todos` command. */
export const STATUS_GLYPH: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "◐",
	blocked: "▲",
	done: "●",
};
