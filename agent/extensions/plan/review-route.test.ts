/**
 * Tests for the **Review Route** rules: which route a Plan Item adopts, and when
 * it may be changed.
 *
 * ## Why this file exists
 *
 * Autonomous Mode was on, the Board said it was on, and it did nothing at all for
 * an entire session. Every Item stayed on the `user` route and every one of them
 * landed on the user's desk — the exact opposite of the mode's purpose.
 *
 * The cause was a single condition. The `oracle` default was applied only when
 * the target state was `ready`:
 *
 * ```
 * if (params.state === "ready" && target.route === undefined && ...)
 * ```
 *
 * But an orchestrator is instructed to mark an Item `active` when it starts work,
 * so the common path is `backlog` → `active` → `review`, which never passes
 * through `ready`. The gate was in a place the traffic did not go.
 *
 * Nothing failed loudly. The mode was stored correctly, reported correctly, and
 * rendered its banner — so the only symptom was work quietly arriving for review
 * by hand. That is why the rule now lives in {@link routeToAdopt}, a pure
 * function, and why every path is asserted here rather than trusted.
 *
 * The second half of the file covers {@link setRoute}. The fix above needs a
 * matching relaxation: an Item with *no* route could not be moved to `oracle`,
 * because `routeOf` reports an absent route as `user` and the ratchet reads that
 * as de-escalation. So Autonomous Mode could not adopt the very Items it was
 * switched on for. Absent is now treated as "nobody chose", while an *explicit*
 * route still ratchets exactly as before — that ratchet is what stops an agent
 * awarding itself cheaper clearance once it sees how painful review would be, so
 * these tests pin down that it survives.
 */
import { describe, expect, test } from "bun:test";
import { backfillRoutes, canDelete, routeToAdopt, setRoute } from "./index.ts";

const AUTONOMOUS = { kind: "plan-meta" as const, autonomous: true };
const MANUAL = { kind: "plan-meta" as const, autonomous: false };

describe("routeToAdopt", () => {
	// The regression itself. `active` and `review` are the states the real path
	// actually uses, and both used to be missed.
	test.each(["backlog", "ready", "active", "blocked", "review"] as const)(
		"adopts oracle on a transition to %s when autonomous",
		(state) => {
			expect(routeToAdopt({ route: undefined }, state, AUTONOMOUS)).toBe(
				"oracle",
			);
		},
	);

	test("adopts oracle on the path that skips grooming entirely", () => {
		// backlog -> active -> review, never touching `ready`: the exact sequence
		// that left every Item of this session's plan on the `user` route.
		const item: { route: "user" | "oracle" | "skip" | undefined } = {
			route: undefined,
		};
		for (const state of ["active", "review"] as const) {
			const adopt = routeToAdopt(item, state, AUTONOMOUS);
			if (adopt !== null) item.route = adopt;
		}
		expect(item.route).toBe("oracle");
	});

	// Terminal states must NOT backfill a route: the `done` guard decides whether
	// an agent may clear an Item by reading its route, so adopting one here would
	// let an Item award itself the route that permits its own completion.
	test.each(["done", "failed", "dropped"] as const)(
		"refuses to adopt a route on a transition to %s",
		(state) => {
			expect(routeToAdopt({ route: undefined }, state, AUTONOMOUS)).toBeNull();
		},
	);

	test("leaves an explicit route alone, which keeps the mode a default", () => {
		// The whole reconciliation with ADR 0023: a mode that overrode per-Item
		// choices was rejected. `user` is the one that matters — an Item the user
		// pinned must never be silently auto-cleared.
		expect(routeToAdopt({ route: "user" }, "active", AUTONOMOUS)).toBeNull();
		expect(routeToAdopt({ route: "skip" }, "active", AUTONOMOUS)).toBeNull();
		expect(routeToAdopt({ route: "oracle" }, "active", AUTONOMOUS)).toBeNull();
	});

	test("adopts nothing when the mode is off or unset", () => {
		expect(routeToAdopt({ route: undefined }, "active", MANUAL)).toBeNull();
		expect(routeToAdopt({ route: undefined }, "active", null)).toBeNull();
		// An absent `autonomous` key is off, not on.
		expect(
			routeToAdopt({ route: undefined }, "active", { kind: "plan-meta" }),
		).toBeNull();
	});
});

