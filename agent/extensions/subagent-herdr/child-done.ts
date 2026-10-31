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
 * - A response **truncated by the output token limit** (`stopReason: "length"`) is
 *   continued, not finished: nothing in pi's agent loop tells the model to go on
 *   after a length stop, so the child asks it to pick up where it stopped, up to
 *   {@link MAX_CONTINUATIONS} times, and only then completes with whatever the
 *   transcript carries — a run that would otherwise sit idle and never settle.
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
  ANCESTRY_ENV,
  ancestorLabel,
  exitPath,
  formatExitSidecar,
  formatNotice,
  formatReportLine,
  type NoticeKind,
  parseAncestry,
  qualifiesAsAnswer,
  reportsPath,
  requiresResultBlock,
  systemPromptPath,
  visibleTextOf,
} from "./rundir.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { openItems, parseTodoState, type TodoItem, type TodoState } from "../lib/todo.js";

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
  /**
   * The child's todo list, replayed from the branch (see `branchTodoState`).
   * Only a card child's gate consults it; absent means "no list", which for
   * a card child is the failure the gate catches.
   */
  cardTodos?: TodoState;
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
   * `fallbacks` — the ancestor hops, nearest first — is passed only when it is
   * non-empty, so the one-level case keeps its exact two-argument call.
   */
  sendNotice(parentPane: string, notice: string, fallbacks?: readonly NoticeHop[]): void;

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
// The delivery route: the parent first, then the surviving ancestors
// ---------------------------------------------------------------------------

/** One hop of a notice's delivery route. */
export interface NoticeHop {
  /** The pane the hop is delivered to. */
  pane: string;
  /** The notice text the hop receives (the parent's hop is the bare notice). */
  notice: string;
}

/** The full delivery route for one notice. */
export interface NoticeRoute {
  /** The parent's pane — hop 0, always first. */
  pane: string;
  /** The parent's notice: today's exact text. */
  notice: string;
  /** The ancestor hops, nearest first; empty when the parent is alive. */
  fallbacks: NoticeHop[];
}

/**
 * The delivery route for one notice: the parent's pane with today's exact
 * notice text, plus one annotated hop per ancestor above the parent.
 *
 * `undefined` when `PI_SUBAGENT_PARENT_PANE` is unset — the notice has
 * nowhere to go at all, which callers keep as today's behaviour (a report is
 * recorded undelivered; the other kinds simply skip).
 *
 * The fallbacks are non-empty only when the stamped chain's HEAD is the
 * parent pane with a real run id: a chain that disagrees with the parent pane
 * is ignored, so it cannot redirect delivery (Assumption 1). Each later entry
 * becomes a hop carrying the same notice annotated with the original parent —
 * `ancestry[0]`, even when an intermediate ancestor is also dead — and the
 * ancestor it lands on (`ancestorLabel`).
 */
export function noticeRoute(
  env: NodeJS.ProcessEnv,
  kind: NoticeKind,
  message: string,
): NoticeRoute | undefined {
  const parentPane = env.PI_SUBAGENT_PARENT_PANE;
  if (!parentPane) return undefined;
  const runId = env.PI_SUBAGENT_RUN_ID ?? "unknown";
  const agent = env.PI_SUBAGENT_AGENT ?? "subagent";
  const notice = formatNotice(runId, agent, kind, message);
  const chain = parseAncestry(env[ANCESTRY_ENV]);
  const head = chain[0];
  const fallbacks: NoticeHop[] =
    head && head.pane === parentPane && head.runId !== ""
      ? chain.slice(1).map((entry) => ({
          pane: entry.pane,
          notice: formatNotice(runId, agent, kind, message, {
            parentAgent: head.agent,
            parentRunId: head.runId,
            deliveredTo: ancestorLabel(entry),
          }),
        }))
      : [];
  return { pane: parentPane, notice, fallbacks };
}

/**
 * The detached POSIX-sh walk that delivers a notice down its route.
 *
 * Positional args are `pane, notice` pairs, parent first. Each hop asks
 * herdr for the prompt; the prompt's own refusal is the liveness probe —
 * no separate `paneExists` call, because a probe-then-send pair is two round
 * trips with a race between them, and the walk must finish inside the
 * child's synchronous close/shutdown window (Assumption 2). A hop that is
 * gone (herdr's measured not-found code, `agent_not_found` — see `herdr.ts`
 * behaviour 8) is skipped; the first accepting hop ends the walk; any other
 * refusal (timeout, crash, any other code) stops it — an uncertain probe
 * says nothing about the parent, and a notice is worth losing to a live pane
 * that merely hiccuped (Assumption 3).
 *
 * Every probe in the walk is bounded, because the walk was the repo's only
 * unbounded *multi-hop* herdr call: a hung herdr CLI at hop 0 means the reroute
 * never happens — dead in its own target scenario — and the detached, unref'd
 * `sh` leaks with no parent left to reap it. (The one-level delivery — a child
 * with no ancestry — is a separate single unbounded call, pre-existing and out
 * of scope here.) The bound is `timeout(1)` at 30 s, the same patience
 * the repo gives any single herdr CLI round trip (`HERDR_TIMEOUT_MS` in
 * `herdr.ts`). herdr's own `--timeout` cannot carry it: measured on 0.9.0,
 * `agent prompt --timeout <MS>` refuses without `--wait` ("--timeout requires
 * --wait", exit 2 — herdr.ts behaviour 9), and the walk's probe is the
 * non-wait form. When `timeout(1)` is absent the probe runs unbounded (the
 * pre-bound behaviour); the refusal semantics are unchanged either way, a
 * killed probe yields no `agent_not_found`, so it stops the walk like any
 * other reachability failure.
 */
