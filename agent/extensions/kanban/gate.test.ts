/**
 * The orchestrator/subagent split: `kanban` for the human's pi, `todo` for a
 * spawned child — decided by `PI_SUBAGENT_RUN_ID`, inside each factory.
 *
 * Run from the repo root: `bun test agent/extensions/kanban/`
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import todo from "../todo.js";
import kanban from "./index.js";

interface Registered {
	tools: string[];
	commands: string[];
	events: string[];
}

/** A stub API that records what a factory registers, and nothing else. */
function stubApi(): { api: ExtensionAPI; seen: Registered } {
	const seen: Registered = { tools: [], commands: [], events: [] };
	const api = {
		registerTool: (tool: { name: string }) => seen.tools.push(tool.name),
		registerCommand: (name: string) => seen.commands.push(name),
		on: (event: string) => seen.events.push(event),
	} as unknown as ExtensionAPI;
	return { api, seen };
}

const saved = process.env.PI_SUBAGENT_RUN_ID;
afterEach(() => {
	if (saved === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
	else process.env.PI_SUBAGENT_RUN_ID = saved;
});

describe("role gate", () => {
	test("the orchestrator gets kanban and no todo", () => {
		delete process.env.PI_SUBAGENT_RUN_ID;
		const k = stubApi();
		kanban(k.api);
		expect(k.seen.tools).toEqual(["kanban"]);
		expect(k.seen.commands).toEqual(["kanban"]);
		expect(k.seen.events).toContain("agent_before_settle");

		const t = stubApi();
		todo(t.api);
		expect(t.seen).toEqual({ tools: [], commands: [], events: [] });
	});

	test("a spawned subagent gets todo and no kanban", () => {
		process.env.PI_SUBAGENT_RUN_ID = "sub-a3f1";
		const k = stubApi();
		kanban(k.api);
		expect(k.seen).toEqual({ tools: [], commands: [], events: [] });

		const t = stubApi();
		todo(t.api);
		expect(t.seen.tools).toEqual(["todo"]);
		expect(t.seen.commands).toEqual(["todos"]);
		// No settle guard in a child: completion is child-done's, on agent_end.
		expect(t.seen.events).not.toContain("agent_before_settle");
	});
});
