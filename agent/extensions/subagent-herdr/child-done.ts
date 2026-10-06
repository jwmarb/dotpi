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
 *
 * ## Testability
 *
 * The handshake logic is factored into `createChildDoneHandshake`, which takes
 * an effects interface. The real Node adapter (filesystem writes, detached
 * spawn, herdr pane close) is constructed by the default export; tests supply
 * a recording stub to verify ordering and deduplication without a live
 * process.
 *
 * @module subagent-herdr/child-done
 */
import { execFile, spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

import {
  exitPath,
  formatExitSidecar,
  formatNotice,
  formatReportLine,
  reportsPath,
} from "./rundir.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A minimal message shape sufficient for `endedCleanly`. */
export type MessageLike = { role: string; stopReason?: string };

/** The side effects the handshake can perform. */
export interface ChildDoneEffects {
  /**
   * Write the `.exit` sidecar. Must remain synchronous: an `await` between the
   * write and `ctx.shutdown()` is a window in which the process can exit with
   * the sidecar unwritten.
   */
  writeExitSidecar(path: string, content: string): boolean;

  /** Append a report line to the run's report log. */
  appendReport(path: string, line: string): void;

  /**
   * Send a notice to the parent's pane. Must preserve detached + ignored-stdio
   * + unref behavior so the delivery survives the child's own process-group kill.
   */
  sendNotice(parentPane: string, notice: string): void;

  /** Fire-and-forget pane close. Never throws. */
  closePane(paneId: string): void;
}

/** Outcome of the `complete` operation. */
export type ChildDoneOutcome =
  | { kind: "no-session-file" }
  | { kind: "write-failed"; sessionFile: string }
  | { kind: "completed"; sessionFile: string };

/** Outcome of the `report` operation. */
export type ChildReportOutcome =
  | { kind: "no-run-dir" }
  | { kind: "recorded-no-parent" }
  | { kind: "delivered" };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Did this turn end cleanly enough to count as completion?
 *
 * Clean means the last assistant message stopped of its own accord. `error`
 * and `aborted` must *not* auto-complete, and a turn whose last message is
 * not from the assistant has not answered anything yet.
 *
 * @param messages - The turn's messages, oldest first.
 */
export function endedCleanly(messages: readonly MessageLike[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") return false;
    return m.stopReason === "stop";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the child-done handshake with injected effects.
 *
 * Holds the `signalled` deduplication flag. The three methods encode the
 * exact ordering: sidecar write → notice → pane close → shutdown.
 *
 * @param effects The side effects to perform.
 * @param env The process environment (for `HERDR_PANE_ID`, `HERDR_ENV`,
 *   `PI_SUBAGENT_PARENT_PANE`, `PI_SUBAGENT_RUN_ID`, `PI_SUBAGENT_AGENT`).
 */
export function createChildDoneHandshake(
  effects: ChildDoneEffects,
  env: NodeJS.ProcessEnv,
): {
  complete(
    sessionFile: string | undefined,
    shutdown: () => void,
  ): ChildDoneOutcome;
  report(
    message: string,
    runDir: string | undefined,
  ): ChildReportOutcome;
  onAgentEnd(
    messages: readonly MessageLike[],
    sessionFile: string | undefined,
    shutdown: () => void,
  ): void;
} {
  /** Written at most once: a second sidecar would tell the parent nothing new. */
  let signalled = false;

  function complete(
    sessionFile: string | undefined,
    shutdown: () => void,
  ): ChildDoneOutcome {
    if (!sessionFile) return { kind: "no-session-file" };

    const written = signalled || effects.writeExitSidecar(
      exitPath(sessionFile),
      formatExitSidecar(),
    );
    signalled = true;

    if (!written) return { kind: "write-failed", sessionFile };

    const parentPane = env.PI_SUBAGENT_PARENT_PANE;
    if (parentPane) {
      effects.sendNotice(
        parentPane,
        formatNotice(
          env.PI_SUBAGENT_RUN_ID ?? "unknown",
          env.PI_SUBAGENT_AGENT ?? "subagent",
          "done",
          "",
        ),
      );
    }
    closePane();
    shutdown();
    return { kind: "completed", sessionFile };
  }

  function report(
    message: string,
    runDir: string | undefined,
  ): ChildReportOutcome {
    if (!runDir) return { kind: "no-run-dir" };

    try {
      effects.appendReport(reportsPath(runDir), formatReportLine(message));
    } catch {
      // fall through: delivery still happens
    }

    const parentPane = env.PI_SUBAGENT_PARENT_PANE;
    if (!parentPane) return { kind: "recorded-no-parent" };

    effects.sendNotice(
      parentPane,
      formatNotice(
        env.PI_SUBAGENT_RUN_ID ?? "unknown",
        env.PI_SUBAGENT_AGENT ?? "subagent",
        "report",
        message,
      ),
    );
    return { kind: "delivered" };
  }

  function onAgentEnd(
    messages: readonly MessageLike[],
    sessionFile: string | undefined,
    shutdown: () => void,
  ): void {
    if (signalled) return;
    if (!endedCleanly(messages)) return;
    if (!sessionFile) return;

    signalled = effects.writeExitSidecar(
      exitPath(sessionFile),
      formatExitSidecar(),
    );
    if (signalled) {
      const parentPane = env.PI_SUBAGENT_PARENT_PANE;
      if (parentPane) {
        effects.sendNotice(
          parentPane,
          formatNotice(
            env.PI_SUBAGENT_RUN_ID ?? "unknown",
            env.PI_SUBAGENT_AGENT ?? "subagent",
            "done",
            "",
          ),
        );
      }
      closePane();
      shutdown();
    }
  }

  function closePane(): void {
    const paneId = env.HERDR_PANE_ID;
    if (env.HERDR_ENV !== "1" || !paneId) return;
    effects.closePane(paneId);
  }

  return { complete, report, onAgentEnd };
}

// ---------------------------------------------------------------------------
// Real Node adapter
// ---------------------------------------------------------------------------

function createNodeEffects(): ChildDoneEffects {
  return {
    writeExitSidecar(path, content) {
      try {
        writeFileSync(path, content);
        return true;
      } catch {
        return false;
      }
    },

    appendReport(path, line) {
      appendFileSync(path, line);
    },

    sendNotice(parentPane, notice) {
      // `spawn` rather than `execFile`, detached and unref'd, because the `done`
      // notice races its own sender's death: `closePane()` kills this child's
      // *process group*, and a delivery still in flight would go with it — the
      // orchestrator would then sleep until a human poked it, which is the bug
      // this channel exists to fix. `detached` puts the delivery in its own
      // process group so it survives that kill; `unref` plus ignored stdio
      // means it holds neither the event loop nor a pipe to a process that is
      // about to exit.
      const child = spawn(
        "herdr",
        ["agent", "prompt", parentPane, notice],
        { detached: true, stdio: "ignore" },
      );
      child.on("error", () => {});
      child.unref();
    },

    closePane(paneId) {
      execFile("herdr", ["pane", "close", paneId], { timeout: 5000 }, () => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Pi extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const effects = createNodeEffects();
  const handshake = createChildDoneHandshake(effects, process.env);

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
      const outcome = handshake.complete(sessionFile, () => ctx.shutdown());

      switch (outcome.kind) {
        case "no-session-file":
          return {
            content: [
              {
                type: "text",
                text: "Error: this session has no session file, so completion cannot be reported. The run was probably started without --session-dir/--session-id.",
              },
            ],
            details: {},
          };
        case "write-failed":
          return {
            content: [
              {
                type: "text",
                text: `Error: could not write the completion marker beside ${outcome.sessionFile}. Not shutting down, because the orchestrator would read that as a run that died mid-task. Report your answer in a final message instead.`,
              },
            ],
            details: {},
          };
        case "completed":
          return {
            content: [{ type: "text", text: "Reported completion; closing this session." }],
            details: {},
          };
      }
    },
  });

  pi.registerTool({
    name: "subagent_report",
    label: "Subagent Report",
    description:
      "Send a message to the orchestrator while your run is in progress: a status update, a blocker, or a finding it should act on now. The orchestrator receives it shortly and it is also recorded in your run's report log. Do NOT use it for your final answer — your last message is the answer.",
    promptSnippet:
      "Send a mid-run message (status, blocker, finding) to the orchestrator while you keep working.",
    promptGuidelines: [
      "Use subagent_report for mid-run communication only: a status checkpoint, a blocker you cannot resolve, a decision you need the orchestrator to make, or a finding it should know about before your run ends.",
      "A report does not block your run — keep working after sending one; the orchestrator may reply, and the reply arrives here as a normal message in this session.",
      "Your final answer is your final message, not a report. Never restate your answer in a report.",
    ],
    parameters: Type.Object({
      message: Type.String({ description: "The message to send to the orchestrator" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const runDir = process.env.PI_SUBAGENT_RUN_DIR;
      const outcome = handshake.report(params.message, runDir);

      switch (outcome.kind) {
        case "no-run-dir":
          return {
            content: [{ type: "text", text: "Error: PI_SUBAGENT_RUN_DIR is not set; the report cannot be recorded." }],
            details: {},
          };
        case "recorded-no-parent":
          return {
            content: [
              { type: "text", text: "Report recorded; no parent pane is known, so the orchestrator will pick it up on its next task check." },
            ],
            details: {},
          };
        case "delivered":
          return {
            content: [{ type: "text", text: "Report sent to the orchestrator." }],
            details: {},
          };
      }
    },
  });

  pi.on("agent_end", (event, ctx) => {
    handshake.onAgentEnd(
      event.messages as MessageLike[],
      ctx.sessionManager.getSessionFile(),
      () => ctx.shutdown(),
    );
  });
}
