/**
 * Contract tests for the run lifecycle, against an in-memory effects stub:
 * no `mock.module`, no temp directories, no real timers. Every effect is a
 * queue or a log, so each behaviour is pinned by what the lifecycle asked for.
 */
import { describe, expect, test } from "bun:test";
import type { AgentProbe } from "./herdr.js";
import type { RunResult } from "./lib.js";
import type { RunRecord } from "./rundir.js";
import {
  createRunLifecycle,
  REVIVAL_WINDOW_MS,
  SETTLE_DELAY_MS,
  type RunLifecycleEffects,
} from "./run-lifecycle.js";

const NOW = 1_000_000_000;

const NO_SESSION: RunResult = { found: false, answered: false, text: "" };
const NO_ANSWER: RunResult = { found: true, answered: false, text: "", sessionFile: "s.jsonl" };
const CLEAN: RunResult = { found: true, answered: true, text: "<result>ok</result>", sessionFile: "s.jsonl" };

const live = (status: "idle" | "working" | "blocked" | "done"): AgentProbe => ({ kind: "state", status, name: undefined });
const GONE: AgentProbe = { kind: "gone" };

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "sub-0001",
    agent: "worker",
    task: "t",
    cwd: "/w",
    paneId: "w1:p1",
    status: "running",
    startedAt: NOW - 60_000,
    ...over,
  };
}

/** One stub world. Every effect logs; probes/extractions are per-run queues (last value repeats). */
function world() {
  const log: string[] = [];
  const probes = new Map<string, AgentProbe[]>();
  const results = new Map<string, RunResult[]>();
  const sidecars = new Set<string>();
  const stamps = new Map<string, string | undefined>();
  const saved: { runId: string; status: string; finishedAt?: number; failedAttempts?: unknown }[] = [];
  let now = NOW;
  let closeImpl: (paneId: string) => Promise<boolean> = async () => true;
  let probeImpl: ((paneId: string) => Promise<AgentProbe>) | undefined;
  let extractImpl: ((runId: string) => Promise<RunResult>) | undefined;

  const next = <T>(m: Map<string, T[]>, key: string, fallback: T): T => {
    const q = m.get(key);
    if (!q || q.length === 0) return fallback;
    return q.length > 1 ? q.shift()! : q[0];
  };

  const effects: RunLifecycleEffects = {
    probe: async (paneId) => {
      log.push(`probe ${paneId}`);
      return probeImpl ? probeImpl(paneId) : next(probes, paneId, GONE);
    },
    close: async (paneId) => {
      log.push(`close ${paneId}`);
      return closeImpl(paneId);
    },
    extract: async (runDir, runId) => {
      log.push(`extract ${runId}`);
      expect(runDir).toBe(`/runs/${runId}`);
      return extractImpl ? extractImpl(runId) : next(results, runId, NO_SESSION);
    },
    hasSidecar: (_dir, runId) => sidecars.has(runId),
    evidenceStamp: (_dir, runId) => {
      log.push(`stamp ${runId}`);
      return stamps.get(runId);
    },
    saveMeta: (r) => {
      log.push(`save ${r.runId} ${r.status}`);
      saved.push({ runId: r.runId, status: r.status, finishedAt: r.finishedAt, failedAttempts: r.failedAttempts });
    },
    runDirOf: (runId) => `/runs/${runId}`,
    now: () => now,
    delay: async (ms) => {
      log.push(`delay ${ms}`);
    },
  };

  return {
    effects,
    lifecycle: createRunLifecycle(effects),
    log,
    probes,
    results,
    sidecars,
    stamps,
    saved,
    setNow: (n: number) => {
      now = n;
    },
    setClose: (f: typeof closeImpl) => {
      closeImpl = f;
    },
    setProbe: (f: typeof probeImpl) => {
      probeImpl = f;
    },
    setExtract: (f: typeof extractImpl) => {
      extractImpl = f;
    },
    count: (prefix: string) => log.filter((l) => l.startsWith(prefix)).length,
  };
}

