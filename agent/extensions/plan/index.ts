/**
 * Plan — the agent's durable work plan.
 *
 * Every agent session (orchestrator and subagent alike) keeps a **Plan**: the
 * ordered list of steps it is executing, persisted as JSON Lines under
 * `~/.pi/agent/plans/`. The plan is dual-sourced — the conversation is the
 * working copy, the file is the durable one (docs/adr/0011). Mutation goes
 * through the single `plan` tool registered here, never through raw file
 * edits (docs/adr/0013).
 *
 * Responsibilities:
 *   - `plan` tool: add / status / seed / archive / show
 *   - Footer status line (`Plan 3/5 · ▸ <active item>`) via setStatus, which
 *     reaches both the built-in footer and /oc-footer through
 *     getExtensionStatuses
 *   - Full item list with status glyphs in a widget below the editor
 *   - Re-injection of the plan into context after compaction (session_compact)
 *     and on session resume (session_start, main sessions only)
 *   - Self-archiving: when the last non-terminal item reaches a terminal
 *     state, the file moves to plans/archive/ with a date prefix
 *
 * Plan keys: the current session's id for main sessions; the PI_PLAN_KEY
 * environment variable for subagent children (passed at spawn by the
 * subagent extension, keyed by Task ID — docs/adr/0012).
 *
 * @module plan
 */

import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import {
	dispatchSuppressed,
	REWORK_TIMEOUT_MS,
	runReview,
} from "./review.js";
// The shared Run-directory contract, so a plan-spawned Run is discoverable by
// exactly the readers that already scan the subagent layout (docs/adr/0039).
import {
	createRunDir,
	finalizeRunDir,
	runsRoot,
} from "../subagent/rundir.js";
import { setSpawnCapRoot } from "../subagent/spawnlimit.js";
import { Text } from "@earendil-works/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import {
	findPaneByLabel,
	herdrAvailable,
	renamePane,
	runInPane,
	sendPaneKeys,
	splitPane,
} from "../herdr/client.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a single Plan Item. Terminal states: done, failed, dropped.
 *
 * The non-terminal states are the Board's columns (docs/adr/0018): moving a
 * card *is* a state change, and there is no column concept separate from state.
 *
 * `backlog` is captured but not yet groomed; `ready` is specified enough to
 * start right now; `blocked` cannot proceed; `review` means the agent believes
 * it landed and is waiting on the user to accept it. Only the user moves
 * `review` -> `done`, so `done` means *accepted* (docs/adr/0017).
 *
 * `failed` means attempted and did not land; `dropped` means abandoned by
 * choice (docs/adr/0014). Both are terminal, but only `failed` claims
 * something went wrong.
 *
 * `pending` is the legacy state that `backlog` and `ready` split. It is still
 * accepted when reading files written by older builds, and is treated as
 * `backlog` everywhere it is displayed or counted.
 */
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

/** Every state this build understands, for validating lines off disk. */
const KNOWN_STATES: readonly PlanState[] = [
	"pending",
	"backlog",
	"ready",
	"active",
	"blocked",
	"review",
	"done",
	"failed",
	"dropped",
];

/**
 * States an agent may set on its own behalf, regardless of Review Route.
 *
 * `done` is absent because it is *conditional*, not forbidden: whether an agent
 * may set it depends on the item's Review Route, so it is admitted by the schema
 * and judged in the handler once the item — and therefore its route — is known.
 * A `user`-routed item still refuses; `oracle` and `skip` do not
 * (docs/adr/0023, superseding 0017).
 */
const AGENT_SETTABLE: readonly PlanState[] = [
	"backlog",
	"ready",
	"active",
	"blocked",
	"review",
	"failed",
	"dropped",
];

/**
 * Who may clear a Plan Item (docs/adr/0023).
 *
 * - `user` — only the user's hand, via `/accept`. The default when absent.
 * - `oracle` — cleared by a `pass` Verdict from an oracle review.
 * - `skip` — goes `active` → `done` directly and never enters `review`, because
 *   `review` is the column for items awaiting a reviewer and a skipped item has
 *   none.
 */
type ReviewRoute = "user" | "oracle" | "skip";

/**
 * Routes in ratchet order, least scrutiny first.
 *
 * The order *is* the rule: a route may only ever move to a later entry. That
 * one-way ratchet is what makes choosing a route at grooming time safe — an
 * agent that discovers its work is hairier than groomed can always ask for more
 * scrutiny, and can never award itself less once it knows how painful review
 * would be.
 */
const ROUTE_ORDER: readonly ReviewRoute[] = ["skip", "oracle", "user"];

/** The route an item is on, treating an absent route as `user`. */
function routeOf(item: PlanItem): ReviewRoute {
	return item.route ?? "user";
}

/**
 * The **Review Budget**: failed Verdicts allowed on one Item before its route
 * ratchets to `user`.
 *
 * Two, so a problem oracle keeps rejecting reaches a human rather than consuming
 * Runs forever (docs/adr/0032).
 */
const REVIEW_BUDGET = 2;

/**
 * Per-plan settings, stored as a single `kind: "plan-meta"` line in the plan
 * file.
 *
 * It lives in the plan file rather than settings.json because the mode is a
 * property of a body of work — one plan may be autonomous while another is not —
 * and it must survive restarts (docs/adr/0032).
 */
interface PlanMeta {
	kind: "plan-meta";
	/** When true, a newly groomed Item defaults to the `oracle` route. */
	autonomous?: boolean;
}

/** Whether a line parsed from the plan file is the plan-meta line. */
function isPlanMeta(obj: unknown): obj is PlanMeta {
	return (
		typeof obj === "object" &&
		obj !== null &&
		(obj as { kind?: unknown }).kind === "plan-meta"
	);
}

/**
 * The default Review Route for a newly groomed Item under the given meta.
 *
 * Autonomous Mode changes only this default — never an Item that stated its own
 * preference, which is what keeps ADR 0023's per-Item granularity intact.
 */
function defaultRoute(meta: PlanMeta | null): ReviewRoute {
	return meta?.autonomous ? "oracle" : "user";
}

/** One line of a plan file: one Plan Item. */
interface PlanItem {
	/** Stable id within the file, `p1`, `p2`, ... (assigned at add/seed). */
	id: string;
	/** What the step is. */
	text: string;
	status: PlanState;
	/** Free-form annotation (why it failed, what landed, ...). */
	note?: string;
	/** Task ID of the subagent delegation executing this item, if any. */
	taskId?: string;
	/**
	 * Who may clear this item (docs/adr/0023).
	 *
	 * Absent means `user`, so every plan file written before routes existed keeps
	 * exactly today's behaviour — an upgrade never silently starts auto-clearing
	 * anything. Only ever escalated, never lowered: `skip` → `oracle` → `user`.
	 */
	route?: ReviewRoute;
	/**
	 * How many oracle Verdicts have already failed this item.
	 *
	 * Bounds the `active` → `review` → `active` loop under Autonomous Mode: once
	 * the Review Budget is spent the route ratchets to `user` (docs/adr/0032).
	 */
	reviews?: number;
	/**
	 * The Run ID of a **Rework** currently working this Item, if any.
	 *
	 * Set before the worker is spawned and cleared when it ends, so it is the one
	 * fact a *different* process can use to know the Item is being edited right
	 * now. Without it, a re-review dispatched while a worker is running judges the
	 * pre-fix code, and its stale `fail` spends the last **Review Budget** unit and
	 * ratchets the route to `user` — irreversibly demoting an Item the worker had
	 * actually fixed. That was reproduced, not theorised (docs/adr/0041).
	 *
	 * On the Item rather than in the Run sidecar because `run.json` records the Run
	 * but not which Item it serves, so it cannot answer "is anyone reworking p1?".
	 * A stale value (host killed mid-Rework) is handled by treating the Run's own
	 * recorded outcome as the source of truth, not this field's presence.
	 */
	reworkRunId?: string;
}

/** Status colors per state, mapped to the theme vocabulary the other
 * extensions already use (see subagent/index.ts renderers). */
