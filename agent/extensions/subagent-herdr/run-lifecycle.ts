/**
 * The run lifecycle: the one owner of completion evidence and of every legal
 * `RunRecord` terminal transition.
 *
 * Before this module the decision "has this run finished, and how?" was made
 * in four places — `reconcile`, `finishRun`, the liveness tick's hand-written
 * revival loop, and the `cancel` arm — each mutating `status`/`finishedAt` on
 * its own. Here it is made once:
 *
 * - **One completion predicate** ({@link RunLifecycle} internals, `completed`):
 *   the `.exit` sidecar, or a *clean* transcript answer (`answered` and no
 *   `salvagedFrom`). A salvage proves the child produced text, not that it
 *   stopped, and herdr's `done` pane state is readiness ("ready for input"),
 *   never termination.
 * - **One writer** of `status`, `finishedAt` and `failedAttempts`.
 * - **One transition table:** `running → done | failed | cancelled`, and
 *   `failed → done` (late completion) only for a run that actually launched —
 *   a launch failure (`failedAttempts` present) never revives.
 * - **Per-run serialization:** every operation on one run id queues behind the
 *   previous one, so a concurrent read and cancel produce exactly one
 *   transition.
 *
 * - **An in-flight launch is not evidence.** A record this process is still
 *   launching (registered, no pane attached yet) is observed as `launching`
 *   and never classified; only a paneless record *not* in flight — one left
 *   by a crash mid-spawn — settles as `no-pane`.
 *
 * It never polls and never waits for a run to finish: a read is one pane probe
 * plus, only when the pane is gone or absent, a short bounded settle (two
 * {@link SETTLE_DELAY_MS} re-reads) for the sidecar write that races herdr's
 * detection of the exit.
 *
 * Pi-free by construction (every effect is injected), so the whole state
 * machine is tested against an in-memory stub.
 *
 * @module subagent-herdr/run-lifecycle
 */
import type { AgentProbe } from "./herdr.js";
import type { RunResult } from "./lib.js";
import type { FailedAttempt, RunRecord, RunStatus } from "./rundir.js";
import { REVIVAL_WINDOW_MS } from "./rundir.js";

export { REVIVAL_WINDOW_MS };

/** Patience between settle re-reads of a gone/absent pane's evidence. */
export const SETTLE_DELAY_MS = 750;

/** Settle re-reads after the first extraction, when a session exists but no signal does. */
const SETTLE_RETRIES = 2;


/** At most this many records are reconciled at once by a sweep. */
const SWEEP_CONCURRENCY = 8;

/** Everything the lifecycle touches outside itself. */
export interface RunLifecycleEffects {
  /** One three-way pane probe (never throws in production). */
  probe(paneId: string): Promise<AgentProbe>;
  /** Close a pane; best-effort. */
  close(paneId: string): Promise<boolean>;
  /** Read the run's transcript answer. */
  extract(runDir: string, runId: string): Promise<RunResult>;
  /** Is the run's `.exit` sidecar on disk? */
  hasSidecar(runDir: string, runId: string): boolean;
  /**
   * A cheap fingerprint of the run's completion evidence — the session
   * file's and the prompt file's size/mtime (`undefined` when there is none
   * to fingerprint). Revival extracts only when it changed.
   */
  evidenceStamp(runDir: string, runId: string): string | undefined;
  /** Persist the record; best-effort (today's contract). */
  saveMeta(rec: RunRecord): void;
  runDirOf(runId: string): string;
  now(): number;
  delay(ms: number): Promise<void>;
  /**
   * Is this process still launching the run (registered, pane not yet
   * attached)? Process-local and never persisted, so a record recovered after
   * a crash mid-spawn is not in flight and still settles as `no-pane`.
   */
  isLaunching(runId: string): boolean;
  /**
   * Does this run have launches of its own that have not finished?
   *
   * The third input to {@link completionSignal} — the pending-spawn predicate
   * over the *whole* on-disk registry, which is why it is an effect and not
   * something this module can read: the lifecycle knows one run dir at a time,
   * and the answer needs every run dir under both of this process's bases.
   * Absent means "no", which is every behaviour this module had before the
   * predicate gained the input.
   */
  hasPendingSpawns?(rec: RunRecord): boolean;
}

/**
 * What a read learned about the pane: `none` when there was no pane to probe or
 * no probe was needed, `launching` when the spawn has not attached one yet.
 */
export type PaneObservation = AgentProbe | { kind: "none" } | { kind: "launching" };

/** Why a transition happened. */
export type LifecycleCause =
  | "launch-failure"
  | "completion-signal"
  | "pane-gone"
  | "no-pane"
  | "cancelled"
  | "late-completion"
  | "sidecar-settle";

