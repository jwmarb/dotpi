/**
 * The running-parent proof for a reroute marker's claimed parent — the pi-free
 * half of the wake path's reroute validation, with its memo.
 *
 * `createReleaseLedger` asks one question through `parentRunIsFinished`: has
 * the run a notice claims as its parent actually stopped? The ledger must stay
 * free of filesystem and herdr I/O, so the lookup is injected as effects and
 * assembled here; `index.ts` binds those effects to the real registry, run
 * dirs, probe and evidence read.
 *
 * ## The predicate's contract
 *
 * The registry copy is trusted only when it is *this pane's own* and already
 * terminal: `loadRegistry` runs once at module load and never refreshes a
 * record this pane does not sweep, so after a restart a foreign `running` copy
 * — and an owned one the same one-shot load left behind — sits stale in exactly
 * the `running` → terminal direction, and a stale `running` strips every
 * genuine reroute from a finished parent's child. Anything else falls through
 * to the disk read (this pane's own dir and the in-session switch target), read
 * *without registering*: the id comes from a model-authored marker, not from a
 * notice addressed to this pane, so the parent must not enter `runs` (where
 * `subagent_tasks list` would surface it) or become addressable by
 * `cancel`/`interrupt`; registration is what the notices this pane was
 * addressed to get.
 *
 * A record that resolves but is still `running` is answered from the pane
 * first — a probe is a pure read, so it touches none of the ownership rules —
 * and any state that is not `gone` answers `false`: a live pane (in any state,
 * including `done`, which is readiness) is the parent's own process still
 * running, and `unreachable` says nothing about the child, mirroring `readNow`.
 * Only a `gone` pane (or a paneless record) leaves the answer to the completion
 * evidence — the `.exit` sidecar, or a clean transcript answer read as a
 * bounded tail — which the one completion predicate (`completionSignal`, the
 * rule the lifecycle's `completed()` applies) decides, read *without settling*
 * in either case: a foreign parent is one the receiver never writes or closes
 * (its scrollback is the failure evidence), and an owned one settles through
 * the ordinary notice path, not this proof. A `running` record whose pane is
 * alive, or whose evidence is absent, is answered `false` — conservative, and
 * exactly what an unreachable herdr already means.
 *
 * Ownership is deliberately not part of the *test* — a foreign parent is valid
 * lineage; in the canonical single-hop case (R spawns A, A finishes, A's
 * child's notice walks to R) the receiver IS the parent's owner, so a
 * foreign-ownership clause would strip the feature's own target, and the
 * live-parent forge is the `direct` check's job, not this one's. It is part of
 * the cache *trust* only.
 *
 * The lookup is total: an evidence read that throws answers
 * `{ finished: false, status }` from the record in hand (its observed status),
 * so the flush can never reject on it. That `status` — the record's, or
 * `"absent"` when nothing resolves — exists for the ledger's log line, never as
 * a memo key.
 *
 * ## The memo
 *
 * `parentProofMemo` is keyed on the run id ALONE and reached only on the
 * `running` branch — the terminal early return runs before the lookup, so a
 * status in the key would be the constant `running`, and keying on the id
 * already shrank it versus the old `${id}:${status}` key. It caches POSITIVES
 * only, and the entry records the source a proof rested on because that source
 * decides the expiry:
 *
 * - a `true` proven by the `.exit` sidecar is a completion record and stands
 *   without an expiry (terminal is terminal);
 * - a `true` inferred from the transcript tail is an inference, not a record,
 *   and expires at {@link PARENT_PROOF_TTL_MS} — a hit past the TTL re-proves;
 * - a `false` is computed, returned and never stored. It is a liveness
 *   inference that goes stale the moment the parent exits, and serving one
 *   silently deletes a reroute note: a pair's `done` lands inside the 1.2 s
 *   coalesce window, so a parent that finishes between the pair's report and
 *   its done would lose the note for the whole TTL. `wake.test.ts` pins exactly
 *   this (both notices keep the note; a live parent pays one probe per notice).
 *
 * The map is never pruned: its entries are bounded by the distinct run ids ever
 * proven (hundreds, not a growth path). One liveness tick bounds the staleness
 * that survives the TTL check — the wake path's own clocks are the 1.2 s
 * coalesce window and this 60 s tick, so a stale entry dies within a tick of
 * whatever re-proves it. What the memo buys is the documented nested-owner
 * case: a foreign `running` parent no process ever ticks would otherwise
 * re-probe on every flush. What the ledger guarantees is narrower — it memoizes
 * nothing, so each notice pays its own call (see `verifiedReroute` in
 * release-ledger.ts).
 *
 * @module subagent-herdr/parent-proof
 */
