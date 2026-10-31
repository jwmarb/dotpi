/**
 * Contract tests for the running-parent proof, against a hand-built effects
 * object: no `mock.module`, no temp directories, no timers. The clock is a
 * mutable `t` read by `now()`, and every effect counts its calls, so the memo
 * policy (positives only, a sidecar proof stands, an answer proof expires at
 * the TTL) is pinned by what the proof asked its effects for.
 */
import { describe, expect, test } from "bun:test";
import type { AgentProbe } from "./herdr.js";
import {
  createParentProof,
  PARENT_PROOF_TTL_MS,
  type ParentProofEffects,
  WAKE_PROBE_TIMEOUT_MS,
} from "./parent-proof.js";
import { LIVENESS_BACKSTOP_MS } from "./release-ledger.js";
import type { RunRecord } from "./rundir.js";

const T0 = 1_000_000_000;
const PARENT = "sub-96ba";

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: PARENT,
    agent: "worker",
    task: "t",
    cwd: "/w",
    paneId: "p1",
    status: "running",
    startedAt: T0 - 60_000,
    ...over,
  };
}

type Evidence = Awaited<ReturnType<ParentProofEffects["completionEvidence"]>>;

/**
 * The base fixture: nothing in the registry, a `running` record on disk with
 * pane `p1`, a `gone` pane, and answer-inferred completion evidence. Each
 * field can be replaced; every effect counts its calls in `counts`.
 */
function world(over: Partial<ParentProofEffects> = {}) {
  let t = T0;
  const counts = { registry: 0, owned: 0, dirFor: 0, disk: 0, probe: 0, evidence: 0 };
  const probeTimeouts: number[] = [];
  const effects: ParentProofEffects = {
    registryRecord: (id) => {
      counts.registry++;
      return over.registryRecord?.(id);
    },
    isOwned: (r) => {
      counts.owned++;
      return over.isOwned?.(r) ?? true;
    },
    dirFor: (id) => {
      counts.dirFor++;
      return over.dirFor?.(id) ?? `/runs/${id}`;
    },
    findOnDisk: (id) => {
      counts.disk++;
      return over.findOnDisk ? over.findOnDisk(id) : { rec: rec(), dir: `/runs/${id}` };
    },
    probe: async (pane, timeoutMs) => {
      counts.probe++;
      probeTimeouts.push(timeoutMs);
      return over.probe ? over.probe(pane, timeoutMs) : { kind: "gone" };
    },
    completionEvidence: async (dir, id) => {
      counts.evidence++;
      return over.completionEvidence
        ? over.completionEvidence(dir, id)
        : { finished: true, from: "answer" };
    },
    now: () => t,
  };
  return {
    proof: createParentProof(effects),
    counts,
    probeTimeouts,
    set: (at: number) => {
      t = at;
    },
  };
}

describe("createParentProof: the memo", () => {
  test("a cached positive inside the TTL is served without re-proving", async () => {
    const w = world();
    expect(await w.proof(PARENT)).toEqual({ finished: true, status: "running" });
    w.set(T0 + PARENT_PROOF_TTL_MS - 1);
    expect(await w.proof(PARENT)).toEqual({ finished: true, status: "running" });
    expect(w.counts.probe).toBe(1);
    expect(w.counts.evidence).toBe(1);
  });

  test("an answer-inferred positive expires at the TTL and re-proves", async () => {
    const w = world();
    await w.proof(PARENT);
    w.set(T0 + PARENT_PROOF_TTL_MS);
    expect(await w.proof(PARENT)).toEqual({ finished: true, status: "running" });
    expect(w.counts.evidence).toBe(2);
    expect(w.counts.probe).toBe(2);
  });

  test("a sidecar-proven positive stands past the TTL", async () => {
    const w = world({ completionEvidence: async () => ({ finished: true, from: "sidecar" }) });
    await w.proof(PARENT);
    w.set(T0 + 10 * PARENT_PROOF_TTL_MS);
    expect(await w.proof(PARENT)).toEqual({ finished: true, status: "running" });
    expect(w.counts.probe).toBe(1);
    expect(w.counts.evidence).toBe(1);
  });

  test("a negative is never cached: the next call re-proves and sees the transition", async () => {
    const answers: Evidence[] = [{ finished: false }, { finished: true, from: "answer" }];
    const w = world({ completionEvidence: async () => answers.shift()! });
    expect(await w.proof(PARENT)).toEqual({ finished: false, status: "running" });
    expect(await w.proof(PARENT)).toEqual({ finished: true, status: "running" });
    expect(w.counts.evidence).toBe(2);
  });

  test("the memo is per factory call: a second proof starts empty", async () => {
    const a = world();
    await a.proof(PARENT);
    const b = world();
    await b.proof(PARENT);
    expect(b.counts.evidence).toBe(1);
  });

  test("the TTL is the liveness backstop", () => {
    expect(PARENT_PROOF_TTL_MS).toBe(LIVENESS_BACKSTOP_MS);
  });
});

