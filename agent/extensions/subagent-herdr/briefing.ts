/**
 * The briefing blocks: what a run becomes as text.
 *
 * A briefing is the whole reason a notice exists — a header, an optional
 * salvage label, the child's todo counts, its answer, a snapshot of the runs it
 * launched, its pane's scrollback when it failed with nothing to say, and its
 * mid-run reports. Before this module those renderers sat in `index.ts` beside
 * the registry, the timers and pi, reading `dirFor`, `readReports`,
 * `allRunCandidates`, `extractRunResult` and the herdr pane primitives straight
 * out of the surrounding scope.
 *
 * Here the wording is all they own. **This module imports no pi, no `herdr.ts`
 * and no `node:`**, and does no work at load: `scripts/check.sh` imports every
 * extension source standalone, so only declarations and pure functions may sit
 * at its top level — the shape `auto-update/status.ts` establishes. Every read a
 * block needs arrives through {@link BriefingEffects}, bound in `index.ts`,
 * where the run dirs and the herdr seam actually live.
 *
 * {@link createBriefing}'s result **is** the ledger's `ReleaseRenderer`: the
 * wiring site passes `renderer: briefing` to a field the ledger declares
 * `renderer: ReleaseRenderer`, so that declaration is the conformance check — a
 * compile instead of misbehaving at wake time. `renderResultBlock` and
 * `pushReports` ride on the returned object because `index.ts`'s `result` arm
 * composes its own output (a still-running run renders no block, and a foreign
 * record carries an inference note under its header) and must not re-implement
 * the answer block or the report join.
 *
 * The joins differ on purpose and both are pinned: `done` and `degraded` join
 * their lines with "\n" because each is one paragraph of a briefing, while a
 * caller that pushes several blocks joins them with "\n\n".
 *
 * @module subagent-herdr/briefing
 */

import { hasExitSidecar, type ChildReport, type Notice, type RunRecord } from "./rundir.js";
import type { RunResult } from "./lib.js";
import {
  healthCheckOfId,
  renderSpawnsBlock,
  type ReleasedTarget,
  type ReleaseRenderer,
} from "./release-ledger.js";

/** Answers are truncated in tool output at this size; the transcript stays complete on disk. */
export const RESULT_MAX_CHARS = 20_000;

/** Terminal text used as a failure diagnostic when the transcript has nothing. */
async function paneDiagnostic(rec: RunRecord, effects: BriefingEffects): Promise<string | null> {
  if (!rec.paneId) return null;
  // herdr reuses pane ids, so the recorded id may now belong to a different
  // pane: read it only when it still carries the label this run was given.
  // An unreadable label (pane gone, herdr unreachable) is treated the same —
  // the output could be anyone's, so no pane output at all.
  const label = await effects.paneLabel(rec.paneId);
  if (label !== `${rec.agent} ${rec.runId}`) return null;
  return effects.readAgent(rec.paneId, 40);
}

/**
 * A finite `startedAt` for a record: `startedAt` is non-optional on the
 * type, but a truncated or hand-edited meta.json can still load a record
 * without one (or with a non-numeric one), and arithmetic on it would then
 * yield NaN. Fall back to now (elapsed ≈ 0) so headers and lists stay
 * readable; `Math.max(0, …)` at the call sites keeps a stale `finishedAt`
 * from rendering a negative elapsed (finishedAt older than startedAt).
 */
export function startedAtOf(rec: RunRecord, now: number = Date.now()): number {
  return Number.isFinite(rec.startedAt) ? rec.startedAt : now;
}

export function formatResultHeader(rec: RunRecord): string {
  const startedAt = startedAtOf(rec);
  const elapsed = rec.finishedAt
    ? `${Math.max(0, Math.round((rec.finishedAt - startedAt) / 1000))}s`
    : "…";
  const healthCheckOf = healthCheckOfId(rec);
  const role = healthCheckOf ? `health check of ${healthCheckOf} — ${rec.status}` : rec.status;
  return `=== ${rec.runId} (${rec.agent}) — ${role} [${elapsed}] ===`;
}

/**
 * Run ids proven to have been delivered as a `done` notice to the run whose
 * answer a spawns block follows — always empty, and deliberately so.
 *
 * The plan was to read them off the session transcript: a `[subagent … done]`
 * input recorded there would be a fact, not a claim. pi does not record one.
 * An `input` hook that answers `handled` (this module's, in every process that
 * loads it) returns before pi creates a message, and session persistence hangs
 * off `message_end`, so a swallowed notice is nowhere on disk — verified against
 * the installed `agent-session.js` and an empty `grep` over a live session. The
 * one durable trace is the briefing the notice was folded into, and a briefing
 * header is text a model can also write, so it is not evidence either.
 *
 * Empty therefore means every finished child is labelled "delivery not
 * provable from disk" — always true, and stated because nothing on disk proves
 * the verdict reached the run whose text is printed above it. The label says
 * what the disk supports (no proof of delivery), not that the block above
 * omitted it: after the pending-spawn deferral a delegating worker settles
 * *because* its graders' verdicts reached it, which the old "not reflected"
 * claim asserted the opposite of.
 */
