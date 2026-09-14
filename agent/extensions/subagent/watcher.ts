/**
 * Parent-side termination for a **Native Run** (docs/adr/0044).
 *
 * ADR 0033 established that *the parent owns Run termination*, after a child that
 * errored but stayed alive left a Task `running` for the life of the session — a
 * spawn slot held, no Reminder, twice in one evening. That principle is preserved
 * here in full. Its mechanism is not, because it cannot be: every part of it read
 * the child's pipes, and a Native Run has none. herdr spawns the process so it can
 * be a TUI, and the parent holds no handle on it.
 *
 * So the same job is done from three signals outside the process:
 *
 * | Signal | Answers |
 * |---|---|
 * | `<session>.exit` sidecar | did the child *declare* itself finished? |
 * | `<runId>.exitcode` sidecar | what did the process exit with? |
 * | herdr `pane_exited` / `pane_closed` | is the pane gone, and *who* closed it? |
 * | session file mtime | is a still-open Run actually doing anything? |
 *
 * ## Why `pane_closed` is the whole basis of Dismissed
 *
 * Measured against herdr 0.9.0: `pane_exited` fires when the process exits, and
 * `pane_closed` fires **only** on an explicit close — an exit-triggered auto-close
 * emits `pane_exited` alone. That asymmetry is what makes user dismissal
 * *detectable* rather than inferred: a `pane_closed` with no `.exit` sidecar is a
 * pane the user shut on a Run that had not finished. It also means a watcher that
 * waited for `pane_closed` would hang on every normal Run, which is why the
 * settle path keys on `pane_exited`.
 *
 * ## Why staleness watches the file, which ADR 0033 rejected
 *
 * 0033 declined to watch the session file for staleness, and gave its reason:
 * "the parent holds the child's pipes, so it can see silence without touching the
 * filesystem." That premise is exactly what this change removes. When the
 * justification for a rejection is deleted, the rejection goes with it — and the
 * **Board** already reads this same signal, so nothing new is being invented.
 *
 * The threshold is inherited rather than re-guessed, because 0033 derived it from
 * pi's retry ladder (worst case ~10.6 min) and warned that it must rise if the
 * ladder does. One difference matters, though: a Native Run is *interactive*, so a
 * pane sitting idle may be waiting for the user rather than wedged. Staleness is
 * therefore only ever reported as `stalled`, never used to kill a pane the user
 * might be reading.
 *
 * @module watcher
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { subscribePaneEvents } from "../herdr/socket.js";
import { DONE_TOOL_NAME } from "./child-done.js";

/**
 * How long a Run may write nothing before it is called stalled.
 *
 * Inherited from the JSON path's constant, which was derived from pi's retry
 * ladder rather than chosen: a Run legitimately grinding through retries must not
 * be called stalled. If `maxRetries` or `maxDelayMs` rise, this must rise with
 * them (docs/adr/0033).
 */
export const STALL_TIMEOUT_MS = 20 * 60 * 1000;

/** How often staleness is checked. Cheap: one `stat` per Run per tick. */
export const STALL_CHECK_MS = 30 * 1000;

/**
 * How long to keep looking for sidecars after the pane is gone.
 *
 * The pane's death and the wrapper's final writes race: herdr destroys the pane
 * the instant the process exits, while the wrapper writes `.exitcode` immediately
 * *after* it. Settling on `pane_exited` alone would therefore routinely miss an
 * exit code that lands microseconds later. This is the grace period in which the
 * filesystem is allowed to catch up.
 */
export const SIDECAR_GRACE_MS = 3000;

/** How a Native Run ended. */
export type NativeOutcome =
	/** The child declared itself finished (or ended cleanly). */
	| "completed"
	/** The process failed, or died without reporting. */
	| "failed"
	/** The user closed the Run Pane before the Run finished. */
	| "dismissed"
	/** The Run wrote nothing for {@link STALL_TIMEOUT_MS}. */
	| "stalled";

/** What the watcher learned about a finished Run. */
export interface NativeResult {
	outcome: NativeOutcome;
	/** From the `.exitcode` sidecar; undefined when it never appeared. */
	exitCode?: number;
	/** Last assistant text in the transcript — the Run's Result payload. */
	lastAssistantText?: string;
	/** Last assistant `stopReason` seen, for diagnostics. */
	stopReason?: string;
	/** Error text from the transcript, when the child reported one. */
	errorMessage?: string;
	/** Turns observed in the transcript. */
	turns: number;
	/** Why the watcher settled as it did, for logs and Reminders. */
	detail: string;
}

