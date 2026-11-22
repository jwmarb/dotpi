/**
 * The one READ that answers "is this run's work already on disk?" — pi-free,
 * with every input injected, and holding the memo that makes the read affordable.
 *
 * **The read is shared; the verdicts are not.** Every site that must classify a
 * run without settling it — the `subagent_tasks` display arms for a foreign
 * `running` record, the reroute proof in `parent-proof.ts` — asks THIS module the
 * same question, so the ordering, the third input and the wording of the source
 * cannot drift between them. But the memo inside is keyed on the question this
 * module answers, and **no memo here may answer another site's question**: a
 * caller with its own expiry, trust or ownership rule keeps its own memo (the
 * parent-proof memo is positives-only and TTL-bounded precisely because a proof
 * is not a verdict). Sharing the read is not sharing a cache.
 *
 * ## What a verdict is
 *
 * The completion evidence for one run dir, read *without settling*: the
 * `.exit` sidecar, or a clean transcript answer read as a bounded tail — the
 * {@link completionSignal} rule, spelled once in `run-lifecycle.ts`. A read,
 * never a write: no transition, no meta save, no pane close — so a run this pane
 * does not own is never settled by it, and the owning pane's process stays the
 * one to do that.
 *
 * `result` is the extraction the decision rested on (absent when the sidecar
 * decided, since the transcript need not be read), so a caller that renders the
 * answer does not read the transcript twice. The negative arm carries none: no
 * caller renders a negative's extraction (the display arms render mid-run reports
 * from `reports.jsonl` instead), so it is not stored.
 *
 * `from` names the evidence the verdict rested on, `sidecar` or `answer`; the
 * negative arm carries none, and no caller consults `from` without a
 * `finished: true`. {@link EvidenceReader.inferredFromClause} is the display wording for
 * it — the clause only, so the two arms keep their own lead word.
 *
 * ## The memo
 *
 * Memoized on the dir plus the run id, stamped on the session file's and the
 * prompt file's size/mtime ({@link evidenceStamp}): without the memo, the display
 * path would pay a bounded 4 MB tail read plus the `system-prompt.md` read for
 * every foreign `running` record on every `status`/`result` call, serially in the
 * id loop — on the answer branch; the sidecar branch pays neither, with or
 * without the memo, because `hasExitSidecar` decides first. The sidecar check
 * runs before the memo, so a sidecar that arrives re-proves; the stamp re-proves
 * a transcript (or prompt file) that moves. No TTL: the verdict is a function of
 * the on-disk bytes the read sees, and both movers invalidate the stamp — the one
 * byte mover the stamp cannot see is an equal-size restore (the Nextcloud sync
 * restore `readSessionTail` documents): a transcript (or prompt file) restored
 * with identical size and mtime serves the cached verdict, which is the right one
 * when the bytes are in fact identical. One thing the stamp cannot see is one of
 * the run's own spawns finishing, which is also an input to the verdict now: a
 * cached `not finished` can therefore outlive the pending spawn by one transcript
 * write. That is the conservative direction (a run the reader would finish is
 * held), and the sidecar the child writes when it really does finish is checked
 * before the memo. NEGATIVES ARE STORED TOO — a `not finished` is the expensive
 * answer (it is the branch that read the transcript) and the one the display arms
 * ask for repeatedly. The map is never pruned: its entries are bounded by the
 * distinct (dir, run id) pairs ever read while sidecarless — `hasExitSidecar`
 * decides before the memo is touched, so a run whose sidecar is already on disk
 * never adds a key; keys are not removed when a run later finishes (hundreds,
 * not a growth path). It contrasts with the parent-proof memo (positives only,
 * TTL-bounded): see `createParentProof` in parent-proof.ts.
 *
 * The dir is in the key, not left to the caller's `dirFor`: `agentDir()` reads
 * `PI_CODING_AGENT_DIR` at call time, so an id whose dir moves (a restart in a
 * different agent dir, no `adoptedRunDirs` entry) must not serve a verdict
 * stamped in the other dir.
 *
 * ## Why the deps are injected
 *
 * The candidate set the pending-spawn input needs is the *whole* on-disk registry,
 * and the scan memo that set rides on belongs to `index.ts`, together with the
 * invalidation every writer there performs. So the candidate list, the sidecar
 * test, the fingerprint, the transcript read and the clock arrive as
 * {@link RunEvidenceDeps}: this module enumerates nothing and owns no scan, which
 * is also what keeps it importable standalone (no top-level work at all).
 *
 * @module subagent-herdr/run-evidence
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { RunResult } from "./lib.js";
import { completionSignal } from "./run-lifecycle.js";
import {
  EVIDENCE_TAIL_BYTES,
  type RunRecord,
  pendingSpawnsOf,
  pickSessionName,
  systemPromptPath,
} from "./rundir.js";

/**
 * A verdict about one run's on-disk completion evidence: finished and *why*
 * (with the extraction it rested on, absent when the sidecar decided), or not
 * finished yet. See this module's header for what a negative is and is not.
 */