describe("run lifecycle: transition table", () => {
  test("running → done on a completion signal", async () => {
    const w = world();
    w.probes.set("w1:p1", [GONE]);
    w.results.set("sub-0001", [CLEAN]);
    const r = rec();
    const o = await w.lifecycle.read(r);
    expect(o.transition).toMatchObject({ from: "running", to: "done", cause: "completion-signal", at: NOW });
    expect(r.status).toBe("done");
  });

  test("running → failed when the pane is gone with no signal", async () => {
    const w = world();
    const r = rec();
    const o = await w.lifecycle.read(r);
    expect(o.transition).toMatchObject({ from: "running", to: "failed", cause: "pane-gone" });
  });

  test("running → cancelled", async () => {
    const w = world();
    const r = rec();
    const o = await w.lifecycle.cancel(r);
    expect(o.transition).toMatchObject({ from: "running", to: "cancelled", cause: "cancelled" });
  });

  test("failed → done for an eligible late completion", async () => {
    const w = world();
    const r = rec({ status: "failed", finishedAt: NOW - 10_000 });
    w.results.set("sub-0001", [CLEAN]);
    const s = await w.lifecycle.sweep([r]);
    expect(s.transitions).toHaveLength(1);
    expect(s.transitions[0]).toMatchObject({ from: "failed", to: "done", cause: "late-completion" });
  });

  test("done, cancelled and launch-failed records never transition again", async () => {
    const w = world();
    w.results.set("sub-0001", [CLEAN]);
    w.sidecars.add("sub-0001");
    for (const r of [
      rec({ status: "done", finishedAt: NOW - 1 }),
      rec({ status: "cancelled", finishedAt: NOW - 1 }),
      rec({ status: "failed", finishedAt: NOW - 1, failedAttempts: [{ error: "x" }] }),
    ]) {
      const before = { ...r };
      expect((await w.lifecycle.read(r)).transition).toBeUndefined();
      expect((await w.lifecycle.cancel(r)).transition).toBeUndefined();
      expect((await w.lifecycle.sweep([r])).transitions).toEqual([]);
      expect(r).toEqual(before);
    }
    expect(w.saved).toEqual([]);
    expect(w.count("probe")).toBe(0);
    expect(w.count("close")).toBe(0);
  });

  test("launchFailed throws on a non-running record", () => {
    const w = world();
    const r = rec({ status: "done", finishedAt: NOW - 1 });
    expect(() => w.lifecycle.launchFailed(r, { error: "boom" })).toThrow(/not running/);
    expect(w.saved).toEqual([]);
  });
});

describe("run lifecycle: sole writer of status/finishedAt/failedAttempts", () => {
  test("every terminal transition stamps the injected now()", async () => {
    const w = world();
    w.setNow(NOW + 5);
    const a = rec({ runId: "sub-000a" });
    const b = rec({ runId: "sub-000b" });
    const c = rec({ runId: "sub-000c" });
    await w.lifecycle.read(a);
    await w.lifecycle.cancel(b);
    w.lifecycle.launchFailed(c, { error: "e" });
    for (const r of [a, b, c]) expect(r.finishedAt).toBe(NOW + 5);
  });

  test("only launchFailed writes failedAttempts", async () => {
    const w = world();
    const a = rec({ runId: "sub-000a" });
    const b = rec({ runId: "sub-000b" });
    await w.lifecycle.read(a); // → failed (pane gone)
    await w.lifecycle.cancel(b);
    expect(a.failedAttempts).toBeUndefined();
    expect(b.failedAttempts).toBeUndefined();
    const c = rec({ runId: "sub-000c" });
    w.lifecycle.launchFailed(c, { model: "fallback/auto", error: "e" });
    expect(c.failedAttempts).toEqual([{ model: "fallback/auto", error: "e" }]);
  });
});

