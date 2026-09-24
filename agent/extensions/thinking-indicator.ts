/**
 * thinking-indicator — live "Thinking…" spinner plus a "Thought for Xs" record.
 *
 * Two halves, deliberately split by lifetime:
 *
 * 1. WHILE REASONING — an animated line above the editor, live and transient:
 *
 *        ▸ ◐ Thinking… 12s  (alt+t to expand)
 *
 *    Click it or press alt+t to watch the raw thinking stream (last 12 lines,
 *    dimmed; earlier content elided). It clears the moment assistant text or a
 *    tool call starts, so it never lingers over a finished turn.
 *
 * 2. AFTER REASONING — the duration is written into the transcript itself, by
 *    relabelling pi's collapsed thinking placeholder via setHiddenThinkingLabel:
 *
 *        Thought for 12s (ctrl+t to expand)
 *
 *    That line is a real pi thinking block, so the advertised ctrl+t genuinely
 *    expands it, and the record stays attached to its message in scrollback
 *    after the widget is gone.
 *
 * REQUIRES `"hideThinkingBlock": true` in agent/settings.json. Without it pi
 * renders thinking in full and there is no placeholder to relabel — half of
 * this extension silently does nothing.
 *
 * Two keybinding constraints are load-bearing here (see the RESERVED list in
 * pi's core, RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS):
 *   - ctrl+t belongs to pi (app.thinking.toggle). We advertise it but must NOT
 *     register it; pi already implements the expand we are pointing at.
 *   - ctrl+k is reserved too (tui.editor.deleteToLineEnd), so the binding this
 *     widget used to declare was silently skipped and never worked. ctrl+o is
 *     reserved as well (app.tools.expand), so the live expand is alt+t, which
 *     is bound to nothing in pi's defaults.
 *
 * setHiddenThinkingLabel is global in pi: one label for every collapsed block.
 * Each finished turn therefore relabels all blocks with its own duration, so on a
 * long session older blocks show the newest duration, not their own. The duration
 * is persisted on the assistant message (thinkingDurationMs) and re-applied on
 * session_start, so a resumed, forked, or reloaded transcript doesn't fall back
 * to pi's default "Thinking..." label.
 *
 * Note: the theme captured at session start is used for styling; switch
 * themes with /theme and it applies after the next /reload or restart.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { fitLines } from "./lib/widget.js";

const FRAMES = ["◐", "◓", "◑", "◒"] as const;
const TICK_MS = 120;
const BODY_MAX_LINES = 12;

/**
 * Expands the LIVE widget. Must stay off pi's reserved list: ctrl+k
 * (deleteToLineEnd) and ctrl+o (tools.expand) are both refused, and a refused
 * registration fails silently.
 */
const LIVE_EXPAND_KEY = "alt+t";

/**
 * Expands the FINISHED record in the transcript. This is pi's own
 * app.thinking.toggle — advertised in the label, never registered by us.
 */
const TRANSCRIPT_EXPAND_KEY = "ctrl+t";

class ThinkingIndicator implements Component {
	private tui: TUI;
	private theme: Theme;
	private active = false;
	private expanded = false;
	private thinking = "";
	private startedAt = 0;
	/** Duration of the most recent finished reasoning, in ms (carries over to message_end). */
	private lastFinishedMs: number | undefined;
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(tui: TUI, theme: Theme) {
		this.tui = tui;
		this.theme = theme;
	}

	dispose(): void {
		this.stopTicker();
	}

	reset(): void {
		this.active = false;
		this.expanded = false;
		this.thinking = "";
		this.startedAt = 0;
		this.stopTicker();
	}

	/** Call on thinking_start / thinking_delta; `text` is the accumulated thinking so far. */
	onThinking(text: string): void {
		this.thinking = text;
		if (!this.active) {
			this.active = true;
			this.startedAt = Date.now();
			this.startTicker();
			this.tui.requestRender();
		}
	}
	/**
	 * Milliseconds of the most recent finished reasoning. Exposed so message_end
	 * can persist the duration even when onIdle() already consumed it on
	 * text_start/toolcall_start.
	 */
	get finishedMs(): number | undefined {
		return this.lastFinishedMs;
	}

	/**
	 * Call on text_start / text_delta / toolcall_start / message_end / agent_end.
	 *
	 * Returns the duration in milliseconds of the reasoning that just ended, or
	 * undefined when there was nothing active. The caller uses it to write the
	 * "Thought for Xs" record into the transcript — the widget itself keeps no
	 * finished state, since it clears here and the transcript is what survives.
	 */
	onIdle(): number | undefined {
		if (!this.active) return undefined;
		const ms = Date.now() - this.startedAt;
		this.lastFinishedMs = ms;
		this.reset();
		this.tui.requestRender();
		return ms;
	}

	private elapsedSeconds(): number {
		return Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
	}

	toggle(): void {
		if (!this.active) return;
		this.expanded = !this.expanded;
		this.tui.requestRender();
	}

	private startTicker(): void {
		this.stopTicker();
		this.timer = setInterval(() => {
			if (!this.active) return;
			this.frame = (this.frame + 1) % FRAMES.length;
			this.tui.requestRender();
		}, TICK_MS);
	}

