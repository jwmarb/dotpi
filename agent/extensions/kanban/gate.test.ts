/**
 * The orchestrator/subagent split: `kanban` for the human's pi, `todo` for a
 * spawned child — decided by `PI_SUBAGENT_RUN_ID`, inside each factory.
 *
 * Run from the repo root: `bun test agent/extensions/kanban/`
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import todo from "../todo.js";
import { setPersonaOverride } from "../lib/persona.js";
import kanban from "./index.js";

interface ToolStub {
	name: string;
	execute?: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => unknown;
}

interface Registered {
	tools: string[];
	toolObjs: ToolStub[];
	commands: string[];
	events: string[];
	handlers: Record<string, (...args: unknown[]) => unknown>;
}

/** A stub API that records what a factory registers, and nothing else. */
function stubApi(): { api: ExtensionAPI; seen: Registered } {
	const seen: Registered = { tools: [], toolObjs: [], commands: [], events: [], handlers: {} };
	const api = {
		registerTool: (tool: ToolStub) => {
			seen.tools.push(tool.name);
			seen.toolObjs.push(tool);
		},
		registerCommand: (name: string) => seen.commands.push(name),
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			seen.events.push(event);
			seen.handlers[event] = handler;
		},
	} as unknown as ExtensionAPI;
	return { api, seen };
}

const saved = process.env.PI_SUBAGENT_RUN_ID;
afterEach(() => {
	if (saved === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
	else process.env.PI_SUBAGENT_RUN_ID = saved;
	setPersonaOverride(undefined);
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
		expect(t.seen).toEqual({ tools: [], commands: [], events: [], toolObjs: [], handlers: {} });
	});

	test("a spawned subagent gets todo and no kanban", () => {
		process.env.PI_SUBAGENT_RUN_ID = "sub-a3f1";
		const k = stubApi();
		kanban(k.api);
		expect(k.seen).toEqual({ tools: [], commands: [], events: [], toolObjs: [], handlers: {} });

		const t = stubApi();
		todo(t.api);
		expect(t.seen.tools).toEqual(["todo"]);
		expect(t.seen.commands).toEqual(["todos"]);
		// No settle guard in a child: completion is child-done's, on agent_end.
		expect(t.seen.events).not.toContain("agent_before_settle");
	});

	test("the settle guard stands down while the active persona denies kanban", async () => {
		delete process.env.PI_SUBAGENT_RUN_ID;
		setPersonaOverride({ name: "quant", dir: "/quant", deniedTools: new Set(["kanban"]) });
		const k = stubApi();
		kanban(k.api);

		// One card on the board: with no stand-down this is exactly the state that
		// holds the turn open.
		const tool = k.seen.toolObjs.find((t) => t.name === "kanban");
		await tool!.execute!("t1", { op: "add", titles: ["a card"] }, undefined, undefined, { hasUI: false });

		// Denied: the guard is inert — the turn settles.
		expect(await k.seen.handlers["agent_before_settle"]({ outcome: "completed", entries: [] })).toBeUndefined();

		// Cleared: the same unaccounted board is guarded again.
		setPersonaOverride(undefined);
		const active = (await k.seen.handlers["agent_before_settle"]({ outcome: "completed", entries: [] })) as
			| { entries: Array<{ type: string; customType?: string }>; continue: boolean }
			| undefined;
		expect(active?.continue).toBe(true);
		expect(active?.entries).toHaveLength(1);
		expect(active?.entries?.[0]).toMatchObject({ type: "custom_message", customType: "kanban-reminder" });
	});
});