describe("run lifecycle: the completion predicate", () => {
  const classify = async (result: RunResult, sidecar = false): Promise<string> => {
    const w = world();
    w.results.set("sub-0001", [result]);
    if (sidecar) w.sidecars.add("sub-0001");
    const r = rec();
    await w.lifecycle.read(r);
    return r.status;
  };

  test("the sidecar alone qualifies", async () => {
    expect(await classify(NO_ANSWER, true)).toBe("done");
    expect(await classify(NO_SESSION, true)).toBe("done");
  });

  test("a clean answer qualifies", async () => {
    expect(await classify(CLEAN)).toBe("done");
  });

  test("answered:false does not qualify", async () => {
    expect(await classify(NO_ANSWER)).toBe("failed");
  });

  for (const label of ["earlier-message", "done-arguments", "truncated-answer", "non-conforming"] as const) {
    test(`salvage "${label}" does not qualify`, async () => {
      expect(await classify({ ...CLEAN, salvagedFrom: label })).toBe("failed");
    });
  }
});

describe("run lifecycle: reading a running record", () => {
  test("a live done pane without a signal stays running", async () => {
    const w = world();
    w.probes.set("w1:p1", [live("done")]);
    w.results.set("sub-0001", [NO_ANSWER]);
    const r = rec();
    const o = await w.lifecycle.read(r);
    expect(o.transition).toBeUndefined();
    expect(r.status).toBe("running");
    expect(o.pane).toEqual(live("done"));
    expect(w.count("delay")).toBe(0); // readiness is not a settle
    expect(w.saved).toEqual([]);
    expect(w.count("close")).toBe(0);
  });

  test("a live done pane with a signal finishes done", async () => {
    const w = world();
    w.probes.set("w1:p1", [live("done")]);
    w.results.set("sub-0001", [CLEAN]);
    const o = await w.lifecycle.read(rec());
    expect(o.transition).toMatchObject({ to: "done", cause: "completion-signal" });
  });

  test("a live working pane stays running without extraction", async () => {
    const w = world();
    w.probes.set("w1:p1", [live("working")]);
    const o = await w.lifecycle.read(rec());
    expect(o.transition).toBeUndefined();
    expect(w.count("extract")).toBe(0);
  });

  test("unreachable stays running, writes nothing, closes nothing, and keeps its error", async () => {
    const w = world();
    const probe: AgentProbe = { kind: "unreachable", error: "herdr exited 1" };
    w.probes.set("w1:p1", [probe]);
    w.results.set("sub-0001", [CLEAN]);
    w.sidecars.add("sub-0001");
    const r = rec();
    const o = await w.lifecycle.read(r);
    expect(r.status).toBe("running");
    expect(r.finishedAt).toBeUndefined();
    expect(o.transition).toBeUndefined();
    expect(o.pane).toEqual(probe);
    expect(w.saved).toEqual([]);
    expect(w.count("close")).toBe(0);
    expect(w.count("extract")).toBe(0);
  });

  test("gone with no signal fails, persists, and never closes the pane", async () => {
    const w = world();
    const r = rec();
    await w.lifecycle.read(r);
    expect(r.status).toBe("failed");
    expect(w.saved).toEqual([{ runId: "sub-0001", status: "failed", finishedAt: NOW, failedAttempts: undefined }]);
    expect(w.count("close")).toBe(0);
  });

  test("no recorded pane settles with cause no-pane, without a probe", async () => {
    const w = world();
    const o = await w.lifecycle.read(rec({ paneId: undefined }));
    expect(o.transition).toMatchObject({ to: "failed", cause: "no-pane" });
    expect(o.pane).toEqual({ kind: "none" });
    expect(w.count("probe")).toBe(0);
  });

  test("a positive signal found after no-pane still reports completion-signal", async () => {
    const w = world();
    w.results.set("sub-0001", [CLEAN]);
    const o = await w.lifecycle.read(rec({ paneId: undefined }));
    expect(o.transition).toMatchObject({ to: "done", cause: "completion-signal" });
  });
});

