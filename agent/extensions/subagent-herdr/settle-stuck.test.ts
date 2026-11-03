/**
 * Tests for the stuck-record settle (`settle-stuck.ts`) and the lifecycle's
 * `settleFromSidecar`, the one path it writes through.
 *
 * Every fixture lives in a fresh temp dir. The real runs dir is read only by the
 * replay suite at the bottom, which never writes: it evaluates the predicate
 * against a copy of the records in memory.
 *
 * Run from the repo root: `bun test agent/extensions/subagent-herdr/settle-stuck.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentProbe } from "./herdr.js";
import { createRunLifecycle, type RunLifecycleEffects } from "./run-lifecycle.js";
import {
  hasExitSidecar,
  isTerminalRecord,
  launchedBy,
  listRunCandidates,
  metaPath,
  pendingSpawnsOf,
  readExitSidecarAt,
  type RunRecord,
} from "./rundir.js";
import {
  isOrphanSettleable,
  settleOrphans,
  settleStuckRecords,
  STUCK_SIDECAR_MIN_AGE_MS,
  type Candidate,
} from "./settle-stuck.js";

const NOW = 1_700_000_000_000;
const GONE: AgentProbe = { kind: "gone" };
const UNREACHABLE: AgentProbe = { kind: "unreachable", error: "timeout" };

function record(over: Partial<RunRecord> & { runId: string }): RunRecord {
  return { agent: "reviewer", task: "t", cwd: "/w", status: "running", startedAt: NOW - 60_000, ...over };
}

/** One temp runs dir holding `meta.json` for each record, and a sidecar where asked. */
function corpus(entries: readonly { rec: RunRecord; sidecarAt?: unknown }[]): { base: string; candidates: Candidate[] } {
  const base = mkdtempSync(join(tmpdir(), "settle-stuck-"));
  for (const { rec, sidecarAt } of entries) {
    const dir = join(base, rec.runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(metaPath(dir), JSON.stringify(rec, null, 2));
    const session = join(dir, `1700000000000_${rec.runId}.jsonl`);
    writeFileSync(session, "{}\n");
    if (sidecarAt !== undefined) writeFileSync(`${session}.exit`, JSON.stringify({ type: "done", at: sidecarAt }));
  }
  return { base, candidates: listRunCandidates([base]) };
}

/** The real lifecycle over the corpus, recording closes and saves. */
function lifecycleOver(base: string) {
  const closes: string[] = [];
  const saves: string[] = [];
  const effects: RunLifecycleEffects = {
    probe: async () => GONE,
    close: async (paneId) => {
      closes.push(paneId);
      return true;
    },
    extract: async () => ({ found: false, answered: false, text: "" }),
    hasSidecar: hasExitSidecar,
    evidenceStamp: () => undefined,
    saveMeta: (rec) => {
      saves.push(rec.runId);
      writeFileSync(metaPath(join(base, rec.runId)), JSON.stringify(rec, null, 2));
    },
    runDirOf: (runId) => join(base, runId),
    now: () => NOW,
    delay: async () => {},
    isLaunching: () => false,
  };
  return { lifecycle: createRunLifecycle(effects), closes, saves };
}

const onDisk = (base: string, runId: string): RunRecord =>
  JSON.parse(readFileSync(metaPath(join(base, runId)), "utf-8")) as RunRecord;

describe("settleFromSidecar: the lifecycle's sidecar-only settle", () => {
  test("running → done at the sidecar's own time; persisted, pane untouched", async () => {
    const { base } = corpus([{ rec: record({ runId: "sub-0001", paneId: "w1:p1" }) }]);
    const { lifecycle, closes, saves } = lifecycleOver(base);
    const rec = onDisk(base, "sub-0001");
    const t = await lifecycle.settleFromSidecar(rec, 123);
    expect(t).toMatchObject({ from: "running", to: "done", cause: "sidecar-settle", at: 123 });
    expect(rec).toMatchObject({ status: "done", finishedAt: 123 });
    expect(saves).toEqual(["sub-0001"]);
    expect(closes).toEqual([]);
  });

  test("refuses anything that is not running, and a time that is not a time", async () => {
    const { base } = corpus([{ rec: record({ runId: "sub-0002" }) }]);
    const { lifecycle, saves } = lifecycleOver(base);
    for (const status of ["done", "failed", "cancelled"] as const) {
      const rec = record({ runId: "sub-0002", status, finishedAt: 5 });
      expect(await lifecycle.settleFromSidecar(rec, 123)).toBeUndefined();
      expect(rec).toMatchObject({ status, finishedAt: 5 });
    }
    const running = record({ runId: "sub-0002" });
    expect(await lifecycle.settleFromSidecar(running, Number.NaN)).toBeUndefined();
    expect(running.status).toBe("running");
    expect(saves).toEqual([]);
  });
});

describe("settleStuckRecords: the one-time cleanup", () => {
  test("a running record with a sidecar at 123 is done at 123, and no pane is closed", async () => {
    const { base, candidates } = corpus([{ rec: record({ runId: "sub-0011", paneId: "w1:p1" }), sidecarAt: 123 }]);
    const { lifecycle, closes } = lifecycleOver(base);
    const settled = await settleStuckRecords(candidates, { lifecycle, sidecarAt: readExitSidecarAt, abandonedBefore: NOW });
    expect(settled.map((t) => t.run.runId)).toEqual(["sub-0011"]);
    expect(onDisk(base, "sub-0011")).toMatchObject({ status: "done", finishedAt: 123 });
    expect(closes).toEqual([]);
  });

  test("no sidecar, or a sidecar whose `at` is not a number: untouched", async () => {
    const { base, candidates } = corpus([
      { rec: record({ runId: "sub-0012" }) },
      { rec: record({ runId: "sub-0013" }), sidecarAt: "x" },
    ]);
    const { lifecycle, saves } = lifecycleOver(base);
    expect(await settleStuckRecords(candidates, { lifecycle, sidecarAt: readExitSidecarAt, abandonedBefore: NOW })).toEqual([]);
    expect(onDisk(base, "sub-0012").status).toBe("running");
    expect(onDisk(base, "sub-0013").status).toBe("running");
    expect(saves).toEqual([]);
  });

  test("terminal records are never rewritten, whatever their sidecar says", async () => {
    const { base, candidates } = corpus([
      { rec: record({ runId: "sub-0014", status: "failed", finishedAt: 7 }), sidecarAt: 123 },
      { rec: record({ runId: "sub-0015", status: "cancelled", finishedAt: 8 }), sidecarAt: 123 },
    ]);
    const { lifecycle, saves } = lifecycleOver(base);
    expect(await settleStuckRecords(candidates, { lifecycle, sidecarAt: readExitSidecarAt, abandonedBefore: NOW })).toEqual([]);
    expect(onDisk(base, "sub-0014")).toMatchObject({ status: "failed", finishedAt: 7 });
    expect(onDisk(base, "sub-0015")).toMatchObject({ status: "cancelled", finishedAt: 8 });
    expect(saves).toEqual([]);
  });

  test("a sidecar too fresh to prove the owner gone is left for the owner", async () => {
    const { base, candidates } = corpus([
      { rec: record({ runId: "sub-0019" }), sidecarAt: NOW - STUCK_SIDECAR_MIN_AGE_MS + 1 },
      { rec: record({ runId: "sub-001a" }), sidecarAt: NOW - STUCK_SIDECAR_MIN_AGE_MS },
    ]);
    const { lifecycle } = lifecycleOver(base);
    const settled = await settleStuckRecords(candidates, {
      lifecycle,
      sidecarAt: readExitSidecarAt,
      abandonedBefore: NOW - STUCK_SIDECAR_MIN_AGE_MS,
    });
    // A live owner settles its own on the next tick, and that is the settlement
    // that briefs; only the one past the horizon is abandoned.
    expect(settled.map((t) => t.run.runId)).toEqual(["sub-001a"]);
    expect(onDisk(base, "sub-0019").status).toBe("running");
  });

  test("idempotent: a second pass over a fresh scan writes nothing", async () => {
    const { base, candidates } = corpus([{ rec: record({ runId: "sub-0016" }), sidecarAt: 123 }]);
    const { lifecycle, saves } = lifecycleOver(base);
    await settleStuckRecords(candidates, { lifecycle, sidecarAt: readExitSidecarAt, abandonedBefore: NOW });
    expect(saves).toEqual(["sub-0016"]);
    await settleStuckRecords(listRunCandidates([base]), { lifecycle, sidecarAt: readExitSidecarAt, abandonedBefore: NOW });
    expect(saves).toEqual(["sub-0016"]);
  });

  test("settles the registry's live copy, and leaves a skipped record alone", async () => {
    const { base, candidates } = corpus([
      { rec: record({ runId: "sub-0017" }), sidecarAt: 123 },
      { rec: record({ runId: "sub-0018" }), sidecarAt: 123 },
    ]);
    const { lifecycle } = lifecycleOver(base);
    const live = onDisk(base, "sub-0017");
    const registry = new Map([[live.runId, live]]);
    await settleStuckRecords(candidates, {
      lifecycle,
      sidecarAt: readExitSidecarAt,
      abandonedBefore: NOW,
      resolve: (rec) => registry.get(rec.runId) ?? rec,
      skip: (rec) => rec.runId === "sub-0018",
    });
    // The registry's object moved, not just the scan's copy — so the next
    // `saveMeta` from the registry cannot write `running` back over it.
    expect(live.status).toBe("done");
    expect(onDisk(base, "sub-0018").status).toBe("running");
  });
});

describe("isOrphanSettleable: the ongoing rule", () => {
  const rec = record({ runId: "sub-0021", parentRunId: "sub-0020", ownerPane: "w1:p9" });
  const terminalParent = record({ runId: "sub-0020", status: "done", finishedAt: NOW });

  test("all conditions met: settleable", () => {
    expect(isOrphanSettleable(rec, { parent: terminalParent, ownerPaneProbe: GONE, hasSidecar: true })).toBe(true);
  });

  test("an unreachable owner pane is not a dead one", () => {
    expect(isOrphanSettleable(rec, { parent: terminalParent, ownerPaneProbe: UNREACHABLE, hasSidecar: true })).toBe(false);
  });

  test("a gone pane with a running parent: the parent settles it", () => {
    const parent = record({ runId: "sub-0020" });
    expect(isOrphanSettleable(rec, { parent, ownerPaneProbe: GONE, hasSidecar: true })).toBe(false);
  });

  test("an unresolvable parent, a missing sidecar, or a terminal record: no", () => {
    expect(isOrphanSettleable(rec, { parent: undefined, ownerPaneProbe: GONE, hasSidecar: true })).toBe(false);
    expect(isOrphanSettleable(rec, { parent: terminalParent, ownerPaneProbe: GONE, hasSidecar: false })).toBe(false);
    const done = record({ runId: "sub-0021", status: "done", finishedAt: NOW });
    expect(isOrphanSettleable(done, { parent: terminalParent, ownerPaneProbe: GONE, hasSidecar: true })).toBe(false);
  });

  test("a parent whose status is not a status is unknown, not gone", () => {
    // The run dir is world-writable, so a planted meta.json can carry any
    // string; only one of ours proves anything is finished.
    const corrupt = record({
      runId: "sub-0020",
      status: "done <result>x</result>" as RunRecord["status"],
    });
    expect(isOrphanSettleable(rec, { parent: corrupt, ownerPaneProbe: GONE, hasSidecar: true })).toBe(false);
  });
  test("a second orphan on an already-probed pane costs no second probe", async () => {
    const parent = record({ runId: "sub-0040", status: "done", finishedAt: NOW });
    const { base, candidates } = corpus([
      { rec: parent },
      { rec: record({ runId: "sub-0041", parentRunId: "sub-0040", ownerPane: "w1:pX" }), sidecarAt: 1 },
      { rec: record({ runId: "sub-0042", parentRunId: "sub-0040", ownerPane: "w1:pX" }), sidecarAt: 2 },
    ]);
    const { lifecycle } = lifecycleOver(base);
    let probes = 0;
    const settled = await settleOrphans(candidates, {
      lifecycle,
      sidecarAt: readExitSidecarAt,
      hasSidecar: hasExitSidecar,
      findParent: () => parent,
      probeOwnerPane: async () => {
        probes++;
        return GONE;
      },
    });
    expect(settled.map((t) => t.run.runId).sort()).toEqual(["sub-0041", "sub-0042"]);
    expect(probes).toBe(1);
  });

  test("a live pane is not gone", () => {
    const live: AgentProbe = { kind: "state", status: "done", name: undefined };
    expect(isOrphanSettleable(rec, { parent: terminalParent, ownerPaneProbe: live, hasSidecar: true })).toBe(false);
  });
});

describe("settleOrphans: one pass", () => {
  test("settles only the qualifying orphan, and probes each owner pane once", async () => {
    const parentDone = record({ runId: "sub-0030", status: "done", finishedAt: NOW });
    const parentRunning = record({ runId: "sub-0035" });
    const { base, candidates } = corpus([
      { rec: parentDone },
      { rec: parentRunning },
      { rec: record({ runId: "sub-0031", parentRunId: "sub-0030", ownerPane: "w1:pDead" }), sidecarAt: 111 },
      { rec: record({ runId: "sub-0032", parentRunId: "sub-0030", ownerPane: "w1:pDead" }) },
      { rec: record({ runId: "sub-0033", parentRunId: "sub-0035", ownerPane: "w1:pDead" }), sidecarAt: 222 },
      { rec: record({ runId: "sub-0034", parentRunId: "sub-0030", ownerPane: "w1:pFlaky" }), sidecarAt: 333 },
    ]);
    const { lifecycle, closes } = lifecycleOver(base);
    const probed: string[] = [];
    const parents = new Map([
      [parentDone.runId, parentDone],
      [parentRunning.runId, parentRunning],
    ]);
    const settled = await settleOrphans(candidates, {
      lifecycle,
      sidecarAt: readExitSidecarAt,
      hasSidecar: hasExitSidecar,
      findParent: (rec) => (typeof rec.parentRunId === "string" ? parents.get(rec.parentRunId) : undefined),
      probeOwnerPane: async (paneId) => {
        probed.push(paneId);
        return paneId === "w1:pDead" ? GONE : UNREACHABLE;
      },
    });
    expect(settled.map((t) => t.run.runId)).toEqual(["sub-0031"]);
    expect(onDisk(base, "sub-0031")).toMatchObject({ status: "done", finishedAt: 111 });
    // No sidecar; running parent; flaky (unreachable) owner pane.
    for (const id of ["sub-0032", "sub-0033", "sub-0034"]) expect(onDisk(base, id).status).toBe("running");
    // sub-0032 has no sidecar and sub-0033 has a running parent, so neither costs
    // a probe; the two that got that far cost one probe per pane.
    expect(probed.sort()).toEqual(["w1:pDead", "w1:pFlaky"]);
    expect(closes).toEqual([]);
  });
  test("a child whose parent has a corrupted status costs no probe and is not settled", async () => {
    const corruptParent = record({ runId: "sub-0050", status: "bogus" as RunRecord["status"] });
    const { base, candidates } = corpus([
      { rec: corruptParent },
      { rec: record({ runId: "sub-0051", parentRunId: "sub-0050", ownerPane: "w1:pCorrupt" }), sidecarAt: 5 },
    ]);
    const { lifecycle, saves } = lifecycleOver(base);
    const probed: string[] = [];
    const settled = await settleOrphans(candidates, {
      lifecycle,
      sidecarAt: readExitSidecarAt,
      hasSidecar: hasExitSidecar,
      findParent: (rec) =>
        typeof rec.parentRunId === "string"
          ? candidates.find((c) => c.rec.runId === rec.parentRunId)?.rec
          : undefined,
      probeOwnerPane: async (paneId) => {
        probed.push(paneId);
        return GONE;
      },
    });
    // The parent proves nothing is finished, so the record is left exactly
    // where it was — and the herdr round-trip it would have cost is saved.
    expect(settled).toEqual([]);
    expect(probed).toEqual([]);
    expect(saves).toEqual([]);
    expect(onDisk(base, "sub-0051").status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Replay over the real corpus: read-only, and skipped where there is none
// ---------------------------------------------------------------------------

const REAL_RUNS = join(import.meta.dir, "..", "..", "subagent-runs");

type CorpusClassification = {
  held: number;
  sidecarReleased: number;
  terminalReleased: number;
  expired: number;
};

/**
 * The classification of one runs dir: every nested child, asked of the shipped
 * rule as of its parent's last turn. Pure over the dir — the frozen-fixture
 * pin and the live-dir replay both run this one function, so they cannot drift
 * apart.
 *
 * Read-only: `listRunCandidates` reads `meta.json`, `readExitSidecarAt` reads
 * sidecars. Nothing here writes.
 */
function classifyCorpus(runsDir: string): CorpusClassification {
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const candidates = listRunCandidates([runsDir]);
  // Keyed on the dir as well as the id: the classifier is single-base, and a
  // key that pretended otherwise would silently mix bases the day a second one
  // is scanned.
  const sidecarAt = new Map(
    candidates.map((c) => [`${c.dir}/${c.rec.runId}`, readExitSidecarAt(c.dir, c.rec.runId)]),
  );
  // A sidecar counts at T once its own `at` is no later than T.
  const sidecarAsOfT = (T: number) => (dir: string, runId: string): boolean => {
    const at = sidecarAt.get(`${dir}/${runId}`);
    return finite(at) && (at as number) <= T;
  };
  // The terminal rule as of T: the shipped record rule, but a record the
  // migration or its owner settled AFTER T was still running at T — its
  // `status` today says nothing about T, so only its settle timestamp
  // (`finishedAt`) may release it.
  // The terminal rule as of T: the shipped record rule, but a record the
  // migration or its owner settled AFTER T was still running at T — its
  // `status` today says nothing about T, so only its settle timestamp
  // (`finishedAt`) may release it. The replay pins everything to T, so T (not
  // the caller's `now`) is what `isTerminalRecord` is asked of.
  const terminalAsOfT = (T: number) => (rec: RunRecord): boolean =>
    isTerminalRecord(rec, T) && finite(rec.finishedAt) && (rec.finishedAt as number) <= T;

  let held = 0;
  let sidecarReleased = 0;
  let terminalReleased = 0;
  let expired = 0;
  for (const { rec: parent, dir: parentDir } of candidates) {
    // A parent is a subagent run that finished (sidecar `at` = T, the end of
    // its last turn). A child is any record the shared relation attributes to
    // it that started inside the parent's own lifetime — the window is what
    // keeps a reused pane id from attributing an unrelated old record to it.
    const T = sidecarAt.get(`${parentDir}/${parent.runId}`);
    const start = parent.startedAt;
    if (!finite(T) || !finite(start)) continue;
    const run = {
      runId: parent.runId,
      ...(typeof parent.paneId === "string" ? { paneId: parent.paneId } : {}),
    };
    const children = candidates.filter(
      (c) =>
        c.rec.runId !== parent.runId &&
        launchedBy(c.rec, run) &&
        finite(c.rec.startedAt) &&
        (c.rec.startedAt as number) >= start &&
        (c.rec.startedAt as number) <= T,
    );
    if (children.length === 0) continue;
    // The shipped rule, asked as of T: the default sidecar reader and the
    // default terminal rule, both pinned to the moment being replayed.
    const pending = new Set(
      pendingSpawnsOf(run, children, T, sidecarAsOfT(T), terminalAsOfT(T)).map((r) => r.runId),
    );
    for (const { rec: c, dir } of children) {
      if (sidecarAsOfT(T)(dir, c.runId)) sidecarReleased++;
      else if (pending.has(c.runId)) held++;
      else if (terminalAsOfT(T)(c)) terminalReleased++;
      else expired++; // no sidecar at T, not terminal at T, past DEFER_MAX at T
    }
  }
  return { held, sidecarReleased, terminalReleased, expired };
}

describe("replay: the pending-spawn rule against a frozen corpus shape", () => {
  test("classifies the recorded population exactly: 94 held, 18 sidecar-released, 4 terminal-released, 0 expired", () => {
    // The population the rule was measured on, rebuilt as a fixture: one
    // finished parent, 94 running children it holds, 18 it released by
    // sidecar, 4 it released as terminal (3 cancelled, 1 failed with
    // `failedAttempts`). An exact pin over frozen records — the live dir is
    // growing, so it is invariants-only below; this fixture is what a
    // regression in the rule must break.
    const T = NOW;
    const parentStart = T - 3_600_000;
    const entries: { rec: RunRecord; sidecarAt?: unknown }[] = [
      {
        rec: record({
          runId: "sub-f000",
          startedAt: parentStart,
          status: "done",
          finishedAt: T,
        }),
        sidecarAt: T,
      },
    ];
    const id = (i: number) => `sub-${(i + 1).toString(16).padStart(4, "0")}`;
    for (let i = 0; i < 94; i++) {
      entries.push({
        rec: record({
          runId: id(i),
          parentRunId: "sub-f000",
          startedAt: T - 3_500_000 + i * 1000,
        }),
      });
    }
    for (let i = 0; i < 18; i++) {
      entries.push({
        rec: record({
          runId: id(94 + i),
          parentRunId: "sub-f000",
          startedAt: T - 3_400_000 + i * 1000,
        }),
        sidecarAt: T - 1_000_000,
      });
    }
    for (let i = 0; i < 3; i++) {
      entries.push({
        rec: record({
          runId: id(112 + i),
          parentRunId: "sub-f000",
          startedAt: T - 3_300_000 + i * 1000,
          status: "cancelled",
          finishedAt: T - 2_000_000,
        }),
      });
    }
    entries.push({
      rec: record({
        runId: id(115),
        parentRunId: "sub-f000",
        startedAt: T - 3_300_000,
        status: "failed",
        failedAttempts: [{ model: "fallback/auto", error: "launch failed" }],
        finishedAt: T - 2_000_000,
      }),
    });
    const { base } = corpus(entries);
    expect(classifyCorpus(base)).toEqual({
      held: 94,
      sidecarReleased: 18,
      terminalReleased: 4,
      expired: 0,
    });
  });
});

/**
 * The replay over the live runs dir, computed once at import time, so the
 * suite can skip itself where the dir is absent or holds no nested child to
 * replay — a machine whose dir exists but has no sidecar'd nested children
 * cannot falsify the invariants.
 */
const REPLAY = existsSync(REAL_RUNS) ? classifyCorpus(REAL_RUNS) : null;

describe.skipIf(
  REPLAY === null ||
    REPLAY.held + REPLAY.sidecarReleased + REPLAY.terminalReleased + REPLAY.expired === 0,
)("replay: the pending-spawn rule against the recorded corpus", () => {
  test("no nested child is left unclassified as of the parent's last turn", () => {
    console.log(
      `[replay] nested children: ${REPLAY!.held} held, ${REPLAY!.sidecarReleased} sidecar-released, `
        + `${REPLAY!.terminalReleased} terminal-released, ${REPLAY!.expired} expired`,
    );
    // The live dir grows with every nested spawn, so the counts are not
    // pinned here (the frozen fixture above pins the rule on the population it
    // was measured on); the invariant is: nothing falls through. A non-zero
    // `expired` is exactly "a child neither the sidecar nor the terminal rule
    // releases, and the bound no longer holds" — the mis-settle this rule
    // exists to prevent.
    expect(REPLAY!.expired).toBe(0);
  });
});
