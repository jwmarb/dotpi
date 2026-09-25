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
 * file, so the parent has one thing to check. Its path and contents come from
 * `rundir.ts`, the module this child shares with the parent that reads them:
 * this file is loaded with pi's `-e`, whose loader resolves sibling imports,
 * so the two halves of the handshake can be spelled once instead of twice.
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
import { execFile, spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

import {
  exitPath,
  formatExitSidecar,
  formatNotice,
  formatReportLine,
  type NoticeKind,
  reportsPath,
} from "./rundir.js";

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

/**
 * Wakes the orchestrator by typing a notice into its pane.
 *
 * This is the whole child → orchestrator channel. The orchestrator no longer
 * sits in a blocking wait, so it is *idle* when this lands — and an idle pi
 * treats an incoming prompt as a new turn. That is the point: a sleeping
 * orchestrator is woken by the notice rather than discovering it whenever a
 * blocking call happened to return.
 *
 * Fire-and-forget on purpose. A report must never wedge the child's turn on a
 * slow delivery, and a `done` notice must never delay the shutdown that
 * follows it: the `.exit` sidecar is the durable record of completion, so a
 * notice that fails to land costs the orchestrator promptness, never the
 * result.
 *
 * @param kind - `report` for a mid-run message, `done` for completion.
 * @param message - Body text; omitted for a bare `done`.
 * @returns Whether a parent pane was known to deliver to.
 */
function notifyParent(kind: NoticeKind, message = ""): boolean {
  const parentPane = process.env.PI_SUBAGENT_PARENT_PANE;
  if (!parentPane) return false;
  const runId = process.env.PI_SUBAGENT_RUN_ID ?? "unknown";
  const agent = process.env.PI_SUBAGENT_AGENT ?? "subagent";
  // `spawn` rather than `execFile`, detached and unref'd, because the `done`
  // notice races its own sender's death: `closeOwnPane()` kills this child's
  // *process group*, and a delivery still in flight would go with it — the
  // orchestrator would then sleep until a human poked it, which is the bug this
  // channel exists to fix. `detached` puts the delivery in its own process group
  // so it survives that kill; `unref` plus ignored stdio means it holds neither
  // the event loop nor a pipe to a process that is about to exit. (`detached` is
  // a spawn option; `execFile` does not accept it.)
  const child = spawn(
    "herdr",
    ["agent", "prompt", parentPane, formatNotice(runId, agent, kind, message)],
    { detached: true, stdio: "ignore" },
  );
  // A missing `herdr` binary emits 'error' asynchronously; unhandled, that is an
  // uncaught exception that would take the child down on its way out.
  child.on("error", () => {});
  child.unref();
  return true;
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
      writeFileSync(exitPath(sessionFile), formatExitSidecar());
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

      // Wake the orchestrator, *then* tear down. The notice is what turns a
      // finished child into a live orchestrator turn; the sidecar it already
      // wrote is the durable fallback if the notice never lands.
      notifyParent("done");
      // Sidecar on disk, parent notified, pane dismissed, *then* shut down (the
      // pane close already kills the process group; this covers a close that
      // didn't land).
      closeOwnPane();
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Reported completion; closing this session." }],
        details: {},
      };
    },
  });
  // -------------------------------------------------------------------------
  // subagent_report — the child → orchestrator leg of mid-run communication
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "subagent_report",
    label: "Subagent Report",
    description:
      "Send a message to the orchestrator while your run is in progress: a status update, a blocker, or a finding it should act on now. The orchestrator receives it shortly and it is also recorded in your run's report log. Do NOT use it for your final answer — your last message is the answer.",
    promptSnippet:
      "Send a mid-run message (status, blocker, finding) to the orchestrator while you keep working.",
    promptGuidelines: [
      "Use subagent_report for mid-run communication only: a status checkpoint, a blocker you cannot resolve, a decision the orchestrator should make, or a finding it should know about before your run ends.",
      "A report does not block your run — keep working after sending one; the orchestrator may reply, and the reply arrives here as a normal message in this session.",
      "Your final answer is your final message, not a report. Never restate your answer in a report.",
    ],
    parameters: Type.Object({
      message: Type.String({ description: "The message to send to the orchestrator" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const runDir = process.env.PI_SUBAGENT_RUN_DIR;
      if (!runDir) {
        return {
          content: [{ type: "text", text: "Error: PI_SUBAGENT_RUN_DIR is not set; the report cannot be recorded." }],
          details: {},
        };
      }

      // Record first: the log is durable even when delivery is not (the
      // orchestrator's pane may be in a dialog, or gone).
      try {
        appendFileSync(reportsPath(runDir), formatReportLine(params.message));
      } catch {
        // fall through: delivery still happens
      }

      if (!notifyParent("report", params.message)) {
        return {
          content: [
            { type: "text", text: "Report recorded; no parent pane is known, so the orchestrator will pick it up on its next task check." },
          ],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: "Report sent to the orchestrator." }],
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
      notifyParent("done");
      closeOwnPane();
      ctx.shutdown();
    }
  });
}
