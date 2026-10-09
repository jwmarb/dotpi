/**
 * todo extension — the simple checklist a SPAWNED SUBAGENT keeps, rendered as a
 * live widget below the editor of its own herdr pane.
 *
 * Subagent-only: the factory returns at once unless `PI_SUBAGENT_RUN_ID` is set
 * (subagent-herdr stamps it into every child, and auto-appends `todo` to every
 * child's `--tools` allowlist). The human's orchestrator gets the kanban board
 * instead (`kanban/`), which replaced this list for it.
 *
 * Use case: multi-step work drifts. The agent writes the steps down, marks one
 * in progress, and whoever watches the child's pane sees what it thinks it is
 * doing.
 *
 * Behavior:
 * - Registers a `todo` tool (add / start / complete / block / drop / clear).
 * - Renders the list below the editor whenever it is non-empty; hides itself
 *   when empty, so a session that never plans anything costs no screen space.
 * - Registers `/todos` to print the list into the transcript on demand.
 *
 * WHY THERE IS NO SETTLE-TIME GUARD ANY MORE
 *
 * This extension used to hold the turn open on `agent_before_settle` while
 * items were still open. That guard now lives in the kanban extension, for the
 * orchestrator. In a subagent it cannot work and would be harmful: pi runs
 * `agent_before_settle` only after `agent_end` (`agent-session.js`
 * `_runAgentPrompt`), and the child's completion handshake
 * (`subagent-herdr/child-done.ts`) acts *on* `agent_end` — it writes the
 * `.exit` sidecar, tells the parent the run is done, closes its own pane and
 * shuts down. A continuation after that is either killed with the pane or,
 * worse, a child still editing files after its parent was told it finished
 * (decided with the oracle). Completion gating belongs to `child-done`.
 *
 * WHY THE STATE IS IN MEMORY, REBUILT FROM THE BRANCH
 *
 * Rebuilding the list from the branch before every op loses updates: pi runs a
 * message's tool calls in parallel and persists their results only after the
 * whole batch, so parallel `todo` calls all replayed the same branch and the
 * last one's snapshot erased the others' (observed: seven `block` calls left
 * one blocked item). Ops therefore apply to the in-memory list, synchronously,
 * and the branch rebuilds it only where the branch can actually change under
 * it — `session_start` (every reason) and `session_tree`.
 *
 *
 * WHY BELOW THE EDITOR AND NOT IN THE FOOTER
 *
 * `ctx.ui.setFooter()` *replaces* pi's built-in footer, which is where the
 * token counts, cost, model id and git branch live — a todo list is not worth
 * that trade. `setWidget(key, content, { placement: "belowEditor" })` composes
 * instead of replacing, so both survive.
 *
 * WHY THE STATE IS NOT IN A FILE
 *
 * The list is rebuilt by replaying `todo` tool results on the *current* branch
 * (`reconstruct`) at those two events. Fork or rewind, and the list is correct
 * for that point in history for free. The `plan` extension removed in `7a54a3b` kept
 * `agent/plans/<key>.jsonl` instead, which had no notion of branches: a rewind
 * left the file describing work the agent no longer remembered doing. Worse,
 * its Board wrote the same file (ADR 0015), which required a cross-process lock
 * that ADR 0035 then found could lose updates outright. One writer, no file, no
 * lock.
 *
 * Install location: ~/.pi/agent/extensions/todo.ts
 * (auto-discovered; hot-reload with /reload)
 */

import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	activeItem,
	applyOp,
	counts,
	demotedBy,
	emptyState,
	STATUS_GLYPH,
	summarize,
	TodoError,
	type TodoItem,
	type TodoOp,
	type TodoState,
	type TodoStatus,
} from "./lib/todo.js";
import { cachedByWidth, row } from "./lib/widget.js";

const TOOL_NAME = "todo";
const WIDGET_KEY = "todo";