describe("setRoute", () => {
	const items = () => [
		{ id: "p1", text: "unrouted", status: "review" as const },
		{
			id: "p2",
			text: "pinned to user",
			status: "review" as const,
			route: "user" as const,
		},
		{
			id: "p3",
			text: "on oracle",
			status: "review" as const,
			route: "oracle" as const,
		},
		{ id: "p4", text: "done", status: "done" as const },
	];

	// The blocker that made "re-route this item to oracle" impossible.
	test("an unrouted item may be set to any route", () => {
		for (const route of ["oracle", "skip", "user"] as const) {
			const list = items();
			const res = setRoute(list, "k", "p1", route);
			expect(res.ok).toBe(true);
			expect(list.find((i) => i.id === "p1")?.route).toBe(route);
		}
	});

	// The property the ratchet exists for. This is the test that must never be
	// relaxed: it is the anti-gaming guarantee.
	test("an explicit route still refuses to be lowered", () => {
		const list = items();
		const res = setRoute(list, "k", "p2", "oracle");
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("only ever escalates");
		// Unchanged on refusal — a refusal that half-applied would be worse than
		// either outcome.
		expect(list.find((i) => i.id === "p2")?.route).toBe("user");

		const list2 = items();
		expect(setRoute(list2, "k", "p3", "skip").ok).toBe(false);
		expect(list2.find((i) => i.id === "p3")?.route).toBe("oracle");
	});

	test("an explicit route may still escalate", () => {
		const list = items();
		expect(setRoute(list, "k", "p3", "user").ok).toBe(true);
		expect(list.find((i) => i.id === "p3")?.route).toBe("user");
	});

	test("setting the same route twice is a no-op, not a refusal", () => {
		const res = setRoute(items(), "k", "p3", "oracle");
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.unchanged).toBe(true);
	});

	test("a terminal item cannot be routed at all", () => {
		const res = setRoute(items(), "k", "p4", "oracle");
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("terminal");
	});

	test("an unknown id is refused rather than ignored", () => {
		const res = setRoute(items(), "k", "p99", "oracle");
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("Unknown item id");
	});

	// `from` is what the caller reports back to the user, so an absent route must
	// still read as `user` there even though the ratchet treats it as unset.
	test("reports the previous route as user when it was absent", () => {
		const res = setRoute(items(), "k", "p1", "oracle");
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.from).toBe("user");
	});
});

/**
 * `canDelete` covers op `delete`, which removes an Item from the plan outright.
 *
 * Two of these are safety properties rather than ergonomics. A terminal Item is
 * the record of what happened, so erasing one is refused for a stronger version
 * of the reason ADR 0014 makes `revise` refuse it — and `dropped` already exists
 * for abandoning work visibly, so the refusal never leaves the caller stuck. And
 * an Item with a live **Rework** has a *writer* editing the repository on its
 * behalf; deleting it would leave a child committing changes that nothing in the
 * plan describes (docs/adr/0041).
 */
describe("canDelete", () => {
	const active = { id: "p1", text: "in flight", status: "active" as const };

	test("deletes a non-terminal item", () => {
		for (const status of ["backlog", "ready", "active", "blocked", "review"] as const) {
			expect(canDelete({ id: "p1", text: "t", status }, "p1", "k", false).ok).toBe(true);
		}
	});

	test("refuses a terminal item, pointing at dropped instead", () => {
		for (const status of ["done", "failed", "dropped"] as const) {
			const res = canDelete({ id: "p1", text: "t", status }, "p1", "k", false);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toContain("record of what happened");
		}
	});

	test("refuses while a rework is still editing the repo", () => {
		const res = canDelete(
			{ ...active, reworkRunId: "pln-abc" },
			"p1",
			"k",
			true,
		);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toContain("still running");
			// The message must name the Run, or the user cannot go look at it.
			expect(res.error).toContain("pln-abc");
		}
	});

	test("allows deletion once the rework has finished", () => {
		expect(
			canDelete({ ...active, reworkRunId: "pln-abc" }, "p1", "k", false).ok,
		).toBe(true);
	});

	test("refuses an unknown id rather than silently succeeding", () => {
		const res = canDelete(undefined, "p99", "k", false);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("Unknown item id");
	});
});