describe("run lifecycle: write ordering", () => {
  test("done: mutation → saveMeta → close", async () => {
    const w = world();
    w.results.set("sub-0001", [CLEAN]);
    const r = rec();
    w.setClose(async () => {
      // Mutation and save both happened before the close.
      expect(r.status).toBe("done");
      expect(w.saved.map((s) => s.status)).toEqual(["done"]);
      return true;
    });
    await w.lifecycle.read(r);
    expect(w.log.filter((l) => !l.startsWith("extract"))).toEqual(["probe w1:p1", "save sub-0001 done", "close w1:p1"]);
  });

  test("failed: saves but never closes", async () => {
    const w = world();
    await w.lifecycle.read(rec());
    expect(w.count("save")).toBe(1);
    expect(w.count("close")).toBe(0);
  });

  test("cancel: mutation → saveMeta → best-effort close; a failing close does not undo it", async () => {
    const w = world();
    const r = rec();
    w.setClose(async () => {
      expect(r.status).toBe("cancelled");
      expect(w.saved.map((s) => s.status)).toEqual(["cancelled"]);
      throw new Error("herdr hung");
    });
    const o = await w.lifecycle.cancel(r);
    expect(w.log).toEqual(["save sub-0001 cancelled", "close w1:p1"]);
    expect(o.transition?.to).toBe("cancelled");
    expect(r.status).toBe("cancelled");
    expect(r.finishedAt).toBe(NOW);
  });

  test("launchFailed writes pane ids, [attempt], status and timestamp before saving, and never closes", () => {
    const w = world();
    const r = rec({ paneId: undefined, tabId: undefined });
    const t = w.lifecycle.launchFailed(r, { model: "fallback/auto", error: "no ready" }, { paneId: "w2:p9", tabId: "w2:t3" });
    expect(t).toMatchObject({ from: "running", to: "failed", cause: "launch-failure", at: NOW });
    expect(r).toMatchObject({ paneId: "w2:p9", tabId: "w2:t3", status: "failed", finishedAt: NOW });
    expect(w.saved).toEqual([
      { runId: "sub-0001", status: "failed", finishedAt: NOW, failedAttempts: [{ model: "fallback/auto", error: "no ready" }] },
    ]);
    expect(w.count("close")).toBe(0);
  });

  test("launchFailed without a pane leaves the pane fields alone", () => {
    const w = world();
    const r = rec({ paneId: undefined });
    w.lifecycle.launchFailed(r, { error: "spawn failed" });
    expect(r.paneId).toBeUndefined();
    expect(r.tabId).toBeUndefined();
  });
});

describe("run lifecycle: settle", () => {
  test("found session, no signal: one extraction then exactly two delay/re-extract pairs", async () => {
    const w = world();
    w.results.set("sub-0001", [NO_ANSWER]);
    await w.lifecycle.read(rec());
    expect(w.log).toEqual([
      "probe w1:p1",
      "extract sub-0001",
      `delay ${SETTLE_DELAY_MS}`,
      "extract sub-0001",
      `delay ${SETTLE_DELAY_MS}`,
      "extract sub-0001",
      "save sub-0001 failed",
    ]);
    expect(SETTLE_DELAY_MS).toBe(750);
  });

  test("no session: no delay", async () => {
    const w = world();
    w.results.set("sub-0001", [NO_SESSION]);
    await w.lifecycle.read(rec());
    expect(w.count("delay")).toBe(0);
    expect(w.count("extract")).toBe(1);
  });

  test("evidence appearing mid-settle stops the retries and finishes done", async () => {
    const w = world();
    w.results.set("sub-0001", [NO_ANSWER, CLEAN]);
    const o = await w.lifecycle.read(rec());
    expect(w.count("delay")).toBe(1);
    expect(w.count("extract")).toBe(2);
    expect(o.transition?.to).toBe("done");
    expect(await o.result()).toEqual(CLEAN);
  });

  test("immediate evidence: no delay at all", async () => {
    const w = world();
    w.results.set("sub-0001", [CLEAN]);
    await w.lifecycle.read(rec());
    expect(w.count("delay")).toBe(0);
  });
});

