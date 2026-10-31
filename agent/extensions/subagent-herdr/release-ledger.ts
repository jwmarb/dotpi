/**
 * The release ledger: the one owner of the parent's wake policy — which
 * notices coalesce into a briefing, which finished runs a briefing carries,
 * when a health check's target is released, and what has already been
 * delivered.
 *
 * Before this module that policy lived in the extension factory's closure,
 * interleaved with the timers and the pi delivery that drive it. Here it is
 * a pure state machine:
 *
 * - **Time is passed in.** Every operation takes `now`; the ledger arms no
 *   timer and reads no clock. It returns the absolute coalesce *deadline* the
 *   caller must arm a timer for, and the caller calls {@link ReleaseLedger.flush}
 *   once that deadline is due.
 * - **Effects are injected.** Reading a record (`lifecycle`), rendering a
 *   block (`renderer`), extracting a result and spawning a health check all
 *   come in through {@link ReleaseLedgerDeps}; the ledger performs no
 *   filesystem, herdr or pi I/O itself.
 * - **It returns text, never sends it.** Delivering the briefing (as steering)
 *   stays with the factory, which owns the pi runtime.
 *
 * The invariants it owns, each pinned by `release-ledger.test.ts`:
 *
 * - **Coalescing.** A sliding window of {@link NOTICE_COALESCE_MS}: every
 *   notice re-arms the deadline, so a fan-out that finishes together wakes the
 *   orchestrator once.
 * - **Dedup.** A run delivered in a completed briefing is never rendered
 *   again; a delayed duplicate notice is swallowed. A late completion (a false
 *   failure corrected by a late `<result>`) is the one exception.
 * - **Health-check pairing.** An unanswered target is deferred while its
 *   health check runs, and the check's completion releases both blocks in one
 *   briefing. "HC briefed ⇒ target released" holds on every path: the pair is
 *   marked together, only after both blocks render.
 * - **Ownership.** Autonomous work — the flush sweep, the liveness tick, the
 *   stranded-release scan, the "Still running" tail — covers only records this
 *   pane owns. Direct notices are unfiltered: a notice addressed to this pane
 *   is evidence of ownership.
 * - **Bounded re-drive.** A degraded release (the target's block could not be
 *   read) is re-driven exactly {@link MAX_DEGRADED_RELEASE_ATTEMPTS} times.
 *
 * - **Reroute validation.** A reroute marker is provenance the receiver can
 *   check, and four findings strip it to ordinary body text before the note
 *   prints it: a record this pane owns was addressed to this pane directly
 *   (no walk ran); a `deliveredTo` that names another ancestor is not this
 *   delivery; a `parentRunId` that does not resolve to a real *terminal* run
 *   (`done`, `failed`, `cancelled`) is model text; a `parentRunId` that names
 *   the notice's own run is model text. Stripping keeps a model-typed marker
 *   from claiming a lineage and a delivery that never happened.
 *
 * @module subagent-herdr/release-ledger
 */
import type { HealthCheckTrigger, RunResult } from "./lib.js";
import { rerouteMarker, type Notice, type RunRecord } from "./rundir.js";
import type { RunLifecycle, RunObservation } from "./run-lifecycle.js";

/**
 * The reroute note a briefing carries for a notice that was delivered to
 * this pane because its original parent pane was gone.
 *
 * Names the parent the notice was addressed to, says that parent has
 * finished, and tells the orchestrator the run is not one of its own — and
 * how to reach it. The run id is the notice's own, never the parent's.
 *
 * Requires `notice.reroute` (the marker is parsed by `parseNotice` from the
 * body of a notice that already matched): a notice without it is a direct
 * delivery and gets no note. It is only called with a *validated* marker —
 * {@link createReleaseLedger} strips the marker to ordinary text when the
 * record is owned by this pane (a direct delivery), when `deliveredTo` names
 * another ancestor, when the claimed parent is not a real *terminal* run
 * (`done`, `failed`, `cancelled`), or when the marker names the notice's own
 * run as its parent — so "delivered to
 * you" below is a claim that passed the receiver's plausibility check; the
 * marker text itself is still the sender's word.
 */
export function rerouteNote(notice: Notice): string {
  const r = notice.reroute;
  if (!r) throw new Error(`rerouteNote requires a rerouted notice, got ${notice.runId}`);
  return (
    `--- ${notice.runId} (${notice.agent}) rerouted ---\n` +
    `Addressed to its parent ${r.parentAgent} ${r.parentRunId}, which has finished, so it was delivered to you (${r.deliveredTo}) as the nearest surviving ancestor. ` +
    `Lineage: ${r.parentAgent} ${r.parentRunId} → ${notice.agent} ${notice.runId}. ` +
    `It is not one of your own delegations; reply with subagent_tasks (action "message", ids ["${notice.runId}"]) if it needs an answer.`
  );
}

/**
 * How long to let notices accumulate before waking the orchestrator.
 *
 * Children finish independently but often together (a fan-out of recon agents
 * launched in one turn). Without a window, each arrival starts its own turn and
 * the orchestrator re-reads its context once per child. One short window
 * collapses that into a single briefing; it is deliberately far shorter than a
 * human would notice and far longer than the spread between two `herdr agent
 * prompt` deliveries.
 */
