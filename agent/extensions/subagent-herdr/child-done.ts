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
 * ## Neither signal fires without an answer
 *
 * Both are gated on the run having produced an answer the orchestrator can
 * actually read — visible assistant text, judged by `qualifiesAsAnswer` in
 * `rundir.ts` against this run's own `system-prompt.md`, which is the same
 * predicate the parent applies when it extracts the result.
 *
 * This exists because the two signals were trusting the model's word for
 * something it was often wrong about. Of thirty-seven recorded `explorer` runs,
 * nine ended with no answer the parent could find: three had passed the whole
 * report to `subagent_done` as a fabricated argument (the tool declares no
 * parameters, but typebox accepts extra properties, so the call was *valid* and
 * the payload was discarded), two had composed it only inside their reasoning,
 * and one ended its turn with nothing but reasoning — which `endedCleanly`
 * reads as a clean finish. `librarian` did the same thing in five more runs.
 * Every one of them looked like a success from both ends.
 *
 * So:
 *
 * - `subagent_done` without an answer is **refused**, with guidance naming the
 *   three places an answer has actually been stranded, up to
 *   {@link MAX_REFUSED_COMPLETIONS} times — then allowed through, because a
 *   child that can never finish is a worse failure than one that finishes badly.
 * - A clean `agent_end` without an answer gets **one** nudge asking for it,
 *   then completes as before if the next end is still silent.
 *
 * ## What the sidecar deliberately does not contain
 *
 * The answer. The sidecar says *when* a run finished; the child's own session
 * transcript says *what* it concluded, and the parent reads the last assistant
 * message from there. Restating the answer as a tool argument would duplicate
 * it and put a size limit on an answer that the transcript already carries —
 * and, as the three salvaged runs above show, a model that tries it tends to
 * get truncated mid-report.
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
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import {
  exitPath,
  formatExitSidecar,
  formatNotice,
  formatReportLine,
  qualifiesAsAnswer,
  reportsPath,
  requiresResultBlock,
  systemPromptPath,
  visibleTextOf,
} from "./rundir.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A minimal message shape sufficient for `endedCleanly` and the answer gate.
 *
 * `content` is optional and loosely typed because this module is loaded into
 * the child with pi's `-e` and reads whatever the running pi hands its
 * `agent_end` handler; only the parts the gate inspects are named.
 */
export type MessageLike = {
  role: string;
  stopReason?: string;
  content?: unknown;
};

/**
 * What the gate needs in order to judge a completion attempt.
 *
 * Optional everywhere it is used: a caller that cannot supply it (a test, a
 * future embedder, a pi whose session shape changed) gets the pre-gate
 * behaviour rather than a child that can never finish.
 */
export interface AnswerContext {
  /** The turn's messages, oldest first. */
  messages: readonly MessageLike[];
  /** The child's composed system prompt, for `qualifiesAsAnswer`. */
  systemPrompt: string | undefined;
}
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

  /**
   * Ask the model, in-session, for the answer it never wrote.
   *
   * Separate from `sendNotice` because it travels the other way: this is the
   * child prompting *itself* for one more turn, not telling the parent
   * anything.
   */
  sendAnswerNudge(message: string): void;
}

/** Outcome of the `complete` operation. */
export type ChildDoneOutcome =
  | { kind: "no-session-file" }
  | { kind: "write-failed"; sessionFile: string }
  /** Refused: no visible answer precedes this call. Carries what to tell the model. */
  | { kind: "no-answer"; guidance: string; attemptsLeft: number }
  | { kind: "completed"; sessionFile: string };

export { visibleTextOf };

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

/**
 * Did this run produce an answer the orchestrator can use?
 *
 * Scans assistant messages newest-first and asks `qualifiesAsAnswer` (the rule
 * shared with the parent, in `rundir.ts`). An earlier message counts: a model
 * that answered properly and then took another turn to tidy up has honoured
 * the handshake, just not in its final message.
 */
export function hasQualifyingAnswer(ctx: AnswerContext): boolean {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i];
    if (m.role !== "assistant") continue;
    if (qualifiesAsAnswer(visibleTextOf(m), ctx.systemPrompt)) return true;
  }
  return false;
}

/**
 * How many times a child may call `subagent_done` without an answer before the
 * gate gives up and lets it finish anyway.
 *
 * Two refusals, then acceptance. The bound exists because the alternative
 * failure is worse than the one being fixed: a model that cannot or will not
 * produce the expected shape would otherwise be told "no" forever, burning
 * tokens in a loop and never releasing its pane. A run that finishes with a
 * poor answer is still a run the parent can read, diagnose and re-delegate.
 */
export const MAX_REFUSED_COMPLETIONS = 2;