/** Resolve the Run's session JSONL inside its directory, if written yet. */
async function findSessionFile(sessionDir: string): Promise<string | null> {
	const { readdir } = await import("node:fs/promises");
	try {
		const names = await readdir(sessionDir);
		// Sessions are named `<iso>_<runId>.jsonl`, so lexical order is chronological.
		const live = names.filter((n) => n.endsWith(".jsonl")).sort();
		const newest = live.at(-1);
		return newest ? path.join(sessionDir, newest) : null;
	} catch {
		return null;
	}
}

/**
 * Parse the transcript for the Run's payload and outcome hints.
 *
 * The outcome is the **last** assistant message, never the worst one ever seen: a
 * Run that errored, retried and delivered is a success, and latching on the first
 * error is the bug ADR 0033 documents in two separate consumers. A half-written
 * final line is skipped rather than fatal, since the child may be mid-write.
 */
export async function readTranscript(file: string): Promise<{
	turns: number;
	lastAssistantText?: string;
	stopReason?: string;
	errorMessage?: string;
}> {
	let raw: string;
	try {
		raw = await readFile(file, "utf-8");
	} catch {
		return { turns: 0 };
	}

	let turns = 0;
	let lastAssistantText: string | undefined;
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	/** Set once the child declared completion, freezing the answer against epilogue. */
	let answerIsFinal = false;

	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue; // Half-written final line.
		}
		if (entry.type !== "message") continue;
		const message = entry.message as
			| {
					role?: unknown;
					content?: unknown;
					stopReason?: unknown;
					errorMessage?: unknown;
			  }
			| undefined;
		if (!message || message.role !== "assistant") continue;

		turns++;
		stopReason =
			typeof message.stopReason === "string" ? message.stopReason : undefined;
		errorMessage =
			typeof message.errorMessage === "string" ? message.errorMessage : undefined;

		// Keep the last assistant message that actually said something: a final turn
		// that only carries a tool call must not blank out the answer before it.
		//
		// But the turn that calls the done tool is *authoritative*, and this is
		// measured rather than theoretical: a child answered "Jupiter is the largest
		// planet" in the same turn as its `subagent_done` call, and pi then emitted a
		// courtesy turn reading "Done." once the tool returned. Last-text-wins
		// therefore reported "Done." as the Result. The child declared itself finished
		// at that call, so what it said *then* is its answer, and anything after it is
		// epilogue.
		if (Array.isArray(message.content)) {
			const parts = message.content as {
				type?: string;
				text?: string;
				name?: string;
			}[];
			const text = parts
				.filter((p) => p.type === "text" && typeof p.text === "string")
				.map((p) => p.text as string)
				.join("")
				.trim();
			const declaredDone = parts.some(
				(p) => p.type === "toolCall" && p.name === DONE_TOOL_NAME,
			);
			if (text && (!answerIsFinal || declaredDone)) lastAssistantText = text;
			if (declaredDone && text) answerIsFinal = true;
		}
	}

	return { turns, lastAssistantText, stopReason, errorMessage };
}

/** Read the `.exit` done sidecar, if the child wrote one. */
async function readDoneSidecar(
	sessionFile: string,
): Promise<{ runId?: string } | null> {
	try {
		const raw = await readFile(`${sessionFile}.exit`, "utf-8");
		return JSON.parse(raw) as { runId?: string };
	} catch {
		return null;
	}
}

/** Read the `.exitcode` sidecar the wrapper writes. */
async function readExitCode(
	sessionDir: string,
	runId: string,
): Promise<number | undefined> {
	try {
		const raw = await readFile(
			path.join(sessionDir, `${runId}.exitcode`),
			"utf-8",
		);
		const n = Number.parseInt(raw.trim(), 10);
		return Number.isNaN(n) ? undefined : n;
	} catch {
		return undefined;
	}
}

/** Inputs for watching one Native Run. */
export interface WatchOptions {
	runId: string;
	sessionDir: string;
	/** The Run Pane's id, so pane events can be attributed to this Run. */
	paneId: string;
	/** Aborts the watch and closes the pane: the parent's kill switch. */
	signal?: AbortSignal;
	/** Overridable for tests. */
	stallTimeoutMs?: number;
	stallCheckMs?: number;
}

/**
 * Watch a Native Run until it ends, and say how.
 *
 * Resolves exactly once. Never throws: a watcher that threw would leave the Task
 * `running` forever, which is precisely the wedge ADR 0033 exists to prevent — so
 * every failure path here still settles with an outcome.
 *
 * @param opts - The Run to watch.
 * @returns How the Run ended, with its payload and exit code when available.
 */
