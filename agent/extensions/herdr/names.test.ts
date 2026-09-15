/**
 * Tests for the two predicates that decide whether a pi session names its herdr
 * pane, and what it may name.
 *
 * ## Why this file exists
 *
 * Both predicates were wrong once, in the same way: they *looked* right and their
 * only symptom was a pane quietly keeping the wrong name.
 *
 * `namesOnReason` began as `reason !== "startup" && return`, on the reasoning that
 * a reload is the same pane and already named. That is backwards \u2014 a reload is
 * precisely how this extension first arrives in a pane that predates it, so
 * `/reload` loaded the new code and then left the pane unnamed. An autonomous
 * oracle review caught it, and also noted there was no committed test for the
 * five-way guard. This is that test.
 *
 * `isChildRun` guards something worse than a cosmetic slip. A Run is also a pi
 * process, so without it every review, rework and delegated Run would relabel its
 * own tab `orchestrator`, destroying the naming its spawner had just applied \u2014
 * the exact opposite of the point. It is asserted per marker rather than once,
 * because the three markers are set by three different code paths and any one of
 * them going missing would silently re-open that hole.
 */
import { describe, expect, test } from "bun:test";
import { isChildRun, namesOnReason } from "../herdr-names.ts";

/** A herdr-hosted session with no child-Run markers: a plain orchestrator. */
const ORCHESTRATOR = {
	HERDR_ENV: "1",
	HERDR_WORKSPACE_ID: "w1",
	HERDR_TAB_ID: "w1:t1",
	HERDR_PANE_ID: "w1:p1",
} as NodeJS.ProcessEnv;

describe("namesOnReason", () => {
	// A fresh session has never been named; a reload is how this extension first
	// reaches a pane that predates it. Both must name.
	test.each(["startup", "reload"] as const)("names on %s", (reason) => {
		expect(namesOnReason(reason)).toBe(true);
	});

	// These swap the session inside a pane that is already named, so renaming
	// would fight a label the user set by hand.
	test.each(["new", "resume", "fork"] as const)("does not name on %s", (reason) => {
		expect(namesOnReason(reason)).toBe(false);
	});

	// The regression, stated as its own case: excluding `reload` is what made
	// /reload load the code and leave the pane unnamed.
	test("reload is included, which is the bug this fixed", () => {
		expect(namesOnReason("reload")).toBe(true);
	});

	test("an unknown reason does not name", () => {
		// Defaulting to naming would mean a future pi reason silently relabels a
		// pane; defaulting to leaving it alone is the recoverable direction.
		expect(namesOnReason("compact")).toBe(false);
		expect(namesOnReason("")).toBe(false);
	});
});

describe("isChildRun", () => {
	test("a plain herdr session is not a child Run", () => {
		expect(isChildRun(ORCHESTRATOR)).toBe(false);
	});

	test("an environment with no herdr variables at all is not a child Run", () => {
		expect(isChildRun({} as NodeJS.ProcessEnv)).toBe(false);
	});

	// One case per marker: each is set by a different spawner, and any one going
	// unrecognised would let that kind of Run overwrite its own name.
	test.each([
		["PI_SUBAGENT_RUN_ID", "sub-a3f1beef-1", "a delegated Run"],
		["PI_PLAN_IN_REVIEW", "1", "an autonomous review"],
		["PI_RUN_WRAPPER", "/x/run-wrapper.sh", "a Run launched through the herdr plugin"],
	])("%s marks %s as a child Run", (key, value) => {
		expect(isChildRun({ ...ORCHESTRATOR, [key]: value })).toBe(true);
	});

	test("an empty marker does not count as set", () => {
		// An exported-but-empty variable is how a shell passes "unset" through a
		// wrapper, so treating it as present would stop an orchestrator naming
		// itself for no reason.
		expect(isChildRun({ ...ORCHESTRATOR, PI_SUBAGENT_RUN_ID: "" })).toBe(false);
		expect(isChildRun({ ...ORCHESTRATOR, PI_PLAN_IN_REVIEW: "" })).toBe(false);
		expect(isChildRun({ ...ORCHESTRATOR, PI_RUN_WRAPPER: "" })).toBe(false);
	});

	test("several markers at once is still a child Run", () => {
		// A rework carries both the wrapper and the review interlock.
		expect(
			isChildRun({
				...ORCHESTRATOR,
				PI_RUN_WRAPPER: "/x/run-wrapper.sh",
				PI_PLAN_IN_REVIEW: "1",
			}),
		).toBe(true);
	});
});
