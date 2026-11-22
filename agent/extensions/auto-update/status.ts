/**
 * The update vocabulary, shared by every update surface.
 *
 * Two things live here: what an `UpdateStatus` *means* to a renderer
 * (`describeUpdate`), and the memoised scheduling of a check
 * (`createUpdateStatusMemo`). Neither owns any wording — the session status,
 * the `/update` prompts, the `pi_update` reply and the startup header keep
 * their own sentences, so what they cannot drift apart is the decision.
 *
 * It **imports nothing** and does no work at load: `scripts/check.sh` imports
 * every extension source standalone, so only declarations and pure functions
 * may sit at this file's top level.
 */

/** The tri-state check result: "could not check" is never folded into "up to date". */
export type UpdateStatus =
	| { status: "current"; currentVersion: string }
	| { status: "available"; currentVersion: string; latestVersion: string }
	| { status: "error" };

/** How long between update checks. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours between checks

/** The three shapes a surface has to render, named once. */
export type UpdateVariant = "current" | "available" | "error";

/**
 * An `UpdateStatus` flattened for rendering: a switch on `variant` instead of
 * the same three status tests re-derived at each call site. `updatePending` is
 * the question every surface asks first, and the versions are present only
 * where the status carries them — so a sentence that interpolates one stays
 * behind that guard rather than printing `undefined`.
 */
export type UpdateDescriptor = {
	variant: UpdateVariant;
	currentVersion?: string;
	latestVersion?: string;
	updatePending: boolean;
};

/**
 * The one reading of a check result. Pure and total, and deliberately free of
 * strings, sentences and theming: naming the variant is all a surface needs
 * before it writes its own message.
 */
export function describeUpdate(status: UpdateStatus): UpdateDescriptor {
	if (status.status === "available") {
		return {
			variant: "available",
			currentVersion: status.currentVersion,
			latestVersion: status.latestVersion,
			updatePending: true,
		};
	}
	if (status.status === "current") {
		return { variant: "current", currentVersion: status.currentVersion, updatePending: false };
	}
	return { variant: "error", updatePending: false };
}

/**
 * A cached check. `at` is the check's **start** time, not its completion: an
 * entry is published before `compute` settles (that is what lets concurrent
 * callers share one in-flight check), so a slow check costs its wait in
 * freshness — the honest reading of "checked at".
 */
export type UpdateMemo = { at: number; promise: Promise<UpdateStatus> };

/** Where a memo lives. An interface so a caller can keep it on `globalThis`. */
export interface UpdateMemoStore {
	read(): UpdateMemo | undefined;
	write(memo: UpdateMemo | undefined): void;
}

/** Everything a memo needs from outside, injected so the scheduling is testable. */
export interface UpdateMemoEffects<Req> {
	compute(request: Req): Promise<UpdateStatus>;
	now(): number;
	store: UpdateMemoStore;
	intervalMs?: number;
}

/**
 * The memoised check: reuse a result for `intervalMs`, recompute when it goes
 * stale, and let `force` skip the window — a manual update request deserves a
 * fresh answer. A check is published to the store before it settles so
 * concurrent callers await the same promise; failures are not cached, because
 * a memo holding an error (or a rejection) would wedge every later check until
 * the window expired.
 *
 * Holds no state of its own: the store is the only memory, so a caller decides
 * how long a memo survives a `/reload`.
 */
export function createUpdateStatusMemo<Req>(
	e: UpdateMemoEffects<Req>,
): (request: Req, force?: boolean) => Promise<UpdateStatus> {
	return (request: Req, force = false): Promise<UpdateStatus> => {
		const intervalMs = e.intervalMs ?? CHECK_INTERVAL_MS;
		const memo = e.store.read();
		if (!force && memo && e.now() - memo.at < intervalMs) return memo.promise;
		const promise: Promise<UpdateStatus> = e
			.compute(request)
			.then((status) => {
				// The identity guard: an older check that finishes late must not clear
				// a newer one a `force` call already published.
				if (status.status === "error" && e.store.read()?.promise === promise) e.store.write(undefined);
				return status;
			})
			.catch((err: unknown) => {
				// A rejection stays a rejection — it is only dropped from the store, so
				// a memo never hands every later caller the same failed check.
				if (e.store.read()?.promise === promise) e.store.write(undefined);
				throw err;
			});
		e.store.write({ at: e.now(), promise });
		return promise;
	};
}
