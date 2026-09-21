/**
 * Changed Files Widget Extension
 *
 * Tracks files modified during a conversation session and displays a widget
 * above the editor showing changed files with status indicators and
 * color-coded +/− line counts. The widget shows at most 5 files; a
 * "… N more — /diff" hint points to the full list.
 *
 * The `/diff` command opens a modal with a scrollable list of *all* changed
 * files. Navigate with ↑↓, press Enter on a file to view its diff in a
 * scrollable view (←/Esc goes back to the list, Esc on the list or Ctrl+C closes).
 *
 * Tracking sources:
 * - `write` / `edit` tool calls (instant, from tool input)
 * - `git status --porcelain` on turn end (catches bash-induced changes)
 *
 * Change indicators:
 * - ● Created  (green)
 * - ● Modified (yellow)
 * - ● Deleted  (red)
 * - ○ Untracked (dim)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type TUI,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

/** Maximum number of files shown in the inline widget. */
const MAX_WIDGET_FILES = 5;

/** Maximum diff lines rendered in the modal (keeps giant diffs responsive). */
const MAX_DIFF_LINES = 5000;

/** Read cap (bytes) for counting/previewing untracked files. */
const MAX_UNTRACKED_BYTES = 256 * 1024;

/** Git porcelain status prefix to our display label. */
const GIT_STATUS_MAP = {
	A: "created",
	M: "modified",
	D: "deleted",
	R: "renamed",
	C: "copied",
	T: "modified",
	U: "modified",
	"??": "untracked",
} as const;

/** Status label to display prefix. */
const STATUS_PREFIX = {
	created: "●",
	modified: "●",
	deleted: "●",
	renamed: "●",
	copied: "●",
	untracked: "○",
} as const;

/** Known change status labels derived from our git status map. */
type ChangeStatus = (typeof GIT_STATUS_MAP)[keyof typeof GIT_STATUS_MAP];

/** Git status keys that have " -> " rename syntax. */
const RENAME_STATUS_PREFIXES = ["R", "C"] as const;

interface ChangedFile {
	path: string;
	status: ChangeStatus;
	/** Added lines; -1 = unknown (no git data available). */
	added: number;
	/** Removed lines; -1 = unknown. */
	removed: number;
	/** true for binary files (`git diff --numstat` reports "-"). */
	binary: boolean;
}

// ---------------------------------------------------------------------------
// Git data collection
// ---------------------------------------------------------------------------

/**
 * Parse `git status --porcelain` output into a map of changed files.
 * Line counts are filled in later by {@link enrichWithCounts}.
 * Returns null if git is not available or not in a repo.
 */
async function parseGitStatus(
	cwd: string,
): Promise<Map<string, ChangedFile> | null> {
	try {
		const output = execSyncGit(cwd, ["status", "--porcelain"]);
		if (!output) return new Map();

		const map = new Map<string, ChangedFile>();

		for (const line of output.split("\n")) {
			if (line.length < 2) continue;

			const status = line.slice(0, 2);
			let file: string;

			// Renamed/copied files have format "R100 old -> new"
			if (RENAME_STATUS_PREFIXES.includes(status[0] as "R" | "C")) {
				const arrowIndex = line.indexOf(" -> ");
				if (arrowIndex === -1) continue;
				file = line.slice(arrowIndex + 4);
			} else {
				file = line.slice(3); // skip "X " prefix
			}

			const label = (GIT_STATUS_MAP[status as keyof typeof GIT_STATUS_MAP] ??
				"modified") as ChangeStatus;
			map.set(file, { path: file, status: label, added: -1, removed: -1, binary: false });
		}

		return map;
	} catch {
		// Not a git repo, git not installed, or timeout — return null
		return null;
	}
}

/**
 * Run `git diff --numstat` (vs HEAD when possible) and map each path to its
 * added/removed line counts. Returns null when git is unavailable; an empty
 * map when there is nothing to report.
 */
function collectNumstat(
	cwd: string,
): Map<string, { added: number; removed: number; binary: boolean }> | null {
	try {
		let output: string;
		try {
			output = execSyncGit(cwd, ["diff", "HEAD", "--numstat"]);
		} catch {
			// No HEAD yet (fresh repo with no commits) — diff index vs worktree.
			output = execSyncGit(cwd, ["diff", "--numstat"]);
		}

		const map = new Map<string, { added: number; removed: number; binary: boolean }>();
		for (const line of output.split("\n")) {
			if (!line) continue;
			const [a, r, ...rest] = line.split("\t");
			const path = rest.join("\t");
			if (!path) continue;
			const binary = a === "-" || r === "-";
			map.set(path, {
				added: binary ? -1 : Number(a) || 0,
				removed: binary ? -1 : Number(r) || 0,
				binary,
			});
		}
		return map;
	} catch {
		return null;
	}
}