describe("run lifecycle: bounded revival", () => {
  test("launch failures are never revival candidates", async () => {
    const w = world();
    w.results.set("sub-0001", [CLEAN]);
    w.sidecars.add("sub-0001");
    const r = rec({ status: "failed", finishedAt: NOW - 1000, failedAttempts: [{ error: "x" }] });
    const s = await w.lifecycle.sweep([r]);
    expect(s.transitions).toEqual([]);
    expect(w.log).toEqual([]);
  });

  test("a failed record older than six minutes is neither stamped nor extracted", async () => {
    const w = world();
    w.results.set("sub-0001", [CLEAN]);
    expect(REVIVAL_WINDOW_MS).toBe(6 * 60_000);
    const r = rec({ status: "failed", finishedAt: NOW - REVIVAL_WINDOW_MS - 1 });
    expect((await w.lifecycle.sweep([r])).transitions).toEqual([]);
    expect(w.log).toEqual([]);
    expect(r.status).toBe("failed");
  });

  test("a failed record with no finishedAt is bounded by startedAt", async () => {
    const w = world();
    w.results.set("sub-0001", [CLEAN]);
    const r = rec({ status: "failed", startedAt: NOW - REVIVAL_WINDOW_MS - 1 });
    expect((await w.lifecycle.sweep([r])).transitions).toEqual([]);
    expect(w.log).toEqual([]);
  });

  test("first examination counts as changed (even an undefined stamp); an unchanged stamp later costs one stamp call and no extraction", async () => {
    const w = world();
    w.results.set("sub-0001", [NO_ANSWER]);
    const r = rec({ status: "failed", finishedAt: NOW - 1000 });
    await w.lifecycle.sweep([r]);
    expect(w.log).toEqual(["stamp sub-0001", "extract sub-0001"]);
    w.log.length = 0;
    await w.lifecycle.sweep([r]);
    expect(w.log).toEqual(["stamp sub-0001"]);
    expect(r.status).toBe("failed");
    expect(w.saved).toEqual([]);
  });

  test("a changed stamp plus a signal revives to done, closes the pane, cause late-completion", async () => {
    const w = world();
    const r = rec({ status: "failed", finishedAt: NOW - 1000 });
    w.stamps.set("sub-0001", "10:1");
    w.results.set("sub-0001", [NO_ANSWER]);
    expect((await w.lifecycle.sweep([r])).transitions).toEqual([]);
    w.stamps.set("sub-0001", "42:2");
    w.results.set("sub-0001", [CLEAN]);
    w.setNow(NOW + 60_000);
    const s = await w.lifecycle.sweep([r]);
    expect(s.transitions).toHaveLength(1);
    expect(s.transitions[0]).toMatchObject({ from: "failed", to: "done", cause: "late-completion", at: NOW + 60_000 });
    expect(r).toMatchObject({ status: "done", finishedAt: NOW + 60_000 });
    expect(w.log.slice(-2)).toEqual(["save sub-0001 done", "close w1:p1"]);
    expect(await s.finished[0].result()).toEqual(CLEAN);
  });
});

