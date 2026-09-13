/**
 * thinking-indicator — live, collapsible "Thinking…" line for pi.
 *
 * While the model is reasoning (thinking tokens streaming, before any text),
 * an animated line appears above the editor:
 *
 *     ▸ ◐ Thinking… 12s  (expand)
 *
 * Click the line or press ctrl+k to expand it and watch the raw thinking
 * stream live (last 12 lines, dimmed; earlier content elided):
 *
 *     ▾ ◑ Thinking… 12s  (collapse)
 *       <thinking text>
 *
 * The widget auto-hides as soon as assistant text starts or the turn ends.
 * Thinking content in the transcript is untouched — pi's built-in ctrl+t /
 * click-to-expand behavior still controls per-block visibility there.
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
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const FRAMES = ["◐", "◓", "◑", "◒"] as const;
const TICK_MS = 120;
const BODY_MAX_LINES = 12;

class ThinkingIndicator implements Component {
	private tui: TUI;
	private theme: Theme;
	private active = false;
	private expanded = false;
	private thinking = "";
	private startedAt = 0;
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

	/** Call on text_start / text_delta / message_end / agent_end. */
	onIdle(): void {
		if (!this.active) return;
		this.reset();
		this.tui.requestRender();
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
		const secs = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
		const arrow = this.expanded ? "▾" : "▸";
		const frame = FRAMES[this.frame];
		const action = this.expanded ? "collapse" : "expand";
		let header = `${arrow} ${frame} ${this.theme.italic("Thinking…")} ${secs}s`;
		const hint = ` (${action})`;
		if (width > header.length + hint.length) {
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
		return lines;
	}
}

let indicator: ThinkingIndicator | undefined;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		indicator?.dispose();
		ctx.ui.setWidget("thinking-indicator", (tui, theme) => {
			indicator = new ThinkingIndicator(tui, theme);
			return indicator;
		});
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
		} else if (ev.type === "text_start" || ev.type === "text_delta") {
			indicator.onIdle();
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (!indicator || !ctx.hasUI) return;
		if (event.message.role === "assistant") indicator.onIdle();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI) indicator?.onIdle();
	});

	pi.registerShortcut("ctrl+k", {
		description: "Expand/collapse the live Thinking… indicator",
		handler: () => indicator?.toggle(),
	});
}