export const COLLECTED_DONE_IDS: ReadonlySet<string> = new Set();

export function truncate(text: string): string {
  if (text.length <= RESULT_MAX_CHARS) return text;
  return `${text.slice(0, RESULT_MAX_CHARS)}\n…[truncated; full transcript: see run dir]`;
}

/**
 * Everything the blocks need from outside, as six reads. The bag is what makes
 * them testable: a fake is an object literal with a call log — no temp dir, no
 * `mock.module`, no herdr (see `briefing.test.ts`).
 */
export interface BriefingEffects {
  /** The run's answer, extracted from its transcript (the no-answer gate). */
  extractResult(rec: RunRecord): Promise<RunResult>;
  /** The child's mid-run reports, in the order it wrote them. */
  reports(rec: RunRecord): Promise<ChildReport[]>;
  /** Every run this process can see, with its directory — one fresh scan. */
  runCandidates(): readonly { rec: RunRecord; dir: string }[];
  /** Drop the caller's candidate memo so {@link BriefingEffects.runCandidates} re-reads. */
  invalidateRunScan(): void;
  /** A pane's current label, for the identity guard in `paneDiagnostic`. */
  paneLabel(paneId: string): Promise<string | undefined>;
  /** A pane's raw scrollback tail; null when herdr refuses. */
  readAgent(paneId: string, lines?: number): Promise<string | null>;
}