import { LIVENESS_BACKSTOP_MS, type ReleaseLedgerDeps } from "./release-ledger.js";
import type { RunRecord } from "./rundir.js";
import type { AgentProbe } from "./herdr.js";

/**
 * Patience for the wake path's parent probe. `probeAgent` shares the
 * module-wide 30 s herdr timeout, but this probe runs on the serialized
 * wake path — one probe per marker-carrying notice whose parent is not
 * proven finished, each bounded at `WAKE_PROBE_TIMEOUT_MS` (5 s) — so a
 * hung herdr would stall every briefing behind it. 5 s is far longer than
 * a healthy local round-trip (measured sub-millisecond) and far shorter
 * than the stall it bounds; a timeout kills the CLI with no reply document,
 * so `probeFromCall` answers `unreachable` (herdr.ts behaviour 10) — "not
 * gone", the conservative direction: the note is stripped, never a pane
 * proven gone.
 */
export const WAKE_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long a cached POSITIVE proof {@link createParentProof} inferred from the
 * transcript tail stands. The full memo policy — positives only, why a sidecar
 * proof never expires, why a `false` is never stored — is documented once on
 * {@link createParentProof}.
 */
export const PARENT_PROOF_TTL_MS = LIVENESS_BACKSTOP_MS;

/** The effects {@link createParentProof} performs, all injected. */
export interface ParentProofEffects {
  /** This process's registry copy, if any (`runs.get`). Never mutated here. */
  registryRecord(runId: string): RunRecord | undefined;
  /** Whether a registry copy belongs to this pane (cache *trust*, not lineage). */
  isOwned(rec: RunRecord): boolean;
  /** Where this process believes the run's dir lives. */
  dirFor(runId: string): string;
  /** The disk read across every run-dir base, without registering anything. */
  findOnDisk(runId: string): { rec: RunRecord; dir: string } | undefined;
  /** One `agent get` round-trip, bounded by `WAKE_PROBE_TIMEOUT_MS`. */
  probe(paneId: string, timeoutMs: number): Promise<AgentProbe>;
  /** The one completion predicate's verdict, read without settling the run. */
  completionEvidence(
    dir: string,
    runId: string,
  ): Promise<{ finished: true; from: "sidecar" | "answer" } | { finished: false }>;
  /** The clock the memo's TTL is measured on. */
  now(): number;
}

/**
 * Build the ledger's `parentRunIsFinished` predicate, holding its cross-flush
 * memo in the closure (one instance per ledger, created once per factory call).
 *
 * The contract, the keying and the memo policy are documented in this module's
 * header; read it before changing anything here.
 */
export function createParentProof(
  effects: ParentProofEffects,
): ReleaseLedgerDeps["parentRunIsFinished"] {
  const parentProofMemo = new Map<string, { at: number; from: "sidecar" | "answer" }>();

  return async (runId) => {
    let status: RunRecord["status"] | "absent" = "absent";
    try {
      const cached = effects.registryRecord(runId);
      const found =
        cached !== undefined && cached.status !== "running" && effects.isOwned(cached)
          ? { rec: cached, dir: effects.dirFor(runId) }
          : effects.findOnDisk(runId);
      if (found === undefined) return { finished: false, status };
      const { rec, dir } = found;
      status = rec.status;
      if (rec.status !== "running") return { finished: true, status };
      const at = effects.now();
      const hit = parentProofMemo.get(runId);
      if (
        hit !== undefined &&
        (hit.from === "sidecar" || at - hit.at < PARENT_PROOF_TTL_MS)
      ) {
        return { finished: true, status };
      }
      const proof = await (async (): Promise<
        | { finished: true; from: "sidecar" | "answer" }
        | { finished: false }
      > => {
        if (rec.paneId !== undefined) {
          const pane = await effects.probe(rec.paneId, WAKE_PROBE_TIMEOUT_MS);
          if (pane.kind !== "gone") return { finished: false };
        }
        const evidence = await effects.completionEvidence(dir, runId);
        return evidence.finished
          ? { finished: true, from: evidence.from }
          : { finished: false };
      })();
      // Positives only — see the header. A `false` is returned, not stored.
      if (proof.finished) parentProofMemo.set(runId, { at, from: proof.from });
      return { finished: proof.finished, status };
    } catch {
      // Last resort, not a failure path: `findOnDisk`, `probe`,
      // `completionEvidence` and the registry reads each swallow their own
      // failures (a missing record, an unreachable herdr, an unreadable
      // sidecar, an unreadable transcript are all answers, not throws), so a
      // throw reaching here means a real bug. The flush contract still gets its
      // conservative `false`.
      return { finished: false, status };
    }
  };
}