const STATE_GLYPH: Record<PlanState, string> = {
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

const STATE_COLOR: Record<PlanState, string> = {
	pending: "dim",
	backlog: "dim",
	ready: "secondary",
	active: "accent",
	blocked: "error",
	review: "warning",
	done: "success",
	failed: "error",
	dropped: "muted",
};

const TERMINAL: PlanState[] = ["done", "failed", "dropped"];

/**
 * The Board's columns, in order, as the Board Pane draws them.
 *
 * Deliberately excludes `failed` and `dropped`: they are terminal outcomes, not
 * places where work waits. Excludes `pending` because it is the legacy alias
 * for `backlog`. Exported so the Board process shares one column order with the
 * tool instead of re-deriving it (docs/adr/0018).
 */
export const BOARD_COLUMNS: readonly PlanState[] = [
	"backlog",
	"ready",
	"active",
	"blocked",
	"review",
	"done",
];

/** Collapse the legacy `pending` alias onto its modern column. */
export function canonicalState(status: PlanState): PlanState {
	return status === "pending" ? "backlog" : status;
}

/**
 * Record the Task ID of the subagent delegation that executes an existing
 * item, in place.
 *
 * Pure — validates against the items handed in and mutates the target, so
 * the guards can be exercised without the file store. The lookup and terminal
 * guards mirror op "revise": an unknown id is refused, and a terminal item is
 * a record of what happened (docs/adr/0014) that no new delegation may
 * overwrite. Re-attaching over a *different* Task ID is allowed — a step
 * re-delegated after a failure replaces the attempt that did not land — and
 * the replaced ID is returned so the overwrite is reported, never silent.
 *
 * @param items - Current items; the target is mutated in place.
 * @param key - The plan key, used in the refusal messages.
 * @param id - The item to attach the Task ID to.
 * @param taskId - The Task ID to record on the item.
 * @returns ok with the replaced ID (null when the item had none, or had this
 *          same one already), or the refusal with its error string.
 */
export function attachTaskId(
	items: PlanItem[],
	key: string,
	id: string,
	taskId: string,
):
	| { ok: true; replaced: string | null }
	| { ok: false; error: string } {
	const item = items.find((i) => i.id === id);
	if (!item)
		return {
			ok: false,
			error: `Unknown item id "${id}" in ${key}. Use op "show" to list items.`,
		};
	// A terminal item is a record of what happened; attaching a Task ID to it
	// would claim a delegation the record never ran (docs/adr/0014).
	if (TERMINAL.includes(item.status))
		return {
			ok: false,
			error: `Cannot attach a Task ID to ${item.id} in ${key}: it is already ${item.status}, and terminal items are immutable.`,
		};
	const replaced =
		item.taskId !== undefined && item.taskId !== taskId ? item.taskId : null;
	item.taskId = taskId;
	return { ok: true, replaced };
}

/**
 * Set an item's Review Route, enforcing the one-way ratchet.
 *
 * Pure and exported so the ratchet can be proven directly — the live tool cannot
 * be trusted to exercise on-disk code, since an extension is loaded once at pi
 * startup and stays resident.
 *
 * A route may only move toward more scrutiny (`skip` → `oracle` → `user`). An
 * attempt to lower one is refused rather than ignored, because silently doing
 * nothing would let an agent believe it had de-escalated its own review.
 *
 * @param items - The item list to mutate in place.
 * @param key - The plan key, used in the refusal messages.
 * @param id - The item to route.
 * @param route - The route to move to.
 * @returns ok with the previous route (or null when it had none), or a refusal.
 */
export function setRoute(
	items: PlanItem[],
	key: string,
	id: string,
	route: ReviewRoute,
):
	| { ok: true; from: ReviewRoute; unchanged: boolean }
	| { ok: false; error: string } {
	const item = items.find((i) => i.id === id);
	if (!item)
		return {
			ok: false,
			error: `Unknown item id "${id}" in ${key}. Use op "show" to list items.`,
		};
	if (TERMINAL.includes(item.status))
		return {
			ok: false,
			error: `Cannot route ${id} in ${key}: it is already ${item.status}, and terminal items are immutable.`,
		};

	const from = routeOf(item);
	if (from === route) return { ok: true, from, unchanged: true };
	if (ROUTE_ORDER.indexOf(route) < ROUTE_ORDER.indexOf(from))
		return {
			ok: false,
			error: `Cannot lower ${id} in ${key} from "${from}" to "${route}": a Review Route only ever escalates (skip → oracle → user). Ask for more scrutiny, never less.`,
		};

	item.route = route;
	return { ok: true, from, unchanged: false };
}

// ---------------------------------------------------------------------------
// Plan file store
// ---------------------------------------------------------------------------

/**
 * The three **Verdict** tokens an oracle review may return.
 *
 * `unsure` shares `fail`'s destination — both return the Item for **Rework** —
 * but stays a distinct token because it tells a reviser the work may be right
 * and could not be established, which is different guidance (docs/adr/0032).
 */
type Verdict = "pass" | "fail" | "unsure";

/**
 * Parse a **Verdict** from a review's output.
 *
 * Deliberately strict: the token must be the last non-empty line, in the exact
 * form `VERDICT: <token>`. There is no prose fallback, because guessing a
 * verdict out of surrounding text is how a review that never reached a
 * conclusion gets read as one. A missing or malformed token is not `unsure` —
 * it is a *dead review*, reported as null and retried rather than acted on
 * (docs/adr/0032).
 *
 * @param output - The review's full stdout.
 * @returns The Verdict, or null when no exact trailing token is present.
 */
export function parseVerdict(output: string): Verdict | null {
	const lines = output.trimEnd().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line) continue;
		// Only the LAST non-empty line is considered. A `VERDICT:` mentioned
		// earlier (quoting instructions, say) must not be mistaken for the answer.
		const m = /^VERDICT:\s*(pass|fail|unsure)$/i.exec(line);
		return m ? (m[1].toLowerCase() as Verdict) : null;
	}
	return null;
}

/**
 * Apply a **Verdict** to an Item, returning what should happen to it.
 *
 * Pure so the **Review Budget** ratchet can be proven without spawning a review.
 * A `pass` clears the Item. A `fail` or `unsure` returns it to `active` for
 * **Rework** and spends one unit of budget; once {@link REVIEW_BUDGET} failed
 * Verdicts have accrued, the route ratchets to `user` so a problem oracle keeps
 * rejecting reaches a human instead of consuming Runs forever (docs/adr/0032).
 *
 * @param item - The Item under review; mutated in place.
 * @param verdict - The parsed Verdict.
 * @param findings - Oracle's findings, written to the Item's note on failure.
 * @returns What was decided, for reporting.
 *
 * @remarks A `pass` sets `done` directly, bypassing the route guard in the
 * `status` op — correct, because a `pass` *is* the `oracle` route being
 * satisfied. That makes this function privileged: it must only ever be called
 * with a Verdict from a real review of an `oracle`-routed Item, never with
 * anything derived from agent or user input, or it becomes a way to set `done`
 * on an Item the user was meant to clear.
 */
export function applyVerdict(
	item: PlanItem,
	verdict: Verdict,
	findings: string,
): { cleared: boolean; escalated: boolean; reviews: number } {
	if (verdict === "pass") {
		item.status = "done";
		return { cleared: true, escalated: false, reviews: item.reviews ?? 0 };
	}
	// fail and unsure share this path by design (docs/adr/0032 amends 0023).
	const reviews = (item.reviews ?? 0) + 1;
	item.reviews = reviews;
	item.status = "active";
	// The findings replace the note and the text is left alone: the work to do is
	// unchanged, only what is known about it.
	item.note = findings;
	const escalated = reviews >= REVIEW_BUDGET;
	if (escalated) item.route = "user";
	return { cleared: false, escalated, reviews };
}

/**
 * Read and parse a plan file.
 *
 * A line that fails to parse is skipped rather than fatal: the file is the
 * durable copy, and one corrupt line must not destroy the rest of the plan.
 *
 * A **plan-meta** line (one carrying `kind: "plan-meta"` instead of an item's
 * id/text/status) holds per-plan settings such as **Autonomous Mode**. It is
 * returned separately from the items, because every writer rewrites the whole
 * file from the item list — so meta that is not threaded explicitly through
 * save is destroyed by the next mutation (docs/adr/0032).
 *
 * @param file - Absolute path of the plan file.
 * @returns Parsed items, or an empty array when the file does not exist.
 */
async function loadPlan(file: string): Promise<PlanItem[]> {
	let raw: string;
	try {
		raw = await readFile(file, "utf-8");
	} catch {
		return [];
	}
	const items: PlanItem[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj = JSON.parse(line) as Partial<PlanItem>;
			// The plan-meta line is not an item; skipping it explicitly (rather than
			// relying on it lacking id/text/status) means adding a field to meta can
			// never make it look like an item.
			if (isPlanMeta(obj)) continue;
			if (
				typeof obj.id === "string" &&
				typeof obj.text === "string" &&
				typeof obj.status === "string"
			) {
				// An unrecognised status comes from a build that knows a state
				// this one does not. Keep the item and surface it as pending
				// rather than skipping the line: misreporting a state is a
				// smaller loss than silently dropping a step (docs/adr/0014).
				const status = (KNOWN_STATES as readonly string[]).includes(obj.status)
					? (obj.status as PlanState)
					: "backlog";
				items.push({
					id: obj.id,
					text: obj.text,
					status,
					note: typeof obj.note === "string" ? obj.note : undefined,
					taskId: typeof obj.taskId === "string" ? obj.taskId : undefined,
					// An unrecognised route is dropped rather than trusted: it would
					// come from a build that knows a route this one does not, and
					// guessing wrong here means clearing work nobody reviewed. Absent
					// means `user`, the safe end of the ratchet (docs/adr/0023).
					route: (ROUTE_ORDER as readonly string[]).includes(
						obj.route as string,
					)
						? (obj.route as ReviewRoute)
						: undefined,
					reviews:
						typeof obj.reviews === "number" && Number.isFinite(obj.reviews)
							? obj.reviews
							: undefined,
					reworkRunId:
						typeof obj.reworkRunId === "string" && obj.reworkRunId !== ""
							? obj.reworkRunId
							: undefined,
				});
			}
		} catch {
			// Corrupt line: skip it, keep the rest.
		}
	}
	return items;
}

/**
 * Read the plan-meta line, if the plan has one.
 *
 * Separate from {@link loadPlan} so its eleven callers stay untouched: only the
 * few places that care about per-plan settings pay for reading them.
 *
 * @param file - Absolute path of the plan file.
 * @returns The meta line, or null when absent or unreadable.
 */
async function loadMeta(file: string): Promise<PlanMeta | null> {
	let raw: string;
	try {
		raw = await readFile(file, "utf-8");
	} catch {
		return null;
	}
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const obj: unknown = JSON.parse(line);
			if (isPlanMeta(obj))
				return {
					kind: "plan-meta",
					autonomous: obj.autonomous === true,
				};
		} catch {
			// Corrupt line: keep looking.
		}
	}
	return null;
}