/** Cap on rendered rows, so a long list cannot push the editor off screen. */
const MAX_WIDGET_ITEMS = 12;

const TodoParams = Type.Object({
	op: Type.Union(
		[
			Type.Literal("add"),
			Type.Literal("start"),
			Type.Literal("complete"),
			Type.Literal("block"),
			Type.Literal("drop"),
			Type.Literal("clear"),
		],
		{ description: "The operation to perform." },
	),
	texts: Type.Optional(
		Type.Array(Type.String(), {
			description: "For add: one short imperative per item, e.g. ['parse the header', 'write the test'].",
		}),
	),
	id: Type.Optional(
		Type.String({ description: "For start/complete/block/drop: the item id, e.g. 't3'." }),
	),
	note: Type.Optional(
		Type.String({
			description:
				"For block: what it is waiting on (required). For complete: how it was confirmed, e.g. 'bun test passes'.",
		}),
	),
});

type TodoParamsType = {
	op: "add" | "start" | "complete" | "block" | "drop" | "clear";
	texts?: string[];
	id?: string;
	note?: string;
};

interface TodoDetails {
	state: TodoState;
}

const STATUS_COLOR: Record<TodoStatus, ThemeColor> = {
	pending: "muted",
	in_progress: "accent",
	blocked: "warning",
	done: "success",
};

/** Turn loose tool arguments into a typed op, refusing what cannot be honoured. */
function toOp(params: TodoParamsType): TodoOp {
	switch (params.op) {
		case "add":
			if (!params.texts || params.texts.length === 0) {
				throw new TodoError("add needs `texts`: a list of item descriptions.");
			}
			return { op: "add", texts: params.texts };
		case "start":
			if (!params.id) throw new TodoError("start needs `id`.");
			return { op: "start", id: params.id };
		case "complete":
			if (!params.id) throw new TodoError("complete needs `id`.");
			return { op: "complete", id: params.id, note: params.note };
		case "block":
			if (!params.id) throw new TodoError("block needs `id`.");
			if (!params.note) throw new TodoError("block needs `note`: what it is waiting on.");
			return { op: "block", id: params.id, note: params.note };
		case "drop":
			if (!params.id) throw new TodoError("drop needs `id`.");
			return { op: "drop", id: params.id };
		case "clear":
			return { op: "clear" };
	}
}

