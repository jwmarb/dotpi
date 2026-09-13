/**
 * One admission cap for every process this pi spawns.
 *
 * There is one machine and one RAM budget, so a limit that only counts *some*
 * spawns does not bound anything. Before this module the subagent registry
 * capped Tasks at 6 and the review dispatcher capped reviews at 3, from separate
 * counters — so nine children was reachable while both limits reported healthy.
 * A Rework worker would have added a third such counter, and the failure mode of
 * that arrangement is the one ADR 0037 is about: every individual guard looks
 * correct and the machine still falls over.
 *
 * Both spawners run in the orchestrator's process. That is not an assumption but
 * a checked fact: children are spawned with `--tools` taken from their agent
 * file, and no agent in `agent/agents/` lists `subagent` or `plan`, so a child
 * can neither delegate nor dispatch a review. A module-level counter therefore
 * bounds the whole machine. If an agent is ever given one of those tools, this
 * stops being true and the cap must move to something cross-process — a lock
 * directory, as in ADR 0035 — so that grant is the thing to guard.
 *
 * The counter is claimed **synchronously with the check**, before any `await`.
 * The first version of the review cap incremented at the spawn, three awaits
 * after its check, and twelve concurrent callers therefore all passed a cap of
 * three: a check-then-act race in the middle of the thing meant to prevent
 * runaway spawning. `claimSlot` exists so that no caller can reproduce it.
 */

/**
 * Ceiling on concurrently running spawned children, of every kind.
 *
 * Six because that was the subagent Task limit this replaces, and a personal
 * machine running six pi children is already working hard. Deliberately not
 * configurable: a plan that needs more than six concurrent children has a
 * scheduling problem that a bigger number will not fix.
 */
export const MAX_SPAWNED_CHILDREN = 6;

/** What a spawn slot was taken for, so a refusal can say who is holding them. */
export type SpawnKind = "task" | "review" | "rework";

/** Live slots, by kind. Counts, not identities: nothing needs to know which. */
const held = new Map<SpawnKind, number>();

/** Total slots currently held. */
function total(): number {
	let n = 0;
	for (const v of held.values()) n += v;
	return n;
}

/** A human-readable breakdown for refusal messages, e.g. `4 tasks, 2 reviews`. */
function describeHeld(): string {
	const parts: string[] = [];
	for (const [kind, n] of held) {
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
 * @param kind - What the child is, used only in the refusal message.
 * @returns A slot to release when the child ends, or a reason it was refused.
 */
export function claimSlot(
	kind: SpawnKind,
): { ok: true; slot: SpawnSlot } | { ok: false; reason: string } {
	if (total() >= MAX_SPAWNED_CHILDREN) {
		return {
			ok: false,
			reason:
				`refused to spawn: ${total()} of ${MAX_SPAWNED_CHILDREN} spawn slots are in use ` +
				`(${describeHeld()}). This cap is shared by every kind of spawned child, ` +
				`so waiting for one to finish is the only way through.`,
		};
	}
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

/** Slots in use, for status output and tests. */
export function slotsInUse(): number {
	return total();
}

/** Reset all counters. Tests only — never call this from running code. */
export function resetSlotsForTests(): void {
	held.clear();
}