/**
 * Cross-process advisory lock around a plan file.
 *
 * `withFileMutationQueue` serialises writers *inside* one process. Since the
 * Board writes the same file from its own process (docs/adr/0015), that is no
 * longer enough: two processes could interleave read-modify-write and lose an
 * item. Both writers take this lock.
 *
 * `mkdir` is the atomic primitive: it fails if the directory exists, so exactly
 * one holder wins. The lock records its owner pid and acquisition time so a
 * crashed holder can be broken rather than wedging the plan forever — an
 * unbreakable lock on your own plan file is worse than the race it prevents.
 */

/**
 * A plan mutation refused because another writer holds the lock.
 *
 * Deliberately an error rather than a silent unlocked write: a refused mutation
 * is visible and retryable, a lost one is neither (docs/adr/0035).
 */
class PlanLockTimeoutError extends Error {
	constructor(file: string) {
		super(
			`Plan file is locked by another writer and did not free up within ${LOCK_WAIT_MS}ms: ${file}. Nothing was written — retry the operation.`,
		);
		this.name = "PlanLockTimeoutError";
	}
}

/** How long a lock may be held before another writer treats it as abandoned. */
const LOCK_STALE_MS = 10_000;

/** How long to keep trying before refusing the mutation. */
const LOCK_WAIT_MS = 3000;

/** Poll interval while waiting for a held lock. */
const LOCK_POLL_MS = 50;

/**
 * Acquire the cross-process lock for a plan file.
 *
 * @param file - Absolute path of the plan file being guarded.
 * @returns A release function that removes the lock only if this caller still
 *          owns it — a holder whose lock was broken as stale must not delete the
 *          replacement holder's lock.
 * @throws {PlanLockTimeoutError} When the lock is held by a live writer for
 *         longer than the wait budget. Refusing is deliberate: proceeding
 *         unlocked loses one of the two writes silently (docs/adr/0035).
 */
async function acquirePlanLock(file: string): Promise<() => Promise<void>> {
	const lockDir = `${file}.lock`;
	const deadline = Date.now() + LOCK_WAIT_MS;

	// A per-acquisition token, so `release` can tell "my lock" from "the lock that
	// replaced mine after it was broken as stale". Without it, a slow holder
	// returning from a long write deletes the new holder's lock and two writers
	// run unlocked (docs/adr/0035).
	const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

	const writeOwner = async () => {
		try {
			await writeFile(
				path.join(lockDir, "owner.json"),
				JSON.stringify({ pid: process.pid, at: Date.now(), token }),
				{ encoding: "utf-8" },
			);
		} catch {
			// The lock is held either way; owner metadata is a debugging aid.
		}
	};

	/** Remove the lock, but only while this acquisition still owns it. */
	const release = async () => {
		try {
			const owner = JSON.parse(
				await readFile(path.join(lockDir, "owner.json"), "utf-8"),
			) as { token?: unknown };
			// Someone else's lock: leave it alone. An unreadable or token-less owner
			// file predates this scheme, so fall through and remove it as before.
			if (typeof owner.token === "string" && owner.token !== token) return;
		} catch {
			// No owner file: treat the lock as ours to clear, as the old code did.
		}
		try {
			await rm(lockDir, { recursive: true, force: true });
		} catch {
			// Already gone: nothing to undo.
		}
	};

	/** Break a lock judged stale, ignoring whose it is. */
	const breakStale = async () => {
		try {
			await rm(lockDir, { recursive: true, force: true });
		} catch {
			// Someone else broke it first.
		}
	};

	while (true) {
		try {
			await mkdir(lockDir, { recursive: false });
			await writeOwner();
			return release;
		} catch {
			// Held by someone. Decide whether they are alive or abandoned.
			//
			// The owner file is written just *after* the directory is created, so a
			// fresh lock legitimately has no owner.json for a moment. Treating that
			// as stale would break a live lock and lose the holder's write, so the
			// directory's own mtime is the fallback age.
			let age: number;
			try {
				const raw = await readFile(path.join(lockDir, "owner.json"), "utf-8");
				const owner = JSON.parse(raw) as { at?: number };
				age =
					typeof owner.at === "number"
						? Date.now() - owner.at
						: await lockDirAge(lockDir);
			} catch {
				age = await lockDirAge(lockDir);
			}

			if (age > LOCK_STALE_MS) {
				// Breaking someone else's abandoned lock, so this must ignore
				// ownership — `release` deliberately refuses to touch another
				// acquisition's lock.
				await breakStale();
				try {
					await mkdir(lockDir, { recursive: false });
					await writeOwner();
					return release;
				} catch {
					// Lost the race to break it; keep waiting rather than proceed.
				}
			} else if (Date.now() > deadline) {
				// The holder looks alive but is slower than our budget. Fail rather
				// than proceed unlocked: returning a no-op release let two processes
				// each read, mutate and atomically rename, so the second rename
				// silently discarded the first writer's item. Atomic rename prevents a
				// *torn* file, never a lost update — and the in-process mutation queue
				// cannot help, since the contending writer is another process (every
				// subagent child runs this same extension with its own PI_PLAN_KEY).
				//
				// A refused mutation is recoverable: the caller reports it and retries.
				// A lost one is invisible (docs/adr/0035).
				throw new PlanLockTimeoutError(file);
			}

			await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
		}
	}
}

/**
 * Age of a lock directory from its own mtime.
 *
 * Used when `owner.json` is absent or unreadable: a lock that exists but has no
 * owner metadata is presumed fresh while the directory itself is young.
 *
 * @returns Milliseconds since the directory was created, or Infinity if it has
 *          vanished (in which case it is free, and "infinitely stale" is right).
 */