/**
 * `backfillRoutes` adopts Autonomous Mode's default onto Items that never stated
 * a route, including ones already parked in `review`.
 *
 * `routeToAdopt` only fires on a transition, so an Item sitting in `review` when
 * the mode is switched on adopts nothing and waits for a reviewer that is never
 * dispatched. That stranded five real Items in this repo's own plan.
 *
 * The load-bearing assertion is that an **explicitly** routed Item is untouched.
 * ADR 0023 rejected a plan-level route that overrides per-Item choices, and 0032
 * rejected a mode that silently auto-clears an Item deliberately routed `user`.
 * Backfilling only *unrouted* Items is the absent-versus-explicit distinction
 * again — if that ever slips, this turns into the override both ADRs refused.
 */
describe("backfillRoutes", () => {
	const AUTO = { kind: "plan-meta" as const, autonomous: true };
	const OFF = { kind: "plan-meta" as const, autonomous: false };

	const plan = () => [
		{ id: "p1", text: "unrouted, in review", status: "review" as const },
		{ id: "p2", text: "unrouted, active", status: "active" as const },
		{
			id: "p3",
			text: "pinned to user",
			status: "review" as const,
			route: "user" as const,
		},
		{ id: "p4", text: "unrouted but done", status: "done" as const },
		{
			id: "p5",
			text: "already oracle",
			status: "active" as const,
			route: "oracle" as const,
		},
	];

	test("adopts oracle for unrouted non-terminal items", () => {
		const items = plan();
		const changed = backfillRoutes(items, AUTO);
		expect(changed.map((i) => i.id)).toEqual(["p1", "p2"]);
		expect(items.find((i) => i.id === "p1")?.route).toBe("oracle");
		expect(items.find((i) => i.id === "p2")?.route).toBe("oracle");
	});

	// The property that keeps this from being ADR 0023's rejected override.
	test("never touches an item the user explicitly routed", () => {
		const items = plan();
		backfillRoutes(items, AUTO);
		expect(items.find((i) => i.id === "p3")?.route).toBe("user");
	});

	test("leaves an already-oracle item alone", () => {
		const items = plan();
		const changed = backfillRoutes(items, AUTO);
		expect(changed.map((i) => i.id)).not.toContain("p5");
		expect(items.find((i) => i.id === "p5")?.route).toBe("oracle");
	});

	// A terminal item's route decides who may clear it; it is already cleared, so
	// that question must not be reopened.
	test("never routes a terminal item", () => {
		const items = plan();
		backfillRoutes(items, AUTO);
		expect(items.find((i) => i.id === "p4")?.route).toBeUndefined();
	});

	test("reports the parked items so their reviews can be dispatched", () => {
		// Dispatch normally rides on the transition into `review`, which has already
		// happened for these — so the caller needs to know which they are.
		const changed = backfillRoutes(plan(), AUTO);
		expect(changed.filter((i) => i.status === "review").map((i) => i.id)).toEqual(["p1"]);
	});

	test("changes nothing when the mode is off or absent", () => {
		for (const meta of [OFF, null, { kind: "plan-meta" as const }]) {
			const items = plan();
			expect(backfillRoutes(items, meta)).toEqual([]);
			expect(items.find((i) => i.id === "p1")?.route).toBeUndefined();
		}
	});

	test("is idempotent", () => {
		const items = plan();
		backfillRoutes(items, AUTO);
		// Second call finds nothing left unrouted, so it cannot re-dispatch reviews.
		expect(backfillRoutes(items, AUTO)).toEqual([]);
	});
});
