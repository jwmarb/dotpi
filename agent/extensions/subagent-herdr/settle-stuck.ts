/**
 * Settling records that are `running` on disk only because nobody ever wrote
 * their final state.
 *
 * A nested child writes its `.exit` sidecar and closes its own pane; the record
 * is then provably finished, and the only thing that turns the disk's `running`
 * into `done` is a liveness sweep by the process that owns the record's pane.
 * For a run whose owner is gone — the ~95 records this module was written for —
 * that sweep never comes: the child is not in the registry of any live process
 * that would sweep it, and its pane belongs to a session that no longer exists.
 *
 * **Sidecar-only, and never `failed`.** The sidecar is written by the child
 * itself, so it is the one piece of evidence about a run that does not depend on
 * a third party getting round to look (`AGENTS.md`: the sidecar *is* the done
 * classification). Nothing here infers completion from silence, from a dead
 * pane, or from elapsed time, because every such rule eventually writes `failed`
 * over an answer that exists — and a `failed` run tells its orchestrator to
 * re-delegate work that was already delivered. So: a record is settled only
 * when a sidecar says so, its `finishedAt` is the sidecar's own `at` rather than
 * the moment somebody noticed, and **no pane is ever closed** — a pane id can be
 * reused, and destroying scrollback is not cleanup.
 *
 * `run-lifecycle.ts` stays the sole writer of `status`/`finishedAt`: every change
 * here goes through the settle path it exports, so transition legality and the
 * `saveMeta` that follows a transition are spelled in one place.
 *
 * Pi-free: the clock, the filesystem, the pane probe and the settle are effects.
 */
import type { AgentProbe } from "./herdr.js";
import { LIVENESS_BACKSTOP_MS, ownerPaneOf } from "./release-ledger.js";
import type { LifecycleTransition, RunLifecycle } from "./run-lifecycle.js";
import { isRunStatus, type RunRecord } from "./rundir.js";

/**
 * How long a sidecar must have sat beside a `running` record before the one-time
 * pass treats the record as abandoned.
 *
 * A live owner settles a sidecar'd record of its own on its next liveness tick —
 * at most {@link LIVENESS_BACKSTOP_MS} — and that settlement is the one that
 * matters, because it is the one that briefs. Settling the disk copy first would
 * take that write from an owner that is about to make it (`index.ts`: "settling is
 * a write, and the write is the owner's"). Six ticks with no settlement is an
 * owner that is not coming: the same horizon the ledger's stranded-release scan
 * uses before it stops re-driving a pair.
 */
export const STUCK_SIDECAR_MIN_AGE_MS = 6 * LIVENESS_BACKSTOP_MS;

/** A candidate record and the run directory it was read from. */
export type Candidate = { rec: RunRecord; dir: string };

/** What the two operations below need from the outside world. */
export interface SettleDeps {
  lifecycle: Pick<RunLifecycle, "settleFromSidecar">;
  /**
   * When did this run's child write its sidecar? `undefined` for no sidecar, an
   * unreadable one, or one whose `at` is not a finite number — all three mean
   * "does not prove anything", which is the answer a settlement needs.
   */
  sidecarAt(dir: string, runId: string): number | undefined;
  /**
   * The record to mutate: the registry's live copy when this process has one, so
   * memory and disk cannot diverge. A candidate from a scan is a *copy* of a
   * record that may also sit in `runs`; settling only the copy would leave the
   * registry saying `running` and its next `saveMeta` would undo this write.
   */
  resolve?(rec: RunRecord): RunRecord;
  /**
   * Leave this record alone? True for a record whose settlement belongs to a
   * sweep that will brief it — the caller's own records — so a settlement here
   * cannot finish one silently.
   */
  skip?(rec: RunRecord): boolean;
}

/** What {@link settleStuckRecords} needs beyond {@link SettleDeps}. */
export interface StuckSettleDeps extends SettleDeps {
  /**
   * Settle only records whose sidecar `at` is no later than this. The caller
   * passes `now - STUCK_SIDECAR_MIN_AGE_MS`; a test passes what it needs.
   */
  abandonedBefore: number;
}

/**
 * Settle every candidate a sidecar proves finished and whose owner has had time
 * to settle it and did not — the one-time cleanup of the records a dead owner
 * left behind. Idempotent by construction: a settled record is no longer
 * `running`, so the next pass finds nothing to do, which is why running it on
 * every root start *is* the migration.
 */
export async function settleStuckRecords(
  candidates: readonly Candidate[],
  deps: StuckSettleDeps,
): Promise<LifecycleTransition[]> {
  const settled: LifecycleTransition[] = [];
  for (const { rec, dir } of candidates) {
    if (rec.status !== "running") continue;
    const at = deps.sidecarAt(dir, rec.runId);
    if (at === undefined || at > deps.abandonedBefore) continue;
    if (deps.skip?.(rec)) continue;
    const t = await deps.lifecycle.settleFromSidecar(deps.resolve?.(rec) ?? rec, at);
    if (t) settled.push(t);
  }
  return settled;
}