async function lockDirAge(lockDir: string): Promise<number> {
	try {
		const info = await stat(lockDir);
		return Date.now() - info.mtimeMs;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/**
 * Atomically read, transform, and rewrite a plan file as one unit of the
 * per-file mutation queue — concurrent tool calls on the same key cannot lose
 * each other's items.
 *
 * The items handed to `mutate` are always re-read from disk under the lock, so
 * a change the Board made since this process last looked is never clobbered
 * (docs/adr/0015).
 *
 * @param file - Absolute path of the plan file.
 * @param mutate - Transform from current items to the next items.
 * @param mutateMeta - Optional transform of the plan-meta line. Omit it to carry
 *        existing meta through unchanged; meta is always preserved either way.
 * @returns The item list that was persisted.
 * @throws {PlanLockTimeoutError} When another writer holds the lock for longer
 *         than the wait budget. Nothing is written; the caller reports it and
 *         the user or agent retries (docs/adr/0035).
 */
async function mutatePlan(
	file: string,
	mutate: (items: PlanItem[]) => PlanItem[] | Promise<PlanItem[]>,
	mutateMeta?: (meta: PlanMeta | null) => PlanMeta | null,
): Promise<PlanItem[]> {
	let next: PlanItem[] = [];
	await withFileMutationQueue(file, async () => {
		const release = await acquirePlanLock(file);
		try {
			const items = await loadPlan(file);
			next = await mutate(items);
			// Meta is read and rewritten inside the same lock as the items. Without
			// this the first mutation after setting Autonomous Mode would silently
			// delete it, since the file is rewritten wholly from the item list.
			const curMeta = await loadMeta(file);
			const nextMeta = mutateMeta ? mutateMeta(curMeta) : curMeta;
			await mkdir(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp-${process.pid}`;
			// Meta leads the file so a human reading the JSONL sees the plan's mode
			// before its items.
			const lines = [
				...(nextMeta ? [JSON.stringify(nextMeta)] : []),
				...next.map((i) => JSON.stringify(i)),
			];
			await writeFile(
				tmp,
				lines.join("\n") + (lines.length ? "\n" : ""),
				{ encoding: "utf-8" },
			);
			await rename(tmp, file);
		} finally {
			await release();
		}
	});
	return next;
}

/**
 * Move a completed plan file into the archive with a date prefix.
 *
 * Collisions (two archived plans for the same key on the same day, e.g. a
 * session that continued after archiving) are resolved with a `.2`, `.3`
 * suffix rather than overwriting — an archive that eats history defeats the
 * point of keeping it.
 *
 * @param file - Absolute path of the plan file to archive.
 * @returns The archive path the file now lives at.
 */
async function archivePlan(file: string): Promise<string> {
	const dir = path.dirname(file);
	const archiveDir = path.join(dir, "archive");
	await mkdir(archiveDir, { recursive: true });
	const name = path.basename(file);
	const date = new Date().toISOString().slice(0, 10);
	let target = path.join(archiveDir, `${date}-${name}`);
	let n = 2;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			await readFile(target, "utf-8");
			// Exists: bump the collision suffix.
			target = path.join(archiveDir, `${date}-${name.replace(/\.jsonl$/, `.${n}.jsonl`)}`);
			n++;
		} catch {
			break; // Free.
		}
	}
	await withFileMutationQueue(file, async () => {
		await rename(file, target);
	});
	return target;
}

/** Format one item as a human/LLM-readable line. */
function formatItem(item: PlanItem): string {
	let line = `${STATE_GLYPH[item.status]} ${item.id} ${item.text}`;
	if (item.taskId) line += ` [${item.taskId}]`;
	if (item.note) line += ` — ${item.note}`;
	return line;
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const PlanItemParam = Type.Object({
	text: Type.String({ description: "What the step is." }),
	note: Type.Optional(
		Type.String({ description: "Optional annotation attached at creation." }),
	),
	taskId: Type.Optional(
		Type.String({
			description:
				"Task ID (e.g. sub-a3f1) of a subagent delegation that executes this item — settable at creation (op add / op seed) or later on an existing item (op attach).",
		}),
	),
});

const PlanParams = Type.Object({
	op: StringEnum(["add", "status", "revise", "seed", "attach", "route", "autonomous", "archive", "show"] as const, {
		description: [
			"add = append a new item (requires text).",
			"status = move an item to a new state (requires id and state); the plan archives itself when every item is terminal.",
			"revise = rewrite an existing item's text in place, keeping its id, position and taskId (requires id and text). Use it when the work changes shape; terminal items cannot be revised.",
			"attach = record the Task ID of the subagent delegation executing an item (requires id and taskId).",
			'route = set who may clear an item: "user" (you cannot clear it), "oracle" (a pass Verdict clears it), or "skip" (it never enters review). Requires id and route. Routes only ever escalate skip → oracle → user: you may always ask for more scrutiny, never less.',
			'autonomous = turn Autonomous Mode on or off for the whole plan (requires "on"). While on, an item you groom to "ready" defaults to the "oracle" route instead of "user", so it is reviewed without the user. Items already routed keep their route.',
			'seed = create a fresh plan for another plan key — the way you write a subagent\'s Starter Plan after delegating (requires for and items). Never clobbers an existing plan.',
			"archive = move the plan file to the archive (all items must be terminal; a no-op report if already archived).",
			"show = read the current plan back.",
		].join(" "),
	}),
	text: Type.Optional(
		Type.String({ description: "Item text (op add / op revise)." }),
	),
	note: Type.Optional(
		Type.String({
			description:
				"Annotation (op add / op status — e.g. why an item failed).",
		}),
	),
	id: Type.Optional(
		Type.String({ description: "Item id, e.g. p3 (op status / op revise / op attach; archive of a single item is not supported — archive moves the whole plan)." }),
	),
	state: Type.Optional(
		StringEnum(
			[
				"pending",
				"backlog",
				"ready",
				"active",
				"blocked",
				"review",
				"done",
				"failed",
				"dropped",
			] as const,
			{
				description:
					"New state for the item (op status). These are the Board's columns: backlog (captured, not yet groomed) → ready (specified enough to start now) → active (in progress) → review (you believe it landed). Use blocked when it cannot proceed, dropped — not failed — for a step abandoned by choice. done depends on the item's Review Route: a `user`-routed item (the default) refuses it, so move that work to review and let the user accept it.",
			},
		),
	),
	taskId: Type.Optional(
		Type.String({
			description:
				"Task ID (e.g. sub-a3f1) of a subagent delegation executing an item: op add records it on the new item, op attach sets it on an existing item (requires id).",
		}),
	),
	route: Type.Optional(
		StringEnum(["user", "oracle", "skip"] as const, {
			description:
				'Who may clear an item (op route, or op add to set it at creation): "user" — only the user, via /accept; "oracle" — a pass Verdict from an oracle review; "skip" — goes straight to done without review. Absent means "user". Only ever escalates: skip → oracle → user.',
		}),
	),
	on: Type.Optional(
		Type.Boolean({
			description:
				"Whether to turn Autonomous Mode on (true) or off (false), for op autonomous.",
		}),
	),
	items: Type.Optional(
		Type.Array(PlanItemParam, {
			description: "Items to seed (op seed).",
		}),
	),
	for: Type.Optional(
		Type.String({
			description:
				"Plan key to address, overriding the default (this session's plan). Use the Task ID of a subagent you just delegated to, e.g. sub-a3f1 — that is how you seed its Starter Plan.",
		}),
	),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Ensure a Board Pane exists for this session, watching this plan file.
 *
 * The Board is a separate process in its own herdr pane (docs/adr/0015), split
 * off the caller's pane so it stays visible without stealing focus. Silently
 * does nothing outside a herdr TUI — which also covers subagent children, since
 * they inherit no pane identity.
 *
 * A board pane is *adopted* rather than assumed: a session that resumes, is
 * imported, or is reloaded gets a new session id and therefore a new plan file
 * path, while any board pane from before is still running and watching the old
 * one. Adoption re-points the existing pane at the current file instead of
 * leaving a board that silently shows a stale plan, or stacking a second pane
 * beside it.
 *
 * @param file - Plan file the Board should watch.
 */
let boardPaneId: string | null = null;

/** Pane label the Board claims, and the marker used to re-find it. */
const BOARD_PANE_LABEL = "Board";

async function ensureBoard(file: string): Promise<void> {
	if (!herdrAvailable()) return;

	const boardScript = path.join(
		// Resolve next to this module rather than by cwd: the session's cwd is the
		// user's project, not the extension directory.
		path.dirname(new URL(import.meta.url).pathname),
		"board.ts",
	);
	const command = `bun ${JSON.stringify(boardScript)} ${JSON.stringify(file)}`;

	// Reuse a board pane already on screen, whoever started it.
	const existing = boardPaneId ?? (await findPaneByLabel(BOARD_PANE_LABEL));
	if (existing) {
		boardPaneId = existing;
		// Interrupt whatever it is watching and re-point it at this session's
		// plan. Idempotent when it is already the right file.
		await sendPaneKeys(existing, "ctrl+c");
		await runInPane(existing, command);
		return;
	}

	const paneId = await splitPane({ direction: "right", cwd: process.cwd() });
	if (!paneId) return;
	boardPaneId = paneId;
	await renamePane(paneId, BOARD_PANE_LABEL);
	await runInPane(paneId, command);
}

/**
 * Whether a Rework Run is still working, according to the Run itself.
 *
 * The Item's `reworkRunId` says a Rework was *started*; only the Run's own
 * `run.json` says whether it is still going. Trusting the marker alone would let
 * a host killed mid-Rework leave an Item permanently unreviewable, turning an
 * interlock into a stall — so an unreadable or absent sidecar reads as "not
 * running", i.e. proceed. Refusing to review is the cautious answer only while
 * there is positive evidence a writer is live (docs/adr/0041).
 */
export async function reworkStillRunning(runId: string): Promise<boolean> {
	try {
		const meta = JSON.parse(
			await readFile(
				path.join(getAgentDir(), "subagent-sessions", runId, "run.json"),
				"utf-8",
			),
		) as { outcome?: unknown };
		if (meta.outcome !== "running") return false;
		// `running` is a claim about now, and whoever would have corrected it may be
		// gone. Two wrong answers are possible and they are not equally bad: saying
		// "still running" when it is not wedges the Item (annoying, recoverable),
		// while saying "finished" when it is not runs a review against a tree the
		// rework is still editing (silently wrong findings). So the order below moves
		// from strongest evidence to weakest, and only ever gives up on a bound.
		const runDir = path.join(getAgentDir(), "subagent-sessions", runId);
		const entries = await readdir(runDir).catch(() => [] as string[]);

		// 1. The **Done signal** or the wrapper's exit code. Both are written by the
		// child's own side, so they survive the orchestrator and are proof the work
		// is over no matter who else is alive.
		if (entries.some((e) => e.endsWith(".exit") || e.endsWith(".exitcode"))) {
			return false;
		}

		// 2. The child's own pid, written by its wrapper before pi starts. This is the
		// only *affirmative* liveness evidence available, and it must be the CHILD's
		// pid rather than the spawner's: herdr owns a **Native Run**, so the child
		// outlives whoever launched it (docs/adr/0044) and a dead spawner proves
		// nothing. An earlier attempt probed the spawner and was rejected for exactly
		// that. A live pid here means the rework is genuinely still working, however
		// long it has been silent — which is the case transcript age gets wrong.
		const pidFile = entries.find((e) => e.endsWith(".pid"));
		if (pidFile) {
			const raw = await readFile(path.join(runDir, pidFile), "utf-8").catch(
				() => "",
			);
			const pid = Number.parseInt(raw.trim(), 10);
			if (Number.isInteger(pid) && pid > 0) {
				try {
					// Signal 0 tests existence without delivering anything. EPERM means a
					// live process owned by someone else, so it counts as alive.
					process.kill(pid, 0);
					return true;
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
					// The child is gone and wrote no Done signal: killed with its pane, or
					// crashed hard. Either way it is not still working.
					return false;
				}
			}
		}

		// 3. No pid file: a **Fallback path** rework (its wrapper never ran) or one
		// launched before the wrapper wrote pids. Fall back to transcript staleness,
		// which is weaker — it detects absence of progress, not termination — so the
		// bound is generous and is a backstop, not the primary signal.
		const sessions = entries.filter((e) => e.endsWith(".jsonl"));
		const mtimes = await Promise.all(
			sessions.map((s) =>
				stat(path.join(runDir, s))
					.then((st) => st.mtimeMs)
					.catch(() => 0),
			),
		);
		// A Run dir with neither pid nor transcript: the spawner died between creating
		// run.json and the child producing anything. Age the *directory* rather than
		// believing `running` forever — believing it unconditionally is the original
		// wedge bug, just relocated to a narrower window.
		const newest = mtimes.length > 0 ? Math.max(...mtimes) : 0;
		const reference =
			newest > 0
				? newest
				: await stat(runDir)
						.then((st) => st.mtimeMs)
						.catch(() => 0);
		if (reference === 0) return false;
		return Date.now() - reference < REWORK_TIMEOUT_MS;
	} catch {
		// No sidecar, unreadable, or corrupt: do not block the review.
		return false;
	}
}

/**
 * Dispatch an autonomous oracle review of one Item and apply the **Verdict**.
 *
 * Fire-and-forget: the caller does not await this, because a review takes
 * minutes and the `status` op must return immediately. Everything is therefore
 * reported through the plan file itself — the Item's note and route — which is
 * the only channel a plan-spawned review has (it has no Mirror Pane, no Board
 * progress line and no Reminder; docs/adr/0032).
 *
 * Never throws. A dead review (no parsable Verdict, a crash, a wedge) leaves the
 * Item in `review` with the reason in its note, so the next pass can retry it
 * rather than the work being silently cleared or silently lost.
 *
 * @param file - Absolute path of the plan file.
 * @param id - The Item to review.
 * @param cwd - Working directory for the review.
 */
async function dispatchReview(
	file: string,
	id: string,
	cwd: string,
): Promise<void> {
	try {
		// The interlock is enforced HERE as well as at the call site, so a future
		// second caller cannot reintroduce unbounded recursion by forgetting it.
		// ADR 0032 rejected honour-system obligations for exactly this reason.
		if (dispatchSuppressed()) return;
		const items = await loadPlan(file);
		const item = items.find((i) => i.id === id);
		// The Item may have moved on while the review was being set up.
		if (!item || item.status !== "review" || routeOf(item) !== "oracle") return;

		// Refuse to review an Item a Rework worker is still editing. Judging code
		// mid-change produces a stale Verdict, and a stale `fail` spends the last
		// Review Budget unit and ratchets the route to `user` for good — reproduced,
		// not theorised (docs/adr/0041). The worker's own recorded outcome decides,
		// not the marker's mere presence, so a marker orphaned by a killed host
		// cannot stall the Item forever.
		if (item.reworkRunId && (await reworkStillRunning(item.reworkRunId))) {
			await mutatePlan(file, (cur) => {
				const target = cur.find((i) => i.id === id);
				if (!target || target.status !== "review") return cur;
				target.note = [
					target.note,
					`[review not started: a rework (\`/run ${item.reworkRunId}\`) is still` +
						` working this item. Re-submit it once that finishes.]`,
				]
					.filter(Boolean)
					.join("\n\n");
				return cur;
			});
			return;
		}

		/**
		 * Set inside the Verdict transaction when the Item goes back for Rework.
		 *
		 * The spawn happens AFTER the transaction: holding the plan lock across a
		 * child process that runs for minutes would block every other plan writer
		 * (docs/adr/0035), and the Rework worker itself needs the lock-free plan.
		 */
		// A holder object rather than a `let`: the assignment happens inside the
		// mutatePlan callback, and the compiler does not track writes made through a
		// closure, so a plain `let` narrows to `never` at the read below.
		const pending: { rework?: { text: string; findings: string } } = {};

		// Give the review a Run directory in the shared on-disk layout, so it shows
		// up in /runs, on the Board and in a Mirror Pane like any subagent Run
		// (docs/adr/0039). The `pln-` prefix marks the producer and deliberately does
		// NOT match the subagent extension's `sub-` ID reservation, so the two mint
		// independently without colliding.
		const runId = `pln-${randomBytes(4).toString("hex")}-1`;
		const runDir = await createRunDir(getAgentDir(), runId, "oracle");
		let outcome: Awaited<ReturnType<typeof runReview>>;
		try {
			outcome = await runReview({
				agentFile: path.join(getAgentDir(), "agents", "oracle.md"),
				itemText: item.text,
				note: item.note,
				cwd,
				runDir,
				runId,
			});
		} finally {
			// In a `finally` because a review that threw or was killed is exactly the
			// one whose outcome a reader needs: a sidecar left saying "running" makes
			// the Mirror Pane claim forever that the Run is about to start, which is
			// the p40 dishonest-waiting bug (docs/adr/0036).
			void finalizeRunDir(
				runDir,
				runId,
				"oracle",
				// A dead review is a failed Run: it produced no Verdict. Only a review
				// that ran to completion counts as completed, whatever it decided.
				outcome! && !outcome!.deadReason ? "completed" : "failed",
			);
		}
		const verdict = outcome.deadReason
			? null
			: parseVerdict(outcome.output);

		await mutatePlan(file, (cur) => {
			const target = cur.find((i) => i.id === id);
			// Re-checked inside the lock: the user may have accepted or re-routed
			// the Item during the minutes the review took, and their hand wins.
			if (!target || target.status !== "review" || routeOf(target) !== "oracle")
				return cur;

			if (!verdict) {
				// A dead review is NOT a Verdict and must not spend the Review
				// Budget: doing so would let a flaky endpoint escalate work that was
				// never actually judged. The Item stays in `review`, awaiting retry.
				target.note = [
					target.note,
					`[autonomous review produced no verdict: ${
						outcome.deadReason ?? "no VERDICT token in the reply"
					}. The item stays in review; it was not judged.]`,
				]
					.filter(Boolean)
					.join(" — ");
				return cur;
			}

			const findings = reviewFindings(outcome.output, verdict);
			const applied = applyVerdict(target, verdict, findings);
			// Captured while the locked item is in hand: reading it again after the
			// transaction would race the user accepting or re-routing the Item.
			if (!applied.cleared && !applied.escalated) {
				pending.rework = { text: target.text, findings };
			}
			return cur;
		});

		// A failed Verdict returns the Item to `active` carrying findings, and
		// something has to pick it up or the loop stalls there. A FRESH Run does it,
		// never the agent whose work was just rejected — that agent believed the work
		// was correct when it moved the Item to `review` (docs/adr/0041).
		//
		// Deliberately NOT dispatched once the Review Budget has escalated the Item
		// to the user: two Verdicts have then failed, the machine has had its turn,
		// and spawning another writer is the runaway the Budget exists to stop.
		if (pending.rework) {
			await dispatchRework(
				file,
				id,
				cwd,
				pending.rework.text,
				pending.rework.findings,
			);
		}
	} catch {
		// Swallowed by design: this runs detached, so a throw here would be an
		// unhandled rejection that kills the host. The plan file is the report.
	}
}

/**
 * Spawn a fresh Run to carry out the **Rework** of a rejected Plan Item.
 *
 * The counterpart of {@link dispatchReview} and deliberately its twin: same
 * interlock, same Run directory, same slot discipline. The difference is what it
 * spawns — a `worker`, which can `write`, `edit` and `bash` — and that is why
 * every guard here is load-bearing rather than ceremonial. This is the only place
 * in the system where a machine's judgement causes a machine to modify the
 * repository with no human in the loop.
 *
 * Four properties make that acceptable, and all four had to exist first
 * (docs/adr/0041): the Run is observable as a `pln-` Run with a `/runs` row and a
 * Mirror Pane (0039); it claims a slot from the one shared spawn cap (0040); its
 * edits are revertable because the repo is under git; and it is bounded by the
 * **Review Budget**, so an Item cannot be reworked forever.
 *
 * Never throws: a rejection here is detached and would kill the host.
 *
 * @param file - The plan file the Item lives in.
 * @param id - The Item being reworked.
 * @param cwd - Where the worker should run, i.e. the repo it may modify.
 * @param itemText - What the step is; unchanged by the failed review.
 * @param findings - What the reviewer objected to. The worker's only context.
 */
async function dispatchRework(
	file: string,
	id: string,
	cwd: string,
	itemText: string,
	findings: string,
): Promise<void> {
	// Checked here as well as by the spawner, for the same reason the review
	// interlock is doubled: a guard only at the call site is one a new caller can
	// forget, which is how the fork bomb escaped (docs/adr/0037).
	if (dispatchSuppressed()) return;
	try {
		const runId = `pln-${randomBytes(4).toString("hex")}-1`;
		const runDir = await createRunDir(getAgentDir(), runId, "worker");
		// Publish the in-flight marker BEFORE spawning, so a re-review cannot slip
		// between the spawn and the mark and judge code the worker is mid-way through
		// changing. The plan file is the only channel another process reads.
		await mutatePlan(file, (cur) => {
			const target = cur.find((i) => i.id === id);
			if (target) target.reworkRunId = runId;
			return cur;
		});
		let outcome: Awaited<ReturnType<typeof runReview>>;
		try {
			outcome = await runReview({
				agentFile: path.join(getAgentDir(), "agents", "worker.md"),
				itemText,
				note: findings,
				cwd,
				runDir,
				runId,
				purpose: "rework",
			});
		} finally {
			void finalizeRunDir(
				runDir,
				runId,
				"worker",
				outcome! && !outcome!.deadReason ? "completed" : "failed",
			);
		}

		// The worker's report is APPENDED to the note, not substituted for it:
		// oracle's findings are why the Rework happened and must survive it, or the
		// next reader sees a fix with no statement of what it was fixing.
		await mutatePlan(file, (cur) => {
			const target = cur.find((i) => i.id === id);
			if (!target) return cur;
			// Cleared unconditionally, even when the Item has moved on and gets no
			// report below: a marker left set would block every future review of this
			// Item, turning a safety interlock into a permanent stall.
			if (target.reworkRunId === runId) target.reworkRunId = undefined;
			// The user may have accepted, re-routed or finished the Item during the
			// minutes the worker took. Their hand wins, as with a late Verdict.
			if (target.status !== "active") return cur;
			target.note = [
				target.note,
				outcome.deadReason
					? `[rework did not complete: ${outcome.deadReason}. The findings above still stand.]`
					: `[rework attempted by a fresh run — see \`/run ${runId}\` for what it did. Re-review to judge it.]`,
			]
				.filter(Boolean)
				.join("\n\n");
			return cur;
		});
	} catch {
		// Swallowed by design, as in dispatchReview: the plan file is the report.
	}
}

/**
 * Reduce a review transcript to the findings written onto a failed Item.
 *
 * The whole transcript is kept for a `fail` or `unsure`, minus the Verdict line
 * itself: a fresh **Run** doing the **Rework** has only this note and no session
 * history, so trimming it to a summary would throw away the very detail that
 * makes the finding actionable (docs/adr/0032).
 */
function reviewFindings(output: string, verdict: string): string {
	const body = output
		.trimEnd()
		.split("\n")
		.filter((l) => !/^VERDICT:\s*(pass|fail|unsure)$/i.test(l.trim()))
		.join("\n")
		.trim();
	return `[oracle review: ${verdict}] ${body}`;
}

export default function (pi: ExtensionAPI) {
	// This process spawns children too — autonomous reviews and Rework workers — so
	// it must count against the same tree-wide budget as delegated Runs. Without
	// this call the plan extension would keep its own in-memory six and the shared
	// cap would bound nothing (docs/adr/0044, amending 0040).
	setSpawnCapRoot(runsRoot(getAgentDir()));

	/** The plan file key for the *current* session: a subagent child is keyed
	 * by the Task ID its spawner passed in the environment (docs/adr/0012);
	 * a main session is keyed by its session id (docs/adr/0011). */
	const currentKey = (ctx: ExtensionUIContext): string => {
		if (process.env.PI_PLAN_KEY) return process.env.PI_PLAN_KEY;
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			return "session";
		}
	};

	const planFileFor = (ctx: ExtensionUIContext, keyOverride?: string): string =>
		path.join(
			getAgentDir(),
			"plans",
			`${keyOverride ?? currentKey(ctx)}.jsonl`,
		);

	/** Live plan state feeding the widget renderer. The renderer reads this on
	 * every TUI render, so mutations only need to update it and request a
	 * render — no per-render file I/O. */
	const view: { items: PlanItem[]; file: string | null } = {
		items: [],
		file: null,
	};

	/**
	 * Reflect the current plan in the footer status line and the widget below
	 * the editor.
	 *
	 * The status line is the one-line form (`Plan 3/5 · ▸ <active item>`); the
	 * widget is the full item list with status glyphs — the footer is a
	 * single-line surface by construction, so the full list lives in the
	 * widget (both surfaces refresh from the same `view` state).
	 *
	 * Never throws: this runs from event handlers where an exception would be
	 * an uncaughtException.
	 */
	const refreshUi = (ui: ExtensionUIContext | undefined, tui?: unknown) => {
		try {
			if (!ui || !ui.hasUI) return;
			const { items } = view;
			if (items.length === 0) {
				ui.setStatus("plan", undefined);
				ui.setWidget("plan", undefined);
				return;
			}
			const done = items.filter((i) => i.status === "done").length;
			const failed = items.filter((i) => i.status === "failed").length;
			const dropped = items.filter((i) => i.status === "dropped").length;
			const review = items.filter((i) => i.status === "review").length;
			const blocked = items.filter((i) => i.status === "blocked").length;
			const active = items.find((i) => i.status === "active");
			// Abandoned work is not work you owe: dropped items leave the
			// denominator and are reported as a suffix (docs/adr/0014).
			const tracked = items.length - dropped;
			const suffix =
				// `review` is surfaced first: it is the only state that needs the
				// user to act, since only the user moves review -> done (adr/0017).
				(review ? `${review}?` : "") +
				(review && (blocked || failed || dropped) ? " " : "") +
				(blocked ? `${blocked}⊗` : "") +
				(blocked && (failed || dropped) ? " " : "") +
				(failed ? `+${failed}✗` : "") +
				(failed && dropped ? " " : "") +
				(dropped ? `${dropped}⊘` : "");
			const count = `Plan ${done}${suffix ? ` (${suffix})` : ""}/${tracked}`;
			const statusText = active
				? `${count} · ▸ ${active.text.length > 40 ? active.text.slice(0, 40) + "…" : active.text}`
				: count;
			ui.setStatus("plan", statusText);

			ui.setWidget(
				"plan",
				(t, theme) => {
					const lines = items.map((item) =>
						theme.fg(STATE_COLOR[item.status] as never, STATE_GLYPH[item.status]) +
						theme.fg("muted", ` ${item.id} `) +
						(item.status === "active"
							? theme.fg("accent", item.text)
							: theme.fg("dim", item.text)) +
						(item.taskId ? theme.fg("warning", ` [${item.taskId}]`) : "") +
						(item.note ? theme.fg("muted", ` — ${item.note}`) : ""),
					);
					return new Text(lines.join("\n"), 0, 0);
				},
				{ placement: "belowEditor" },
			);
			void tui;
		} catch {
			// A torn-down or reloaded TUI must not take down the session.
		}
	};

	/**
	 * Re-inject the current plan into the conversation so it survives
	 * compaction by construction rather than by model compliance
	 * (docs/adr/0011).
	 *
	 * `nextTurn` delivery queues the message for the next LLM call without
	 * triggering a turn on its own — the plan re-enters context exactly when
	 * the agent next acts, and never interrupts anything.
	 */
	const reinjectPlan = (ctx: ExtensionUIContext, reason: string): void => {
		try {
			const key = currentKey(ctx);
			void (async () => {
				const file = planFileFor(ctx);
				const items = await loadPlan(file);
				if (items.length === 0) return;
				const open = items.filter((i) => !TERMINAL.includes(i.status));
				if (open.length === 0) return; // Nothing left to track.
				const text = [
					`Your plan (key: ${key}, file: ${file}) — re-injected ${reason}:`,
					...items.map(formatItem),
					"",
					"Continue tracking it with the plan tool. Do not re-create it.",
				].join("\n");
				pi.sendMessage(
					{
						customType: "plan_restore",
						content: text,
						display: false,
					},
					{ deliverAs: "nextTurn" },
				);
			})().catch(() => {});
		} catch {
			// Re-injection is a safety net; its own failure must not crash the session.
		}
	};

	pi.registerTool<typeof PlanParams, { key: string; file: string }>({
		name: "plan",
		label: "Plan",
		description: [
			"Maintain your Plan — the ordered list of steps you are executing to keep work on track.",
			"The plan persists to a .jsonl file under ~/.pi/agent/plans (one line per item), survives compaction (it is re-injected automatically), and archives itself into plans/archive/ when every item is done, failed or dropped.",
			'Use it before and while doing any work that requires careful execution — when in doubt, make a plan; a one-item plan is fine. Only a purely conversational reply needs no plan.',
			"Revise an item's wording with op revise when the work changes shape, and mark a step you abandon as dropped rather than failed.",
			"When a subagent delegation takes over a step, record the Task ID on that step with op attach — the Board shows a step's live progress only for cards carrying a Task ID.",
			"States are the Board's columns: backlog → ready → active → review. Whether you may set done depends on the item's Review Route — by default you cannot, so move finished work to review and let the user accept it.",
			"Maintain the plan exclusively with this tool — never by editing the plan file with write/edit.",
		].join(" "),
		promptSnippet:
			"Maintain your Plan (ordered work list) — add / status / revise / seed / attach / archive / show. Persists to disk, survives compaction.",
		promptGuidelines: [
			"Before executing any procedure that requires careful execution, establish your Plan with the plan tool — when in doubt, make a plan. Only purely conversational replies need no plan.",
			"The plan is session-wide and accumulates across requests; keep at most one item active and move it to review/failed/dropped before moving on.",
			'Item states are the Board\'s columns: "backlog" (captured, not yet groomed), "ready" (specified enough to start now), "active" (in progress, limit one), "blocked" (cannot proceed — use it instead of leaving an item falsely active), "review" (you believe it landed).',
			'"done" means the item\'s Review Route was satisfied, not "I finished". An item routed "user" — the default when no route is set — reaches done only by the user\'s hand via /accept, so finish your work by moving it to "review" and saying so. An item routed "oracle" is cleared by a pass Verdict; one routed "skip" goes straight to done. Set a route with op "route", and remember it only ever escalates (skip → oracle → user): you may always ask for more scrutiny, never less.',
			'When advice or new facts change the shape of the work (e.g. an oracle or planner Result), rewrite the affected items with op "revise" and mark abandoned ones "dropped" — "failed" means attempted and did not land, not "we changed our mind".',
			'When delegating to a subagent: write the child\'s Starter Plan into the delegation text, seed it via plan op "seed" for the returned Task ID, and record that Task ID on the plan item that delegates the step with plan op "attach" (the item\'s id + the Task ID — the item always exists before its delegation runs). The child owns its plan file from then on.',
		],
		parameters: PlanParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const key = params.for ?? currentKey(ctx);
			const file = planFileFor(ctx, params.for);
			const ui = ctx.hasUI ? ctx.ui : undefined;

			const result = (
				text: string,
				override?: { key: string; file: string },
			) => {
				refreshUi(ui, undefined);
				return {
					content: [{ type: "text" as const, text }],
					details: override ?? { key, file },
				};
			};

			switch (params.op) {
				case "show": {
					const items = await loadPlan(file);
					if (items.length === 0)
						return result(`No plan yet for ${key} (${file}).`);
					view.items = items;
					view.file = file;
					return result(
						`Plan for ${key} (${file}):\n${items.map(formatItem).join("\n")}`,
					);
				}

				case "add": {
					if (!params.text)
						return result('op "add" requires "text".', undefined);
					const items = await mutatePlan(file, (cur) => {
						const maxN = cur.reduce((m, i) => {
							const n = /^p(\d+)$/.exec(i.id)?.[1];
							return n ? Math.max(m, parseInt(n, 10)) : m;
						}, 0);
						const item: PlanItem = {
							id: `p${maxN + 1}`,
							text: params.text,
							status: "backlog",
							note: params.note,
							taskId: params.taskId,
							// A route at creation is allowed because a new item has no route
							// to lower — the ratchet only constrains *changes*, which op
							// "route" enforces (docs/adr/0023).
							route: params.route,
						};
						cur.push(item);
						return cur;
					});
					view.items = items;
					view.file = file;
					return result(
						`Added ${items[items.length - 1].id} to ${key} (${items.length} item${items.length === 1 ? "" : "s"}): ${params.text}`,
					);
				}

				case "status": {
					if (!params.id || !params.state)
						return result(
							'op "status" requires "id" and "state".',
							undefined,
						);
					// `done` means the item's Review Route was satisfied (docs/adr/0023,
					// superseding 0017's "only the user"). The guard is therefore no
					// longer judgeable from the target state alone — it needs the item's
					// route in hand, so the legality check moves below the lookup.
					if (
						params.state !== "done" &&
						!(AGENT_SETTABLE as readonly string[]).includes(params.state)
					)
						return result(
							`Cannot set "${params.state}": it is not an agent-settable state.`,
							undefined,
						);
					const items = await loadPlan(file);
					const item = items.find((i) => i.id === params.id);
					if (!item)
						return result(
							`Unknown item id "${params.id}" in ${key}. Use op "show" to list items.`,
							undefined,
						);

					// Now the route is in hand, judge a `done` on its terms. A `user`
					// route still refuses, and that refusal is the whole anti-gaming
					// property: an agent may escalate its own item but can never award
					// itself the cheaper clearance (docs/adr/0023).
					if (params.state === "done") {
						const route = routeOf(item);
						if (route === "user")
							return result(
								`Cannot set "done" on ${item.id}: it is routed to "user", which means only the user clears it via /accept. Move it to "review" and say so. To have oracle clear it instead, escalate with op "route" — but a route only ever escalates, so this cannot be lowered from "user".`,
								undefined,
							);
					}

					let demoted: string | null = null;
					// Read the mode before the mutation: the default it supplies is
					// applied inside the locked callback below.
					const autoRoute = defaultRoute(await loadMeta(file));
					let routedByMode: ReviewRoute | null = null;
					const updated = await mutatePlan(file, (cur) => {
						for (const other of cur) {
							// WIP limit of one applies to `active` alone: `blocked` and
							// `review` are holding areas and are deliberately uncapped.
							// Demote to `ready`, not `backlog` — work that was already
							// started is by definition specified enough to start.
							if (params.state === "active" && other.id !== item.id && other.status === "active") {
								other.status = "ready";
								demoted = other.id;
							}
						}
						const target = cur.find((i) => i.id === item.id)!;
						// Grooming is when an Item's Review Route is chosen, so this is
						// where Autonomous Mode supplies its default. Only an Item that
						// never stated a preference is affected — a route already set
						// wins, which is what keeps the mode a default rather than the
						// override ADR 0023 rejected (docs/adr/0032).
						if (
							params.state === "ready" &&
							target.route === undefined &&
							autoRoute !== "user"
						) {
							target.route = autoRoute;
							routedByMode = autoRoute;
						}
						target.status = params.state;
						if (params.note !== undefined) target.note = params.note;
						return cur;
					});
					view.items = updated;
					view.file = file;

					// An oracle-routed Item entering `review` triggers its own review.
					// Fire-and-forget: a review takes minutes and this op must return now.
					// Suppressed inside a review child, which loads this same extension
					// and would otherwise recurse (docs/adr/0032).
					let dispatched = false;
					const reviewed = updated.find((i) => i.id === item.id);
					if (
						params.state === "review" &&
						reviewed &&
						routeOf(reviewed) === "oracle" &&
						!dispatchSuppressed()
					) {
						dispatched = true;
						void dispatchReview(file, item.id, process.cwd());
					}

					const justCompleted = updated.every((i) =>
						TERMINAL.includes(i.status),
					);
					if (justCompleted && updated.length > 0) {
						// Self-archive: the last non-terminal item just landed.
						const archived = await archivePlan(file);
						view.items = [];
						view.file = null;
						refreshUi(ui, undefined);
						return result(
							[
								`${item.id} → ${params.state}. Every item in ${key} is terminal — plan archived to ${archived}.`,
								demoted ? `(${demoted} was active; demoted to pending.)` : "",
								routedByMode
									? `(Autonomous Mode routed it to "${routedByMode}".)`
									: "",
							]
								.filter(Boolean)
								.join(" "),
						);
					}
					return result(
						[
							`${item.id} → ${params.state}${demoted ? ` (${demoted} demoted to pending)` : ""}.`,
							// Never let the mode route an item silently: the agent must be
							// told who will clear the work it just groomed.
							routedByMode
								? `Autonomous Mode routed it to "${routedByMode}" (it had no route of its own). Escalate with op "route" if it needs the user.`
								: "",
							dispatched
								? "An oracle review was dispatched for it. It runs detached and reports only through this item's note and route, so check back with op \"show\" — a pass clears the item, a fail returns it to active with oracle's findings in the note."
								: "",
						]
							.filter(Boolean)
							.join(" "),
					);
				}

				case "revise": {
					if (!params.id || !params.text)
						return result(
							'op "revise" requires "id" and "text".',
							undefined,
						);
					const items = await loadPlan(file);
					const item = items.find((i) => i.id === params.id);
					if (!item)
						return result(
							`Unknown item id "${params.id}" in ${key}. Use op "show" to list items.`,
							undefined,
						);
					// A terminal item is a record of what happened; rewriting its
					// text would rewrite that record (docs/adr/0014).
					if (TERMINAL.includes(item.status))
						return result(
							`Cannot revise ${item.id} in ${key}: it is already ${item.status}, and terminal items are immutable. Use op "add" for a new step instead.`,
							undefined,
						);
					const before = item.text;
					const updated = await mutatePlan(file, (cur) => {
						const target = cur.find((i) => i.id === item.id);
						if (target) target.text = params.text as string;
						return cur;
					});
					view.items = updated;
					view.file = file;
					return result(
						`Revised ${item.id} in ${key}: "${before}" → "${params.text}".`,
					);
				}

				case "attach": {
					const id = params.id;
					const taskId = params.taskId;
					if (!id || !taskId)
						return result(
							'op "attach" requires "id" and "taskId".',
							undefined,
						);
					// Validate INSIDE the locked read-modify-write. Validating a snapshot
					// first and mutating a re-read one let an item go terminal in between
					// and still be modified, and made `replaced` describe the stale
					// snapshot rather than what was actually overwritten (docs/adr/0035).
					//
					// Not a status change: the item keeps its state and position, so the
					// self-archive check op "status" runs must not fire here, and no other
					// field of the item is touched.
					let outcome: ReturnType<typeof attachTaskId> | undefined;
					const updated = await mutatePlan(file, (cur) => {
						outcome = attachTaskId(cur, key, id, taskId);
						if (!outcome.ok) return cur; // Refused: persist nothing changed.
						for (const it of cur) if (it.id === id) it.taskId = taskId;
						return cur;
					});
					if (!outcome || !outcome.ok)
						return result(
							outcome?.error ?? `Could not attach ${taskId} to ${id} in ${key}.`,
							undefined,
						);
					view.items = updated;
					view.file = file;
					return result(
						outcome.replaced
							? `Attached ${taskId} to ${id} in ${key} — replaced the earlier ${outcome.replaced} (the step was re-delegated).`
							: `Attached ${taskId} to ${id} in ${key}.`,
					);
				}

				case "route": {
					if (!params.id || !params.route)
						return result('op "route" requires "id" and "route".', undefined);
					const id = params.id;
					const route = params.route;
					// Validated inside the locked read-modify-write, like attach: the
					// ratchet must be judged against the list actually being written, or
					// a concurrent escalation could be silently lowered (docs/adr/0035).
					let outcome: ReturnType<typeof setRoute> | undefined;
					const updated = await mutatePlan(file, (cur) => {
						outcome = setRoute(cur, key, id, route);
						return cur;
					});
					if (!outcome || !outcome.ok)
						return result(
							outcome?.error ?? `Could not route ${id} in ${key}.`,
							undefined,
						);
					view.items = updated;
					view.file = file;
					if (outcome.unchanged)
						return result(`${id} in ${key} is already routed to "${route}".`);
					return result(
						`Routed ${id} in ${key}: "${outcome.from}" → "${route}".${
							route === "user"
								? " Only the user can clear it now."
								: route === "skip"
									? " It will go straight to done without review."
									: " A pass Verdict from an oracle review clears it."
						}`,
					);
				}

				case "autonomous": {
					if (params.on === undefined)
						return result(
							'op "autonomous" requires "on" (true to enable, false to disable).',
							undefined,
						);
					const on = params.on;
					// Written through mutatePlan so the meta line is created under the
					// same lock as any item write, and so an existing plan with no meta
					// line gains one atomically (docs/adr/0035).
					view.items = await mutatePlan(
						file,
						(cur) => cur,
						() => ({ kind: "plan-meta", autonomous: on }),
					);
					view.file = file;
					// Existing items are deliberately untouched: the mode supplies a
					// default for items groomed from now on, and retro-routing work
					// the user already chose to review would be exactly the override
					// ADR 0023 rejected.
					return result(
						on
							? `Autonomous Mode is ON for ${key}. Items you groom to "ready" from now on default to the "oracle" route instead of "user". Existing items keep their current route — nothing was re-routed. When such an item reaches "review" an oracle review is dispatched automatically: a pass clears it, a fail or unsure returns it to "active" with the findings in its note, and after two failed verdicts its route ratchets to "user".`
							: `Autonomous Mode is OFF for ${key}. Items you groom from now on default to the "user" route. Items already routed to "oracle" keep that route — a route only ever escalates, so turning the mode off cannot lower them.`,
					);
				}

				case "seed": {
					if (!params.for || !params.items?.length)
						return result(
							'op "seed" requires "for" (the plan key, e.g. a Task ID) and "items".',
							undefined,
						);
					const existing = await loadPlan(file);
					if (existing.length > 0)
						return result(
							`Plan for ${key} already has ${existing.length} item(s) — not clobbered. Use op "add" to extend it.`,
							undefined,
						);
					const seeded: PlanItem[] = params.items.map((it, n) => ({
						id: `p${n + 1}`,
						text: it.text,
						status: "backlog",
						note: it.note,
						taskId: it.taskId,
					}));
					await mutatePlan(file, () => seeded);
					// The seeded plan belongs to another agent (usually a child
					// that has its own TUI-less process): this session's widget
					// must not start showing someone else's plan.
					return result(
						`Seeded Starter Plan for ${key} (${seeded.length} items) at ${file}.`,
					);
				}

				case "archive": {
					const items = await loadPlan(file);
					if (items.length === 0)
						return result(
							`Nothing to archive for ${key}: no plan file found (it may already be archived in ${path.join(path.dirname(file), "archive")}).`,
							undefined,
						);
					const open = items.filter((i) => !TERMINAL.includes(i.status));
					if (open.length > 0)
						return result(
							`Cannot archive ${key}: ${open.length} item(s) not terminal yet (${open.map((i) => `${i.id}: ${i.status}`).join(", ")}).`,
							undefined,
						);
					const archived = await archivePlan(file);
					view.items = [];
					view.file = null;
					refreshUi(ui, undefined);
					return result(`Plan for ${key} archived to ${archived}.`);
				}
			}
		},

		renderCall(args, theme) {
			const target = args.for ? ` ${args.for}` : "";
			const detail: string[] = [];
			if (args.op === "add" && args.text)
				detail.push(args.text.length > 50 ? `${args.text.slice(0, 50)}…` : args.text);
			if (args.op === "status") detail.push(`${args.id} → ${args.state}`);
			if (args.op === "revise" && args.text)
				detail.push(
					`${args.id} → ${args.text.length > 40 ? `${args.text.slice(0, 40)}…` : args.text}`,
				);
			if (args.op === "attach" && args.taskId)
				detail.push(`${args.id} ← [${args.taskId}]`);
			if (args.op === "route" && args.route)
				detail.push(`${args.id} ⇒ ${args.route}`);
			if (args.op === "autonomous" && args.on !== undefined)
				detail.push(args.on ? "on" : "off");
			if (args.op === "seed") detail.push(`${args.items?.length ?? 0} items`);
			return new Text(
				theme.fg("toolTitle", theme.bold("plan ")) +
					theme.fg("accent", args.op) +
					theme.fg("muted", target) +
					(detail.length ? theme.fg("dim", ` ${detail.join(" ")}`) : ""),
				0,
				0,
			);
		},

		renderResult(result, _opts, theme) {
			const text = result.content[0];
			const body = text?.type === "text" ? text.text : "";
			return new Text(theme.fg("toolOutput", body), 0, 0);
		},
	});

	// -----------------------------------------------------------------------
	// Session lifecycle
	// -----------------------------------------------------------------------

	/**
	 * On session start: restore the UI for an existing plan and re-inject it
	 * for *main* sessions (a resumed session's conversation no longer
	 * contains the plan).
	 *
	 * Subagent children (PI_PLAN_KEY set) are deliberately not injected:
	 * their Starter Plan arrives in the delegation prompt, and duplicating
	 * it into context would just burn tokens (docs/adr/0012).
	 */
	pi.on("session_start", (_event, ctx) => {
		if (!process.env.PI_PLAN_KEY) {
			// Restore + re-inject for the main session.
			const key = currentKey(ctx);
			const file = planFileFor(ctx);
			void (async () => {
				const items = await loadPlan(file);
				view.items = items;
				view.file = items.length ? file : null;
				refreshUi(ctx.hasUI ? ctx.ui : undefined, undefined);
				if (items.some((i) => !TERMINAL.includes(i.status)))
					reinjectPlan(ctx, "after session resume");
			})().catch(() => {});
			// The Board is spawned for every main session, including ones that
			// never make a plan: it shows an empty state until items appear.
			// Failure to spawn must never affect the session, so it is fully
			// detached from the restore path above.
			if (ctx.mode === "tui") void ensureBoard(file).catch(() => {});
		} else {
			// Child: point the view at the child's own plan file so its tool
			// calls (if any run in a TUI) display correctly. No injection.
			const file = planFileFor(ctx);
			void (async () => {
				view.items = await loadPlan(file);
				view.file = view.items.length ? file : null;
				refreshUi(ctx.hasUI ? ctx.ui : undefined, undefined);
			})().catch(() => {});
		}
	});

	/**
	 * Compaction removes the plan from the conversation; put it back for the
	 * next LLM call (docs/adr/0011).
	 */
	pi.on("session_compact", (_event, ctx) => {
		reinjectPlan(ctx, "after compaction");
	});

	/**
	 * `/accept` — the user's path from review to done (docs/adr/0017).
	 *
	 * `done` means *accepted by the user*, so the plan tool refuses to set it and
	 * an agent can only ever move work to `review`. That leaves acceptance with
	 * no mechanism at all unless the user has one: this is it. Without this
	 * command a plan can never archive, because its last items sit in `review`
	 * forever.
	 *
	 * Usage:
	 *   /accept        accept every item currently in review
	 *   /accept p4     accept one item by id
	 *   /accept p4 p7  accept several
	 */
	pi.registerCommand("accept", {
		description: "Accept reviewed plan items (review → done)",
		handler: async (args, ctx) => {
			const file = planFileFor(ctx);
			const requested = (args ?? "")
				.split(/[\s,]+/)
				.map((s) => s.trim())
				.filter(Boolean);

			const before = await loadPlan(file);
			const inReview = before.filter((i) => i.status === "review");

			if (inReview.length === 0) {
				ctx.ui.notify("Nothing in review to accept", "info");
				return;
			}

			// No ids given: accept the whole review column.
			const targets = requested.length
				? requested
				: inReview.map((i) => i.id);

			const unknown = targets.filter(
				(id) => !before.some((i) => i.id === id),
			);
			const notInReview = targets.filter((id) =>
				before.some((i) => i.id === id && i.status !== "review"),
			);
			const accepting = targets.filter((id) =>
				inReview.some((i) => i.id === id),
			);

			if (accepting.length === 0) {
				ctx.ui.notify(
					unknown.length
						? `Unknown item(s): ${unknown.join(", ")}`
						: `Not in review: ${notInReview.join(", ")}`,
					"error",
				);
				return;
			}

			const updated = await mutatePlan(file, (cur) => {
				for (const item of cur)
					if (accepting.includes(item.id)) item.status = "done";
				return cur;
			});
			view.items = updated;
			view.file = file;

			// Accepting the last outstanding item completes the plan, so the same
			// self-archive rule the tool applies has to fire here too — otherwise
			// acceptance would be the one mutation that leaves a finished plan open.
			const complete =
				updated.length > 0 && updated.every((i) => TERMINAL.includes(i.status));
			if (complete) {
				const archived = await archivePlan(file);
				view.items = [];
				view.file = null;
				refreshUi(ctx.hasUI ? ctx.ui : undefined, undefined);
				ctx.ui.notify(
					`Accepted ${accepting.join(", ")} — plan complete, archived to ${path.basename(archived)}`,
					"info",
				);
				return;
			}

			refreshUi(ctx.hasUI ? ctx.ui : undefined, undefined);
			const skipped = [...unknown, ...notInReview];
			ctx.ui.notify(
				`Accepted ${accepting.join(", ")}${skipped.length ? ` (skipped ${skipped.join(", ")})` : ""}`,
				"info",
			);
		},
	});

	/** Clear plan surfaces on shutdown so a dead plan never lingers in the UI. */
	pi.on("session_shutdown", (_event, ctx) => {
		view.items = [];
		view.file = null;
		refreshUi(ctx.hasUI ? ctx.ui : undefined, undefined);
		// The Board Pane is deliberately left open. Closing it on shutdown means a
		// session that hands off to another one (import, resume, reload) takes the
		// board down with it and the successor has no surface to adopt — which is
		// worse than a board pane outliving the session that opened it. A stale
		// board is re-pointed by ensureBoard, not orphaned.
	});
}
