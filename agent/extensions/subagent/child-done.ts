/**
 * The child half of a **Native Run**'s completion handshake (docs/adr/0044).
 *
 * Loaded into a Native Run's `pi` with `-e`, this is how a child tells its parent
 * it has finished. It exists because the parent no longer holds the child's pipes:
 * herdr spawns the process so it can be a TUI, and a TUI's stdout is a terminal
 * for a human, not an event stream for a program. Something has to close that gap,
 * and it has to be inside the child.
 *
 * ## The two signals, and why there are two
 *
 * Both write the *same* `<session>.exit` sidecar, so the parent has one thing to
 * watch:
 *
 * 1. **The `subagent_done` tool.** A deliberate declaration: the child decides it
 *    is finished and says so. Always available, because the launcher injects it
 *    into every Native Run's tool allowlist — a child that could not report
 *    completion would hang until the stall watchdog fired, so this is never
 *    something an agent definition can accidentally omit.
 * 2. **A clean `agent_end`.** A child that simply stops talking is also finished.
 *    Without this, a subagent that answered perfectly but ignored the tool would
 *    be indistinguishable from one that wedged. This is the difference between a
 *    contract the model must remember and a contract the runtime enforces.
 *
 * A failing or aborted turn writes nothing: the parent classifies those from the
 * `.exitcode` sidecar and the pane's fate, and a sidecar claiming success would
 * override that with a lie.
 *
 * ## What the sidecar deliberately does not contain
 *
 * The answer. The sidecar says *when* a Run finished; the child's own session
 * transcript says *what* it concluded, and the parent reads the last assistant
 * message from there. Making the child restate its whole write-up as a tool
 * argument would duplicate it, invite truncation, and put a size limit on an
 * answer — while the transcript is already on disk, already complete, and already
 * the file both the Board and the Run Index read.
 *
 * This is also why ADR 0044 could retire the `<result>` tag contract: the payload
 * no longer has to survive a round trip through prose the model formats by hand.
 *
 * @module child-done
 */

import { writeFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The tool a child calls to declare itself finished. */
export const DONE_TOOL_NAME = "subagent_done";

/**
 * What a `<session>.exit` sidecar holds.
 *
 * Small on purpose: a presence-and-reason marker, not a payload. `runId` is
 * carried so a sidecar can be matched to the Run that wrote it — a resumed
 * session reuses its session path, and without the id the parent would have to
 * infer ownership from whether the pane is still alive, which is a race whenever
 * pane teardown outpaces the sidecar write.
 */
export interface ExitSidecar {
	/** How the Run ended: declared by the tool, or inferred from a clean turn. */
	type: "done";
	/** Which Run wrote this, so a reused session path cannot confuse the parent. */
	runId?: string;
	/** When it was written, for diagnostics only. */
	at: number;
}

/**
 * Write the done sidecar beside the Run's session file.
 *
 * Synchronous, and deliberately so: the tool path calls this immediately before
 * `ctx.shutdown()`, and an `await` between the write and the shutdown is a window
 * in which the process can exit with the sidecar unwritten — which the parent
 * would read as a Run that died without finishing.
 *
 * Never throws. A failed write degrades a completed Run into one the parent must
 * classify from its exit code instead, which is a worse outcome than a clean
 * handshake but a far better one than a crashed child.
 *
 * @param sessionFile - The child's own session JSONL path.
 * @param runId - The Run's id, when known.
 * @returns Whether the sidecar was written.
 */
export function writeExitSidecar(sessionFile: string, runId?: string): boolean {
	const body: ExitSidecar = { type: "done", runId, at: Date.now() };
	try {
		writeFileSync(`${sessionFile}.exit`, JSON.stringify(body), {
			encoding: "utf-8",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Did this turn end cleanly enough to count as completion?
 *
 * Clean means the last assistant message stopped of its own accord. `error` and
 * `aborted` are the two outcomes that must *not* auto-complete: the first is a
 * failure the parent will classify from the exit code, the second is a
 * cancellation. `toolUse` and `length` are not terminal at all — the loop
 * continues — so they are not treated as an ending either.
 *
 * A turn whose last message is not from the assistant (a bare user message, say)
 * is not an ending: nothing has answered yet.
 *
 * @param messages - The turn's messages, oldest first.
 */
export function endedCleanly(
	messages: readonly { role: string; stopReason?: string }[],
): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") return false;
		return m.stopReason === "stop";
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	// Set by the generated wrapper (native.ts), so a sidecar can name its Run.
	const runId = process.env.PI_SUBAGENT_RUN_ID;

	/** Written at most once: a second sidecar would tell the parent nothing new. */
	let signalled = false;

	pi.registerTool({
		name: DONE_TOOL_NAME,
		label: "Subagent Done",
		description:
			"Declare this subagent Run finished and close its session. Call this once, as your final action, after your last message states your complete answer. Your answer is read from the transcript — do not restate it here.",
		promptSnippet:
			"Declare this subagent Run finished and shut down. Your last message is your answer.",
		promptGuidelines: [
			"Call subagent_done exactly once, as the very last thing you do, after the message containing your complete answer.",
			"Do not pass your answer to subagent_done — the orchestrator reads your final message from the transcript, so anything restated here is duplicated.",
			"If you cannot complete the task, still say why in a final message and then call subagent_done: a Run that never reports is left to time out, which tells the orchestrator far less than an explanation.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				// No session means no sidecar path and no transcript to read a Result
				// from. Refuse rather than shut down: the parent would see a child that
				// vanished, whereas an error keeps the Run alive and explains itself.
				return {
					content: [
						{
							type: "text",
							text: "Error: this session has no session file, so completion cannot be reported. The Run was probably started without --session-dir/--session-id.",
						},
					],
				};
			}

			const written = signalled || writeExitSidecar(sessionFile, runId);
			signalled = true;
			if (!written) {
				return {
					content: [
						{
							type: "text",
							text: `Error: could not write the completion marker beside ${sessionFile}. Not shutting down, because the orchestrator would read that as a Run that died mid-task. Report your answer in a final message instead.`,
						},
					],
				};
			}

			// Shut down *after* the sidecar is on disk, never before.
			ctx.shutdown();
			return {
				content: [
					{ type: "text", text: "Reported completion; closing this session." },
				],
				details: {},
			};
		},
	});

	// The second signal: a child that finished talking is finished, whether or not
	// it remembered the tool.
	pi.on("agent_end", (event, ctx) => {
		if (signalled) return;
		if (!endedCleanly(event.messages as { role: string; stopReason?: string }[]))
			return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		signalled = writeExitSidecar(sessionFile, runId);
		if (signalled) ctx.shutdown();
	});
}