export const NOTICE_WALK_SCRIPT = `if command -v timeout >/dev/null 2>&1; then BOUND="timeout 30"; else BOUND=""; fi
while [ "$#" -ge 2 ]; do
  err=$( { $BOUND herdr agent prompt "$1" "$2"; } 2>&1 ) && exit 0
  case "$err" in *'"code":"agent_not_found"'*) shift 2 ;; *) exit 1 ;; esac
done
exit 1
`;

/**
 * The argv that runs {@link NOTICE_WALK_SCRIPT} for one route.
 *
 * `sh -c` with the script as a positional string and the hops as positional
 * args: the notice text (quotes, `$`, newlines — the report body) is never
 * interpolated into the script, so it rides the argv byte-for-byte.
 */
export function noticeWalkArgv(route: NoticeRoute): string[] {
  return [
    "-c",
    NOTICE_WALK_SCRIPT,
    "subagent-notice",
    route.pane,
    route.notice,
    ...route.fallbacks.flatMap((h) => [h.pane, h.notice]),
  ];
}

// ---------------------------------------------------------------------------
// The card gate: a child that was delegated a kanban card owes the board a list
// ---------------------------------------------------------------------------

/**
 * The card id this child was delegated, when the parent passed one.
 *
 * One truthiness check for the whole file: an empty string (a malformed
 * `PI_KANBAN_CARD`) is "no card" — it gates nothing, registers no ask tool,
 * and prints in no prose.
 */
function cardOf(env: NodeJS.ProcessEnv): string | undefined {
  const card = env.PI_KANBAN_CARD;
  return card && card.length > 0 ? card : undefined;
}

/** The open items, named for the guidance prose: up to 8, then a count. */
function openItemsClause(open: readonly TodoItem[]): string {
  const shown = open.slice(0, 8).map((i) => `${i.id} (${i.text})`).join("; ");
  const more = open.length > 8 ? ` … and ${open.length - 8} more` : "";
  return shown + more;
}

/** The settlement demand for an unsettled (non-empty) list, shared by every card message. */
function cardOpenClause(card: string, open: readonly TodoItem[]): string {
  return `Kanban card ${card} is not accounted for: ${openItemsClause(open)} are still open. Complete each (with a note naming how it was checked), \`block\` it with a note if it waits on something, or \`drop\` it if it is not needed.`;
}

/**
 * The card gate's view of the child's list: whether it is empty, and which
 * items are still the child's to settle.
 *
 * `blocked` is not open: it is a declared waiting state with a note, and the
 * board surfaces it separately. `undefined` (the child never built a list)
 * is `empty` — for a card child that is exactly the failure the gate exists
 * to catch: the list the child keeps *is* the card.
 */
export function cardAccounting(state: TodoState | undefined): { empty: boolean; open: TodoItem[] } {
  if (!state || state.items.length === 0) return { empty: true, open: [] };
  return { empty: false, open: openItems(state) };
}

/**
 * The card half of the one `agent_end` nudge, appended to the answer nudge
 * when a card child stops talking without an answer.
 */
export function cardNudgeTail(card: string, accounting: { empty: boolean; open: readonly TodoItem[] }): string {
  const clause = accounting.empty
    ? `You are working kanban card ${card}, and your todo list is empty: your first action is a \`todo\` \`add\` of one item per step of card ${card}, before any other work.`
    : cardOpenClause(card, accounting.open);
  return `\n\n${clause}`;
}

/**
 * What the child is told when it stops with a qualifying answer but an
 * unsettled card list: the answer is fine, the list is not, and the run
 * cannot finish until the list is settled.
 */
export function cardOnlyNudge(card: string, accounting: { empty: boolean; open: readonly TodoItem[] }): string {
  const clause = accounting.empty
    ? `Your todo list is empty: your first action is a \`todo\` \`add\` of one item per step of card ${card}, before any other work.`
    : cardOpenClause(card, accounting.open);
  return [
    `Your run has an answer the orchestrator can read, but kanban card ${card} is not settled, so the run cannot finish yet.`,
    ``,
    clause,
    ``,
    `Then call \`subagent_done\`.`,
  ].join("\n");
}

/**
 * The card half of a refused `subagent_done`. `left`/`max` mirror the answer
 * gate's bound — the card gate shares that budget rather than consuming a
 * second one.
 *
 * The opening is accurate on its own, because the refusal is what the model
 * reads: when only the card list blocks (a qualifying answer exists), this
 * is the *whole* guidance, and an answer-negating opening would be a lie.
 */
export function cardDoneRefusal(
  card: string,
  accounting: { empty: boolean; open: readonly TodoItem[] },
  left: number,
  max: number,
): string {
  const clause = accounting.empty
    ? `Your first action is a \`todo\` \`add\` of one item per step of card ${card}: build the list before any other work, and finish every item before you close the run.`
    : cardOpenClause(card, accounting.open);
  return [
    `Your run has an answer the orchestrator can read, but kanban card ${card} is not settled, so completion was refused.`,
    ``,
    `Card ${card}: ${clause}`,
    ``,
    `This refusal counts against the same ${max}-refusal budget as a missing answer (${left} left after this one).`,
  ].join("\n");
}

