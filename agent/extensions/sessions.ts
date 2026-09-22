/**
 * Sessions extension — /sessions command.
 *
 * Opens a modal listing previous sessions for the current project. Each
 * entry shows the session's first user message (truncated to
 * FIRST_MESSAGE_MAX_CHARS), its date, and message count. Type to filter the
 * list; Enter resumes the selected session, Esc closes the modal (clearing
 * the filter first when one is active).
 *
 * Data comes from pi's own `SessionManager.list()`, which already extracts
 * first messages, session names, and mtimes — no re-parsing of JSONL here.
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import {
	type TUI,
	Key,
	matchesKey,
} from "@earendil-works/pi-tui";
import { cachedByWidth, frame, row } from "./lib/widget.js";

/** Hard cap (characters) for the first-message preview in the list. */
export const FIRST_MESSAGE_MAX_CHARS = 200;

/**
 * Normalize a session preview for single-line display: strip control
 * characters (they render as nothing or garbage in a list row) and collapse
 * whitespace runs so the preview fits one line.
 */
export function normalizePreview(text: string): string {
	return text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Truncate a normalized preview to FIRST_MESSAGE_MAX_CHARS, appending "…"
 * when cut. Input is plain text (see normalizePreview), so a character
 * slice is safe here — no ANSI to preserve.
 */
export function truncatePreview(text: string): string {
	if (text.length <= FIRST_MESSAGE_MAX_CHARS) return text;
	return text.slice(0, FIRST_MESSAGE_MAX_CHARS) + "…";
}

/**
 * Format a session date for the list: `Sep 21 21:44` for the current year,
 * `Sep 21 '25 21:44` for other years.
 */
export function formatSessionDate(d: Date): string {
	const months = [
		"Jan", "Feb", "Mar", "Apr", "May", "Jun",
		"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
	];
	const day = String(d.getDate()).padStart(2, "0");
	const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	const year = d.getFullYear();
	if (year !== new Date().getFullYear()) {
		return `${months[d.getMonth()]} ${day} '${String(year).slice(2)} ${time}`;
	}
	return `${months[d.getMonth()]} ${day} ${time}`;
}

/**
 * Fixed width of the date cell so the message column starts at the same
 * offset on every row (covers `● Sep 21 '25 21:44`).
 */
const DATE_CELL_WIDTH = 19;

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

interface SessionsModalArgs {
	sessions: SessionInfo[];
	/** Path of the session currently open, marked with ● in the list. */
	currentPath: string | undefined;
	tui: TUI;
	theme: Theme;
	done: (path: string | undefined) => void;
}

/**
 * Build the scrollable sessions-list modal component.
 *
 * State: a search filter (type to narrow), a selection index, and a list
 * scroll offset. The frame, row fitting and width-cached render all come
 * from `lib/widget.js` — this decides only what is shown.
 */
export function createSessionsModal({ sessions, currentPath, tui, theme, done }: SessionsModalArgs) {
	let filtered = sessions;
	let search = "";
	let selectedIndex = 0;
	let listScroll = 0;
	/**
	 * The overlay's render cache.
	 *
	 * Declared before `build` and assigned immediately after it, so no code
	 * path can reach `refresh()` before the assignment: `refresh` is called
	 * only from `handleInput`, which escapes only via the object returned
	 * at the end of this function.
	 */
	let viewer: { render: (width: number) => string[]; invalidate: () => void };

	function refresh(): void {
		viewer.invalidate();
		tui.requestRender();
	}

	/** Re-filter the list from the current search string. */
	function applySearch(): void {
		if (!search) {
			filtered = sessions;
			return;
		}
		const q = search.toLowerCase();
		filtered = sessions.filter((s) => {
			const hay = (s.name ? `${s.name} ` : "") + normalizePreview(s.firstMessage);
			return hay.toLowerCase().includes(q);
		});
		if (selectedIndex >= filtered.length) {
			selectedIndex = Math.max(0, filtered.length - 1);
		}
	}

	/** Rows available for the list inside the overlay. */
	function visibleRows(): number {
		const rows = tui.terminal?.rows ?? 24;
		// The overlay is capped near 90% of terminal height; reserve chrome + hints.
		return Math.max(4, Math.floor(rows * 0.9) - 7);
	}

	/**
	 * Builds the overlay's lines for a given width. Measurement, padding and
	 * the border all belong to `lib/widget.js`; this decides only *what* is
	 * shown.
	 */
	function build(width: number): string[] {
		const innerW = Math.max(1, Math.floor(width) - 4);
		const body: string[] = [];

		if (filtered.length === 0) {
			const msg = search
				? `No matches for "${search}"`
				: "No previous sessions for this project";
			body.push(theme.fg("muted", msg));
			body.push("");
			body.push(theme.fg("dim", " Esc close"));
			return frame(body, {
				title: "Sessions",
				width,
				styleTitle: (t) => theme.fg("accent", theme.bold(t)),
			});
		}

		const title = search
			? `Sessions (${filtered.length}/${sessions.length})`
			: `Sessions (${sessions.length})`;

		// Keep the selection in view.
		const visible = visibleRows();
		if (selectedIndex < listScroll) listScroll = selectedIndex;
		if (selectedIndex >= listScroll + visible) listScroll = selectedIndex - visible + 1;
		listScroll = Math.min(listScroll, Math.max(0, filtered.length - visible));

		const rows: string[] = [];
		for (let i = listScroll; i < Math.min(listScroll + visible, filtered.length); i++) {
			const s = filtered[i]!;
			const selected = i === selectedIndex;
			const isCurrent = s.path === currentPath;
			const date = (isCurrent ? "● " : "") + formatSessionDate(s.modified);
			const preview = truncatePreview(normalizePreview(s.firstMessage));
			const namePart = s.name
				? theme.fg("warning", `${s.name} — `)
				: "";
			const msgPart = theme.fg("text", preview);
			const bodyText = namePart + (selected ? theme.bold(msgPart) : msgPart);
			rows.push(
				row(
					[
						{ text: selected ? theme.fg("accent", "> ") : "  " },
						{ text: theme.fg("muted", date.padEnd(DATE_CELL_WIDTH)) },
						{ text: bodyText, flex: true, min: 10 },
						{ text: theme.fg("dim", ` ${s.messageCount}`) },
					],
					innerW,
				),
			);
		}
		while (rows.length < visible) rows.push("");
		body.push(...rows);

		if (search) {
			body.push(theme.fg("dim", ` filter: "${search}" · Esc clears`));
		}
		body.push(theme.fg("dim", " ↑↓ navigate · PgUp/PgDn jump · Enter resume · Esc close"));

		return frame(body, {
			title,
			width,
			styleTitle: (t) => theme.fg("accent", theme.bold(t)),
		});
	}

	function handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			selectedIndex = Math.max(0, selectedIndex - 1);
			refresh();
		} else if (matchesKey(data, Key.down)) {
			selectedIndex = Math.min(filtered.length - 1, selectedIndex + 1);
			refresh();
		} else if (matchesKey(data, Key.pageUp)) {
			const visible = visibleRows();
			selectedIndex = Math.max(0, selectedIndex - visible);
			refresh();
		} else if (matchesKey(data, Key.pageDown)) {
			const visible = visibleRows();
			selectedIndex = Math.min(filtered.length - 1, selectedIndex + visible);
			refresh();
		} else if (matchesKey(data, Key.enter)) {
			const selected = filtered[selectedIndex];
			done(selected ? selected.path : undefined);
		} else if (matchesKey(data, Key.escape)) {
			if (search) {
				search = "";
				applySearch();
				refresh();
			} else {
				done(undefined);
			}
		} else if (matchesKey(data, Key.ctrl("c"))) {
			done(undefined);
		} else if (matchesKey(data, Key.backspace)) {
			search = search.slice(0, -1);
			applySearch();
			refresh();
		} else {
			// Anything else printable goes into the search filter.
			const clean = data.replace(/[\x00-\x1f\x7f]/g, "");
			if (clean) {
				search += clean;
				applySearch();
				refresh();
			}
		}
	}

	// The cache is keyed on the render width, so a horizontal resize rebuilds
	// rather than serving lines measured against the old terminal.
	viewer = cachedByWidth(build);

	// `build` also sizes its row slice from the terminal *height*
	// (visibleRows), which the width-keyed cache cannot see. pi re-renders on
	// a height change but does not invalidate, so a taller terminal would
	// keep the old row count until the next keypress. Track it here and drop
	// the cached draw ourselves.
	let lastRows = tui.terminal?.rows;

	return {
		render: (width: number) => {
			const rows = tui.terminal?.rows;
			if (rows !== lastRows) {
				lastRows = rows;
				viewer.invalidate();
			}
			return viewer.render(width);
		},
		handleInput,
		invalidate: () => viewer.invalidate(),
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Register the sessions extension with the pi agent.
 *
 * Adds the `/sessions` command, which lists previous sessions for the
 * current project in a modal — each entry previewing the session's first
 * user message (truncated to 200 characters) — and resumes the selected
 * session on Enter.
 *
 * @param pi - The pi extension API.
 */
export default function (pi: ExtensionAPI) {
	pi.registerCommand("sessions", {
		description: "List previous sessions (first message preview) and resume one",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Session list needs the interactive UI", "warning");
				return;
			}

			let sessions: SessionInfo[];
			try {
				sessions = await SessionManager.list(ctx.cwd);
			} catch {
				ctx.ui.notify("Could not read the session list", "error");
				return;
			}

			const currentPath = ctx.sessionManager.getSessionFile();
			const selected = await ctx.ui.custom<string | undefined>(
				(tui, theme, _kb, done) =>
					createSessionsModal({ sessions, currentPath, tui, theme, done }),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "85%", maxHeight: "90%" },
				},
			);

			if (!selected) return;
			if (selected === currentPath) {
				ctx.ui.notify("Already in this session", "info");
				return;
			}
			const { cancelled } = await ctx.switchSession(selected);
			if (cancelled) {
				ctx.ui.notify("Session switch cancelled", "warning");
			}
		},
	});
}