/**
 * What the child is told when its completion is refused.
 *
 * Names the three places an answer has actually been stranded, because a
 * generic "write your answer" does not correct a model that believes it just
 * did — it wrote one, into its reasoning or into a tool argument.
 */
export function answerGuidance(requiresResult: boolean, attemptsLeft: number): string {
  const shape = requiresResult
    ? "a single `<result>…</result>` element containing your complete write-up"
    : "your complete answer";
  return [
    `Your run has no answer the orchestrator can read, so completion was refused.`,
    ``,
    `Write ${shape} as a normal assistant message — plain visible output, now, in this turn.`,
    `It must NOT be in your reasoning (the orchestrator never sees that) and NOT in a tool argument`,
    `(\`subagent_done\` takes no arguments and discards anything passed to it).`,
    ``,
    `Then call \`subagent_done\` again.`,
    attemptsLeft > 0
      ? `If you call it without an answer again, it will be refused ${attemptsLeft} more time(s) and then allowed through — at which point the orchestrator receives nothing.`
      : `This is your last refusal: the next call will be allowed through even without an answer, and the orchestrator will receive nothing.`,
  ].join("\n");
}

/** What the child is asked when it stops talking without an answer. */
export function nudgeMessage(requiresResult: boolean): string {
  return [
    `You stopped without leaving an answer the orchestrator can read.`,
    ``,
    requiresResult
      ? `Write your complete write-up now as a normal assistant message, inside a single \`<result>…</result>\` element.`
      : `Write your complete answer now as a normal assistant message.`,
    `Reasoning is not visible to the orchestrator, so an answer composed there does not count.`,
    ``,
    `Then call \`subagent_done\`.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the child-done handshake with injected effects.
 *
 * Holds the deduplication and gate state: `signalled` (the sidecar is written
 * at most once), the count of refused completions, and whether the one
 * agent-end nudge has been spent. The methods encode the exact ordering:
 * sidecar write → notice → pane close → shutdown.
 *
 * ## The answer gate
 *
 * Completion is refused while the run has produced no answer the orchestrator
 * can read, up to {@link MAX_REFUSED_COMPLETIONS} times. A refusal performs
 * *no* side effects — no sidecar above all — because the sidecar is precisely
 * what makes the parent classify a run as `done` and read its (missing) answer.
 *
 * The gate is skipped entirely when the caller supplies no {@link AnswerContext}:
 * refusing a caller that cannot prove it answered would make the run
 * unfinishable, which is a worse failure than the one being prevented.
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
    answer?: AnswerContext,
  ): ChildDoneOutcome;
  report(
    message: string,
    runDir: string | undefined,
  ): ChildReportOutcome;
  onAgentEnd(
    messages: readonly MessageLike[],
    sessionFile: string | undefined,
    shutdown: () => void,
    systemPrompt?: string,
  ): void;
} {
  /** Written at most once: a second sidecar would tell the parent nothing new. */
  let signalled = false;
  /** Completion attempts refused so far, capped by `MAX_REFUSED_COMPLETIONS`. */
  let refusedCompletions = 0;
  /** Spent at most once per run: an ignored nudge must not loop the session. */
  let nudged = false;

  function complete(
    sessionFile: string | undefined,
    shutdown: () => void,
    answer?: AnswerContext,
  ): ChildDoneOutcome {
    if (!sessionFile) return { kind: "no-session-file" };

    // The gate. Only ever consulted before the first durable signal: once the
    // sidecar is on disk the run *is* finished, and re-judging it would refuse
    // a second call that is merely redundant.
    if (
      !signalled &&
      answer &&
      refusedCompletions < MAX_REFUSED_COMPLETIONS &&
      !hasQualifyingAnswer(answer)
    ) {
      refusedCompletions++;
      return {
        kind: "no-answer",
        guidance: answerGuidance(
          requiresResultBlock(answer.systemPrompt),
          MAX_REFUSED_COMPLETIONS - refusedCompletions,
        ),
        attemptsLeft: MAX_REFUSED_COMPLETIONS - refusedCompletions,
      };
    }

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
    systemPrompt?: string,
  ): void {
    if (signalled) return;
    if (!endedCleanly(messages)) return;
    if (!sessionFile) return;

    // A clean end with nothing visible to report: ask once, then let it go.
    //
    // `endedCleanly` is satisfied by a `stopReason: "stop"` message that
    // carries only reasoning, which is how sub-9bad finished — the parent dutifully
    // recorded a successful run whose answer existed nowhere. One nudge turns
    // that into a second turn in which the model can write what it already
    // worked out; an ignored nudge must not loop the session, so it is spent
    // once and the next clean end completes as before.
    if (!nudged && !hasQualifyingAnswer({ messages, systemPrompt })) {
      nudged = true;
      effects.sendAnswerNudge(nudgeMessage(requiresResultBlock(systemPrompt)));
      return;
    }

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

function createNodeEffects(sendNudge: (message: string) => void): ChildDoneEffects {
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

    sendAnswerNudge(message) {
      sendNudge(message);
    },
  };
}

// ---------------------------------------------------------------------------
// Pi extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  /**
   * The nudge is delivered as a follow-up, not steering.
   *
   * It is sent from an `agent_end` handler, i.e. after the run is over, so
   * there is no tool-call loop left to cut into — the distinction that makes
   * `steer` load-bearing for the *parent's* wake briefing does not apply here.
   * pi starts a fresh run for messages queued by an `agent_end` handler
   * (`agent-session.js` `_handlePostAgentRun`), which is exactly the extra turn
   * the nudge needs. Wrapped because `sendUserMessage` asserts an active
   * session and must never take down the child it is trying to rescue.
   *
   * `expandPromptTemplates` is deliberately not passed: `sendUserMessage`
   * hardcodes it to `false` in the 0.75.4 types this scope compiles against and
   * defaults it to `false` in the 1.0.4 pi that runs, so naming it would buy
   * nothing and fail the typecheck on the older tree.
   */
  const sendNudge = (message: string): void => {
    try {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    } catch {
      // The child then completes on its next clean end, one nudge having been
      // spent. Losing the extra turn costs an answer; throwing here would cost
      // the whole run.
    }
  };

  const effects = createNodeEffects(sendNudge);
  const handshake = createChildDoneHandshake(effects, process.env);

  /**
   * The prompt this child was launched with, read once.
   *
   * The run directory's `system-prompt.md` is what `spawnRun` wrote and what
   * the parent reads back when it extracts the answer, so both halves judge
   * the same bytes. `ctx.getSystemPrompt()` would describe the *composed*
   * prompt instead, which pi assembles differently at each end.
   */
  const readSystemPrompt = (): string | undefined => {
    const runDir = process.env.PI_SUBAGENT_RUN_DIR;
    if (!runDir) return undefined;
    try {
      return readFileSync(systemPromptPath(runDir), "utf-8");
    } catch {
      return undefined;
    }
  };

  /**
   * The visible messages of the current branch, for the gate.
   *
   * Safe to read inside a tool's `execute`: the assistant message carrying
   * this very `subagent_done` call is already persisted. pi's agent loop awaits
   * `message_end` for the assistant message (`agent-loop.js`
   * `streamAssistantResponse`) before it runs `executeToolCalls`, and
   * `agent-session.js` appends to the session on that event with listeners
   * awaited sequentially (`agent.js` `processEvents`). So the branch here
   * already includes the filler line the model wrote instead of its answer —
   * which is the whole thing the gate has to be able to see.
   */
  const branchMessages = (ctx: { sessionManager: { getBranch(): unknown[] } }): MessageLike[] => {
    try {
      return ctx.sessionManager
        .getBranch()
        .map((entry) => (entry as { message?: MessageLike }).message)
        .filter((m): m is MessageLike => !!m && typeof m.role === "string");
    } catch {
      return [];
    }
  };

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Declare this subagent finished and close its session. Call this once, as your final action, immediately after a normal assistant message that states your complete answer. The orchestrator reads that message from the transcript — this tool takes no arguments and discards anything passed to it. A call made before you have written a visible answer is refused.",
    promptSnippet:
      "Declare this subagent finished and shut down. Your last visible message is your answer.",
    promptGuidelines: [
      "Write your complete answer as a normal assistant message FIRST, then call subagent_done as the very last thing you do.",
      "Your answer must be visible assistant text. Reasoning does not reach the orchestrator, so an answer composed only in your thinking is lost — this is the single most common way a run ends up reporting nothing.",
      "subagent_done takes no arguments. Do not pass your answer (as `message` or any other field): such a call looks valid and the payload is discarded, so the orchestrator receives whatever filler you wrote instead.",
      "If your prompt says only what is inside `<result>` reaches the orchestrator, then your visible answer must contain one complete `<result>…</result>` element.",
      "Calling subagent_done without a visible answer is refused and tells you what to fix; it is only refused a bounded number of times, after which the run finishes with nothing to report.",
      "If you cannot complete the task, still say why in a visible message and then call subagent_done: a run that never reports is left to time out, which tells the orchestrator far less than an explanation.",
    ],
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      const outcome = handshake.complete(sessionFile, () => ctx.shutdown(), {
        messages: branchMessages(ctx),
        systemPrompt: readSystemPrompt(),
      });

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
        case "no-answer":
          return {
            // `isError` so the model reads this as a failed call to correct,
            // not as a result to acknowledge and move on from.
            isError: true,
            content: [{ type: "text", text: outcome.guidance }],
            details: { attemptsLeft: outcome.attemptsLeft },
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
      readSystemPrompt(),
    );
  });
}