/** Thin wrapper over execFileSync with the options git calls share. */
function execSyncGit(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		timeout: 5_000,
		maxBuffer: 4 * 1024 * 1024,
		stdio: ["ignore", "pipe", "ignore"], // silence stderr (e.g., "fatal: not a git repo")
	});
}

/**
 * Count lines in an (untracked) file, capped at MAX_UNTRACKED_BYTES.
 * Returns -1 when the file cannot be read.
 */
function countFileLines(cwd: string, relPath: string): number {
	try {
		const buf = readFileSync(join(cwd, relPath));
		const slice = buf.subarray(0, MAX_UNTRACKED_BYTES);
		let lines = 0;
		for (let i = 0; i < slice.length; i++) {
			if (slice[i] === 0x0a) lines++;
		}
		if (slice.length > 0 && slice[slice.length - 1] !== 0x0a) lines++;
		return lines;
	} catch {
		return -1;
	}
}

/** Fill in added/removed counts for a git-derived file map (in place). */
function enrichWithCounts(
	files: Map<string, ChangedFile>,
	cwd: string,
): Map<string, ChangedFile> {
	const numstat = collectNumstat(cwd);
	for (const file of files.values()) {
		const ns = numstat?.get(file.path);
		if (ns) {
			file.added = ns.added;
			file.removed = ns.removed;
			file.binary = ns.binary;
		}
		if (file.status === "untracked") {
			const n = countFileLines(cwd, file.path);
			if (n >= 0) {
				file.added = n;
				file.removed = 0;
				file.binary = false;
			}
		}
	}
	return files;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/**
 * Map a change status label to a theme color key.
 *
 * @param status - The git change status label.
 * @returns A theme color key for styling.
 */
function statusToColor(status: ChangeStatus): ThemeColor {
	switch (status) {
		case "created":
			return "success";
		case "modified":
			return "warning";
		case "deleted":
			return "error";
		case "untracked":
			return "dim";
		case "renamed":
		case "copied":
			return "muted";
		default: {
			// Exhaustiveness check — compiler error if a new status is added
			const _never: never = status;
			throw new Error(`Unexpected status: ${_never}`);
		}
	}
}

/**
 * Render the color-coded `+added -removed` counts for one file.
 *
 * @param file - The changed file entry.
 * @param theme - The theme accessor.
 * @returns Styled counts string (`bin`, `+? -?`, or `+N -M`).
 */
function formatCounts(file: ChangedFile, theme: Theme): string {
	if (file.binary) return theme.fg("muted", "bin");
	if (file.added < 0 && file.removed < 0) return theme.fg("dim", "+? -?");
	const plus = theme.fg("toolDiffAdded", `+${Math.max(file.added, 0)}`);
	const minus = theme.fg("toolDiffRemoved", `-${Math.max(file.removed, 0)}`);
	return `${plus} ${minus}`;
}


/**
 * Color one raw diff line for the modal viewer.
 *
 * @param line - A raw diff line (from `git diff` or synthesized for untracked files).
 * @param theme - The theme accessor.
 * @returns The styled line.
 */
function styleDiffLine(line: string, theme: Theme): string {
	if (
		line.startsWith("diff ") ||
		line.startsWith("index ") ||
		line.startsWith("new file") ||
		line.startsWith("deleted file") ||
		line.startsWith("old mode") ||
		line.startsWith("new mode") ||
		line.startsWith("similarity") ||
		line.startsWith("rename ") ||
		line.startsWith("+++") ||
		line.startsWith("---")
	) {
		return theme.fg("muted", line);
	}
	if (line.startsWith("+")) return theme.fg("toolDiffAdded", line);
	if (line.startsWith("-")) return theme.fg("toolDiffRemoved", line);
	if (line.startsWith("@@")) return theme.fg("accent", line);
	return theme.fg("text", line);
}

/**
 * Wrap a body in a rounded frame with an accent title, fitting `width`
 * visible columns exactly (every line is truncated/padded to fit).
 *
 * @param body - The framed content lines (may carry ANSI styling).
 * @param width - Total frame width in visible columns.
 * @param theme - The theme accessor.
 * @param title - Plain-text title shown in the top border.
 * @returns The framed lines.
 */
function frameLines(body: string[], width: number, theme: Theme, title: string): string[] {
	const w = Math.max(10, Math.floor(width));
	const innerW = w - 4; // "│ " + content + " │"

	// Top border: `╭─ Title ───╮`
	let t = title;
	const maxTitle = Math.max(4, w - 8);
	if (visibleWidth(t) > maxTitle) t = truncateToWidth(t, maxTitle);
	const dashes = Math.max(0, w - visibleWidth("╭─ ") - visibleWidth(t) - 2);
	const out: string[] = [`╭─ ${theme.fg("accent", theme.bold(t))} ${"─".repeat(dashes)}╮`];

	for (const line of body) {
		const fitted = truncateToWidth(line, innerW);
		const pad = Math.max(0, innerW - visibleWidth(fitted));
		out.push(`│ ${fitted}${" ".repeat(pad)} │`);
	}

	out.push(`╰${"─".repeat(w - 2)}╯`);
	return out;
}

// ---------------------------------------------------------------------------
// Diff modal
// ---------------------------------------------------------------------------

/** Diff body for a tracked file: `git diff HEAD -- <path>`. */
function runGitDiff(cwd: string, path: string): string[] {
	try {
		const out = execFileSync("git", ["diff", "HEAD", "--", path], {
			cwd,
			encoding: "utf-8",
			timeout: 10_000,
			maxBuffer: 8 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.split("\n");
	} catch {
		return ["(diff unavailable — git error)"];
	}
}

/** Diff body for an untracked file: every line rendered as an addition. */
function readUntrackedDiffLines(cwd: string, relPath: string): string[] {
	try {
		const buf = readFileSync(join(cwd, relPath));
		const text = buf.subarray(0, MAX_UNTRACKED_BYTES).toString("utf-8");
		const lines = text.split("\n");
		if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
		return lines.map((l) => `+${l}`);
	} catch {
		return ["(file unreadable)"];
	}
}

interface DiffViewerArgs {
	cwd: string;
	files: ChangedFile[];
	tui: TUI;
	theme: Theme;
	done: (result: void) => void;
}

/**
 * Build the scrollable diff-viewer component: a files list (↑↓ + Enter) and
 * per-file diff views (scroll + ←/Esc back).
 */
function createDiffViewer(args: DiffViewerArgs): Component {
	const { cwd, files, tui, theme, done } = args;

	let view: "files" | "diff" = "files";
	let selectedIndex = 0;
	let listScroll = 0;
	let diffScroll = 0;
	const diffCache = new Map<string, string[]>();
	let cachedLines: string[] | undefined;

	function refresh(): void {
		cachedLines = undefined;
		tui.requestRender();
	}

	/** Rows available for content inside the overlay. */
	function visibleRows(): number {
		const rows = tui.terminal?.rows ?? 24;
		// The overlay is capped near 85% of terminal height; reserve chrome + hints.
		return Math.max(4, Math.floor(rows * 0.85) - 6);
	}

	function diffLinesFor(file: ChangedFile): string[] {
		const cached = diffCache.get(file.path);
		if (cached) return cached;
		let lines =
			file.status === "untracked"
				? readUntrackedDiffLines(cwd, file.path)
				: runGitDiff(cwd, file.path);
		if (lines.length > MAX_DIFF_LINES) {
			const overflow = lines.length - MAX_DIFF_LINES;
			lines = [...lines.slice(0, MAX_DIFF_LINES), `… truncated (${overflow} more lines)`];
		}
		diffCache.set(file.path, lines);
		return lines;
	}

	function render(width: number): string[] {
		if (cachedLines) return cachedLines;
		const w = Math.max(10, Math.floor(width));
		const innerW = Math.max(4, w - 4);
		const body: string[] = [];
		let title: string;

		if (view === "files") {
			title = `Changed Files (${files.length})`;
			const rows = files.map((file, i) => {
				const marker = i === selectedIndex ? theme.fg("accent", ">") : " ";
				const dot = theme.fg(statusToColor(file.status), STATUS_PREFIX[file.status] ?? "●");
				const counts = formatCounts(file, theme);
				const maxPath = Math.max(
					4,
					innerW - visibleWidth(`${marker}  ${dot} `) - visibleWidth(counts) - 1,
				);
				return `${marker}  ${dot} ${truncateToWidth(theme.fg("text", file.path), maxPath)} ${counts}`;
			});

			const visible = visibleRows();
			// Keep the selection in view.
			if (selectedIndex < listScroll) listScroll = selectedIndex;
			if (selectedIndex >= listScroll + visible) listScroll = selectedIndex - visible + 1;
			listScroll = Math.min(listScroll, Math.max(0, rows.length - visible));

			const slice = rows.slice(listScroll, listScroll + visible);
			while (slice.length < visible) slice.push("");
			body.push(...slice);
			body.push(theme.fg("dim", " ↑↓ navigate · Enter view diff · Esc close"));
		} else {
			const file = files[selectedIndex];
			if (!file) {
				view = "files";
				return render(width);
			}
			title = file.path;
			const all = diffLinesFor(file);
			const visible = Math.max(2, visibleRows() - 2); // reserve meta + hint rows
			const maxScroll = Math.max(0, all.length - visible);
			diffScroll = Math.min(diffScroll, maxScroll);

			body.push(
				`${formatCounts(file, theme)} · ${all.length} line${all.length === 1 ? "" : "s"}`,
			);
			const slice = all.slice(diffScroll, diffScroll + visible);
			while (slice.length < visible) slice.push("");
			for (const line of slice) {
				body.push(truncateToWidth(styleDiffLine(line, theme), innerW));
			}
			body.push(theme.fg("dim", " ↑↓ scroll · PgUp/PgDn jump · ←/Esc back · Ctrl+C close"));
		}

		cachedLines = frameLines(body, w, theme, title);
		return cachedLines;
	}

	function handleInput(data: string): void {
		if (view === "files") {
			if (matchesKey(data, Key.up)) {
				selectedIndex = Math.max(0, selectedIndex - 1);
				refresh();
			} else if (matchesKey(data, Key.down)) {
				selectedIndex = Math.min(files.length - 1, selectedIndex + 1);
				refresh();
			} else if (matchesKey(data, Key.enter)) {
				diffScroll = 0;
				view = "diff";
				refresh();
			} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				done(undefined);
			}
			return;
		}

		// Diff view
		const file = files[selectedIndex];
		const total = file ? diffLinesFor(file).length : 0;
		const visible = Math.max(2, visibleRows() - 2);
		const maxScroll = Math.max(0, total - visible);
		if (matchesKey(data, Key.up)) {
			diffScroll = Math.max(0, diffScroll - 1);
			refresh();
		} else if (matchesKey(data, Key.down)) {
			diffScroll = Math.min(maxScroll, diffScroll + 1);
			refresh();
		} else if (matchesKey(data, Key.pageUp)) {
			diffScroll = Math.max(0, diffScroll - visible);
			refresh();
		} else if (matchesKey(data, Key.pageDown)) {
			diffScroll = Math.min(maxScroll, diffScroll + visible);
			refresh();
		} else if (matchesKey(data, Key.ctrl("c"))) {
			done(undefined);
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.escape)) {
			view = "files";
			refresh();
		}
	}

	return {
		render,
		handleInput,
		invalidate: () => {
			cachedLines = undefined;
		},
	};
}


// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Register the changed-files extension with the pi agent.
 *
 * Tracks files modified during a conversation session and displays a widget
 * above the editor showing changed files with status indicators and color-coded
 * +/− line counts (at most 5 files). Registers the `/diff` command, which opens
 * a scrollable modal of all changed files with per-file diff views.
 *
 * @param pi - The pi extension API.
 */
export default function (pi: ExtensionAPI) {
	/** Context type extracted from the pi.on event handler signature. */
	type HookContext = Parameters<Parameters<typeof pi.on>[1]>["1"];

	/** Files tracked from tool calls (before git status correction). */
	let toolTrackedFiles = new Map<string, ChangedFile>();

	/** Widget key for setWidget. */
	const WIDGET_KEY = "changed-files";


	/**
	 * Update the widget with the current changed-files state.
	 */
	function updateWidget(ctx: HookContext) {
		if (!ctx.hasUI || toolTrackedFiles.size === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const files = Array.from(toolTrackedFiles.values()).sort((a, b) =>
			a.path.localeCompare(b.path),
		);

		ctx.ui.setWidget(WIDGET_KEY, (tui, t) => buildWidgetComponentFor(files, t));
	}

	/**
	 * Merge git status results into the tracked files map and update widget.
	 *
	 * When git is available, its authoritative list (enriched with +/− counts)
	 * replaces tool-tracked files. When git is unavailable, tool-tracked files
	 * are kept as-is.
	 *
	 * @param ctx - The hook context.
	 */
	async function refreshFromGit(ctx: HookContext) {
		const gitFiles = await parseGitStatus(ctx.cwd);

		if (gitFiles !== null) {
			// Git is available — use its authoritative list, with line counts
			toolTrackedFiles = enrichWithCounts(gitFiles, ctx.cwd);
		}
		// If git is not available, keep tool-tracked files as-is

		updateWidget(ctx);
	}

	/**
	 * Add a file from a tool call to the tracked set.
	 *
	 * @param ctx - The hook context.
	 * @param path - The file path (absolute or relative).
	 * @param status - The change status label.
	 * @param added - Added line count (-1 when unknown).
	 * @param removed - Removed line count (-1 when unknown).
	 */
	function trackToolFile(
		ctx: HookContext,
		path: string,
		status: ChangeStatus,
		added: number,
		removed: number,
	) {
		const relative = toRelativePath(path, ctx.cwd);
		toolTrackedFiles.set(relative, { path: relative, status, added, removed, binary: false });
		updateWidget(ctx);
	}

	// --- Event handlers ---

	pi.on("session_start", async (_event, ctx) => {
		// Reset state for new session
		toolTrackedFiles = new Map();
		ctx.ui.setWidget(WIDGET_KEY, undefined);

		// Initial git status check (for resumed sessions with pending changes)
		await refreshFromGit(ctx);
	});

	// Track `write` (created) and `edit` (modified) tool calls
	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as { path?: string; content?: string };
		if (!input.path) return;

		if (event.toolName === "write") {
			const added =
				typeof input.content === "string"
					? Math.max(1, input.content.split("\n").length)
					: -1;
			trackToolFile(ctx, input.path, "created", added, 0);
		} else if (event.toolName === "edit") {
			// Edit granularity (added/removed lines) isn't in the input —
			// the turn_end git refresh fills in real counts.
			trackToolFile(ctx, input.path, "modified", -1, -1);
		}
	});

	// After each turn, refresh from git for authoritative status + counts
	pi.on("turn_end", async (_event, ctx) => {
		await refreshFromGit(ctx);
	});

	// --- Command: show changed files summary ---

	pi.registerCommand("changed-files", {
		description: "Show files changed during this session",
		handler: async (_args, ctx) => {
			await refreshFromGit(ctx);

			const files = Array.from(toolTrackedFiles.values());
			if (files.length === 0) {
				ctx.ui.notify("No files changed yet", "info");
				return;
			}

			// Re-pin the widget (already live via updateWidget) and notify.
			updateWidget(ctx);
			ctx.ui.notify(`Changed files: ${files.length} file(s) — /diff for details`, "info");
		},
	});

	// --- Command: scrollable diff modal ---

	pi.registerCommand("diff", {
		description: "Open a scrollable diff viewer for all changed files (↑↓ + Enter)",
		handler: async (_args, ctx) => {
			await refreshFromGit(ctx);

			const files = Array.from(toolTrackedFiles.values()).sort((a, b) =>
				a.path.localeCompare(b.path),
			);
			if (files.length === 0) {
				ctx.ui.notify("No files changed yet", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Diff viewer needs the interactive UI", "warning");
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) =>
					createDiffViewer({ cwd: ctx.cwd, files, tui, theme, done }),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "82%", maxHeight: "88%" },
				},
			);
		},
	});
}

