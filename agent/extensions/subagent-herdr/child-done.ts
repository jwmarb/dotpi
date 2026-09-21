/**
 * The child half of the subagent-herdr completion handshake.
 *
 * Loaded into a delegated child's `pi` with `-e` (see `buildChildArgv`), this
 * is how a child tells its parent that it is finished. The parent no longer
 * holds the child's pipes — herdr owns the process so it can be a TUI — so
 * something inside the child has to close the gap.
 *
 * ## The two signals, and why there are two
 *
 * Both write the same `<session>.exit` sidecar next to the child's session
 * file, so the parent has one thing to check:
 *
 * 1. **The `subagent_done` tool.** A deliberate declaration: the child decides
 *    it is finished and says so. Always available, because the launcher
 *    injects it into every child's tool allowlist — a child that cannot
 *    report completion cannot finish.
 * 2. **A clean `agent_end`.** A child that simply stops talking is also
 *    finished. Without this, a subagent that answered perfectly but forgot
 *    the tool would be indistinguishable from one that wedged.
 *
 * A failing or aborted turn writes nothing: a sidecar claiming success would
 * override the failure with a lie, and the parent classifies those from the
 * missing sidecar plus the pane's terminal output.
 *
 * ## What the sidecar deliberately does not contain
 *
 * The answer. The sidecar says *when* a run finished; the child's own session
 * transcript says *what* it concluded, and the parent reads the last assistant
 * message from there. Restating the answer as a tool argument would duplicate
 * it and put a size limit on an answer that the transcript already carries.
 *
 * ## Pane self-dismissal
 *
 * After the sidecar is on disk, the child also closes its own herdr pane
 * (`closeOwnPane`, using the `HERDR_PANE_ID` herdr injects into launched
 * agents), so a finished run disappears immediately instead of lingering
 * until herdr's post-exit cleanup. The parent still closes the pane as a
 * backstop when it classifies the run — a close that didn't land there must
 * not leave a ghost pane behind.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
/**
 * Did this turn end cleanly enough to count as completion?
 *
 * Clean means the last assistant message stopped of its own accord. `error`
 * and `aborted` must *not* auto-complete, and a turn whose last message is
 * not from the assistant has not answered anything yet.
 *
 * @param messages - The turn's messages, oldest first.
 */
export function endedCleanly(messages: readonly { role: string; stopReason?: string }[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") return false;
    return m.stopReason === "stop";
  }
  return false;
}

/**
 * Closes this child's own herdr pane, fire-and-forget.
 *
 * herdr injects `HERDR_PANE_ID` into every agent it launches, so a child can
 * dismiss its own pane the instant it finishes instead of lingering until
 * herdr's post-exit cleanup. Closing the pane kills the process group, which
 * also makes `ctx.shutdown()` below a redundant safety net. Never throws:
 * a cosmetic cleanup must not be able to fail the completion handshake, and
 * the parent closes the pane again as a backstop when it classifies the run.
 */
function closeOwnPane(): void {
  const paneId = process.env.HERDR_PANE_ID;
  if (process.env.HERDR_ENV !== "1" || !paneId) return;
  execFile("herdr", ["pane", "close", paneId], { timeout: 5000 }, () => {});
}

export default function (pi: ExtensionAPI) {
  /** Written at most once: a second sidecar would tell the parent nothing new. */
  let signalled = false;

  /**
   * Synchronous on purpose: the tool path calls this immediately before
   * `ctx.shutdown()`, and an `await` between the write and the shutdown is a
   * window in which the process can exit with the sidecar unwritten — which
   * the parent would read as a run that died without finishing.
   */
  const writeSidecar = (sessionFile: string): boolean => {
    try {
      writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done", at: Date.now() }));
      return true;
    } catch {
      return false;
    }
  };

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Declare this subagent finished and close its session. Call this once, as your final action, after your last message states your complete answer. Your answer is read from the transcript — do not restate it here.",
    promptSnippet:
      "Declare this subagent finished and shut down. Your last message is your answer.",
    promptGuidelines: [
      "Call subagent_done exactly once, as the very last thing you do, after the message containing your complete answer.",
      "Do not pass your answer to subagent_done — the orchestrator reads your final message from the transcript, so anything restated here is duplicated.",
      "If you cannot complete the task, still say why in a final message and then call subagent_done: a run that never reports is left to time out, which tells the orchestrator far less than an explanation.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        // No session means no sidecar path and no transcript to read an answer
        // from. Refuse rather than shut down: an error keeps the run alive and
        // explains itself, whereas a vanished child tells the parent nothing.
        return {
          content: [
            {
              type: "text",
              text: "Error: this session has no session file, so completion cannot be reported. The run was probably started without --session-dir/--session-id.",
            },
          ],
          details: {},
        };
      }

      const written = signalled || writeSidecar(sessionFile);
      signalled = true;
      if (!written) {
        return {
          content: [
            {
              type: "text",
              text: `Error: could not write the completion marker beside ${sessionFile}. Not shutting down, because the orchestrator would read that as a run that died mid-task. Report your answer in a final message instead.`,
            },
          ],
          details: {},
        };
      }

      // Sidecar on disk, pane dismissed, *then* shut down (the pane close
      // already kills the process group; this covers a close that didn't land).
      closeOwnPane();
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Reported completion; closing this session." }],
        details: {},
      };
    },
  });

  // The second signal: a child that finished talking is finished, whether or
  // not it remembered the tool.
  pi.on("agent_end", (event, ctx) => {
    if (signalled) return;
    if (!endedCleanly(event.messages as { role: string; stopReason?: string }[])) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    signalled = writeSidecar(sessionFile);
    if (signalled) {
      closeOwnPane();
      ctx.shutdown();
    }
  });
}