	private stopTicker(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "click" && event.button === "left") {
			this.toggle();
			return { handled: true };
		}
		return undefined;
	}

	invalidate(): void {
		// render() is pure over current state; nothing to clear
	}

	render(width: number): string[] {
		if (!this.active) return [];
		const secs = this.elapsedSeconds();
		const arrow = this.expanded ? "▾" : "▸";
		const frame = FRAMES[this.frame];
		const action = this.expanded ? "collapse" : "expand";
		let header = `${arrow} ${frame} ${this.theme.italic("Thinking…")} ${secs}s`;
		const hint = ` (${LIVE_EXPAND_KEY} to ${action})`;
		// visibleWidth, not .length: header carries ANSI styling, whose bytes would
		// otherwise be counted as columns and hide the hint on wide terminals.
		if (width >= visibleWidth(header) + hint.length) {
			header += this.theme.fg("dim", hint);
		}
		const lines = [header];
		if (this.expanded) {
			const body = this.thinking.trim();
			if (body) {
				const rawLines = body.split("\n");
				const elided = rawLines.length > BODY_MAX_LINES;
				if (elided) {
					lines.push(this.theme.fg("dim", "  … (earlier thinking elided)"));
				}
				for (const line of rawLines.slice(-BODY_MAX_LINES)) {
					const colored = this.theme.fg("thinkingText", `  ${line}`);
					for (const wrapped of wrapTextWithAnsi(colored, Math.max(1, width))) {
						lines.push(wrapped);
					}
				}
			}
		}
		// The header is hand-built rather than wrapped, so nothing above has
		// measured it: a narrow Run Pane makes "▸ ◐ Thinking… 12s" wider than the
		// terminal, and pi kills the process over it rather than clipping.
		return fitLines(lines, width);
	}
}

let indicator: ThinkingIndicator | undefined;

/**
 * Builds the label pi shows for a finished thinking block.
 *
 * Sub-second reasoning is labelled "<1s" rather than skipped: the default
 * "Thinking..." label reads as in-progress, so a finished block left with it
 * looks stuck — and the default 27B model routinely thinks for under a second.
 */
function durationLabel(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	return `Thought for ${seconds <= 0 ? "<1s" : `${seconds}s`} (${TRANSCRIPT_EXPAND_KEY} to expand)`;
}

/** Writes the finished-reasoning record into pi's collapsed thinking placeholder. */
function recordDuration(ctx: ExtensionContext, ms: number | undefined): void {
	if (ms === undefined) return;
	ctx.ui.setHiddenThinkingLabel(durationLabel(ms));
}

/**
 * Re-apply the newest persisted duration after pi re-renders a stored transcript.
 *
 * Only the newest is applied because setHiddenThinkingLabel is global — see the
 * header. A session with nothing persisted leaves pi's default label alone.
 */
function restoreLatestDuration(ctx: ExtensionContext): void {
	let latest: number | undefined;
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		const ms = (message as { thinkingDurationMs?: number }).thinkingDurationMs;
		if (typeof ms === "number") latest = ms;
	}
	if (latest !== undefined) ctx.ui.setHiddenThinkingLabel(durationLabel(latest));
}

/**
 * How long to wait before re-applying the restored label.
 *
 * On /reload and session switches the transcript already exists when
 * session_start fires, so the immediate call relabels it. On a cold start
 * (`pi --session`, `pi -c`) pi renders the transcript *after* session_start and
 * the immediate call is lost, so it is re-applied once the first frame is up.
 * Measured: a set at session_start (and at +0ms) does not survive; +200ms does.
 */
const RESTORE_RETRY_MS = 250;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		indicator?.dispose();
		ctx.ui.setWidget("thinking-indicator", (tui, theme) => {
			indicator = new ThinkingIndicator(tui, theme);
			return indicator;
		});
		// Any start that renders a stored transcript (pi --session/--continue, the
		// /sessions switch, a fork, /reload) rebuilds its thinking blocks with pi's
		// default label, and resetExtensionUI has dropped the global one. Restoring
		// unconditionally is correct: reason does not distinguish those starts
		// (a --session resume reports "startup"), and a session with nothing
		// persisted leaves the label untouched.
		restoreLatestDuration(ctx);
		setTimeout(() => {
			if (ctx.hasUI) restoreLatestDuration(ctx);
		}, RESTORE_RETRY_MS);
	});

	pi.on("message_update", (event, ctx) => {
		if (!indicator || !ctx.hasUI) return;
		const ev = event.assistantMessageEvent;
		if (ev.type === "thinking_start" || ev.type === "thinking_delta") {
			const message = event.message;
			if (message.role !== "assistant") return;
			const thinking = message.content
				.filter((c) => c.type === "thinking")
				.map((c) => c.thinking)
				.join("\n\n");
			indicator.onThinking(thinking);
		} else if (ev.type === "text_start" || ev.type === "text_delta" || ev.type === "toolcall_start") {
			// A tool call with no preceding text is the common agent path; without
			// this the spinner would keep counting through tool execution.
			recordDuration(ctx, indicator.onIdle());
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (!indicator || !ctx.hasUI) return;
		if (event.message.role !== "assistant") return;
		// For text/toolcall turns onIdle() already consumed the duration when the
		// block first went idle; lastFinishedMs carries it across to message_end.
		const ms = indicator.onIdle() ?? indicator.finishedMs;
		recordDuration(ctx, ms);
		const hasThinking = event.message.content.some((c) => c.type === "thinking" && c.thinking.trim());
		if (ms === undefined || !hasThinking) return;
		// Persist the duration on the message itself so a re-rendered transcript
		// (resume, switch, reload) can restore the label.
		return { message: { ...event.message, thinkingDurationMs: ms } as typeof event.message };
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI && indicator) recordDuration(ctx, indicator.onIdle());
	});

	// Registers the LIVE expand only. ctrl+t is pi's own and already expands the
	// transcript record we advertise it for; registering it here would be refused.
	pi.registerShortcut(LIVE_EXPAND_KEY, {
		description: "Expand/collapse the live Thinking… indicator",
		handler: () => indicator?.toggle(),
	});
}