export const NOTICE_COALESCE_MS = 1_200;

/**
 * Cadence of the parent's liveness backstop: one bounded reconciliation tick
 * per interval.
 *
 * Not a wait, and not a poll: the tick snapshots the running records, asks
 * herdr once per record, and returns. A live child costs one status probe and
 * nothing else; a dead child is classified from its sidecar and woken through
 * the ordinary coalesced path. It exists because a notice is a prompt to look,
 * never the evidence — a lost child delivery (the child's detached
 * `sendUserMessage` dying with its process) or a restarted parent can leave a
 * record saying `running` while the child is long gone.
 */
export const LIVENESS_BACKSTOP_MS = 60_000;

/**
 * How many degraded deliveries a release gets before the pair is retired.
 *
 * A release whose target block degraded (the target's result read threw) is
 * re-driven by the liveness tick's stranded-release scan; `extractRunResult` is
 * throw-resistant but not unthrowable — OOM on a huge transcript, a permissions
 * problem — and a persistently unreadable target would otherwise produce a
 * 60-second wake storm of re-delivered health-check blocks.
 *
 * Exactly this many: the counter is incremented only when a flush actually
 * returns a degraded briefing, and the ledger serializes that increment with
 * the scan that reads it, so after the third delivery the next tick marks both
 * ids briefed (retiring both cached results) and the last degraded block — which
 * points at `subagent_tasks` — stands as the final delivery. The increment is
 * deliberately *not* in the scan: the scan only enqueues, and a notice that
 * never reaches a compose (shutdown drops the batch) must not burn the bound on
 * a release the orchestrator never saw.
 */
