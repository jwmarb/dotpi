/**
 * The memoised update check — `createUpdateStatusMemo` — tested against fakes:
 * a mutable clock, a closure store, a counting `compute`, and hand-resolved
 * deferreds where a check must be observed mid-flight. No pi, no fs, no npm.
 *
 * `index.ts`'s `getUpdateStatus` is deliberately NOT tested end-to-end: its
 * `compute` resolves the *real* running package, and under `bun test` that
 * lookup fails, so every call would return `{ status: "error" }` and clear the
 * entry — a "the memo was stored" assertion would then pass or fail for a
 * reason that has nothing to do with the memo.
 */

import { describe, expect, test } from "bun:test";

import {
	CHECK_INTERVAL_MS,
	createUpdateStatusMemo,
	type UpdateMemo,
	type UpdateStatus,
} from "../auto-update/status.js";

/** The memo's request, opaque to it: the factory must hand it back to `compute`. */
type Request = { readonly pkg: string };

const REQ: Request = { pkg: "@earendil-works/pi-coding-agent" };
const CURRENT: UpdateStatus = { status: "current", currentVersion: "1.0.0" };
const AVAILABLE: UpdateStatus = { status: "available", currentVersion: "1.0.0", latestVersion: "1.1.0" };
const ERROR: UpdateStatus = { status: "error" };

/** A memo over a mutable clock, a closure store and a counting compute. */
function harness(seed: UpdateStatus = CURRENT) {
	let clock = 1_000_000;
	let store: UpdateMemo | undefined;
	let result = seed;
	const computes: Request[] = [];
	const memo = createUpdateStatusMemo<Request>({
		compute: async (request) => {
			computes.push(request);
			return result;
		},
		now: () => clock,
		store: {
			read: () => store,
			write: (m) => {
				store = m;
			},
		},
		intervalMs: CHECK_INTERVAL_MS,
	});
	return {
		memo,
		/** Move the clock without running anything. */
		advance: (ms: number) => {
			clock += ms;
		},
		setResult: (s: UpdateStatus) => {
			result = s;
		},
		/** Stand in for a `/reload`: the store forgets, the clock does not move. */
		resetStore: () => {
			store = undefined;
		},
		computeCount: () => computes.length,
		stored: () => store,
	};
}

describe("createUpdateStatusMemo", () => {
	test("the first call computes and stores", async () => {
		const h = harness();
		expect(await h.memo(REQ)).toEqual(CURRENT);
		expect(h.computeCount()).toBe(1);
		expect(h.stored()).toBeDefined();
	});

	test("a second call inside the window gets the same promise back", async () => {
		const h = harness();
		const first = h.memo(REQ);
		h.advance(CHECK_INTERVAL_MS - 1);
		const second = h.memo(REQ);
		expect(second).toBe(first);
		expect(await second).toEqual(CURRENT);
		expect(h.computeCount()).toBe(1);
	});

	test("past the window it recomputes", async () => {
		const h = harness();
		await h.memo(REQ);
		h.advance(CHECK_INTERVAL_MS);
		h.setResult(AVAILABLE);
		expect(await h.memo(REQ)).toEqual(AVAILABLE);
		expect(h.computeCount()).toBe(2);
	});

	test("an error is not cached", async () => {
		const h = harness(ERROR);
		expect(await h.memo(REQ)).toEqual(ERROR);
		expect(h.stored()).toBeUndefined();
		h.setResult(CURRENT);
		expect(await h.memo(REQ)).toEqual(CURRENT);
		expect(h.computeCount()).toBe(2);
	});

	test("force bypasses an in-window memo", async () => {
		const h = harness();
		await h.memo(REQ);
		h.advance(1000);
		h.setResult(AVAILABLE);
		expect(await h.memo(REQ, true)).toEqual(AVAILABLE);
		expect(h.computeCount()).toBe(2);
	});

	test("concurrent callers share one in-flight check", async () => {
		let settle!: (s: UpdateStatus) => void;
		let computes = 0;
		let store: UpdateMemo | undefined;
		const memo = createUpdateStatusMemo<Request>({
			compute: async () => {
				computes++;
				return new Promise<UpdateStatus>((resolve) => {
					settle = resolve;
				});
			},
			now: () => 0,
			store: {
				read: () => store,
				write: (m) => {
					store = m;
				},
			},
			intervalMs: CHECK_INTERVAL_MS,
		});
		// The entry is published before `compute` settles, which is the whole
		// point: the second caller joins the running check instead of starting
		// a second `npm view`.
		const a = memo(REQ);
		const b = memo(REQ);
		expect(b).toBe(a);
		expect(computes).toBe(1);
		settle(AVAILABLE);
		const [ra, rb] = await Promise.all([a, b]);
		expect(ra).toBe(rb);
		expect(ra).toEqual(AVAILABLE);
		expect(store?.promise).toBe(a);
	});

	test("the memo does not survive a store reset", async () => {
		const h = harness();
		await h.memo(REQ);
		h.resetStore();
		expect(await h.memo(REQ)).toEqual(CURRENT);
		expect(h.computeCount()).toBe(2);
	});

	test("a late error does not clear a newer forced entry", async () => {
		const settles: ((s: UpdateStatus) => void)[] = [];
		let store: UpdateMemo | undefined;
		const memo = createUpdateStatusMemo<Request>({
			compute: async () =>
				new Promise<UpdateStatus>((resolve) => {
					settles.push(resolve);
				}),
			now: () => 0,
			store: {
				read: () => store,
				write: (m) => {
					store = m;
				},
			},
			intervalMs: CHECK_INTERVAL_MS,
		});
		const slow = memo(REQ); // the one that will fail, last to answer
		const fresh = memo(REQ, true); // a forced re-check publishes over it
		settles[1]!(AVAILABLE);
		expect(await fresh).toEqual(AVAILABLE);
		expect(store?.promise).toBe(fresh);
		settles[0]!(ERROR);
		expect(await slow).toEqual(ERROR);
		// The identity guard: the stale failure clears only its own entry.
		expect(store?.promise).toBe(fresh);
	});

	test("a rejection is rethrown, never cached", async () => {
		const boom = new Error("the check threw");
		let computes = 0;
		let store: UpdateMemo | undefined;
		const memo = createUpdateStatusMemo<Request>({
			compute: async () => {
				computes++;
				if (computes === 1) throw boom;
				return CURRENT;
			},
			now: () => 0,
			store: {
				read: () => store,
				write: (m) => {
					store = m;
				},
			},
			intervalMs: CHECK_INTERVAL_MS,
		});
		let caught: unknown;
		try {
			await memo(REQ);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBe(boom); // a rejection stays a rejection
		expect(store).toBeUndefined(); // …and a rejected promise never outlives its check
		expect(await memo(REQ)).toEqual(CURRENT);
		expect(computes).toBe(2);
	});
});
