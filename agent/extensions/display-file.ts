/**
 * display-file extension — lets the agent open local files in the user's
 * default application (browser for HTML/PDF, image viewer for images, etc.).
 *
 * Use case: after producing an artifact the user should view — e.g. the
 * HTML report built by the research skill, or a rendered PDF — call
 * `display_file` with the file path so it opens in the user's browser
 * immediately, instead of the user hunting for it in a file manager.
 *
 * Behavior:
 * - Resolves `path` relative to the current working directory.
 * - Validates the file exists and is a regular file.
 * - Spawns the platform opener detached (never blocks the agent):
 *     darwin  → open <file>
 *     win32   → cmd /c start "" <file>
 *     other   → xdg-open <file>
 * - Waits briefly for the opener to exit non-zero (e.g. no display, no
 *   default handler) and reports the failure instead of faking success.
 *
 * Install location: ~/.pi/agent/extensions/display-file.ts
 * (auto-discovered; hot-reload with /reload)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Platform opener
// ---------------------------------------------------------------------------

interface Opener {
	command: string;
	args: (file: string) => string[];
	hint: string;
}

/** Pick the command that opens a file in the OS default application. */
function getOpener(): Opener {
	switch (process.platform) {
		case "darwin":
			return {
				command: "open",
				args: (file) => [file],
				hint: "macOS `open`",
			};
		case "win32":
			return {
				command: "cmd",
				args: (file) => ["/c", "start", "", file],
				hint: "Windows `start`",
			};
		default:
			return {
				command: "xdg-open",
				args: (file) => [file],
				hint: "xdg-open (a desktop display session must be available)",
			};
	}
}

/** How long to wait for the opener to report a hard failure. */
const OPENER_FAILURE_WINDOW_MS = 5_000;

/**
 * Spawn the opener detached and wait up to `OPENER_FAILURE_WINDOW_MS` for
 * an early non-zero exit or spawn error. A still-running or cleanly exited
 * opener counts as success (the browser/viewer is a separate long-lived
 * process, so we don't wait for it).
 */
async function launchOpener(opener: Opener, file: string): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		const child = spawn(opener.command, opener.args(file), {
			detached: true,
			stdio: ["ignore", "ignore", "pipe"],
		});

		let stderr = "";
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const finish = (error: string | null) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(error ? error + (stderr.trim() ? ` — ${stderr.trim().slice(0, 500)}` : "") : null);
		};

		// Give the opener a short window to fail fast (missing handler,
		// no display). Success = still alive or exited 0.
		timer = setTimeout(() => finish(null), OPENER_FAILURE_WINDOW_MS);

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			if (stderr.length > 1_000) stderr = stderr.slice(-1_000);
		});
		child.on("error", (err: NodeJS.ErrnoException) =>
			finish(`failed to launch ${opener.command}: ${err.message}`),
		);
		child.on("exit", (code) => {
			if (code !== null && code !== 0) {
				finish(`${opener.command} exited with code ${code}`);
			}
		});

		// Detach: the browser/viewer must survive pi's process tree.
		child.unref();
	});
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const DisplayFileParams = Type.Object({
	path: Type.String({
		description:
			"File to open in the user's default application — e.g. an HTML report, PDF, or image. Absolute, or relative to the current working directory.",
	}),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "display_file",
		label: "Display File",
		description:
			"Open a local file in the user's default application (browser for HTML/PDF, viewer for images). Use to show the user a finished artifact, e.g. after writing an HTML report or PDF.",
		promptSnippet:
			"Open a local file in the user's default browser/app (HTML report, PDF, image, ...).",
		promptGuidelines: [
			"After producing an artifact the user should view — e.g. an HTML report or PDF written to disk — call display_file with its path so it opens in the user's browser.",
			"display_file opens local files only and the file must exist on disk. It never blocks: the browser is a separate process.",
		],
		parameters: DisplayFileParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const abs = path.isAbsolute(params.path)
				? params.path
				: path.resolve(ctx.cwd, params.path);

			let stat: fs.Stats | null;
			try {
				stat = await fs.promises.stat(abs);
			} catch {
				stat = null;
			}
			if (!stat) {
				return {
					content: [{ type: "text", text: `Error: file not found: ${abs}` }],
				};
			}
			if (!stat.isFile()) {
				return {
					content: [{ type: "text", text: `Error: ${abs} is not a regular file` }],
				};
			}

			const opener = getOpener();
			const error = await launchOpener(opener, abs);

			if (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error: could not open ${abs} (${error}). Hint: ${opener.hint}. The file is on disk — the user can open it manually.`,
						},
					],
					details: { path: abs, opener: opener.command, success: false, error },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Opened ${abs} in the user's default application (browser for HTML/PDF).`,
					},
				],
				details: { path: abs, opener: opener.command, success: true },
			};
		},
	});
}
