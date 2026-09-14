/**
 * One admission cap for every process this pi spawns — and for every pi in its tree.
 *
 * There is one machine and one RAM budget, so a limit that only counts *some*
 * spawns does not bound anything. Before this module the subagent registry
 * capped Tasks at 6 and the review dispatcher capped reviews at 3, from separate
 * counters — so nine children was reachable while both limits reported healthy.
 * A Rework worker would have added a third such counter, and the failure mode of
 * that arrangement is the one ADR 0037 is about: every individual guard looks
 * correct and the machine still falls over.
 *
 * ## Why the counter is no longer in memory
 *
 * ADR 0040 rested this module on a checked fact, and recorded exactly what would
 * falsify it: "children are spawned with `--tools` taken from their agent file,
 * and no agent in `agent/agents/` lists `subagent` or `plan`, so a child can
 * neither delegate nor dispatch a review. A module-level counter therefore bounds
 * the whole machine. If an agent is ever given one of those tools, this stops
 * being true and the cap must move to something cross-process — a lock directory,
 * as in ADR 0035 — so that grant is the thing to guard."
 *
 * ADR 0044 makes that grant. A **Native Run** is a full interactive `pi` with
 * these same extensions loaded, and nesting is allowed, so a child *can* spawn.
 * A per-process counter would then mean six children *per process*, recursively:
 * six, then thirty-six, with no ceiling anywhere. So the count now lives in a
 * lock directory shared by every pi in the tree, in the shape ADR 0035 uses for
 * the plan lock.
 *
 * ## The two properties that must not be lost
 *
 * **The claim is synchronous with its check.** The first version of the review
 * cap incremented at the spawn, three awaits after its check, and twelve
 * concurrent callers therefore all passed a cap of three: a check-then-act race
 * in the middle of the thing meant to prevent runaway spawning. Going
 * cross-process must not reintroduce it, which is why every filesystem call here
 * is the *sync* variant. `claimSlot` stays synchronous, and its exclusivity comes
 * from `mkdirSync` on a unique token directory — an atomic create-if-absent that
 * needs no coordination.
 *
 * **The cap never over-admits.** A crashed holder must not hold a slot forever,
 * so tokens are reaped — but liveness is decided by probing the holder's *pid*,
 * never by wall-clock age. A Run legitimately occupies a slot for hours (an
 * oracle review here ran 24 turns over ten minutes; a native Run a user is
 * steering could sit idle far longer), so any age-based staleness rule would reap
 * live holders and over-admit. A recycled pid can at worst keep a dead holder's
 * slot alive until the next reap, whose cost is a refused spawn — retryable, and
 * always the safe direction.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Ceiling on concurrently running spawned children, of every kind.
 *
 * Six because that was the subagent Task limit this replaces, and a personal
 * machine running six pi children is already working hard. Deliberately not
 * configurable: a plan that needs more than six concurrent children has a
 * scheduling problem that a bigger number will not fix.
 *
 * Since ADR 0044 this is a *tree-wide* six, not six per process.
 */
export const MAX_SPAWNED_CHILDREN = 6;

/** What a spawn slot was taken for, so a refusal can say who is holding them. */
export type SpawnKind = "task" | "review" | "rework";

/** Live slots, by kind. Counts, not identities: nothing needs to know which. */
const held = new Map<SpawnKind, number>();

/**
 * The directory holding one token per in-flight child, or null for in-memory mode.
 *
 * Set once per process by {@link setSpawnCapRoot}. While null this module behaves
 * exactly as it did before ADR 0044 — a module-level counter — which keeps it
 * usable standalone and in tests, and keeps a misconfigured process capped rather
 * than uncapped.
 */
let capDir: string | null = null;

/**
 * Point the cap at a directory shared by every pi in this tree.
 *
 * Idempotent, and deliberately tolerant: if the directory cannot be created the
 * module falls back to its in-memory counter rather than throwing. A process that
 * cannot see the shared count is still capped at six on its own, which is wrong
 * but bounded — whereas refusing to start would take out the orchestrator over a
 * permissions problem.
 *
 * @param dir - Directory to hold the token files, e.g. `<agentDir>/subagent-sessions`.
 */
export function setSpawnCapRoot(dir: string): void {
	const target = path.join(dir, ".spawn-cap");
	try {
		mkdirSync(target, { recursive: true });
		capDir = target;
	} catch {
		capDir = null;
	}
}

/** Whether this process is counting slots tree-wide rather than in memory. */
export function spawnCapIsTreeWide(): boolean {
	return capDir !== null;
}

/** One token file's contents: who holds the slot, and what for. */
interface TokenBody {
	pid: number;
	kind: SpawnKind;
	at: number;
}

/**
 * Is this pid still alive?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `EPERM` means the process exists but is not ours to signal, which is
 * still *alive* — so only a thrown `ESRCH` counts as dead.
 */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Read the live tokens, deleting any whose holder is gone.
 *
 * Called before every count, because the alternative — a background sweep — would
 * let a crashed holder block a spawn until the sweep next ran. Unreadable or
 * malformed tokens are treated as *live* rather than reaped: a token being
 * written by another process right now is legitimately half-there, and counting
 * it is the safe error (a refused spawn, not an over-admission).
 */