/**
 * The card clause of a refusal that already carries the answer guidance:
 * the same settlement demand in refusal tone, without the standalone opening
 * (the answer guidance's opening is the refusal's own there).
 */
function cardRefusalClause(
  card: string,
  accounting: { empty: boolean; open: readonly TodoItem[] },
  left: number,
  max: number,
): string {
  const clause = accounting.empty
    ? `Your first action is a \`todo\` \`add\` of one item per step of card ${card}: build the list before any other work, and finish every item before you close the run.`
    : cardOpenClause(card, accounting.open);
  return `\n\nCard ${card}: ${clause} This refusal counts against the same ${max}-refusal budget as a missing answer (${left} left after this one).`;
}
/**
 * How many times a card child may ask the orchestrator for guidance about its
 * card before the tool stops delivering. Mirrors the {@link MAX_REFUSED_COMPLETIONS}
 * discipline: bounded, and the refusal is visible (`isError`) rather than a
 * silently dropped wake-up.
 */
export const MAX_ASKS_PER_RUN = 3;

/**
 * The ask tool's whole decision, made pure: budget first, send second.
 *
 * The budget is spent only by an ask that actually posted: a `no-run-dir`
 * ask is a launch misconfiguration, and burning one of the three on it
 * would leave a live child with less guidance than it was promised. The
 * send is a thunk so the budget-spent refusal never touches the wire.
 */