/**
 * THE completion predicate, as a pure rule over what the caller already has:
 * whether the `.exit` sidecar is on disk, and the transcript extraction.
 * Dir-free on purpose — the lifecycle applies it through its own effects
 * (whose `runDirOf` knows this process's bases), while the factory's reroute
 * evidence read (`parentRunIsFinished`) consumes the same rule with a dir it
 * resolved from {@link runDirBases}-style bases the lifecycle does not know.
 * A salvage (`answered` with a `salvagedFrom`) is deliberately not a signal:
 * it proves the child produced text, not that it stopped.
 *
 * `hasPendingSpawns` is the third input, and it is the reason a *clean* answer is
 * no longer enough on its own: a delegating child follows its own agent's
 * instruction to launch its graders, write a `<result>` saying the pass is
 * pending, and end its turn to be woken by them. That waiting turn's answer is
 * clean by every rule above, and the old two-input predicate read it as the run
 * being finished — settling the worker and closing its pane while the verdicts it
 * was waiting for were still unwritten. A run with unfinished spawns of its own
 * (`rundir.ts`'s `pendingSpawnsOf` — no sidecar, and a status that is not
 * terminal) is therefore not finished, however well its last turn ended.
 *
 * The sidecar still wins outright: a child that wrote one *did* finish, whatever
 * its spawns look like, and it is the child's own write that settles the question
 * (the anti-pattern that the sidecar *is* the done classification).
 *
 * Injected by the caller rather than computed here, so this module stays pi-free
 * and disk-free about the rest of the registry: only the factory can enumerate
 * every run dir.
 */
export function completionSignal(
  hasSidecar: boolean,
  result: RunResult,
  hasPendingSpawns = false,
): boolean {
  return (
    hasSidecar ||
    (result.answered && result.salvagedFrom === undefined && !hasPendingSpawns)
  );
}

export interface LifecycleTransition {
  run: RunRecord;
  from: RunStatus;
  to: RunStatus;
  cause: LifecycleCause;
  at: number;
}

export interface RunObservation {
  run: RunRecord;
  pane: PaneObservation;
  /** Present only when this operation changed the run's status. */
  transition?: LifecycleTransition;
  /**
   * The run's result, extracted at most once per observation: seeded with the
   * extraction reconciliation already did, otherwise read lazily.
   */
  result(): Promise<RunResult>;
}

export interface SweepResult {
  /** Every transition the sweep made, in input order. */
  transitions: LifecycleTransition[];
  /** The observations of runs that transitioned, in input order. */
  finished: RunObservation[];
}

export interface RunLifecycle {
  /** Bring one record up to date: at most one probe, never a wait for completion. */
  read(rec: RunRecord): Promise<RunObservation>;
  /**
   * Reconcile running records and examine revival candidates, in input order,
   * {@link SWEEP_CONCURRENCY} at a time; one bad record never aborts the sweep.
   * `exclude` suppresses both.
   */
  sweep(recs: readonly RunRecord[], opts?: { exclude?: ReadonlySet<string> }): Promise<SweepResult>;
  /** Record a launch that never started; throws on a non-running record. */
  launchFailed(
    rec: RunRecord,
    attempt: FailedAttempt,
    pane?: { paneId: string; tabId?: string },
  ): LifecycleTransition;
  /** Cancel a running record: persist first, then close its pane best-effort. */
  cancel(rec: RunRecord): Promise<RunObservation>;
  /**
   * Settle a `running` record as `done` on the strength of its `.exit` sidecar
   * alone, stamping `finishedAt` with the sidecar's own `at`. Persists; **never
   * closes a pane** and never writes `failed`. `undefined` when the record is not
   * `running` or `at` is not a finite number.
   *
   * The settlement for records whose owner can no longer sweep them (a dead
   * parent, a pane that went with its session). It skips the probe and the
   * transcript read on purpose: the sidecar is the child's own write and the
   * done classification by itself, and the pane is left alone because a pane id
   * outlives its run — closing whatever now answers to it is not cleanup.
   */
  settleFromSidecar(rec: RunRecord, at: number): Promise<LifecycleTransition | undefined>;
}