/** Normalize a file path to be relative to cwd.
 *
 * @param path - An absolute, relative, or already-normalized file path.
 * @param cwd - The working directory root.
 * @returns The path relative to cwd, with leading "/" or "./" stripped.
 */
function toRelativePath(path: string, cwd: string): string {
	if (path.startsWith(cwd)) {
		return path.slice(cwd.length).replace(/^\//, "");
	}
	if (path.startsWith("./")) {
		return path.slice(2);
	}
	return path;
}

/** Widget factory shim so `setWidget` keeps its (tui, theme) signature. */
function buildWidgetComponentFor(files: ChangedFile[], theme: Theme): Component {
	const shown = files.slice(0, MAX_WIDGET_FILES);
	const hidden = files.length - shown.length;
	return {
		render: (width: number) => {
			const usable = Number.isFinite(width) && width > 0 ? width : 40;
			const lines: string[] = [];
			lines.push(
				theme.fg("accent", theme.bold(" Changed Files")) +
					theme.fg("dim", ` (${files.length})`),
			);
			for (const file of shown) {
				const prefix = `  ${theme.fg(statusToColor(file.status), STATUS_PREFIX[file.status] ?? "●")}`;
				const counts = formatCounts(file, theme);
				const maxPath = Math.max(4, usable - visibleWidth(prefix) - visibleWidth(counts) - 2);
				lines.push(
					`${prefix} ${truncateToWidth(theme.fg("text", file.path), maxPath)}  ${counts}`,
				);
			}
			if (hidden > 0) {
				lines.push(theme.fg("dim", `  … ${hidden} more — /diff`));
			}
			return lines;
		},
		invalidate: () => {},
	};
}
