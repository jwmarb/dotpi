/**
 * Regression tests for {@link buildSubagentToolAllowlist}.
 *
 * The core contract under test (docs/adr/0037): an autonomous child — a
 * review or rework — may NOT delegate, so with `allowNesting` false the
 * nesting tools must be ABSENT from the result no matter what the agent
 * file declares. They are removed, not merely not added: a file that
 * declares `subagent` or `subagent_tasks` must not hand the capability to
 * the child.
 *
 * Not discovered by pi's extension loader (a subdirectory exposes only its
 * `index.ts`); run directly: `bun test agent/extensions/subagent/native.test.ts`
 *
 * @module native.test
 */
import { describe, expect, it } from "bun:test";
import { buildSubagentToolAllowlist, NESTING_TOOLS } from "./native.js";

const DONE = "subagent_done";

describe("buildSubagentToolAllowlist", () => {
	it("returns null when the agent declares no tools", () => {
		expect(buildSubagentToolAllowlist(undefined, DONE)).toBeNull();
		expect(buildSubagentToolAllowlist([], DONE)).toBeNull();
		expect(buildSubagentToolAllowlist([], DONE, false)).toBeNull();
	});

	it("always appends the done tool", () => {
		expect(buildSubagentToolAllowlist(["read", "bash"], DONE)).toContain(DONE);
		expect(buildSubagentToolAllowlist(["read", "bash"], DONE, false)).toContain(
			DONE,
		);
	});

	it("adds the nesting tools for a delegating child", () => {
		const tools = buildSubagentToolAllowlist(["read", "bash"], DONE) ?? [];
		for (const tool of NESTING_TOOLS) expect(tools).toContain(tool);
	});

	it("does not add the nesting tools when nesting is disallowed", () => {
		const tools = buildSubagentToolAllowlist(["read", "bash"], DONE, false) ?? [];
		for (const tool of NESTING_TOOLS) expect(tools).not.toContain(tool);
		expect(tools).toContain("read");
		expect(tools).toContain("bash");
	});

	/**
	 * Regression (oracle review, D2): the previous version initialized the
	 * allowlist from the agent's declared tools and only refrained from
	 * *adding* the nesting tools, so an agent file that declares either of
	 * them leaked them into an autonomous child — `runReviewNatively` then
	 * passed the list through unchanged despite requesting no nesting.
	 */
	it("removes nesting tools an agent file declares when nesting is disallowed", () => {
		const declared = ["read", "bash", "subagent", "subagent_tasks"];
		const tools = buildSubagentToolAllowlist(declared, DONE, false) ?? [];
		for (const tool of NESTING_TOOLS) expect(tools).not.toContain(tool);
		// Everything else survives, in order, with the done tool guaranteed.
		expect(tools).toEqual(["read", "bash", DONE]);
	});

	it("removes a single declared nesting tool", () => {
		const tools =
			buildSubagentToolAllowlist(["bash", "subagent_tasks"], DONE, false) ?? [];
		expect(tools).not.toContain("subagent_tasks");
		expect(tools).not.toContain("subagent");
		expect(tools).toEqual(["bash", DONE]);
	});

	it("keeps declared nesting tools when nesting is allowed", () => {
		const tools =
			buildSubagentToolAllowlist(["subagent", "subagent_tasks"], DONE) ?? [];
		expect(tools).toEqual(["subagent", "subagent_tasks", DONE]);
	});

	it("deduplicates a done tool the agent already declared", () => {
		const tools = buildSubagentToolAllowlist([DONE, "bash"], DONE, false) ?? [];
		expect(tools).toEqual([DONE, "bash"]);
	});
});