export function createRunLifecycle(effects: RunLifecycleEffects): RunLifecycle {
  /** Tail of each run id's operation queue. */
  const queues = new Map<string, Promise<void>>();
  /** Last evidence stamp examined per run id. */
  const examinedStamps = new Map<string, string | undefined>();
  /**
   * Run ids examined at least once, kept apart from the stamps so a first
   * examination counts as changed even when its stamp is `undefined`.
   */
  const examined = new Set<string>();

  const serialize = <T>(runId: string, op: () => Promise<T>): Promise<T> => {
    const previous = queues.get(runId) ?? Promise.resolve();
    const result = previous.then(op);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    queues.set(runId, tail);
    void tail.then(() => {
      if (queues.get(runId) === tail) queues.delete(runId);
    });
    return result;
  };

  /** THE completion predicate: {@link completionSignal} through this lifecycle's effects. */
  const completed = (rec: RunRecord, result: RunResult): boolean =>
    completionSignal(
      effects.hasSidecar(effects.runDirOf(rec.runId), rec.runId),
      result,
      effects.hasPendingSpawns?.(rec) ?? false,
    );

  /**
   * The same rule for a run whose pane is **gone** (or was never recorded): the
   * pending input pinned off, which is the one place the third input is not
   * consulted.
   *
   * A deferral is a promise that the run will be looked at again, and only a live
   * pane can keep that promise. The process behind a gone pane cannot be woken by
   * its children's notices, so refusing it `done` buys nothing and costs
   * something specific: a run that produced a clean answer and whose pane has
   * since been destroyed would be written `failed`, which is the label that tells
   * the orchestrator to re-delegate rather than read the answer. Dead-pane
   * settlement is deliberately unchanged.
   */
  const completedDead = (rec: RunRecord, result: RunResult): boolean =>
    completionSignal(effects.hasSidecar(effects.runDirOf(rec.runId), rec.runId), result);

  const extract = (rec: RunRecord): Promise<RunResult> =>
    effects.extract(effects.runDirOf(rec.runId), rec.runId);

  const observe = (
    rec: RunRecord,
    pane: PaneObservation,
    transition?: LifecycleTransition,
    extracted?: RunResult,
  ): RunObservation => {
    let memo: Promise<RunResult> | undefined = extracted ? Promise.resolve(extracted) : undefined;
    return {
      run: rec,
      pane,
      ...(transition ? { transition } : {}),
      result: () => (memo ??= extract(rec)),
    };
  };

  /**
   * The one mutation of status/finishedAt; undefined for an illegal transition.
   * `at` defaults to the injected clock; the sidecar settle passes the time the
   * child actually finished.
   */
  const transition = (
    rec: RunRecord,
    to: RunStatus,
    cause: LifecycleCause,
    at: number = effects.now(),
  ): LifecycleTransition | undefined => {
    const from = rec.status;
    const legal =
      (from === "running" && to !== "running") ||
      (from === "failed" && to === "done" && rec.failedAttempts === undefined);
    if (!legal) return undefined;
    rec.status = to;
    rec.finishedAt = at;
    return { run: rec, from, to, cause, at };
  };

  const closeQuietly = async (paneId: string | undefined): Promise<void> => {
    if (!paneId) return;
    try {
      await effects.close(paneId);
    } catch {
      // Best-effort cleanup: the transition is already durable.
    }
  };

  /**
   * done: persist, then close — the run no longer owns its pane, and the
   * evidence (sidecar or clean answer) is already on disk.
   */
  const finishDone = async (rec: RunRecord, cause: LifecycleCause): Promise<LifecycleTransition | undefined> => {
    const t = transition(rec, "done", cause);
    if (!t) return undefined;
    effects.saveMeta(rec);
    await closeQuietly(rec.paneId);
    return t;
  };

  /**
   * failed: persist, and never close — herdr destroys scrollback with the
   * pane, and a failure nobody can read is a diagnosis nobody can do.
   */
  const finishFailed = (rec: RunRecord, cause: LifecycleCause): LifecycleTransition | undefined => {
    const t = transition(rec, "failed", cause);
    if (t) effects.saveMeta(rec);
    return t;
  };

  /**
   * Classify a run whose pane is gone (or was never recorded) from its
   * evidence, re-reading twice when a session exists but no signal does yet:
   * the child's sidecar write races herdr's detection of its exit.
   */
  const settle = async (
    rec: RunRecord,
    pane: PaneObservation,
    fallback: "pane-gone" | "no-pane",
  ): Promise<RunObservation> => {
    let result = await extract(rec);
    let signal = completedDead(rec, result);
    for (let i = 0; i < SETTLE_RETRIES && !signal && result.found; i++) {
      await effects.delay(SETTLE_DELAY_MS);
      result = await extract(rec);
      signal = completedDead(rec, result);
    }
    const t = signal ? await finishDone(rec, "completion-signal") : finishFailed(rec, fallback);
    return observe(rec, pane, t, result);
  };

  const readNow = async (rec: RunRecord): Promise<RunObservation> => {
    if (rec.status !== "running") return observe(rec, { kind: "none" });
    // Still launching in this process: no pane yet is the spawn's own gap, not
    // evidence of anything — classifying it here is what failed live runs and
    // health-checked them before their first turn.
    if (!rec.paneId && effects.isLaunching(rec.runId)) return observe(rec, { kind: "launching" });
    // No pane was ever recorded: nothing will ever report, so classify from disk.
    if (!rec.paneId) return settle(rec, { kind: "none" }, "no-pane");
    const pane = await effects.probe(rec.paneId);
    if (pane.kind === "gone") return settle(rec, pane, "pane-gone");
    // Unreachable says nothing about the child; a live non-done pane is working.
    if (pane.kind === "unreachable" || pane.status !== "done") return observe(rec, pane);
    // A live `done` pane is readiness, not termination: look at the evidence,
    // and finish only on a real signal.
    const result = await extract(rec);
    if (completed(rec, result)) return observe(rec, pane, await finishDone(rec, "completion-signal"), result);
    return observe(rec, pane, undefined, result);
  };

  const revivable = (rec: RunRecord, now: number): boolean =>
    rec.status === "failed" &&
    rec.failedAttempts === undefined &&
    // A record with no usable timestamp fails closed (NaN comparison).
    now - (rec.finishedAt ?? rec.startedAt) <= REVIVAL_WINDOW_MS;

  /** Examine one failed run for a late completion; undefined when nothing changed. */
  const reviveNow = async (rec: RunRecord): Promise<RunObservation | undefined> => {
    if (!revivable(rec, effects.now())) return undefined;
    const stamp = effects.evidenceStamp(effects.runDirOf(rec.runId), rec.runId);
    const changed = !examined.has(rec.runId) || examinedStamps.get(rec.runId) !== stamp;
    examined.add(rec.runId);
    examinedStamps.set(rec.runId, stamp);
    if (!changed) return undefined;
    const result = await extract(rec);
    if (!completed(rec, result)) return undefined;
    const t = await finishDone(rec, "late-completion");
    return t ? observe(rec, { kind: "none" }, t, result) : undefined;
  };

  const read = (rec: RunRecord): Promise<RunObservation> => serialize(rec.runId, () => readNow(rec));

  const sweep = async (
    recs: readonly RunRecord[],
    opts?: { exclude?: ReadonlySet<string> },
  ): Promise<SweepResult> => {
    const exclude = opts?.exclude ?? new Set<string>();
    const now = effects.now();
    const candidates = recs.filter(
      (rec) => !exclude.has(rec.runId) && (rec.status === "running" || revivable(rec, now)),
    );
    const finished: RunObservation[] = [];
    for (let i = 0; i < candidates.length; i += SWEEP_CONCURRENCY) {
      const slice = candidates.slice(i, i + SWEEP_CONCURRENCY);
      const observed = await Promise.all(
        slice.map(async (rec): Promise<RunObservation | undefined> => {
          try {
            if (rec.status === "running") {
              const o = await read(rec);
              return o.transition ? o : undefined;
            }
            return await serialize(rec.runId, () => reviveNow(rec));
          } catch {
            return undefined; // one bad record must not abort the sweep
          }
        }),
      );
      for (const o of observed) if (o) finished.push(o);
    }
    return { transitions: finished.map((o) => o.transition!), finished };
  };

  const launchFailed = (
    rec: RunRecord,
    attempt: FailedAttempt,
    pane?: { paneId: string; tabId?: string },
  ): LifecycleTransition => {
    if (rec.status !== "running") {
      throw new Error(`launchFailed: run ${rec.runId} is ${rec.status}, not running`);
    }
    // Link the record to the kept pane so its scrollback can be found; the
    // pane is never closed — it is the failure's evidence.
    if (pane) {
      rec.paneId = pane.paneId;
      if (pane.tabId !== undefined) rec.tabId = pane.tabId;
    }
    rec.failedAttempts = [attempt];
    const t = transition(rec, "failed", "launch-failure")!;
    effects.saveMeta(rec);
    return t;
  };

  const cancel = (rec: RunRecord): Promise<RunObservation> =>
    serialize(rec.runId, async () => {
      const t = transition(rec, "cancelled", "cancelled");
      if (!t) return observe(rec, { kind: "none" });
      // Persist BEFORE the close, deliberately: closing is destructive and can
      // hang or fail, and a cancellation must stay durable either way. (The
      // old order — close, then save — lost the cancel on a hung close.)
      effects.saveMeta(rec);
      await closeQuietly(rec.paneId);
      return observe(rec, { kind: "none" }, t);
    });

  const settleFromSidecar = (rec: RunRecord, at: number): Promise<LifecycleTransition | undefined> =>
    serialize(rec.runId, async () => {
      // Narrower than `transition`'s table on purpose: only `running` qualifies.
      // A `failed` record is revived through the sweep, which re-reads its
      // evidence; this path reads none, so it must not overrule a verdict.
      if (rec.status !== "running" || !Number.isFinite(at)) return undefined;
      const t = transition(rec, "done", "sidecar-settle", at);
      if (t) effects.saveMeta(rec);
      return t;
    });

  return { read, sweep, launchFailed, cancel, settleFromSidecar };
}