export type CompletionEvidence =
  | { finished: true; from: "sidecar" | "answer"; result?: RunResult }
  | { finished: false };

/** Everything {@link createEvidenceReader} reads outside itself. */
export interface RunEvidenceDeps {
  /** Is the run's `.exit` sidecar on disk? The first input, and the short-circuit. */
  hasExitSidecar(runDirPath: string, runId: string): boolean;
  /** The fingerprint the memo is keyed on — {@link evidenceStamp} in production. */
  evidenceStamp(runDirPath: string, runId: string): string | undefined;
  /** The run's transcript answer, read as a bounded tail. */
  extractRunResult(dir: string, runId: string, tailBytes?: number): Promise<RunResult>;
  /**
   * Every run record on disk with the dir it was read from — the candidate set
   * of the pending-spawn input. Owned by the caller (with its scan memo); this
   * module only asks.
   */
  allRunCandidates(): readonly { rec: RunRecord; dir: string }[];
  /** The clock the pending-spawn bound is measured on. */
  now(): number;
}

/**
 * A cheap fingerprint of a run's completion evidence: its session file's and
 * its `system-prompt.md`'s size and mtime. Revival extracts a failed run's
 * transcript only when this moved, and the memoized evidence verdict re-proves
 * the same way. The prompt file is part of the verdict — it decides the
 * `<result>` contract the answer is judged against — so a rewrite of it must
 * move the fingerprint too; its absence is a stamp value, not an error, a
 * missing prompt degrades the verdict to the weaker rule, and that
 * (non)existence is part of what the verdict rests on.
 */
export function evidenceStamp(runDirPath: string, runId: string): string | undefined {
  try {
    // Shared rule with findSessionFile: a resumed dir's fingerprint must
    // move when the transcript the run is READ from moves — the oldest
    // (frozen) transcript would pin revival off forever.
    const name = pickSessionName(readdirSync(runDirPath), runId);
    if (!name) return undefined;
    const stat = statSync(join(runDirPath, name));
    let promptStamp: string;
    try {
      const prompt = statSync(systemPromptPath(runDirPath));
      promptStamp = `${prompt.size}:${prompt.mtimeMs}`;
    } catch {
      promptStamp = "absent";
    }
    return `${stat.size}:${stat.mtimeMs}\u0000${promptStamp}`;
  } catch {
    return undefined;
  }
}

/** What {@link createEvidenceReader} answers. */
export interface EvidenceReader {
  /** THE verdict — {@link completionSignal} over this module's three inputs. */
  completionEvidence(dir: string, runId: string, paneId?: string): Promise<CompletionEvidence>;
  /** The display clause naming the evidence a verdict rested on. */
  inferredFromClause(from: "sidecar" | "answer"): string;
}

/**
 * Build the evidence reader over one process's deps (see
 * {@link RunEvidenceDeps}). One instance per process, created at module scope in
 * `index.ts`: the memo is per-process state, exactly like the registry it reads.
 */
export function createEvidenceReader(deps: RunEvidenceDeps): EvidenceReader {
  /** Keyed `${dir}\u0000${runId}`; policy in this module's header. */
  const memo = new Map<string, { stamp: string | undefined; value: CompletionEvidence }>();

  /**
   * Does this run have a launch of its own that has not finished? The same third
   * input the lifecycle gets, so the evidence read and the lifecycle cannot
   * disagree about a delegating run (see `completionSignal`).
   */
  const hasPendingSpawns = (runId: string, paneId?: string): boolean =>
    pendingSpawnsOf({ runId, paneId }, deps.allRunCandidates(), deps.now()).length > 0;

  const completionEvidence = async (
    dir: string,
    runId: string,
    paneId?: string,
  ): Promise<CompletionEvidence> => {
    const sidecar = deps.hasExitSidecar(dir, runId);
    if (sidecar) return { finished: true, from: "sidecar" };
    const stamp = deps.evidenceStamp(dir, runId);
    const key = `${dir}\u0000${runId}`;
    const hit = memo.get(key);
    if (hit !== undefined && hit.stamp === stamp) return hit.value;
    const result = await deps.extractRunResult(dir, runId, EVIDENCE_TAIL_BYTES);
    // The record's own pane, passed by the caller: every call site holds the
    // record in hand, and a run missing from this process's registry is not a
    // run with no pane — the legacy `ownerPane` relation is exactly what an
    // unregistered record speaks, and dropping it would make `finished` MORE
    // likely, the direction a read must not lean.
    const hasPending = hasPendingSpawns(runId, paneId);
    const value: CompletionEvidence = completionSignal(sidecar, result, hasPending)
      ? { finished: true, from: "answer", result }
      : { finished: false };
    memo.set(key, { stamp, value });
    return value;
  };

  const inferredFromClause = (from: "sidecar" | "answer"): string =>
    from === "sidecar"
      ? "the .exit sidecar is on disk, not settled by this pane"
      : "final answer in transcript, not settled by this pane";

  return { completionEvidence, inferredFromClause };
}