export function askExecute(
  asks: number,
  send: () => ChildReportOutcome,
): { text: string; isError: boolean; asksAfter: number } {
  if (asks >= MAX_ASKS_PER_RUN) {
    return {
      isError: true,
      asksAfter: asks,
      text: `The ask budget for this run is spent (${MAX_ASKS_PER_RUN} asks). Decide from the card and the report log, or finish the run with an explanation of what is unresolved.`,
    };
  }
  const outcome = send();
  switch (outcome.kind) {
    case "no-run-dir":
      return {
        text: "Error: PI_SUBAGENT_RUN_DIR is not set; the ask cannot be recorded.",
        isError: false,
        asksAfter: asks,
      };
    case "delivered":
      return { text: "Ask sent to the orchestrator.", isError: false, asksAfter: asks + 1 };
    case "recorded-no-parent":
      return {
        text: "Ask recorded; no parent pane is known, so the orchestrator will see it on its next task check.",
        isError: false,
        asksAfter: asks + 1,
      };
    default: {
      // Exhaustive by construction: a fourth outcome variant must fail tsc
      // here, not silently ride the "recorded" text and spend budget.
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

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

/** The last assistant message in the turn, if any. */
function lastAssistantOf(messages: readonly MessageLike[]): MessageLike | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return undefined;
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

/**
 * How many times a child may be asked to continue a response that the output
 * token limit cut off mid-message, before the run is allowed to finish.
 *
 * The bound exists for the same reason as {@link MAX_REFUSED_COMPLETIONS}: a
 * model that keeps hitting the limit (a report longer than its output budget)
 * would otherwise be continued forever. Three extra full output budgets is
 * plenty to finish a report; a run that ends after them finishes with what the
 * transcript carries, which the parent labels salvage rather than a clean
 * answer.
 */
export const MAX_CONTINUATIONS = 3;

/** What the child is told when its response was truncated by the output token limit. */
export function continuationMessage(requiresResult: boolean): string {
  const contract = requiresResult
    ? `Continue and finish the report. Your visible answer must contain one complete \`<result>…</result>\` element in a single message — if the previous one was cut off, re-emit the whole report inside it.`
    : `Continue from exactly where you stopped, without repeating what you have already written. Your visible answer is your final assistant message.`;
  return [
    `Your previous response was truncated before completion: the model reached its output token limit mid-message.`,
    ``,
    contract,
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
 * at most once), the count of refused completions, the count of spent
 * truncation continuations, and whether the one agent-end nudge has been spent.
 * The methods encode the exact ordering:
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
 * ## The card gate
 *
 * A child that was delegated a kanban card (`PI_KANBAN_CARD`) is refused the
 * same way while its list is empty (it never built it from the card) or items
 * are still open. The card gate shares the answer gate's refusal counter: one
 * bad `subagent_done` consumes one refusal, whatever it got wrong.
 *
 * @param effects The side effects to perform.
 * @param env The process environment (for `HERDR_PANE_ID`, `HERDR_ENV`, `PI_SUBAGENT_ANCESTRY`,
 *   `PI_SUBAGENT_PARENT_PANE`, `PI_SUBAGENT_RUN_ID`, `PI_SUBAGENT_AGENT`,
 *   `PI_KANBAN_CARD`).
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
    cardTodos?: TodoState,
  ): void;
} {
  /** Written at most once: a second sidecar would tell the parent nothing new. */
  let signalled = false;
  /** Completion attempts refused so far, capped by `MAX_REFUSED_COMPLETIONS`. */
  let refusedCompletions = 0;
  /** Spent at most once per run: an ignored nudge must not loop the session. */
  let nudged = false;
  /**
   * Truncation continuations sent so far, capped by `MAX_CONTINUATIONS`: a
   * response cut off by the output token limit is continued, not finished,
   * while the bound lasts and no qualifying answer exists yet.
   */
  let continuations = 0;

  function complete(
    sessionFile: string | undefined,
    shutdown: () => void,
    answer?: AnswerContext,
  ): ChildDoneOutcome {
    if (!sessionFile) return { kind: "no-session-file" };

    // The gate. Only ever consulted before the first durable signal: once the
    // sidecar is on disk the run *is* finished, and re-judging it would refuse
    // a second call that is merely redundant.
    //
    // A card child owes the board a list, not just an answer: an empty list
    // (the child never built it from its card) and open items are refused the
    // same way a missing answer is — through this same counter, so one bad
    // call consumes one refusal, not two.
    const card = cardOf(env);
    const acct = card !== undefined && answer ? cardAccounting(answer.cardTodos) : undefined;
    const cardBlocking = acct !== undefined && (acct.empty || acct.open.length > 0);
    if (
      !signalled &&
      answer &&
      refusedCompletions < MAX_REFUSED_COMPLETIONS &&
      (!hasQualifyingAnswer(answer) || cardBlocking)
    ) {
      refusedCompletions++;
      const left = MAX_REFUSED_COMPLETIONS - refusedCompletions;
      const answered = hasQualifyingAnswer(answer);
      // When only the card list blocks, the refusal is the card refusal alone:
      // the answer guidance's opening ("no answer") and closing ("receives
      // nothing") are both lies in that case, and an instruction to re-emit the
      // answer would strand the report the model already wrote.
      const guidance =
        answered && cardBlocking && card !== undefined && acct
          ? cardDoneRefusal(card, acct, left, MAX_REFUSED_COMPLETIONS)
          : answerGuidance(requiresResultBlock(answer.systemPrompt), left) +
            (cardBlocking && card !== undefined && acct
              ? cardRefusalClause(card, acct, left, MAX_REFUSED_COMPLETIONS)
              : "");
      return {
        kind: "no-answer",
        guidance,
        attemptsLeft: left,
      };
    }

    const written = signalled || effects.writeExitSidecar(
      exitPath(sessionFile),
      formatExitSidecar(),
    );
    signalled = true;

    if (!written) return { kind: "write-failed", sessionFile };

    const route = noticeRoute(env, "done", "");
    if (route) {
      if (route.fallbacks.length === 0) effects.sendNotice(route.pane, route.notice);
      else effects.sendNotice(route.pane, route.notice, route.fallbacks);
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

    const route = noticeRoute(env, "report", message);
    if (!route) return { kind: "recorded-no-parent" };
    if (route.fallbacks.length === 0) effects.sendNotice(route.pane, route.notice);
    else effects.sendNotice(route.pane, route.notice, route.fallbacks);
    return { kind: "delivered" };
  }

  function onAgentEnd(
    messages: readonly MessageLike[],
    sessionFile: string | undefined,
    shutdown: () => void,
    systemPrompt?: string,
    cardTodos?: TodoState,
  ): void {
    if (signalled) return;
    if (!sessionFile) return;

    // A card child owes the board a settled list: an empty list (never built
    // from the card) and open items are a first-class reason to continue the
    // run, like a missing answer — one follow-up turn through the same
    // one-shot nudge slot, no sidecar from the nudge path, and the next clean
    // end finishes the run whatever the list state.
    const card = cardOf(env);
    const acct = card !== undefined ? cardAccounting(cardTodos) : undefined;
    const cardUnsettled = acct !== undefined && (acct.empty || acct.open.length > 0);

    // A response cut off by the output token limit is not a finish: the model
    // stopped mid-answer because its output budget ran out, and nothing in pi's
    // agent loop tells it to go on — the run would sit idle in its pane. For a
    // result-contract child truncated mid-`<result>` it is worse than idle: the
    // parent's completion predicate demands a clean, unsalvaged answer, so the
    // run could never settle. Ask the model to continue, bounded by
    // MAX_CONTINUATIONS; when the bound is spent (or an answer already exists)
    // finish the run the same way a clean end does, so the parent reads
    // whatever the transcript carries and labels a short answer as salvage.
    const answered = hasQualifyingAnswer({ messages, systemPrompt });
    const lastAssistant = lastAssistantOf(messages);
    if (lastAssistant?.stopReason === "length") {
      if (continuations < MAX_CONTINUATIONS && !answered) {
        continuations++;
        // A truncated `!answered` run is also a card run when its list has
        // open items: the one continuation turn carries both. A settled list
        // gets no tail — `openItemsClause([])` returns "", so appending would
        // read "…:  are still open" and spend the one-shot nudge on nothing.
        effects.sendAnswerNudge(
          continuationMessage(requiresResultBlock(systemPrompt)) +
            (cardUnsettled && card !== undefined && acct ? cardNudgeTail(card, acct) : ""),
        );
        return;
      }
      // `cardOnlyNudge` opens "Your run has an answer the orchestrator can
      // read" — true only when `answered`. A truncation with no answer must
      // not spend the one-shot `nudged` slot on a lie: that slot is what
      // recovers a stranded report at the clean-end path.
      if (!nudged && answered && cardUnsettled && card !== undefined && acct) {
        nudged = true;
        effects.sendAnswerNudge(cardOnlyNudge(card, acct));
        return;
      }
      finishRun(sessionFile, shutdown);
      return;
    }

    if (!endedCleanly(messages)) return;

    // A clean end with nothing visible to report (or, for a card child, an
    // unsettled list): ask once, then let it go.
    //
    // `endedCleanly` is satisfied by a `stopReason: "stop"` message that
    // carries only reasoning, which is how sub-9bad finished — the parent dutifully
    // recorded a successful run whose answer existed nowhere. One nudge turns
    // that into a second turn in which the model can write what it already
    // worked out; an ignored nudge must not loop the session, so it is spent
    // once and the next clean end completes as before.
    if (!nudged && (!answered || cardUnsettled)) {
      nudged = true;
      if (answered && card !== undefined && acct) {
        // The answer is fine; the card list is the only thing blocking.
        effects.sendAnswerNudge(cardOnlyNudge(card, acct));
      } else {
        let nudge = nudgeMessage(requiresResultBlock(systemPrompt));
        // A card child that stops without an answer and has open items is,
        // for the board, a card that stopped without a list: the same one
        // nudge carries both. A settled list gets no tail (empty clause).
        if (cardUnsettled && card !== undefined && acct) {
          nudge += cardNudgeTail(card, acct);
        }
        effects.sendAnswerNudge(nudge);
      }
      return;
    }

    finishRun(sessionFile, shutdown);
  }

  /**
   * The one finish path: sidecar → notice → pane close → shutdown.
   *
   * Shared by the clean-end and truncated-end completions so the ordering —
   * and the `signalled` dedup that makes the sidecar at-most-once — is
   * spelled exactly once.
   */
  function finishRun(sessionFile: string, shutdown: () => void): void {
    signalled = effects.writeExitSidecar(
      exitPath(sessionFile),
      formatExitSidecar(),
    );
    if (signalled) {
      const route = noticeRoute(env, "done", "");
      if (route) {
        if (route.fallbacks.length === 0) effects.sendNotice(route.pane, route.notice);
        else effects.sendNotice(route.pane, route.notice, route.fallbacks);
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
// Child watchdog: one-shot stall detection, independent of the handshake
// ---------------------------------------------------------------------------

/**
 * How long an assistant stream may go without a `message_update` before the
 * child reports it as stalled.
 *
 * Measured from the LAST update, not from the stream's start: a live stream
 * emits `message_update` continuously, and xhigh thinking is routine here — a
 * thinking-heavy stream can go minutes with no visible text — so a phase that
 * reaches this age since its last update has stopped producing output rather
 * than merely moved slowly.
 *
 * Known limitation: the idle phase — the stretch between a stream's end and
 * the next stream's or tool's start — is unwatched, so a child wedged there
 * (e.g. inside a provider call that emits no events) is not detected.
 *
 * pi emits `message_update` for assistant streaming only; a non-assistant
 * `message_update` is ignored by the watchdog.
 */
export const STREAMING_STALL_MS = 5 * 60_000;

/**
 * How long one top-level tool call may go without activity before the child
 * reports it as stalled.
 *
 * Activity is the tool's own start/end/update events; a nested (codemode)
 * sub-call's start, end, or update refreshes the PARENT's entry, because work
 * inside the child is work of the outer tool.
 *
 * Known limitation: a tool that hangs before its first event (a start that
 * never arrives) never opens an entry, so it is unwatched.
 */
export const TOOL_STALL_MS = 10 * 60_000;

/** The watchdog's tick cadence: how often it re-examines the active phases. */
export const WATCHDOG_TICK_MS = 30_000;

/**
 * The child's active activity phase. The streaming half is a single slot —
 * assistant messages are sequential — but the tool half is a map keyed by
 * toolCallId (see {@link ToolEntry}), because pi runs tool calls in parallel
 * batches and codemode nests sub-calls inside them: a single slot would let
 * any sibling's or nested child's end clear a hung tool's phase, and the hung
 * tool would run unwatched.
 */
type WatchdogPhase =
  | { kind: "idle" }
  | { kind: "streaming"; startedAt: number; lastActivityAt: number; warned: boolean };

/** One top-level tool call under watch. */
interface ToolEntry {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  lastActivityAt: number;
  /** One-shot: at most one stall notice per tool call. */
  warned: boolean;
}

/**
 * The watchdog's character count of a message: `text` + `thinking` +
 * JSON-stringified tool-call `arguments`.
 *
 * Deliberately wider than the handshake's `visibleTextOf` (text parts only —
 * thinking is excluded there because reasoning never reaches the orchestrator,
 * which is the point of the gate). A stall notice, by contrast, should read as
 * "produced N" when the child was in fact producing: a silently reasoning
 * model's thinking is production, and partial tool-call arguments are
 * production. The two counters answer different questions, so they must not
 * be merged. The count is untrimmed by design (diverges deliberately from
 * `visibleTextOf`, which trims): a stall notice should reflect raw production.
 */
function watchdogCharsOf(message: MessageLike): number {
  const content = message.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: unknown; text?: unknown; thinking?: unknown; arguments?: unknown };
    if (p.type === "text" && typeof p.text === "string") {
      chars += p.text.length;
    } else if (p.type === "thinking" && typeof p.thinking === "string") {
      chars += p.thinking.length;
    } else if (p.type === "toolCall" && p.arguments != null) {
      // Partial while streaming: the args object is built up across
      // `toolcall_delta` frames, so the latest snapshot's args are the
      // production so far.
      chars += JSON.stringify(p.arguments).length;
    }
  }
  return chars;
}

/** The side effects the watchdog can perform. */
export interface ChildWatchdogEffects {
  /** The current time in ms, injected so tests drive the clock. */
  now(): number;
  /**
   * Deliver a notice to the parent pane. Must preserve detached + ignored-stdio
   * + unref behavior so the delivery survives the child's own process-group kill.
   * `fallbacks` — the ancestor hops, nearest first — is passed only when it is
   * non-empty, so the one-level case keeps its exact two-argument call.
   */
  sendNotice(parentPane: string, notice: string, fallbacks?: readonly NoticeHop[]): void;
}

/**
 * Create the child-side stall watchdog with injected effects.
 *
 * Independent of {@link createChildDoneHandshake}: it observes streaming and
 * tool phases and, once a phase overruns its threshold, sends exactly one
 * `stalled` notice to the parent. The parent is the one that spawns the
 * health-check; the child only signals. Each fresh phase gets a fresh one-shot
 * allowance, so a phase that is restarted is re-warnable, but a phase that
 * merely continues does not re-warn.
 *
 * The character count in a streaming stall notice is computed lazily, inside
 * `check()`, from the LATEST `message_update` snapshot (pi emits a fresh
 * shallow copy per update, reusing the content array): text, thinking, and
 * JSON-stringified tool-call arguments, so a silently reasoning stream does
 * not read as "produced nothing". Storing the reference — not a running
 * count — keeps each update O(1); the count is read once per tick, not once
 * per token delta.
 *
 * @param effects The side effects to perform (clock + detached notice).
 * @param env The process environment (for `PI_SUBAGENT_ANCESTRY`, `PI_SUBAGENT_RUN_ID`,
 *   `PI_SUBAGENT_AGENT`, `PI_SUBAGENT_PARENT_PANE`).
 */
export function createChildWatchdog(
  effects: ChildWatchdogEffects,
  env: NodeJS.ProcessEnv,
): {
  onMessageStart(message: MessageLike): void;
  onMessageUpdate(message: MessageLike): void;
  onMessageEnd(message: MessageLike): void;
  onToolExecutionStart(toolCallId: string, toolName: string, parentToolCallId?: string): void;
  onToolExecutionEnd(toolCallId?: string, parentToolCallId?: string): void;
  onToolExecutionUpdate(toolCallId?: string, parentToolCallId?: string): void;
  onAgentEnd(): void;
  check(): void;
} {
  let phase: WatchdogPhase = { kind: "idle" };
  /** Every top-level tool call in flight, keyed by toolCallId. */
  const toolEntries = new Map<string, ToolEntry>();
  /** Latest `message_update` snapshot of the active stream; the char count is derived from it, lazily, at check time. */
  let latestMessage: MessageLike | null = null;

  /**
   * Resolve a tool entry by walking ancestors: trim at the last `/` repeatedly
   * until a key hits the map. Top-level ids have no `/`; nested (codemode) ids
   * are `<parentId>/<n>` chains, and the walk is unbounded: it trims to any depth.
   */
  function resolveEntry(id: string): ToolEntry | undefined {
    let key = id;
    for (;;) {
      const entry = toolEntries.get(key);
      if (entry) return entry;
      const slash = key.lastIndexOf("/");
      if (slash === -1) return undefined;
      key = key.slice(0, slash);
    }
  }

  function onMessageStart(message: MessageLike): void {
    // Only an assistant message starts a fresh streaming phase; a user or
    // toolResult message_start is not the child talking.
    if (message.role !== "assistant") return;
    const at = effects.now();
    phase = { kind: "streaming", startedAt: at, lastActivityAt: at, warned: false };
    latestMessage = message;
  }

  function onMessageUpdate(message: MessageLike): void {
    if (phase.kind !== "streaming") return;
    // Each update carries the current full message (pi's agent-loop.js emits
    // `{...partialMessage}` per update, a fresh shallow copy reusing the content
    // array), so the latest one is everything the stream has produced so far.
    // Store the reference, not a count: pi updates on every token delta, and
    // scanning the content on each one would be O(n) per delta, quadratic over
    // a stream — the count is read once per tick, inside check().
    phase.lastActivityAt = effects.now();
    latestMessage = message;
  }

  function onMessageEnd(message: MessageLike): void {
    // Symmetry with onMessageStart: only the assistant's own message end
    // closes its phase; a user or toolResult end says nothing about it.
    if (message.role !== "assistant") return;
    if (phase.kind !== "streaming") return;
    phase = { kind: "idle" };
    latestMessage = null;
  }

  function onToolExecutionStart(toolCallId: string, toolName: string, parentToolCallId?: string): void {
    if (parentToolCallId !== undefined) {
      // A nested (codemode) sub-call's start is activity of the outer tool:
      // refresh the parent's clock so a busy codemode (e.g. 40 sequential reads
      // over 20 min) does not false-stall the parent entry.
      const entry = resolveEntry(parentToolCallId);
      if (entry) entry.lastActivityAt = effects.now();
      return;
    }
    // Only a TOP-LEVEL tool call gets an entry.
    // Upsert: a start for an id already in the map restarts its clock.
    const at = effects.now();
    toolEntries.set(toolCallId, {
      toolCallId,
      toolName,
      startedAt: at,
      lastActivityAt: at,
      warned: false,
    });
  }

  function onToolExecutionEnd(toolCallId?: string, parentToolCallId?: string): void {
    if (parentToolCallId !== undefined) {
      // A nested (codemode) sub-call's end is activity of the outer tool:
      // refresh the parent's clock. Identity-blind clearing is exactly what
      // let a sibling's end clear a hung tool's entry, so a nested end must
      // not delete the parent.
      const entry = resolveEntry(parentToolCallId);
      if (entry) entry.lastActivityAt = effects.now();
      return;
    }
    if (toolCallId === undefined) return;
    toolEntries.delete(toolCallId);
  }

  function onToolExecutionUpdate(toolCallId?: string, parentToolCallId?: string): void {
    // Activity inside a nested child is activity of the outer tool, so a
    // nested update (parentToolCallId = P) refreshes the ancestor entry P;
    // a top-level update refreshes its own entry. An update whose entry is
    // already gone (its end arrived first) is a no-op.
    const id = parentToolCallId ?? toolCallId;
    if (id === undefined) return;
    const entry = resolveEntry(id);
    if (!entry) return;
    entry.lastActivityAt = effects.now();
  }

  function onAgentEnd(): void {
    // A turn boundary: clear whatever the previous turn left behind. A
    // non-truncation throw mid-batch can leave an orphaned start with no
    // matching end, which would otherwise wedge an entry and false-stall the
    // next turn; a stream that ends without message_end is the same shape on
    // the streaming half. agent_end is the one ending path every outcome
    // (clean, aborted, error) emits, so it is the place to reset both.
    phase = { kind: "idle" };
    toolEntries.clear();
    latestMessage = null;
  }

  function check(): void {
    const now = effects.now();
    if (phase.kind === "streaming" && !phase.warned) {
      if (now - phase.lastActivityAt >= STREAMING_STALL_MS) {
        phase.warned = true;
        const chars = latestMessage ? watchdogCharsOf(latestMessage) : 0;
        sendStalled(`phase=streaming elapsedMs=${now - phase.startedAt} charsGenerated=${chars}`);
      }
    }
    // One notice per tool call, and the OLDEST stalled one first: a batch
    // with several wedged siblings warns them in start order, one per tick.
    let stalled: ToolEntry | undefined;
    for (const entry of toolEntries.values()) {
      if (entry.warned || now - entry.lastActivityAt < TOOL_STALL_MS) continue;
      if (!stalled || entry.startedAt < stalled.startedAt) stalled = entry;
    }
    if (stalled) {
      stalled.warned = true;
      sendStalled(`phase=tool elapsedMs=${now - stalled.startedAt} tool=${stalled.toolName}`);
    }
  }

  function sendStalled(text: string): void {
    const route = noticeRoute(env, "stalled", text);
    // No route (no parent pane): the notice has nowhere to go. A stall signal
    // that cannot be delivered is a no-op, not a reason to throw from the
    // watchdog tick.
    if (!route) return;
    if (route.fallbacks.length === 0) effects.sendNotice(route.pane, route.notice);
    else effects.sendNotice(route.pane, route.notice, route.fallbacks);
  }

  return {
    onMessageStart,
    onMessageUpdate,
    onMessageEnd,
    onToolExecutionStart,
    onToolExecutionEnd,
    onToolExecutionUpdate,
    onAgentEnd,
    check,
  };
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

    sendNotice(parentPane, notice, fallbacks) {
      // `spawn` rather than `execFile`, detached and unref'd, because the `done`
      // notice races its own sender's death: `closePane()` kills this child's
      // *process group*, and a delivery still in flight would go with it — the
      // orchestrator would then sleep until a human poked it, which is the bug
      // this channel exists to fix. `detached` puts the delivery in its own
      // process group so it survives that kill; `unref` plus ignored stdio
      // means it holds neither the event loop nor a pipe to a process that is
      // about to exit.
      //
      // A fallback-aware delivery rides the same detached process: one `sh`
      // that walks the hops in order, so the detach property holds for every
      // hop, and the walk's prompt is its own liveness probe.
      if (fallbacks && fallbacks.length > 0) {
        const child = spawn(
          "sh",
          noticeWalkArgv({ pane: parentPane, notice, fallbacks: [...fallbacks] }),
          { detached: true, stdio: "ignore" },
        );
        child.on("error", () => {});
        child.unref();
        return;
      }
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

  /**
   * The child's todo state, replayed from the current branch — the newest
   * `todo` tool result's `details.state`, validated by the shared
   * `parseTodoState` (`lib/todo.ts`) — the same rule the kanban board's
   * reader applies (`todo.ts`'s own rebuild is looser).
   *
   * The same replay rule as the todo extension's `reconstruct`: the last
   * snapshot wins, malformed ones SKIPPED — the same "skip, keep walking"
   * rule {@link ../kanban/runs.ts} applies, so one fact has one rule and the
   * board and the gate can never disagree about which snapshot is current.
   * `undefined` only when the branch carries no valid `todo` result at all.
   */
  const branchTodoState = (ctx: { sessionManager: { getBranch(): unknown[] } }): TodoState | undefined => {
    try {
      // The branch is oldest-first: keep the LAST valid snapshot, skipping
      // malformed ones (the board's rule in `kanban/runs.ts`) — one fact, one
      // rule, so a torn write never reads as "no list" for the gate while the
      // board shows progress.
      let best: TodoState | undefined;
      for (const entry of ctx.sessionManager.getBranch()) {
        if ((entry as { type?: unknown }).type !== "message") continue;
        const msg = (entry as { message?: unknown }).message as
          | { role?: unknown; toolName?: unknown; details?: unknown }
          | undefined;
        if (msg?.role !== "toolResult" || msg?.toolName !== "todo") continue;
        const parsed = parseTodoState((msg.details as { state?: unknown } | undefined)?.state);
        if (parsed) best = parsed;
      }
      return best;
    } catch {
      return undefined;
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
      // The list is the card's, and only a card child's gate consults it — so
      // only a card child pays for the branch replay.
      const card = cardOf(process.env);
      const outcome = handshake.complete(sessionFile, () => ctx.shutdown(), {
        messages: branchMessages(ctx),
        systemPrompt: readSystemPrompt(),
        cardTodos: card !== undefined ? branchTodoState(ctx) : undefined,
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

  // Card children only: the board is the contract, and a card child that
  // cannot progress because the card is ambiguous is stuck in a pane the
  // orchestrator is not watching. One bounded channel to ask for guidance;
  // delivery is `handshake.report`, so the ask is recorded in the run's
  // report log like any other mid-run message.
  if (cardOf(process.env) !== undefined) {
    let asks = 0;
    pi.registerTool({
      name: "subagent_ask",
      label: "Ask Orchestrator",
      description:
        "Ask the orchestrator for guidance about your kanban card: an ambiguity you cannot resolve, a missing input, a decision the card leaves open. The orchestrator receives it shortly and may answer in this session. Bounded per run.",
      promptSnippet: "Ask the orchestrator for guidance about your card (card runs only).",
      promptGuidelines: [
        "Use subagent_ask when the card is ambiguous or an input is missing and you cannot proceed without the orchestrator's answer.",
        "An ask is not a status update (that is subagent_report) and not your final answer (that is your last message).",
        `You may ask at most ${MAX_ASKS_PER_RUN} times per run; after that the tool reports the budget is spent.`,
      ],
      parameters: Type.Object({
        question: Type.String({ description: "The question about your card" }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const runDir = process.env.PI_SUBAGENT_RUN_DIR;
        const r = askExecute(asks, () => handshake.report(`[ask] ${params.question}`, runDir));
        asks = r.asksAfter;
        return {
          ...(r.isError ? { isError: true } : {}),
          content: [{ type: "text", text: r.text }],
          details: {},
        };
      },
    });
  }

  pi.on("agent_end", (event, ctx) => {
    // Same rule as the tool: the branch replay is for card children only.
    const card = cardOf(process.env);
    handshake.onAgentEnd(
      event.messages as MessageLike[],
      ctx.sessionManager.getSessionFile(),
      () => ctx.shutdown(),
      readSystemPrompt(),
      card !== undefined ? branchTodoState(ctx) : undefined,
    );
  });
  // Child-side stall watchdog: independent of the handshake. It observes
  // streaming/tool phases and sends one `stalled` notice when a phase overruns
  // its threshold; the parent then decides whether to spawn a health check.
  const watchdog = createChildWatchdog(
    {
      now: () => Date.now(),
      sendNotice: effects.sendNotice,
    },
    process.env,
  );

  pi.on("message_start", (event) => {
    watchdog.onMessageStart(event.message as MessageLike);
  });
  pi.on("message_update", (event) => {
    watchdog.onMessageUpdate(event.message as MessageLike);
  });
  pi.on("message_end", (event) => {
    watchdog.onMessageEnd(event.message as MessageLike);
  });
  pi.on("tool_execution_start", (event) => {
    // 0.75.4's ToolExecution*Event predates `parentToolCallId`; the running
    // pi carries it, so read it off the event structurally. A nested (codemode)
    // sub-call sets it and must not touch the map of top-level entries.
    const parentToolCallId = (event as { parentToolCallId?: string }).parentToolCallId;
    watchdog.onToolExecutionStart(event.toolCallId, event.toolName, parentToolCallId);
  });
  pi.on("tool_execution_update", (event) => {
    // A nested sub-call's update carries its parent's id; activity inside the
    // child is activity of the outer tool, so it refreshes the parent's entry.
    const parentToolCallId = (event as { parentToolCallId?: string }).parentToolCallId;
    watchdog.onToolExecutionUpdate(event.toolCallId, parentToolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    // A nested sub-call's end carries its parent's id and must not delete the
    // parent's entry; only a top-level end deletes its own.
    const parentToolCallId = (event as { parentToolCallId?: string }).parentToolCallId;
    watchdog.onToolExecutionEnd(event.toolCallId, parentToolCallId);
  });
  pi.on("agent_end", () => {
    // A turn boundary clears whatever the previous turn left behind: an
    // orphaned start (a throw mid-batch) would otherwise wedge an entry and
    // false-stall the next turn.
    watchdog.onAgentEnd();
  });

  // One tick, unref'd so it never holds the child's event loop open, and cleared
  // on shutdown. A tick is a bounded phase re-check, not a wait. The body is
  // wrapped because a synchronous throw in a timer callback is uncaught and
  // would kill the child; a lost tick costs one 30-second delay, not the run.
  const watchdogTimer = setInterval(() => {
    try {
      watchdog.check();
    } catch {
      // The next tick re-examines the same phases; nothing is lost by dropping
      // one.
    }
  }, WATCHDOG_TICK_MS);
  watchdogTimer.unref();
  pi.on("session_shutdown", () => {
    clearInterval(watchdogTimer);
  });
}