export const MAX_DEGRADED_RELEASE_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Record predicates (shared with the factory's query paths)
// ---------------------------------------------------------------------------

/**
 * The target run id a health-check record points at, or `undefined` when the
 * record is not a health check. A non-string `healthCheckOf` (a corrupted or
 * truncated meta.json) is treated as absent, matching `isRunRecord` in
 * rundir.ts, so it can neither trip the recursion guard nor key a bogus
 * deferral.
 */
export function healthCheckOfId(rec: RunRecord): string | undefined {
  return typeof rec.healthCheckOf === "string" ? rec.healthCheckOf : undefined;
}

/**
 * The herdr pane id that owns a record — the spawning parent's pane, stamped
 * at spawn — or `undefined` when the record is legacy (no stamp) or carries a
 * corrupted (non-string) one. A non-string `ownerPane` is treated as absent,
 * matching `isRunRecord` in rundir.ts, so ownership is loadable but not
 * sweepable: the record stays queryable, it is just never swept.
 */
export function ownerPaneOf(rec: RunRecord): string | undefined {
  return typeof rec.ownerPane === "string" ? rec.ownerPane : undefined;
}

/**
 * Whether `paneId` (this process's herdr pane) owns a record: string equality
 * only. `undefined` owns nothing — a process that does not know its own pane
 * (`HERDR_PANE_ID` unset) does not autonomously sweep any record, because it
 * cannot tell its own apart from the others'.
 */
export function isOwnedBy(rec: RunRecord, paneId: string | undefined): boolean {
  return paneId !== undefined && ownerPaneOf(rec) === paneId;
}

// ---------------------------------------------------------------------------
// Terminal result cache
// ---------------------------------------------------------------------------

/**
 * Terminal results already read, so one transcript is not read twice between a
 * liveness tick and the compose it triggers (they can be 1 MB).
 *
 * Each entry is keyed to the record's `finishedAt` as well as its id. Every
 * lifecycle transition stamps a fresh `finishedAt`, so a result cached before a
 * later one — a `failed` run revived to `done` by a late `<result>` — can never
 * be served for it: staleness is impossible by construction rather than by
 * every writer remembering to refresh.
 */
export interface TerminalResultCache {
  /** The cached result, or undefined when absent or cached for an earlier transition. */
  get(rec: RunRecord): RunResult | undefined;
  set(rec: RunRecord, result: RunResult): void;
  delete(runId: string): void;
  readonly size: number;
}

export function createTerminalResultCache(): TerminalResultCache {
  const entries = new Map<string, { finishedAt: number | undefined; result: RunResult }>();
  return {
    get(rec) {
      const e = entries.get(rec.runId);
      return e && e.finishedAt === rec.finishedAt ? e.result : undefined;
    },
    set(rec, result) {
      entries.set(rec.runId, { finishedAt: rec.finishedAt, result });
    },
    delete(runId) {
      entries.delete(runId);
    },
    get size() {
      return entries.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * A target whose release a failed compose for its health check carried.
 *
 * "Unregistered" is its own case rather than a record with a missing `agent`: a
 * target id with no registry entry (a `meta.json` that failed to parse at
 * load, or a `healthCheckOf` pointing at a run this process never registered)
 * has no record to name, and the stranded-release scan — which loops over the
 * targets *in* the registry — can never re-drive it. The bare id in the
 * briefing text is therefore the only release the orchestrator will ever get
 * for such a pair.
 */
export type ReleasedTarget =
  | { kind: "registered"; runId: string; agent: string; status: RunRecord["status"] }
  | { kind: "unregistered"; runId: string };

/** The effectful block renderers; the ledger decides *what* renders, these decide *how*. */
export interface ReleaseRenderer {
  /** One finished run's full block (header, answer, diagnostics, reports). */
  done(rec: RunRecord, result?: RunResult): Promise<string>;
  /** A released target's block when its result could not be read. */
  degraded(rec: RunRecord): Promise<string>;
  /** The minimal, I/O-free briefing used when composing the full one threw. */
  fallback(
    batch: readonly Notice[],
    swept: readonly RunRecord[],
    releasedTargets: readonly ReleasedTarget[],
  ): string;
}

/**
 * What one health-check spawn produced: `{ ok: false, error }` (refused or the
 * spawn failed), `{ ok: true, rec }` (a check was spawned or an in-flight one
 * reused), or `{ ok: true }` with no `rec` (another entrant is mid-spawn).
 */
export interface HealthCheckSpawnOutcome {
  ok: boolean;
  rec?: RunRecord;
  error?: string;
}

/** Everything the ledger touches outside itself. */
export interface ReleaseLedgerDeps {
  /** The live registry. Records are the lifecycle's: it mutates them in place. */
  records(): readonly RunRecord[];
  lifecycle: Pick<RunLifecycle, "read" | "sweep">;
  renderer: ReleaseRenderer;
  /**
   * Actually spawn the health-check run for a target. Policy-free: the
   * recursion guard, the reuse of a running check and the in-flight marker
   * are the ledger's.
   */
  spawnHealthCheck(target: RunRecord, trigger: HealthCheckTrigger): Promise<HealthCheckSpawnOutcome>;
  /** Read a run's result directly (a release target outside the current sweep). */
  extractRunResult(rec: RunRecord): Promise<RunResult>;
  /** This process's herdr pane; `undefined` owns nothing. */
  ownerPane: string | undefined;
  /**
   * The label the delivery walker stamps on the notice it delivers to this
   * process — `orchestrator` for the root, `agent runId` for a nested child —
   * or `undefined` when the process has no pane to be named. Compared against
   * a reroute marker's `deliveredTo` before the note prints it: a marker that
   * claims delivery to a *different* ancestor is not this delivery's.
   */
  selfLabel: string | undefined;
  /**
   * The parent-side half of a reroute marker's provenance: whether the
   * marker's `parentRunId` resolves (registry or disk) to a *terminal* record.
   * The `direct` and `wrongHop` checks prove the delivery; this one proves the
   * lineage — a marker survives only when its claimed parent is a real
   * *terminal* run (`done`, `failed`, `cancelled`). Ownership is deliberately not part of the test: in the canonical
   * single-hop case (R spawns A, A finishes, A's child's notice walks to R) the
   * receiver IS the parent's owner, so a foreign-ownership clause would strip
   * the feature's own target. A model-typed `parentRunId` that resolves to
   * nothing (or to a live run) strips the marker to ordinary text; the ledger
   * separately refuses a marker that names the notice's own run as its parent.
   * I/O lives here (the factory), not in the ledger, which stays free of
   * filesystem reads. The factory answers a `running` record from its pane
   * first — a pure read, so it touches none of the ownership rules — and any
   * state that is not `gone` is `false`: a live pane, in any state, is the
   * parent's own process still running, and `unreachable` says nothing about
   * the child. Only a `gone` pane (or a paneless record) is answered from
   * non-mutating completion evidence (the sidecar, or a clean transcript
   * answer). It never settles the record in either case — a foreign parent
   * the receiver never writes or closes (the scrollback is the failure
   * evidence), and an owned one whose own notice settles it through the
   * ordinary path, not this proof. The predicate is total: an evidence read
   * that throws is answered `{ finished: false, status }` from the record in
   * hand, so it can never reject the flush. The answer carries the status it
   * was read from — the record's status, or `"absent"` when nothing
   * resolves — for the ledger's log line, NOT as a memo key. The predicate's
   * own cross-flush memo (index.ts `parentProofMemo`) is keyed on the run id
   * ALONE, caches positives only, and is reached only on the `running`
   * branch: a terminal status short-circuits before the lookup. A proven
   * `true` stands (sidecar) or is re-proven past `PARENT_PROOF_TTL_MS`
   * (answer); a `false` is never stored, so a parent that finishes between
   * a pair's two notices (one 1.2 s coalesce window) is re-proven for the
   * second and keeps the note — `wake.test.ts` pins that. The ledger itself
   * memoizes nothing (see `verifiedReroute`).
   */
  parentRunIsFinished: (
    runId: string,
  ) => Promise<{ finished: boolean; status: RunRecord["status"] | "absent" }>;
}

export interface ReleaseLedger {
  /**
   * Buffer one notice into the coalesce window. Returns the new absolute
   * deadline (`now + NOTICE_COALESCE_MS`) to arm a flush for, or `undefined`
   * after shutdown.
   */
  enqueue(notice: Notice, now: number): number | undefined;
  /**
   * Compose the due batch into briefing text. `undefined` when the deadline
   * has not passed (the batch stays pending), when there is nothing to say,
   * or after shutdown. Calls are serialized.
   */
  flush(now: number): Promise<string | undefined>;
  /**
   * One liveness tick: an owned sweep plus the stranded-release scan. Returns
   * the current coalesce deadline when it enqueued a notice, or `undefined`
   * when it enqueued none (or another tick is still in flight).
   */
  tick(now: number): Promise<number | undefined>;
  /** Mark a run delivered and retire its cached result. */
  markBriefed(runId: string): void;
  /** Run ids delivered in a completed briefing. */
  readonly briefedRunIds: ReadonlySet<string>;
  /** How many terminal results are cached (every briefed-mark retires one). */
  terminalResultCount(): number;
  /** Drop the pending batch and make every later call a no-op. */
  shutdown(): void;
}

/** A briefing and the run ids its blocks covered. */
interface ComposedBriefing {
  text: string;
  /**
   * The dedup contract: exactly the runs whose blocks were delivered — never a
   * run whose block was withheld behind a health check, or its release would
   * be swallowed as a duplicate.
   */
  briefedRunIds: Set<string>;
  /**
   * Health-check ids whose target block degraded in this compose. Neither id
   * of such a pair is marked briefed, so the stranded-release scan re-drives
   * the release; the ledger counts those deliveries to bound the re-drive.
   */
  degradedRunIds: Set<string>;
}

const BRIEFING_PREFIX = "[subagent update — delivered automatically, not typed by the user]";

const doneNotice = (rec: RunRecord): Notice => ({ runId: rec.runId, agent: rec.agent, kind: "done", text: "" });

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createReleaseLedger(deps: ReleaseLedgerDeps): ReleaseLedger {
  /** Notices seen since the last flush consumed a batch. */
  let pending: Notice[] = [];
  /** Absolute time the pending batch is due; `undefined` when nothing is pending. */
  let deadline: number | undefined;
  /** Run ids already delivered in a completed briefing. */
  const briefed = new Set<string>();
  /**
   * Results already extracted for terminal runs. Only terminal results are
   * cached, an entry is dropped once its run is marked briefed, and one cached
   * before a later transition is never served. Bounded by the registry: an
   * entry outlives its briefing only for a target deferred behind a health
   * check, and that pair retires through `markBriefed` on every path (clean
   * release, degraded bound, compose failure).
   */
  const results = createTerminalResultCache();
  /**
   * Degraded-release delivery counter, keyed on the health-check run id. It is
   * cleared on every path that retires the pair — a clean release, the bound
   * burning, the compose-failure fallback, or the age-gate skip. The one
   * residual is a degraded check whose target is later briefed independently
   * of it (the spawn-failure arm briefs the target alone), which strands at
   * most one counter entry for the process lifetime.
   */
  const degradedReleaseAttempts = new Map<string, number>();
  /**
   * Synchronous in-flight marker for health-check spawns. The spawn registers
   * its record only after its own awaits (agent discovery), so two concurrent
   * entrants could both see no running check and both spawn. The marker is
   * added before any await, so the second entrant sees it and bails; it is
   * cleared in `finally`, so no path leaks it.
   */
  const healthCheckInFlight = new Set<string>();
  /** Serializes flush bodies so overlapping flushes cannot race the dedup set. */
  let flushChain: Promise<unknown> = Promise.resolve();
  let shutDown = false;
  /** Overlap guard: at most one liveness tick in flight. */
  let ticking = false;

  const isOwned = (rec: RunRecord): boolean => isOwnedBy(rec, deps.ownerPane);

  const lookup = (runId: string): RunRecord | undefined => {
    for (const r of deps.records()) if (r.runId === runId) return r;
    return undefined;
  };

  const markBriefed = (runId: string): void => {
    briefed.add(runId);
    results.delete(runId);
  };

  /**
   * The health check currently running for a target. The single definition
   * of "a check is running for this target": the spawn reuse and the deferral
   * both read through here, so the predicate cannot drift between the two.
   */
  const runningHealthCheckFor = (runId: string): RunRecord | undefined =>
    deps.records().find((r) => r.status === "running" && healthCheckOfId(r) === runId);

  /**
   * An owned health check that has gone terminal for a target and is not in
   * `exclude`. The exclude set keeps a check that already briefed from
   * satisfying the scan, so a delivered release is not re-enqueued every tick
   * and an earlier briefed check cannot shadow the one carrying the release.
   */
  const terminalHealthCheckFor = (runId: string, exclude: ReadonlySet<string>): RunRecord | undefined =>
    deps
      .records()
      .find((r) => r.status !== "running" && healthCheckOfId(r) === runId && !exclude.has(r.runId) && isOwned(r));

  /**
   * Spawns (or reuses) the health check that diagnoses a target. At most one
   * running check per target, and a health check is never health-checked.
   * Callers treat `ok` as "a check is running or about to run" and never read
   * `rec` off the in-flight collision shape.
   */
  const requestHealthCheck = async (
    target: RunRecord,
    trigger: HealthCheckTrigger,
  ): Promise<HealthCheckSpawnOutcome> => {
    if (target.agent === "healthcheck" || healthCheckOfId(target)) {
      return {
        ok: false,
        error: `Run ${target.runId} is itself a health check, so it is not health-checked again.`,
      };
    }
    const inFlight = runningHealthCheckFor(target.runId);
    if (inFlight) return { ok: true, rec: inFlight };
    if (healthCheckInFlight.has(target.runId)) return { ok: true };
    healthCheckInFlight.add(target.runId);
    try {
      return await deps.spawnHealthCheck(target, trigger);
    } finally {
      healthCheckInFlight.delete(target.runId);
    }
  };

  /**
   * The reroute marker, validated against what the receiver can know.
   *
   * The marker is model-readable text: a `report` body is model-authored and
   * crosses `parseNotice` verbatim, so a child delivering to its *live* parent
   * can type a marker of its own. Before the note prints the marker as
   * measured provenance, four findings strip it — the same four the module
   * header names:
   *
   * - the record is owned by this pane ⇒ the child addressed this pane
   *   directly (its parent is this process), so no walk ran and the marker is
   *   ordinary body text;
   * - `deliveredTo` names another ancestor ⇒ the walk delivered to that hop,
   *   not to this pane, so the marker is not this delivery's;
   * - the claimed `parentRunId` does not resolve to a real *terminal* run
   *   (`done`, `failed`, `cancelled`) ⇒ the lineage is model text, not
   *   measured provenance;
   * - the claimed `parentRunId` names the notice's own run ⇒ the lineage is
   *   model text, not measured provenance.
   *
   * Any hit strips `reroute` and reconstitutes the marker into the text
   * (`rerouteMarker`, byte-for-byte the child's own wording — the marker itself, not the whole notice) so the body keeps
   * it as ordinary text. `selfLabel` undefined (no pane) cannot be checked —
   * and such a process receives no herdr prompt in the first place.
   */
  const verifiedReroute = async (notice: Notice): Promise<Notice> => {
    if (!notice.reroute) return notice;
    const rec = lookup(notice.runId);
    const direct = rec !== undefined && isOwned(rec);
    const wrongHop =
      deps.selfLabel !== undefined && notice.reroute.deliveredTo !== deps.selfLabel;
    const parentRunId = notice.reroute.parentRunId;
    // Each notice that reaches the lineage test pays its own predicate call
    // (the ledger keeps no memo of its own, and the caller skips validation
    // for an already-noted run, and the self-parent strip short-circuits
    // before the call). A per-batch map here would add nothing: the
    // expensive half — the pane probe and the evidence read — is bounded by
    // the predicate's own cross-flush memo (index.ts `parentProofMemo`),
    // keyed on the run id alone, reached only on the `running` branch, and
    // caching positives only: a proven `true` stands (sidecar) or is
    // re-proven past `PARENT_PROOF_TTL_MS` (answer), and a `false` is never
    // stored, so a parent that finishes between the pair's two notices (one
    // 1.2 s coalesce window) is re-proven for the second and keeps the note.
    // What the transition tests pin is the ledger's own no-memo, against a
    // memo-free stub.
    // The one parent lookup the ledger performs, run only for a marker the
    // delivery checks did not already strip: a marker about to be stripped
    // must not pay a parent read. The predicate is total (it answers from
    // the record in hand when its evidence read throws), so it can never
    // reject the flush.
    const noLineage =
      direct || wrongHop
        ? false
        : parentRunId === notice.runId ||
          !(await deps.parentRunIsFinished(parentRunId)).finished;
    if (!direct && !wrongHop && !noLineage) return notice;
    const r = notice.reroute;
    return {
      ...notice,
      text: notice.text ? `${rerouteMarker(r)} ${notice.text}` : rerouteMarker(r),
      reroute: undefined,
    };
  };

  /**
   * The briefing a batch of notices plus a sweep becomes.
   *
   * A `done` notice inlines the child's answer. A `report` is reconciled
   * first: if the child has finished by flush time it renders as a full
   * result block rather than a stale "still working" line. A `stalled` notice
   * is consumed — the health check that spawns from it is what briefs — and
   * only a check that cannot launch leaves a block behind.
   *
   * Deferral is derived from the registry, not a persistent set: a target is
   * deferred iff a health-check record for it is running. The release rides
   * the check's own done notice (enqueued by the tick when it finds the check
   * terminal, and by the `cancel` action), so when a terminal check renders
   * here its target's block joins this same briefing — unless the target
   * already briefed.
   */
  const compose = async (batch: readonly Notice[], swept: readonly RunObservation[]): Promise<ComposedBriefing> => {
    const blocks: string[] = [];
    const composedBriefed = new Set<string>();
    const degraded = new Set<string>();
    const alreadyBriefed = (runId: string): boolean => composedBriefed.has(runId) || briefed.has(runId);

    const renderFinished = async (observation: RunObservation): Promise<void> => {
      const rec = observation.run;
      if (alreadyBriefed(rec.runId)) return;
      /** This run's result: cached, or read once through its observation. */
      const resultOfRun = async (): Promise<RunResult> => {
        // A run that transitioned in this observation (a late completion, say)
        // has fresher evidence than anything cached before it.
        const cached = observation.transition ? undefined : results.get(rec);
        if (cached) return cached;
        const result = await observation.result();
        // Only terminal results are cached: a running record's answer may still change.
        if (rec.status !== "running") results.set(rec, result);
        return result;
      };

      const targetId = healthCheckOfId(rec);
      if (targetId) {
        // A terminal health check releases its target unconditionally — not
        // gated on a deferral set — so a cancelled check releases the same way
        // a completed one does, and a check without an answer spawns nothing.
        const target = lookup(targetId);
        let targetBlock: string | undefined;
        let targetDegraded = false;
        if (target !== undefined && !alreadyBriefed(target.runId) && target.status !== "running") {
          try {
            // A release target is not necessarily part of this sweep, so it
            // falls back to its own direct read when nothing is cached.
            const targetResult = results.get(target) ?? (await deps.extractRunResult(target));
            targetBlock = await deps.renderer.done(target, targetResult);
          } catch {
            // Degraded, not dropped: the check's block is still delivered, and
            // neither id is marked, so the scan re-drives the release.
            targetBlock = await deps.renderer.degraded(target);
            targetDegraded = true;
            degraded.add(rec.runId);
          }
        }
        // Atomic mark: both blocks are rendered before either id is marked,
        // and the pair is marked together, so "check briefed" implies "target
        // released". A degraded target block marks neither.
        blocks.push(await deps.renderer.done(rec, await resultOfRun()));
        if (targetBlock !== undefined) blocks.push(targetBlock);
        if (!targetDegraded) {
          composedBriefed.add(rec.runId);
          if (targetBlock !== undefined && target !== undefined) composedBriefed.add(target.runId);
        }
        return;
      }

      const result = await resultOfRun();
      // An answered run renders; so does a cancelled one — it was deliberately
      // killed, so there is nothing for a health check to diagnose.
      if (result.answered || rec.status === "cancelled") {
        blocks.push(await deps.renderer.done(rec, result));
        composedBriefed.add(rec.runId);
        return;
      }
      // No answer: hold the block behind a health check. One that cannot
      // launch must not hold it — render it now. A *terminal* earlier check
      // does not block the spawn: the stall and no-answer triggers ask
      // different questions.
      const hc = await requestHealthCheck(rec, { kind: "ended-without-result" });
      if (hc.ok) return;
      blocks.push(await deps.renderer.done(rec, result));
      composedBriefed.add(rec.runId);
    };

    // One reroute note per run per flush: a pair of notices for the same
    // re-routed run (report + done) briefs the situation once.

    const noted = new Set<string>();
    const noteReroute = (notice: Notice, before: number): void => {
      if (notice.reroute && blocks.length > before && !noted.has(notice.runId)) {
        noted.add(notice.runId);
        blocks.splice(before, 0, rerouteNote(notice));
      }
    };

    for (const raw of batch) {
      // An already-noted run skips validation for its second notice: its note
      // is suppressed for the block below (one per run per flush), so the
      // marker a strip would have served never prints, and the parent read it
      // would cost is discarded with the note.
      const notice = noted.has(raw.runId) ? raw : await verifiedReroute(raw);
      const before = blocks.length;
      const rec = lookup(notice.runId);
      if (!rec) {
        if (notice.reroute) {
          // A re-routed notice for a run this process never spawned: the note
          // is the whole briefing for it — it says where the run lives and how
          // to reach it, which the restart text cannot. The body rides with it
          // when there is one: a rerouted report whose meta is unreadable and
          // run dir gone is the only information available, and a note that
          // swallows it loses it. One note per run per flush, like the
          // registered path.
          if (noted.has(notice.runId)) {
            // Second notice for the same re-routed run in one flush: the note
            // is suppressed (one per run per flush, like the registered path),
            // but the notice itself is not — a report + done pair must not lose
            // the completion.
            blocks.push(
              `--- ${notice.runId} (${notice.agent}) ${notice.kind} ---\n${
                notice.text || "(no message)"
              }`,
            );
            continue;
          }
          noted.add(notice.runId);
          blocks.push(rerouteNote(notice) + (notice.text ? `\n\n${notice.text}` : ""));
          continue;
        }
        // A notice for a run this process never registered (the parent
        // restarted and the meta file was lost). Still worth surfacing.
        blocks.push(
          `--- ${notice.runId} (${notice.agent}) ${notice.kind} ---\n${
            notice.text || "(no message)"
          }\n(This task is not in my registry — it may predate a restart.)`,
        );
        continue;
      }
      // Read before deciding: a report notice may have arrived while the child
      // was still working, but by flush time the child may have finished.
      const observation = await deps.lifecycle.read(rec);
      if (rec.status === "running") {
        if (notice.kind === "stalled") {
          // A marker stripped above rides back into `notice.text` as ordinary
          // body text, and this detail is what the health check's task quotes:
          // deliberate. The strip only downgrades the *note's* provenance
          // claim; it does not delete the child's own wording, and the
          // diagnosis should see what the child actually sent.
          const hc = await requestHealthCheck(rec, { kind: "stalled", detail: notice.text });
          if (!hc.ok) {
            blocks.push(
              `--- ${rec.runId} (${rec.agent}) stalled ---\n${notice.text || "(no detail)"}\n` +
                `The automatic health check could not launch: ${hc.error}. ` +
                `Look at it with subagent_tasks (action "result", ids ["${rec.runId}"]), or interrupt/cancel it.`,
            );
          }
          // A rerouted stall that launches its health check adds no block at
          // all — and no note, no wake: nothing is pending for it here.
          noteReroute(notice, before);
          continue;
        }
        blocks.push(
          `--- ${rec.runId} (${notice.agent}) ${notice.kind === "report" ? "sent a mid-run report" : "sent a notice"} ---\n${notice.text || "(no message)"}\n` +
            `It is still working. Reply with subagent_tasks (action "message", ids ["${rec.runId}"]) if it needs an answer or a correction.`,
        );
        noteReroute(notice, before);
        continue;
      }
      await renderFinished(observation);
      noteReroute(notice, before);
    }
    for (const observation of swept) await renderFinished(observation);

    // Ownership bounds the tail: a foreign session's running children are not
    // this orchestrator's to report on.
    const stillRunning = deps.records().filter((r) => r.status === "running" && isOwned(r));
    const tail =
      stillRunning.length > 0
        ? `\n\nStill running: ${stillRunning
            .map((r) => `${r.runId} (${r.agent})`)
            .join(", ")}. Do not wait or poll for them — carry on with what you can do now, then end your turn; they will wake you the same way.`
        : "\n\nNo subagent tasks are still running.";
    const text = blocks.length > 0 ? `${BRIEFING_PREFIX}\n\n${blocks.join("\n\n")}${tail}` : "";
    return { text, briefedRunIds: composedBriefed, degradedRunIds: degraded };
  };

  /**
   * The fallback when composing threw (it reads run dirs and probes herdr).
   * The orchestrator must still be told something, so the batch and sweep are
   * marked delivered and named by id.
   *
   * A terminal health check carries its target's release here too: the target
   * is marked with it ("HC briefed ⇒ target released") and named in the text,
   * because it is neither a fresh notice nor a swept record. Only *terminal*
   * checks release, and a running target is never marked — its own done
   * notice will carry its real block. An unregistered target is named by its
   * bare id: there is no record to mark, and the scan could never re-drive it.
   */
  const fallbackAfterComposeFailure = (fresh: readonly Notice[], swept: readonly RunObservation[]): string => {
    const releasedTargets: ReleasedTarget[] = [];
    const releaseTargetOf = (check: RunRecord): void => {
      const targetId = healthCheckOfId(check);
      if (!targetId) return;
      // The pair retires on every path that reaches here, including the
      // running-target return below, so the counter is cleared unconditionally.
      degradedReleaseAttempts.delete(check.runId);
      const target = lookup(targetId);
      if (!target) {
        releasedTargets.push({ kind: "unregistered", runId: targetId });
        return;
      }
      if (target.status === "running") return;
      markBriefed(target.runId);
      releasedTargets.push({ kind: "registered", runId: target.runId, agent: target.agent, status: target.status });
    };
    for (const n of fresh) {
      const rec = lookup(n.runId);
      if (!rec || rec.status === "running") continue;
      markBriefed(rec.runId);
      releaseTargetOf(rec);
    }
    for (const { run } of swept) {
      // Swept records are terminal by construction.
      markBriefed(run.runId);
      releaseTargetOf(run);
    }
    return deps.renderer.fallback(
      fresh,
      swept.map((o) => o.run),
      releasedTargets,
    );
  };

  const flushBatch = async (batch: readonly Notice[]): Promise<string | undefined> => {
    if (shutDown) return undefined;
    // Suppress delayed duplicate notices for runs already briefed.
    const fresh = batch.filter((n) => {
      const rec = lookup(n.runId);
      return !(rec && rec.status !== "running" && briefed.has(n.runId));
    });
    if (fresh.length === 0) return undefined;

    // Fold in other owned runs that finished since the last wake: the
    // registry is global, and a foreign run's finished state is its owner's.
    const swept: RunObservation[] = [];
    try {
      const exclude = new Set([...fresh.map((n) => n.runId), ...briefed]);
      const sweep = await deps.lifecycle.sweep(deps.records().filter(isOwned), { exclude });
      swept.push(...sweep.finished);
    } catch {
      // Best effort: the notice-driven briefing still goes out.
    }

    let composed: ComposedBriefing;
    try {
      composed = await compose(fresh, swept);
    } catch {
      const text = fallbackAfterComposeFailure(fresh, swept);
      return shutDown ? undefined : text;
    }

    for (const id of composed.briefedRunIds) {
      markBriefed(id);
      // A pair that delivered cleanly no longer needs its retry counter.
      degradedReleaseAttempts.delete(id);
    }
    // Every notice was consumed (each stall spawned its health check) and the
    // sweep found nothing: there is no briefing, and "" would wake for nothing.
    if (!composed.text || shutDown) return undefined;
    // Count only degraded releases this flush actually returns for delivery.
    for (const id of composed.degradedRunIds) {
      degradedReleaseAttempts.set(id, (degradedReleaseAttempts.get(id) ?? 0) + 1);
    }
    return composed.text;
  };

  const enqueue = (notice: Notice, now: number): number | undefined => {
    if (shutDown) return undefined;
    pending.push(notice);
    // Sliding, and never backwards: a tick that started before a direct
    // notice arrived must not pull the window in under it.
    deadline = Math.max(deadline ?? Number.NEGATIVE_INFINITY, now + NOTICE_COALESCE_MS);
    return deadline;
  };

  const flush = (now: number): Promise<string | undefined> => {
    if (shutDown || deadline === undefined || now < deadline) return Promise.resolve(undefined);
    const batch = pending;
    pending = [];
    deadline = undefined;
    const body = flushChain.then(() => flushBatch(batch));
    flushChain = body.catch(() => {});
    return body;
  };

  /**
   * One liveness tick: a single bounded reconciliation sweep of owned records,
   * then the stranded-release scan.
   *
   * For every record the sweep finished it enqueues the done notice the
   * child's own delivery was supposed to carry: a health check always (its
   * completion releases its target), an answered run always, and an
   * unanswered ordinary run only when its health check cannot launch.
   *
   * The scan re-enqueues a lost release — the done notice of a terminal check
   * whose terminal, unbriefed target never got its block — gated by age (a
   * check terminal for longer than `6 * LIVENESS_BACKSTOP_MS` is not
   * re-driven: after a restart the dedup set is empty, and every historical
   * pair would otherwise re-brief) and by {@link MAX_DEGRADED_RELEASE_ATTEMPTS}.
   */
  const tickBody = async (now: number): Promise<number | undefined> => {
    if (ticking || shutDown) return undefined;
    ticking = true;
    let enqueuedAny = false;
    const enqueueFromTick = (notice: Notice): void => {
      if (enqueue(notice, now) !== undefined) enqueuedAny = true;
    };
    try {
      // The exclude set is the dedup set restricted to running records: a
      // terminal briefed record must stay a revival candidate, because a late
      // answer is exactly what corrects an already-delivered false failure.
      const owned = deps.records().filter(isOwned);
      const exclude = new Set(owned.filter((r) => r.status === "running" && briefed.has(r.runId)).map((r) => r.runId));
      const sweep = await deps.lifecycle.sweep(owned, { exclude });
      for (const t of sweep.transitions) {
        // Let the late answer correct an already-delivered false failure.
        if (t.cause === "late-completion") briefed.delete(t.run.runId);
      }
      // Releases the finished loop enqueued this tick: the flush is still
      // ~1200 ms away, so without this set the scan below would enqueue the
      // same release twice (and a degraded pair, marking neither id, would
      // render twice).
      const enqueuedThisTick = new Set<string>();
      for (const observation of sweep.finished) {
        const rec = observation.run;
        try {
          if (healthCheckOfId(rec)) {
            enqueueFromTick(doneNotice(rec));
            enqueuedThisTick.add(rec.runId);
            continue;
          }
          const result = await observation.result();
          // The compose that this notice triggers reuses it instead of re-reading.
          results.set(rec, result);
          if (result.answered) {
            enqueueFromTick(doneNotice(rec));
            enqueuedThisTick.add(rec.runId);
            continue;
          }
          const hc = await requestHealthCheck(rec, { kind: "ended-without-result" });
          // On success the run is deferred: the check's completion is the wake.
          if (!hc.ok) {
            enqueueFromTick(doneNotice(rec));
            enqueuedThisTick.add(rec.runId);
          }
        } catch {
          // One bad record: the next tick retries.
        }
      }

      const releaseExcludes = new Set<string>([...briefed, ...enqueuedThisTick]);
      for (const target of [...deps.records()]) {
        if (!isOwned(target) || target.status === "running" || healthCheckOfId(target)) continue;
        if (briefed.has(target.runId)) continue;
        const check = terminalHealthCheckFor(target.runId, releaseExcludes);
        if (!check) continue;
        // A record with neither timestamp fails OPEN here (NaN compares
        // false) by deliberate choice: re-driving a malformed record's release
        // is cheaper than leaving it stranded forever.
        if (now - (check.finishedAt ?? check.startedAt) > 6 * LIVENESS_BACKSTOP_MS) {
          // The pair retires without a briefed mark; its counter retires with it.
          degradedReleaseAttempts.delete(check.runId);
          continue;
        }
        if ((degradedReleaseAttempts.get(check.runId) ?? 0) >= MAX_DEGRADED_RELEASE_ATTEMPTS) {
          // The bound is burned: the last degraded block stands as the final
          // delivery, and both ids retire (with their cached results).
          markBriefed(check.runId);
          markBriefed(target.runId);
          degradedReleaseAttempts.delete(check.runId);
          continue;
        }
        enqueueFromTick(doneNotice(check));
      }
    } finally {
      ticking = false;
    }
    // The *current* deadline, not the one this tick's last enqueue produced: a
    // direct notice that arrived during the tick's awaits slid it later, and
    // re-arming the earlier one would fire a flush before the batch is due.
    return enqueuedAny && !shutDown ? deadline : undefined;
  };

  /**
   * {@link tickBody} behind a guarantee: whatever this tick enqueued gets its
   * deadline back to the caller even if a later step throws. Without it, a
   * throw after the first enqueue would strand that batch until some unrelated
   * notice arrived — a timer that fired mid-tick saw a deadline the tick had
   * already pushed later, and returned without consuming.
   */
  const tick = async (now: number): Promise<number | undefined> => {
    try {
      return await tickBody(now);
    } catch {
      return pending.length > 0 && !shutDown ? deadline : undefined;
    }
  };

  return {
    enqueue,
    flush,
    tick,
    markBriefed,
    briefedRunIds: briefed,
    terminalResultCount: () => results.size,
    shutdown: () => {
      shutDown = true;
      pending = [];
      deadline = undefined;
    },
  };
}