describe("createParentProof: the live-pane and failure paths", () => {
  const live: AgentProbe[] = [
    { kind: "unreachable", error: null },
    { kind: "unreachable", error: "herdr timed out" },
    { kind: "state", status: "working", name: "worker" },
    { kind: "state", status: "done", name: undefined },
  ];
  for (const pane of live) {
    test(`a ${pane.kind}${pane.kind === "state" ? `/${pane.status}` : ""} pane answers false without reading evidence`, async () => {
      const w = world({ probe: async () => pane });
      expect(await w.proof(PARENT)).toEqual({ finished: false, status: "running" });
      expect(w.counts.evidence).toBe(0);
      expect(w.probeTimeouts).toEqual([WAKE_PROBE_TIMEOUT_MS]);
      // A negative is not cached: a second call probes again.
      await w.proof(PARENT);
      expect(w.counts.probe).toBe(2);
    });
  }

  test("the probe is bounded at 5 s, not the module-wide 30 s", () => {
    expect(WAKE_PROBE_TIMEOUT_MS).toBe(5_000);
  });

  test("a disk read that throws answers false with status absent", async () => {
    const w = world({
      findOnDisk: () => {
        throw new Error("boom");
      },
    });
    expect(await w.proof(PARENT)).toEqual({ finished: false, status: "absent" });
  });

  test("an evidence read that rejects answers false from the record in hand, and caches nothing", async () => {
    let fail = true;
    const w = world({
      completionEvidence: async () => {
        if (fail) throw new Error("boom");
        return { finished: true, from: "answer" };
      },
    });
    expect(await w.proof(PARENT)).toEqual({ finished: false, status: "running" });
    fail = false;
    expect(await w.proof(PARENT)).toEqual({ finished: true, status: "running" });
    expect(w.counts.probe).toBe(2);
  });
});

describe("createParentProof: the record lookup", () => {
  test("a terminal disk record answers true without probing", async () => {
    for (const status of ["done", "failed", "cancelled"] as const) {
      const w = world({ findOnDisk: (id) => ({ rec: rec({ status }), dir: `/runs/${id}` }) });
      expect(await w.proof(PARENT)).toEqual({ finished: true, status });
      expect(w.counts.probe).toBe(0);
      expect(w.counts.evidence).toBe(0);
    }
  });

  test("an owned terminal registry copy is trusted: the disk is not read", async () => {
    const w = world({ registryRecord: () => rec({ status: "done" }), isOwned: () => true });
    expect(await w.proof(PARENT)).toEqual({ finished: true, status: "done" });
    expect(w.counts.disk).toBe(0);
    expect(w.counts.dirFor).toBe(1);
  });

  test("a foreign terminal registry copy falls through to the disk read", async () => {
    const w = world({ registryRecord: () => rec({ status: "done" }), isOwned: () => false });
    expect(await w.proof(PARENT)).toEqual({ finished: true, status: "running" });
    expect(w.counts.disk).toBe(1);
  });

  test("an owned running registry copy falls through to the disk read", async () => {
    const w = world({
      registryRecord: () => rec({ status: "running" }),
      findOnDisk: (id) => ({ rec: rec({ status: "done" }), dir: `/runs/${id}` }),
    });
    expect(await w.proof(PARENT)).toEqual({ finished: true, status: "done" });
    expect(w.counts.disk).toBe(1);
    // The running copy is not even asked about ownership: status decides first.
    expect(w.counts.owned).toBe(0);
  });

  test("nothing found answers false with status absent", async () => {
    const w = world({ findOnDisk: () => undefined });
    expect(await w.proof(PARENT)).toEqual({ finished: false, status: "absent" });
    expect(w.counts.probe).toBe(0);
  });

  test("a paneless running record skips the probe and reads evidence", async () => {
    const w = world({ findOnDisk: (id) => ({ rec: rec({ paneId: undefined }), dir: `/runs/${id}` }) });
    expect(await w.proof(PARENT)).toEqual({ finished: true, status: "running" });
    expect(w.counts.probe).toBe(0);
    expect(w.counts.evidence).toBe(1);
  });

  test("the evidence read gets the dir the lookup resolved", async () => {
    const dirs: string[] = [];
    const w = world({
      findOnDisk: () => ({ rec: rec(), dir: "/switched/sub-96ba" }),
      completionEvidence: async (dir) => {
        dirs.push(dir);
        return { finished: false };
      },
    });
    await w.proof(PARENT);
    expect(dirs).toEqual(["/switched/sub-96ba"]);
  });
});