/** The inputs {@link isOrphanSettleable} judges; each is a fact, not an inference. */
export interface OrphanSettleEvidence {
  /** The parent record, resolved through `parentRunId`. `undefined` = unknown. */
  parent: RunRecord | undefined;
  /**
   * Probe of the pane that owns the record. Only `{ kind: "gone" }` — herdr
   * answering `agent_not_found` — says the owner is dead; `unreachable` means
   * herdr could not be asked, which is not evidence about anyone.
   */
  ownerPaneProbe: AgentProbe;
  /** Is the record's own `.exit` sidecar on disk? */
  hasSidecar: boolean;
}

/**
 * Can this record be settled by a process that does not own it?
 *
 * Every condition is load-bearing, and together they are deliberately narrower
 * than the one-time pass above: this predicate runs on a live interval, where a
 * wrong yes writes over a run another process is still driving.
 *
 * - `rec.status === "running"` — a terminal record needs no help, and rewriting
 *   one would clobber the `finishedAt` its owner already chose.
 * - **a sidecar exists** — the only proof of completion. Everything else is a
 *   guess about a process rather than a fact about a run.
 * - **its parent is terminal** — while the parent runs, the parent's own sweep
 *   settles the record, and the parent is the one process that must not lose the
 *   wake this settlement would imply. A parent this process cannot resolve is
 *   *unknown*, not *gone*, so it does not qualify either.
 * - **the owner pane is `gone`** — `agent_not_found` only. `unreachable` (herdr
 *   not answering, a malformed reply) leaves the owner possibly alive, and a
 *   possibly-alive owner gets settled by itself.
 */
export function isOrphanSettleable(rec: RunRecord, evidence: OrphanSettleEvidence): boolean {
  if (rec.status !== "running") return false;
  if (!evidence.hasSidecar) return false;
  const { parent, ownerPaneProbe } = evidence;
  // A parent whose status is not one of ours is *unknown*, not *gone*: a
  // corrupted status string from the world-writable dir must not prove
  // anything is finished, so it disqualifies, like an unresolvable parent.
  if (parent === undefined || !isRunStatus(parent.status) || parent.status === "running") return false;
  return ownerPaneProbe.kind === "gone";
}

/** What {@link settleOrphans} needs beyond {@link SettleDeps}. */
export interface OrphanSettleDeps extends SettleDeps {
  /** Resolve a `parentRunId` to its record, or `undefined` when it cannot be found. */
  findParent(rec: RunRecord): RunRecord | undefined;
  /** Ask herdr about one pane. At most once per distinct pane per call. */
  probeOwnerPane(paneId: string): Promise<AgentProbe>;
  /** Is this run's `.exit` sidecar on disk? */
  hasSidecar(dir: string, runId: string): boolean;
}

/**
 * Settle the orphans among `candidates`: finished, ownerless records that no
 * live process will ever sweep. See {@link isOrphanSettleable} for the rule; the
 * ordering below is only about cost — every disk check (status, sidecar, parent)
 * comes before the one herdr round-trip, and one pane is probed at most once per
 * pass however many of its records are under examination.
 *
 * Candidates a caller has already put in a registry are still eligible: the
 * registry is shared with the whole runs dir, and `running` in it only means
 * some process read the record once.
 */
export async function settleOrphans(
  candidates: readonly Candidate[],
  deps: OrphanSettleDeps,
): Promise<LifecycleTransition[]> {
  const settled: LifecycleTransition[] = [];
  const probes = new Map<string, Promise<AgentProbe>>();
  for (const { rec, dir } of candidates) {
    if (rec.status !== "running") continue;
    if (!deps.hasSidecar(dir, rec.runId)) continue;
    if (deps.skip?.(rec)) continue;
    const ownerPane = ownerPaneOf(rec);
    if (!ownerPane) continue;
    // The parent is a disk read and the probe is a herdr round-trip, so a record
    // whose parent rules it out never costs a probe.
    const parent = deps.findParent(rec);
    if (parent === undefined || !isRunStatus(parent.status) || parent.status === "running") continue;
    let probe = probes.get(ownerPane);
    if (probe === undefined) {
      probe = deps.probeOwnerPane(ownerPane);
      probes.set(ownerPane, probe);
    }
    const ownerPaneProbe = await probe;
    if (!isOrphanSettleable(rec, { parent, ownerPaneProbe, hasSidecar: true })) continue;
    const at = deps.sidecarAt(dir, rec.runId);
    if (at === undefined) continue;
    const t = await deps.lifecycle.settleFromSidecar(deps.resolve?.(rec) ?? rec, at);
    if (t) settled.push(t);
  }
  return settled;
}
