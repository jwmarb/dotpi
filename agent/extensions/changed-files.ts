/**
 * Changed Files Widget Extension
 *
 * Tracks files modified during a conversation session and displays a widget
 * above the editor showing changed files with status indicators.
 *
 * Tracking sources:
 * - `write` / `edit` tool calls (instant, from tool input)
 * - `git status --porcelain` on turn end (catches bash-induced changes)
 *
 * Change indicators:
 * - ● Created  (green)
 * - ● Modified (yellow)
 * - ● Deleted  (red)
 * - ● Untracked (dim)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
}

/**
 * Parse `git status --porcelain` output into a map of changed files.
 * Returns null if git is not available or not in a repo.
 */
async function parseGitStatus(
	cwd: string,
): Promise<Map<string, ChangedFile> | null> {
	try {
		const { execSync } = await import("node:child_process");
		const output = execSync("git status --porcelain", {
			cwd,
			encoding: "utf-8",
			timeout: 5_000,
			stdio: ["inherit", "pipe", "ignore"], // silence stderr (e.g., "fatal: not a git repo")
		}).trim();

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
			map.set(file, { path: file, status: label });
		}

		return map;
	} catch {
		// Not a git repo, git not installed, or timeout — return null
		return null;
	}
}

/**
 * Normalize a file path to be relative to cwd.
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

/**
 * Register the changed-files extension with the pi agent.
 *
 * Tracks files modified during a conversation session and displays a widget
 * above the editor showing changed files with status indicators.
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
	 * Map a change status label to a theme color key.
	 *
	 * @param status - The git change status label.
	 * @returns A theme color key for styling.
	 */
	function statusToColor(status: ChangeStatus): string {
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
	 * Render the list of changed files as an array of styled lines.
	 *
	 * @param files - Array of changed file entries.
	 * @param theme - The theme accessor (`ctx.ui.theme` or `t` from widget callback).
	 * @returns Styled lines suitable for widget rendering.
	 */
	function renderFileList(
		files: ChangedFile[],
		theme: {
			fg: (color: string, text: string) => string;
			bold?: (text: string) => string;
		},
	): string[] {
		const lines: string[] = [];

		// Header line
		const count = files.length;
		const header =
			theme.fg(
				"accent",
				theme.bold ? theme.bold(" Changed Files") : " Changed Files",
			) + theme.fg("dim", ` (${count})`);
		lines.push(header);

		// File entries
		for (const file of files) {
			const prefix = STATUS_PREFIX[file.status] ?? "●";
			const colorKey = statusToColor(file.status);
			const line = `  ${theme.fg(colorKey, prefix)} ${theme.fg("text", file.path)}`;
			lines.push(line);
		}

		return lines;
	}

	/**
	 * Update the widget with the current changed-files state.
	 */
	function updateWidget(ctx: HookContext) {
		if (!ctx.hasUI || toolTrackedFiles.size === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const files = Array.from(toolTrackedFiles.values());

		ctx.ui.setWidget(WIDGET_KEY, (_tui, t) => {
			const lines = renderFileList(files, t);
			return {
				render: () => lines,
				invalidate: () => {},
			};
		});
	}

	/**
	 * Merge git status results into the tracked files map and update widget.
	 *
	 * When git is available, its authoritative list replaces tool-tracked files.
	 * When git is unavailable, tool-tracked files are kept as-is.
	 *
	 * @param ctx - The hook context.
	 */
	async function refreshFromGit(ctx: HookContext) {
		const gitFiles = await parseGitStatus(ctx.cwd);

		if (gitFiles !== null) {
			// Git is available — use its authoritative list
			toolTrackedFiles = gitFiles;
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
	 */
	function trackToolFile(ctx: HookContext, path: string, status: ChangeStatus) {
		const relative = toRelativePath(path, ctx.cwd);
		toolTrackedFiles.set(relative, { path: relative, status });
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
		const input = event.input as { path?: string };
		if (!input.path) return;

		if (event.toolName === "write") {
			trackToolFile(ctx, input.path, "created");
		} else if (event.toolName === "edit") {
			trackToolFile(ctx, input.path, "modified");
		}
	});

	// After each turn, refresh from git for authoritative status
	pi.on("turn_end", async (_event, ctx) => {
		await refreshFromGit(ctx);
	});

	// --- Command: show changed files summary ---

	pi.registerCommand("changed-files", {
		description: "Show files changed during this session",
		handler: async (_args, ctx) => {
			await refreshFromGit(ctx);

			const files = Array.from(toolTrackedFiles.values());
			const theme = ctx.ui.theme;

			if (files.length === 0) {
				ctx.ui.notify("No files changed yet", "info");
				return;
			}

			const lines: string[] = [];
			lines.push("");
			lines.push(...renderFileList(files, theme));
			lines.push("");
			lines.push(`  ${theme.fg("dim", `${files.length} file(s) changed`)}`);
			lines.push("");

			ctx.ui.setWidget(WIDGET_KEY, (_tui, t) => {
				return {
					render: () => lines,
					invalidate: () => {},
				};
			});

			ctx.ui.notify(`Changed files: ${files.length} file(s)`, "info");
		},
	});
}