describe("run lifecycle: serialization and results", () => {
  test("concurrent read() and cancel() on one run produce exactly one transition and one save", async () => {
    const w = world();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    w.setProbe(async () => {
      await gate;
      return GONE;
    });
    w.results.set("sub-0001", [CLEAN]);
    const r = rec();
    const reading = w.lifecycle.read(r);
    const cancelling = w.lifecycle.cancel(r);
    const reading2 = w.lifecycle.read(r);
    release();
    const [a, b, c] = await Promise.all([reading, cancelling, reading2]);
    const transitions = [a, b, c].filter((o) => o.transition);
    expect(transitions).toHaveLength(1);
    expect(a.transition?.to).toBe("done"); // the read was queued first
    expect(w.count("save")).toBe(1);
    expect(w.count("probe")).toBe(1);
  });

  test("result() reuses the reconciliation extraction and returns the same promise", async () => {
    const w = world();
    w.results.set("sub-0001", [CLEAN]);
    const o = await w.lifecycle.read(rec());
    const extracts = w.count("extract");
    const p1 = o.result();
    const p2 = o.result();
    expect(p1).toBe(p2);
    expect(await p1).toEqual(CLEAN);
    expect(w.count("extract")).toBe(extracts);
  });

  test("result() on a still-running read extracts at most once", async () => {
    const w = world();
    w.probes.set("w1:p1", [live("working")]);
    w.results.set("sub-0001", [CLEAN]);
    const o = await w.lifecycle.read(rec());
    expect(w.count("extract")).toBe(0);
    const p1 = o.result();
    const p2 = o.result();
    expect(p1).toBe(p2);
    await p1;
    expect(w.count("extract")).toBe(1);
  });

  test("result() on a live-done read reuses its evidence extraction", async () => {
    const w = world();
    w.probes.set("w1:p1", [live("done")]);
    w.results.set("sub-0001", [NO_ANSWER]);
    const o = await w.lifecycle.read(rec());
    await o.result();
    await o.result();
    expect(w.count("extract")).toBe(1);
  });
});

describe("run lifecycle: sweep", () => {
  test("preserves input order, isolates a throwing record, and never exceeds eight concurrent operations", async () => {
    const w = world();
    let inFlight = 0;
    let peak = 0;
    const recs = Array.from({ length: 20 }, (_, i) => rec({ runId: `sub-${String(i).padStart(4, "0")}`, paneId: `w1:p${i}` }));
    // Finish in reverse order so completion order differs from input order.
    w.setProbe(async (paneId) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      const i = Number(paneId.slice(4));
      for (let k = 0; k < 20 - i; k++) await Promise.resolve();
      inFlight--;
      if (i === 5) throw new Error("bad record");
      return i % 3 === 0 ? live("working") : GONE;
    });
    const s = await w.lifecycle.sweep(recs);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBe(8);
    const expected = recs.filter((_, i) => i !== 5 && i % 3 !== 0).map((r) => r.runId);
    expect(s.finished.map((o) => o.run.runId)).toEqual(expected);
    expect(s.transitions.map((t) => t.run.runId)).toEqual(expected);
    expect(recs[5].status).toBe("running");
  });

  test("exclude suppresses both running reconciliation and failed revival", async () => {
    const w = world();
    w.results.set("sub-000a", [CLEAN]);
    w.results.set("sub-000b", [CLEAN]);
    const a = rec({ runId: "sub-000a" });
    const b = rec({ runId: "sub-000b", status: "failed", finishedAt: NOW - 1000 });
    const s = await w.lifecycle.sweep([a, b], { exclude: new Set(["sub-000a", "sub-000b"]) });
    expect(s.transitions).toEqual([]);
    expect(w.log).toEqual([]);
  });

  test("still-running observations are not reported as finished", async () => {
    const w = world();
    w.probes.set("w1:p1", [live("working")]);
    const s = await w.lifecycle.sweep([rec()]);
    expect(s.finished).toEqual([]);
  });
});

describe("run lifecycle: no polling", () => {
  test("each read() performs at most one probe, and a working run never delays", async () => {
    const w = world();
    w.probes.set("w1:p1", [live("working")]);
    const r = rec();
    for (let i = 0; i < 3; i++) await w.lifecycle.read(r);
    expect(w.count("probe")).toBe(3);
    expect(w.count("delay")).toBe(0);
  });

  test("a gone settle probes once and delays a bounded twice, never more", async () => {
    const w = world();
    w.results.set("sub-0001", [NO_ANSWER]);
    await w.lifecycle.read(rec());
    expect(w.count("probe")).toBe(1);
    expect(w.count("delay")).toBe(2);
  });

  test("cancel and launchFailed never probe or delay", async () => {
    const w = world();
    await w.lifecycle.cancel(rec({ runId: "sub-000a" }));
    w.lifecycle.launchFailed(rec({ runId: "sub-000b" }), { error: "e" });
    expect(w.count("probe")).toBe(0);
    expect(w.count("delay")).toBe(0);
  });
});