export async function watchNativeRun(
	opts: WatchOptions,
): Promise<NativeResult> {
	const stallTimeout = opts.stallTimeoutMs ?? STALL_TIMEOUT_MS;
	const stallCheck = opts.stallCheckMs ?? STALL_CHECK_MS;

	/** Set once the pane is gone, with how it went. */
	let paneGone: "exited" | "closed" | null = null;

	const subscription = await subscribePaneEvents({
		paneIds: [opts.paneId],
		onExited: (id) => {
			if (id === opts.paneId && !paneGone) paneGone = "exited";
		},
		onClosed: (id) => {
			// Only an explicit close emits this, which is what makes a user's
			// dismissal distinguishable from a process that simply ended.
			if (id === opts.paneId && !paneGone) paneGone = "closed";
		},
	});

	const started = Date.now();
	/** Latest mtime seen on the session file, for staleness. */
	let lastProgressAt = started;

	const settle = async (
		outcome: NativeOutcome,
		detail: string,
	): Promise<NativeResult> => {
		subscription?.close();
		const sessionFile = await findSessionFile(opts.sessionDir);
		const transcript = sessionFile
			? await readTranscript(sessionFile)
			: { turns: 0 };
		const exitCode = await readExitCode(opts.sessionDir, opts.runId);
		return { outcome, exitCode, ...transcript, detail };
	};

	try {
		while (true) {
			if (opts.signal?.aborted) {
				return await settle(
					"failed",
					"the parent cancelled this Run and closed its pane",
				);
			}

			const sessionFile = await findSessionFile(opts.sessionDir);

			// 1. Did the child declare itself finished? This wins over everything,
			//    including a pane that has already gone: a Run that reported success
			//    and then had its pane torn down is still a success.
			if (sessionFile) {
				const done = await readDoneSidecar(sessionFile);
				// A resumed session reuses its path, so a sidecar naming a different
				// Run belongs to an earlier one and must not settle this Run.
				if (done && (!done.runId || done.runId === opts.runId)) {
					// The child declares completion *before* its wrapper records the exit
					// code — `subagent_done` shuts the session down, and only then does the
					// wrapper resume and write. Settling instantly would therefore report
					// every clean Run's exit code as unknown, so give the wrapper the same
					// grace the pane-exit path gets. Measured: the sidecar lands within a
					// second or so of the done marker.
					for (
						let waited = 0;
						waited < SIDECAR_GRACE_MS &&
						(await readExitCode(opts.sessionDir, opts.runId)) === undefined;
						waited += 250
					) {
						await new Promise((r) => setTimeout(r, 250));
					}
					return await settle("completed", "the child reported completion");
				}
			}

			// 2. Is the pane gone? Then the Run is over one way or another; give the
			//    wrapper's final writes a moment to land before classifying.
			if (paneGone) {
				const how = paneGone;
				await new Promise((r) => setTimeout(r, SIDECAR_GRACE_MS));
				const late = sessionFile ? await readDoneSidecar(sessionFile) : null;
				if (late && (!late.runId || late.runId === opts.runId)) {
					return await settle("completed", "the child reported completion");
				}
				if (how === "closed") {
					return await settle(
						"dismissed",
						"the user closed the Run Pane before the Run reported completion",
					);
				}
				const code = await readExitCode(opts.sessionDir, opts.runId);
				return await settle(
					"failed",
					code === undefined
						? "the Run's process ended without reporting completion or an exit code"
						: `the Run's process exited ${code} without reporting completion`,
				);
			}

			// 3. The pane is still open, but has `pi` already finished? A failing Run's
			//    wrapper deliberately *stays alive* holding the pane so the error stays
			//    readable (docs/adr/0044), which means waiting for the process to die
			//    would hold this Run's **Spawn slot** for the whole hour-long hold — one
			//    visible failure could starve the budget. The exit code appearing is the
			//    Run being over; the pane outliving it is presentation, not work.
			const earlyCode = await readExitCode(opts.sessionDir, opts.runId);
			if (earlyCode !== undefined) {
				return earlyCode === 0
					? await settle(
							"completed",
							"the Run's process exited cleanly",
						)
					: await settle(
							"failed",
							`the Run's process exited ${earlyCode}; its pane is being held open so the error stays readable`,
						);
			}

			// 4. Still open and still running: is it doing anything? A Native Run may
			//    legitimately sit idle waiting for the user, so this reports rather
			//    than kills.
			if (sessionFile) {
				try {
					const info = await stat(sessionFile);
					if (info.mtimeMs > lastProgressAt) lastProgressAt = info.mtimeMs;
				} catch {
					// Vanished mid-Run; the pane event will settle it.
				}
			}
			if (Date.now() - lastProgressAt > stallTimeout) {
				return await settle(
					"stalled",
					`the Run wrote nothing for ${Math.round(stallTimeout / 60000)} minutes`,
				);
			}

			await new Promise((r) => setTimeout(r, stallCheck));
		}
	} catch (err) {
		// Settling with an outcome always beats leaving a Task running forever.
		return await settle(
			"failed",
			`the watcher failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