function liveTokens(dir: string): TokenBody[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}

	const alive: TokenBody[] = [];
	for (const name of names) {
		const tokenDir = path.join(dir, name);
		let body: TokenBody | null = null;
		try {
			body = JSON.parse(
				readFileSync(path.join(tokenDir, "owner.json"), "utf-8"),
			) as TokenBody;
		} catch {
			// Half-written or foreign: count it, do not reap it.
			alive.push({ pid: -1, kind: "task", at: Date.now() });
			continue;
		}
		if (typeof body.pid === "number" && !pidAlive(body.pid)) {
			try {
				rmSync(tokenDir, { recursive: true, force: true });
			} catch {
				// Someone else reaped it first; either way it is not counted.
			}
			continue;
		}
		alive.push(body);
	}
	return alive;
}

/** Total slots currently held. */
function total(): number {
	if (capDir) return liveTokens(capDir).length;
	let n = 0;
	for (const v of held.values()) n += v;
	return n;
}

/** A human-readable breakdown for refusal messages, e.g. `4 tasks, 2 reviews`. */
function describeHeld(): string {
	const counts = new Map<SpawnKind, number>();
	if (capDir) {
		for (const t of liveTokens(capDir)) {
			const kind = (t.kind ?? "task") as SpawnKind;
			counts.set(kind, (counts.get(kind) ?? 0) + 1);
		}
	} else {
		for (const [k, v] of held) counts.set(k, v);
	}

	const parts: string[] = [];
	for (const [kind, n] of counts) {
		if (n > 0) parts.push(`${n} ${kind}${n === 1 ? "" : "s"}`);
	}
	return parts.length > 0 ? parts.join(", ") : "none";
}

/**
 * A claimed spawn slot. Release it exactly once, from a `finally`.
 *
 * `release` is idempotent, so a caller that releases on both a normal and an
 * error path cannot drive the counter negative and quietly enlarge the cap.
 */
export interface SpawnSlot {
	release(): void;
}

/**
 * Claim a slot for one child, or refuse.
 *
 * Synchronous by design and by necessity: the check and the claim must not be
 * separated by an `await`, or concurrent callers all pass the check before any
 * of them counts. Callers must therefore claim *first* and do their async setup
 * afterwards, releasing the slot if that setup fails.
 *
 * In tree-wide mode the claim is a `mkdirSync` of a uniquely-named token
 * directory — atomic create-if-absent, so two processes cannot mint the same
 * token — followed by writing the holder's pid into it. The count is re-read
 * *after* the create and the token is withdrawn if the cap was already met, which
 * makes a lost race resolve as a refusal rather than an over-admission. Two
 * processes claiming the last slot simultaneously may therefore both withdraw:
 * the cost is a spurious refusal, and refusals are retryable by design.
 *
 * @param kind - What the child is, used only in the refusal message.
 * @returns A slot to release when the child ends, or a reason it was refused.
 */
export function claimSlot(
	kind: SpawnKind,
): { ok: true; slot: SpawnSlot } | { ok: false; reason: string } {
	const refusal = (n: number) => ({
		ok: false as const,
		reason:
			`refused to spawn: ${n} of ${MAX_SPAWNED_CHILDREN} spawn slots are in use ` +
			`(${describeHeld()}). This cap is shared by every kind of spawned child, ` +
			`across every pi in this tree, so waiting for one to finish is the only ` +
			`way through.`,
	});

	if (!capDir) {
		const n = total();
		if (n >= MAX_SPAWNED_CHILDREN) return refusal(n);
		held.set(kind, (held.get(kind) ?? 0) + 1);
		let released = false;
		return {
			ok: true,
			slot: {
				release() {
					if (released) return;
					released = true;
					held.set(kind, Math.max(0, (held.get(kind) ?? 0) - 1));
				},
			},
		};
	}

	const before = total();
	if (before >= MAX_SPAWNED_CHILDREN) return refusal(before);

	const name = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const tokenDir = path.join(capDir, name);
	try {
		// Exclusive create: the atomic step that makes this claim ours alone.
		mkdirSync(tokenDir, { recursive: false });
		writeFileSync(
			path.join(tokenDir, "owner.json"),
			JSON.stringify({ pid: process.pid, kind, at: Date.now() } satisfies TokenBody),
			{ encoding: "utf-8" },
		);
	} catch {
		// Could not stake a claim; refuse rather than proceed uncounted.
		return refusal(before);
	}

	// Re-count with our own token present. If we overshot, withdraw: a spurious
	// refusal is recoverable, an over-admission is what this module exists to stop.
	if (total() > MAX_SPAWNED_CHILDREN) {
		try {
			rmSync(tokenDir, { recursive: true, force: true });
		} catch {
			// Nothing more we can do; the reaper will collect it when we exit.
		}
		return refusal(MAX_SPAWNED_CHILDREN);
	}

	let released = false;
	return {
		ok: true,
		slot: {
			release() {
				if (released) return;
				released = true;
				try {
					rmSync(tokenDir, { recursive: true, force: true });
				} catch {
					// Already gone: nothing to undo.
				}
			},
		},
	};
}

/** Slots in use, for status output and tests. */
export function slotsInUse(): number {
	return total();
}

/**
 * Reset all counters. Tests only — never call this from running code.
 *
 * Clears the shared directory too, since a test asserting on the cap must not
 * inherit another test's tokens.
 */
export function resetSlotsForTests(): void {
	held.clear();
	if (capDir && existsSync(capDir)) {
		try {
			rmSync(capDir, { recursive: true, force: true });
			mkdirSync(capDir, { recursive: true });
		} catch {
			// Best effort: a test that cannot clear the dir will report its own failure.
		}
	}
}
