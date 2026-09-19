/**
 * Plan file store: the JSONL file a **Plan** persists as, and the machinery
 * that guards it.
 *
 * A Plan is dual-sourced — the conversation is the working copy, the file is
 * the durable one (docs/adr/0011). This module owns everything about the file
 * itself: its path, its line schema, the reader that tolerates corruption,
 * the cross-process lock, and the atomic mutate. It lives apart from the
 * extension so that *other producers of Runs* — the subagent extension, and
 * any future spawner — can seed a Run's plan file at spawn without importing
 * the whole plan tool (docs/adr/0048).
 *
 * @module planfile
 */

import {
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Line schema
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a single Plan Item. Terminal states: done, failed, dropped.
 *
 * The non-terminal states are the Board's columns (docs/adr/0018): moving a
 * card *is* a state change, and there is no column concept separate from state.
 *
 * `backlog` is captured but not yet groomed; `ready` is specified enough to
 * start right now; `blocked` cannot proceed; `review` means the agent believes
 * it landed and is waiting for the user to accept it. Only the user moves
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
export type PlanState =
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
export const KNOWN_STATES: readonly PlanState[] = [
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
 * Who may clear a Plan Item (docs/adr/0023).
 *
 * - `user` — only the user's hand, via `/accept`. The default when absent.
 * - `oracle` — cleared by a `pass` Verdict from an oracle review.
 * - `skip` — goes `active` → `done` directly and never enters `review`, because
 *   `review` is the column for items awaiting a reviewer and a skipped item has
 *   none.
 */
export type ReviewRoute = "user" | "oracle" | "skip";

/**
 * Routes in ratchet order, least scrutiny first.
 *
 * The order *is* the rule: a route may only ever move to a later entry. That
 * one-way ratchet is what makes choosing a route at grooming time safe — an
 * agent that discovers its work is hairier than groomed can always ask for more
 * scrutiny, and can never award itself less once it knows how painful review
 * would be.
 */
export const ROUTE_ORDER: readonly ReviewRoute[] = ["skip", "oracle", "user"];

/** One line of a plan file: one Plan Item. */
export interface PlanItem {
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
	/**
	 * The Run ID of the **review** dispatched for this Item, if one is in flight.
	 *
	 * The twin of {@link reworkRunId} for the review side: set before the review
	 * Run is spawned and cleared when it ends (docs/adr/0048). It exists for the
	 * Board, which lists a card's Runs by reading each Run's own plan file — the
	 * rework Run is findable through `reworkRunId`, and without this field the
	 * review Run's plan would be findable only by parsing the Item's note.
	 */
	reviewRunId?: string;
}

/**
 * Per-plan settings, stored as a single `kind: "plan-meta"` line in the plan
 * file.
 *
 * It lives in the plan file rather than settings.json because the mode is a
 * property of a body of work — one plan may be autonomous while another is not —
 * and it must survive restarts (docs/adr/0032).
 */
export interface PlanMeta {
	kind: "plan-meta";
	/** When true, an unrouted Item adopts the `oracle` route on any non-terminal state change, never on a terminal one (docs/adr/0032). */
	autonomous?: boolean;
}

/** Whether a line parsed from the plan file is the plan-meta line. */
export function isPlanMeta(obj: unknown): obj is PlanMeta {
	return (
		typeof obj === "object" &&
		obj !== null &&
		(obj as { kind?: unknown }).kind === "plan-meta"
	);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read and parse a plan file.
 *
 * A corrupt line is skipped, never fatal — the Board and a concurrent writer
 * both read this file, and one corrupt line must not destroy the rest of the
 * plan.
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
export async function loadPlan(file: string): Promise<PlanItem[]> {
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
					reviewRunId:
						typeof obj.reviewRunId === "string" && obj.reviewRunId !== ""
							? obj.reviewRunId
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
 * Separate from {@link loadPlan} so its callers stay untouched: only the
 * few places that care about per-plan settings pay for reading them.
 *
 * @param file - Absolute path of the plan file.
 * @returns The meta line, or null when absent or unreadable.
 */
export async function loadMeta(file: string): Promise<PlanMeta | null> {
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

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

/**
 * A plan mutation refused because another writer holds the lock.
 *
 * Deliberately an error rather than a silent unlocked write: a refused mutation
 * is visible and retryable, a lost one is neither (docs/adr/0035).
 */
export class PlanLockTimeoutError extends Error {
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
export async function acquirePlanLock(file: string): Promise<() => Promise<void>> {
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

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * Returned by a {@link mutatePlan} callback to mean "write nothing at all".
 *
 * Several operations validate inside the lock and then refuse — a terminal Item
 * that may not be deleted, an unknown id, a Rework still holding an Item. Those
 * used to `return cur` and were documented as persisting nothing, which was false:
 * `mutatePlan` rewrote the file unconditionally, and because `loadPlan` skips
 * malformed lines and drops unrecognised fields, that rewrite could *destroy data*
 * on an operation that reported changing nothing. Measured on a non-canonical
 * plan file, a refused delete silently removed both a corrupt line and an unknown
 * field.
 *
 * A sentinel rather than a boolean flag or a nullable return, because the callback
 * already returns the item list: this keeps "no change" impossible to express by
 * accident, and impossible to confuse with "an empty plan".
 */
export const NO_WRITE = Symbol("plan:no-write");

/**
 * Atomically read, transform, and rewrite a plan file as one unit of the
 * per-file mutation queue — concurrent tool calls on the same key cannot lose
 * each other's items.
 *
 * A callback that returns {@link NO_WRITE} leaves the file completely untouched —
 * not rewritten from the parsed items — which is what a validate-then-refuse
 * operation needs in order to honestly persist nothing.
 *
 * The items handed to `mutate` are always re-read from disk under the lock, so
 * a change the Board made since this process last looked is never clobbered
 * (docs/adr/0015).
 *
 * @param file - Absolute path of the plan file.
 * @param mutate - Transform from current items to the next items, or
 *        {@link NO_WRITE} to abandon the write and leave the file byte-for-byte
 *        as it was.
 * @param mutateMeta - Optional transform of the plan-meta line. Omit it to carry
 *        existing meta through unchanged; meta is always preserved either way.
 *        Not consulted when the items callback returns {@link NO_WRITE}.
 * @returns The item list that was persisted, or the items as read when the
 *          callback declined to write.
 * @throws {PlanLockTimeoutError} When another writer holds the lock for longer
 *         than the wait budget. Nothing is written; the caller reports it and
 *         the user or agent retries (docs/adr/0035).
 */
export async function mutatePlan(
	file: string,
	mutate: (
		items: PlanItem[],
	) => PlanItem[] | typeof NO_WRITE | Promise<PlanItem[] | typeof NO_WRITE>,
	mutateMeta?: (meta: PlanMeta | null) => PlanMeta | null,
): Promise<PlanItem[]> {
	let next: PlanItem[] = [];
	await withFileMutationQueue(file, async () => {
		const release = await acquirePlanLock(file);
		try {
			const items = await loadPlan(file);
			const result = await mutate(items);
			if (result === NO_WRITE) {
				// Return before the file is touched at all. Rewriting it from `items`
				// would be lossy even though nothing "changed": `loadPlan` drops
				// malformed lines and unrecognised fields, so a refusal would silently
				// delete data it never reported deleting.
				next = items;
				return;
			}
			next = result;
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

// ---------------------------------------------------------------------------
// Run plan seeding (docs/adr/0048)
// ---------------------------------------------------------------------------


/**
 * The one-line nudge appended to a delegation brief when the child's Starter
 * Plan was seeded (docs/adr/0048).
 *
 * The child's plan is deliberately not injected into its context — the
 * `PI_PLAN_KEY` branch of session start restores it for the plan tool, not for
 * the conversation — so the nudge is the bridge: it tells the child the plan
 * exists and that maintaining it is part of the job. It crosses inside the
 * brief text, so it is part of the delegation, not a second channel
 * (docs/adr/0047 is unchanged).
 *
 * @param n - The number of items that were seeded.
 */
export function YOUR_PLAN_NUDGE(n: number): string {
	return `Your plan is seeded with ${n} items — maintain it as you work`;
}

/**
 * Seed a Run's own plan file with a Starter Plan (docs/adr/0048).
 *
 * Called from the spawn path that already owns the plan key — the subagent
 * extension for a delegated Run, the plan extension for a plan-spawned Run —
 * so the seed lands in the same code path that computes the key, rather than
 * depending on orchestrator memory.
 *
 * Never clobbers: a file that already exists — whatever it contains — is left
 * byte-for-byte, and the caller is told the seed was skipped. The existence
 * check runs under the lock, so a writer that lands between the caller's last
 * read and this one cannot be clobbered by us (docs/adr/0035).
 *
 * Checking *existence* rather than the parsed item list is what protects an
 * empty, metadata-only, or corrupt file: those parse to zero items, so a
 * length check would seed them and `mutatePlan`'s rewrite-from-parsed would
 * destroy the lines `loadPlan` cannot represent — metadata, corrupt entries
 * (docs/adr/0048).
 *
 * Seeded items carry route `skip`: the child is the worker and cannot `/accept`
 * its own items, and a `user`-routed item would block the child's `done`
 * (docs/adr/0048).
 *
 * @param agentDir - The pi agent directory.
 * @param key - The Run's plan key (its Task ID, or its own runId).
 * @param items - The Starter Plan's item texts.
 * @returns `seeded: true` when the items were written, `false` when a plan
 *          already existed and was left alone.
 */
export async function seedRunPlan(
	agentDir: string,
	key: string,
	items: string[],
): Promise<{ seeded: boolean }> {
	const file = planFilePathFor(agentDir, key);
	const seeded: PlanItem[] = items.map((text, n) => ({
		id: `p${n + 1}`,
		text,
		status: "backlog",
		route: "skip",
	}));
	// A holder object rather than a `let`: the assignment happens inside the
	// mutatePlan callback, and the compiler does not track writes made through
	// a closure, so a plain `let` narrows at the read below.
	const result: { seeded: boolean } = { seeded: false };
	await mutatePlan(file, async (_items) => {
		// Never clobber: a file that pre-exists, whatever it contains, is
		// somebody else's — the seed is skipped, not merged (docs/adr/0048).
		let exists = false;
		try {
			await stat(file);
			exists = true;
		} catch {
			// Absent: this is the only branch the seed may take.
		}
		if (exists) return NO_WRITE;
		result.seeded = true;
		return seeded;
	});
	return result;
}
/**
 * The plan file for a plan key, under an agent directory.
 *
 * @param agentDir - The pi agent directory (`getAgentDir()`).
 * @param key - The plan key: a Task ID, a Run ID, or a session ID.
 */
export function planFilePathFor(agentDir: string, key: string): string {
	return path.join(agentDir, "plans", `${key}.jsonl`);
}