/** The ledger's three renderers, plus the two blocks `index.ts` composes itself. */
export interface Briefing extends ReleaseRenderer {
  /** One completed run's lines, pushed onto the caller's output array. */
  renderResultBlock(
    rec: RunRecord,
    out: string[],
    /** Pre-fetched result, when the caller already ran the no-answer gate. */
    result?: RunResult,
    /** Display-only note under the header (the foreign-record inference label). */
    note?: string,
  ): Promise<void>;
  /** The mid-run reports the `result` arm also appends to a still-running run. */
  pushReports(rec: RunRecord, out: string[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Briefings (the text a notice becomes)
// ---------------------------------------------------------------------------

/**
 * Binds the renderers to one effects bag. Construction does no work — the
 * returned object is only closures — so `index.ts` may build it at module
 * scope, next to the run-dir helpers its effects call.
 */
export function createBriefing(effects: BriefingEffects): Briefing {
  /**
   * Appends the child's mid-run reports (the child → orchestrator leg) to a
   * result output block, when there are any. A report that was also delivered
   * live to this session shows up here too — the log is the durable copy.
   */
  async function pushReports(rec: RunRecord, out: string[]): Promise<void> {
    const reports = await effects.reports(rec);
    if (reports.length === 0) return;
    out.push(
      `--- reports sent to you by ${rec.agent} during the run (${reports.length}) ---\n${reports
        .map((r) => `- ${r.message}`)
        .join("\n")}`,
    );
  }

  /**
   * Pushes one completed run's block (header, optional inference note, salvage
   * note, todos line, answer text, diagnostics, reports)
   * onto the caller's output array. The caller must have already brought the
   * record up to date (`lifecycle.read`, or a sweep) — except the display-only
   * foreign-record path, which passes its inference note: the status is inferred
   * from on-disk evidence, not settled by this pane.
   */
  async function renderResultBlock(
    rec: RunRecord,
    out: string[],
    /** Pre-fetched result, when the caller already ran the no-answer gate. */
    result?: RunResult,
    /** Display-only note under the header (the foreign-record inference label). */
    note?: string,
  ): Promise<void> {
    out.push(formatResultHeader(rec));
    if (note) out.push(note);
    const resolved = result ?? (await effects.extractResult(rec));
    // A salvaged answer is labelled rather than passed off as a clean report: the
    // orchestrator should know it is reading something the child stranded in the
    // wrong place, because it may be truncated and the delegation may be worth
    // re-running. A clean answer in the right place gets no label at all.
    const salvageNote: Record<string, string> = {
      "done-arguments":
        "(recovered from this run's subagent_done arguments — the child passed its answer to the tool instead of writing it as a message, so it is very likely truncated)",
      "truncated-answer":
        "(this is the child's final answer, but it does not close its `<result>` element — most likely cut off by the output limit, so treat it as incomplete)",
      "earlier-message":
        "(recovered from an earlier message — the child answered and then kept working, so its final message was not the answer)",
      "non-conforming":
        "(NOT AN ANSWER — this run produced no report, only this line. Everything it concluded is lost; re-delegate the task rather than relying on this.)",
    };
    if (resolved.salvagedFrom) out.push(salvageNote[resolved.salvagedFrom]);
    // The child's checklist rides the briefing itself: what the run settled
    // is orchestrator-relevant even when its prose is one line. Counts come
    // from extractRunResult's single pass (the shared parseTodoState rule),
    // so this costs no extra read.
    const td = resolved.todos;
    if (td && td.total > 0) {
      const bits = [`${td.done}/${td.total} done`];
      if (td.inProgress) bits.push(`${td.inProgress} in progress`);
      if (td.blocked) bits.push(`${td.blocked} blocked`);
      if (td.pending) bits.push(`${td.pending} pending`);
      out.push(`todos: ${bits.join(", ")}`);
    }
    out.push(resolved.answered ? truncate(resolved.text) : "(no final answer in transcript)");
    // What this run launched, as of now, on the line right after its answer — so
    // it lands just past the child's closing `</result>` in what the receiver
    // reads, and outside the element. To `out` ONLY: never the transcript, the
    // sidecar or `system-prompt.md`, which are evidence the completion predicates
    // read, and a line written into any of them would become a new candidate
    // answer. A fresh scan rather than the memo: the header says "snapshot at",
    // and a record set left over from the last tick could be a minute old.
    effects.invalidateRunScan();
    const spawns = renderSpawnsBlock(rec, effects.runCandidates(), COLLECTED_DONE_IDS, Date.now(), hasExitSidecar);
    if (spawns) out.push(spawns);
    if (rec.status === "failed" && !resolved.answered) {
      const diag = await paneDiagnostic(rec, effects);
      if (diag) out.push(`\n--- pane output ---\n${truncate(diag)}`);
    }
    await pushReports(rec, out);
  }

  /**
   * Renders one completed run's block as a single string (joined with "\n").
   * Used by the wake briefing where each block is an independent paragraph.
   */
  async function doneBlock(rec: RunRecord, result?: RunResult): Promise<string> {
    const out: string[] = [];
    await renderResultBlock(rec, out, result);
    return out.join("\n");
  }

  /**
   * A released target's block when its result read threw: the real header —
   * so the block stays discoverable by the `=== sub-xxxx` header every release
   * assertion pins — plus a pointer to `subagent_tasks`. `readReports` never
   * throws, so the mid-run reports ride the degraded block too.
   */
  async function degradedBlock(rec: RunRecord): Promise<string> {
    const out: string[] = [
      formatResultHeader(rec),
      `result block unavailable; read it with subagent_tasks (action "result", ids ["${rec.runId}"])`,
    ];
    await pushReports(rec, out);
    return out.join("\n");
  }

  return { renderResultBlock, pushReports, done: doneBlock, degraded: degradedBlock, fallback: fallbackBriefing };
}

/**
 * Minimal briefing used when composing the full one threw.
 *
 * Deliberately does no I/O: this is the path taken *because* I/O failed, and a
 * wake that says only "something happened, go and look" still beats an
 * orchestrator that sleeps through a finished child.
 */
function fallbackBriefing(
  batch: readonly Notice[],
  swept: readonly RunRecord[],
  /**
   * Targets whose release a failed compose for their health check carried:
   * neither a fresh notice nor a swept record, so the caller surfaces them
   * here explicitly.
   */
  releasedTargets: ReadonlyArray<ReleasedTarget>,
): string {
  const ids = new Set<string>();
  const lines: string[] = [];
  for (const n of batch) {
    if (!ids.has(n.runId)) {
      ids.add(n.runId);
      lines.push(`- ${n.runId} (${n.agent}) ${n.kind}${n.text ? `: ${n.text}` : ""}`);
    }
  }
  for (const r of swept) {
    if (!ids.has(r.runId)) {
      ids.add(r.runId);
      lines.push(`- ${r.runId} (${r.agent}) ${r.status}`);
    }
  }
  for (const t of releasedTargets) {
    if (!ids.has(t.runId)) {
      ids.add(t.runId);
      lines.push(
        t.kind === "unregistered"
          ? `- ${t.runId} — release carried by the failed health check's briefing; this id is not in my registry, so I have no record of it — read it from its run dir, or with subagent_tasks (action "result") if it exists`
          : `- ${t.runId} (${t.agent}) ${t.status} — release carried by the failed health check's briefing`,
      );
    }
  }
  return (
    `[subagent update — delivered automatically, not typed by the user]\n\n${lines.join("\n")}\n\n` +
    `I could not read the run details. Use subagent_tasks (action "result") on the ids above to collect them.`
  );
}