export default function (pi: ExtensionAPI) {
	// The orchestrator has the kanban board; only spawned subagents keep this list.
	if (!process.env.PI_SUBAGENT_RUN_ID) return;

	let state: TodoState = emptyState();

	/**
	 * Rebuild the list from the current branch's `todo` tool results.
	 *
	 * The last snapshot wins: each result carries the whole state after its op,
	 * so replaying is a scan for the final one rather than a fold over ops.
	 */
	function reconstruct(ctx: ExtensionContext) {
		let found: TodoState | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message as { role?: string; toolName?: string; details?: unknown };
			if (msg.role !== "toolResult" || msg.toolName !== TOOL_NAME) continue;
			const details = msg.details as TodoDetails | undefined;
			if (details?.state?.items) found = details.state;
		}
		state = found ?? emptyState();
	}

	function buildLines(theme: Theme, width: number): string[] {
		const c = counts(state);
		const shown = state.items.slice(0, MAX_WIDGET_ITEMS);
		const hidden = state.items.length - shown.length;

		const lines: string[] = [
			theme.fg("accent", theme.bold(" Todo")) + theme.fg("dim", ` (${c.done}/${c.total})`),
		];

		for (const item of shown) {
			const color = STATUS_COLOR[item.status];
			const text = item.status === "done" ? theme.fg("dim", item.text) : theme.fg("text", item.text);
			lines.push(
				row(
					[
						{ text: `  ${theme.fg(color, STATUS_GLYPH[item.status])} ` },
						{ text: theme.fg("dim", `${item.id} `) },
						{ text, flex: true },
						{ text: item.note ? theme.fg("dim", `  ${item.note}`) : "" },
					],
					width,
				),
			);
		}

		if (hidden > 0) lines.push(theme.fg("dim", `  … ${hidden} more`));
		return lines;
	}

	/** Show the widget when there is something to show; otherwise remove it. */
	function refreshWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		if (state.items.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			// Every line leaves through `row`/`cachedByWidth` (lib/widget.js): an
			// unmeasured line wider than the terminal throws in pi's TUI host and
			// takes the whole process with it.
			(_tui, theme) => cachedByWidth((width) => buildLines(theme, width)) as Component,
			{ placement: "belowEditor" },
		);
	}

	pi.registerTool<typeof TodoParams, TodoDetails>({
		name: TOOL_NAME,
		label: "Todo",
		description:
			"Maintain a todo list for your current task, shown below the editor in your pane. " +
			"Ops: add (texts), start (id), complete (id, note?), block (id, note), drop (id), clear. " +
			"Items are addressed by id, so you never resend the whole list.",
		promptSnippet: "Track multi-step work in a visible todo list (add/start/complete/block).",
		promptGuidelines: [
			"For work of three or more non-trivial steps, call todo with op 'add' to write the steps down before starting. Skip it for single-step or trivial requests — a plan for trivial work is noise.",
			"Mark exactly one item in progress with op 'start' before working on it, and op 'complete' immediately after finishing it, not batched at the end. Starting an item automatically demotes the previous one, so complete or block the current item before starting the next.",
			"Only complete an item when it is genuinely finished. If tests fail, the implementation is partial, or you hit an unresolved error, use op 'block' with a note saying what is wrong instead.",
			"Before you finish your reply, every item must be resolved: complete, blocked with a note, or dropped. Settle the list as you go — nothing reminds you at the end.",
			"Do not restate the todo list in your replies after calling the tool — the user already sees it below the editor.",
		],
		parameters: TodoParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// No reconstruct here: the in-memory list is authoritative between branch
			// changes, and replaying the branch per op loses parallel updates (header).

			const before = state;
			try {
				state = applyOp(state, toOp(params as TodoParamsType));
			} catch (err) {
				if (err instanceof TodoError) {
					return {
						content: [{ type: "text", text: err.message }],
						details: { state },
						isError: true,
					};
				}
				throw err;
			}

			refreshWidget(ctx);

			// A `start` that silently demoted the previous item is the first half of
			// the forgetting this extension guards against: the agent moves on and
			// the abandoned item sits at pending for the rest of the session. Say it
			// here, where the fix is still one call away — lib/todo.ts promises the
			// caller reports this rather than demoting in silence.
			const demoted = demotedBy(before, state);
			const lines = [summarize(state)];
			if (demoted) {
				lines.push(
					`Note: ${demoted.id} (${demoted.text}) went back to pending. ` +
						"If it is finished, complete it; if something is in the way, block it with a note.",
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { state },
			};
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current todo list",
		handler: async (_args, ctx) => {
			reconstruct(ctx);
			refreshWidget(ctx);

			if (state.items.length === 0) {
				ctx.ui.notify("Todo list is empty.", "info");
				return;
			}

			const active = activeItem(state);
			const lines = state.items.map((item: TodoItem) => {
				const note = item.note ? ` — ${item.note}` : "";
				return `${STATUS_GLYPH[item.status]} ${item.id}  ${item.text}${note}`;
			});
			const header = active ? `Todo — now: ${active.text}` : "Todo";
			ctx.ui.notify([header, ...lines].join("\n"), "info");
		},
	});

	// Both events fire on a branch change; the widget must follow the branch or
	// it will show a list the conversation has moved away from.
	pi.on("session_start", async (_event, ctx) => {
		reconstruct(ctx);
		refreshWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstruct(ctx);
		refreshWidget(ctx);
	});

}
