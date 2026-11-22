/**
 * Contract tests for the shared "is this run's work already on disk" READ,
 * against a hand-built deps bag: no `mock.module`, no temp directories, no
 * `node:fs`, no timers. Every dep counts its own calls and the stamp is a
 * mutable pair joined exactly as `evidenceStamp` joins a real session file's and
 * prompt file's size/mtime, so each rule is pinned by what the reader asked its
 * deps for — not by what it printed. That is the whole point of these tests:
 * the memo is a cost decision, so the assertions are call counts.
 */
import { describe, expect, test } from "bun:test";
import type { RunResult } from "./lib.js";
import type { RunRecord } from "./rundir.js";
import { createEvidenceReader, type RunEvidenceDeps } from "./run-evidence.js";

const T0 = 1_000_000_000;
const RUN = "sub-aaaa";
/** Two dirs, one run id — the case the key must not collapse. */
const DIR_A = "/runs-a/sub-aaaa";
const DIR_B = "/runs-b/sub-aaaa";

const NO_ANSWER: RunResult = { found: true, answered: false, text: "", sessionFile: "s.jsonl" };
const answer = (text = "<result>done</result>"): RunResult => ({
  found: true,
  answered: true,
  text,
  sessionFile: "s.jsonl",
});

/** The stamp shape `evidenceStamp` returns: session stamp, NUL, prompt stamp. */
const stampOf = (session: string, prompt: string): string => `${session}\u0000${prompt}`;
const STAMP = stampOf("4096:1000", "512:2000");

function child(over: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    agent: "worker",
    task: "t",
    cwd: "/w",
    status: "running",
    startedAt: T0 - 60_000,
    parentRunId: RUN,
    ...over,
  };
}

/**
 * The fixture: a sidecarless run in `DIR_A` with an unanswered transcript and no
 * spawns. Each knob is a field on `state`; `counts` is what these tests assert.
 */
function world() {
  const counts = { sidecar: 0, stamp: 0, extract: 0, candidates: 0, now: 0 };
  const state = {
    sidecar: false,
    /** Per-dir stamp; unset dirs answer the base `STAMP`. */
    stamps: new Map<string, string | undefined>(),
    /** What the transcript extraction returns for ANY dir. */
    answer: NO_ANSWER as RunResult,
    candidates: [] as { rec: RunRecord; dir: string }[],
    now: T0,
    setStamp(dir: string, stamp: string | undefined): void {
      state.stamps.set(dir, stamp);
    },
  };
  const deps: RunEvidenceDeps = {
    hasExitSidecar: (_dir, _runId) => {
      counts.sidecar++;
      return state.sidecar;
    },
    evidenceStamp: (dir, _runId) => {
      counts.stamp++;
      return state.stamps.has(dir) ? state.stamps.get(dir) : STAMP;
    },
    extractRunResult: async (_dir, _runId, tailBytes) => {
      counts.extract++;
      // The tail cap is part of the contract: the evidence read is bounded.
      expect(typeof tailBytes).toBe("number");
      return state.answer;
    },
    allRunCandidates: () => {
      counts.candidates++;
      return state.candidates;
    },
    now: () => {
      counts.now++;
      return state.now;
    },
  };
  return { counts, state, reader: createEvidenceReader(deps) };
}

describe("completionEvidence", () => {
  test("the .exit sidecar answers before the stamp, the transcript and the memo", async () => {
    const { counts, state, reader } = world();
    state.sidecar = true;

    const first = await reader.completionEvidence(DIR_A, RUN);
    expect(first).toEqual({ finished: true, from: "sidecar" });
    // Short-circuited: no fingerprint read, no transcript read.
    expect(counts.stamp).toBe(0);
    expect(counts.extract).toBe(0);
    // And the second call goes back to the disk too: the sidecar is checked
    // BEFORE the map, so a sidecar verdict is never served from the memo (and a
    // run whose sidecar was already on disk never adds a key).
    const second = await reader.completionEvidence(DIR_A, RUN);
    expect(second).toEqual({ finished: true, from: "sidecar" });
    expect(counts.sidecar).toBe(2);
    expect(counts.stamp).toBe(0);
    expect(counts.extract).toBe(0);
  });

  test("a sidecarless verdict is memoized on the stamp", async () => {
    const { counts, state, reader } = world();
    state.answer = answer();

    const first = await reader.completionEvidence(DIR_A, RUN);
    expect(first).toEqual({ finished: true, from: "answer", result: state.answer });
    const second = await reader.completionEvidence(DIR_A, RUN);
    // The SAME object, not a re-computed equal one — the point of the memo.
    expect(second).toBe(first);
    expect(counts.extract).toBe(1);
  });

  test("a negative verdict is stored too", async () => {
    const { counts, reader } = world();

    const first = await reader.completionEvidence(DIR_A, RUN);
    expect(first).toEqual({ finished: false });
    const second = await reader.completionEvidence(DIR_A, RUN);
    expect(second).toBe(first);
    expect(counts.extract).toBe(1);
  });

  test("a moved transcript re-proves", async () => {
    const { counts, state, reader } = world();

    const first = await reader.completionEvidence(DIR_A, RUN);
    expect(first).toEqual({ finished: false });

    // Only the session half of the fingerprint moves; the prompt half is equal.
    state.setStamp(DIR_A, stampOf("9216:1500", "512:2000"));
    const second = await reader.completionEvidence(DIR_A, RUN);
    expect(counts.extract).toBe(2);
    expect(second).not.toBe(first);
  });

  test("only the prompt file moving re-proves", async () => {
    const { counts, state, reader } = world();

    await reader.completionEvidence(DIR_A, RUN);
    // The session half is byte-for-byte the same stamp; the `<result>` contract
    // the answer is judged against changed, and that alone must re-prove.
    state.setStamp(DIR_A, stampOf("4096:1000", "990:3000"));
    await reader.completionEvidence(DIR_A, RUN);
    expect(counts.extract).toBe(2);
  });

  test("the key carries the dir, so a second dir is not served the first verdict", async () => {
    const { counts, state, reader } = world();

    // `DIR_A` is answered `not finished` and that negative is now memoized.
    const inA = await reader.completionEvidence(DIR_A, RUN);
    expect(inA).toEqual({ finished: false });
    expect(counts.extract).toBe(1);

    // Same run id, a different dir, the SAME stamp, and a transcript that does
    // answer. A run-id-only key would serve `DIR_A`'s stale negative here.
    state.answer = answer();
    const inB = await reader.completionEvidence(DIR_B, RUN, "pane-1");
    expect(inB).toEqual({ finished: true, from: "answer", result: state.answer });
    expect(counts.extract).toBe(2);
  });

  test("a pending spawn holds a clean answer, read off the deps' clock", async () => {
    const { counts, state, reader } = world();
    state.answer = answer();
    state.candidates = [{ rec: child({ runId: "sub-bbbb" }), dir: "/runs-a/sub-bbbb" }];

    const verdict = await reader.completionEvidence(DIR_A, RUN, "pane-1");
    expect(verdict).toEqual({ finished: false });
    // The candidate set and the clock are the deps', not a module-level import,
    // so the reader never enumerates the registry on its own.
    expect(counts.candidates).toBe(1);
    expect(counts.now).toBe(1);
  });

  test("a finished spawn releases the verdict", async () => {
    const { counts, state, reader } = world();
    state.answer = answer();
    state.candidates = [
      { rec: child({ runId: "sub-bbbb", status: "done", finishedAt: T0 - 1000 }), dir: "/runs-a/sub-bbbb" },
    ];

    expect(await reader.completionEvidence(DIR_A, RUN, "pane-1")).toEqual({
      finished: true,
      from: "answer",
      result: state.answer,
    });
    expect(counts.candidates).toBe(1);
  });
});

describe("inferredFromClause", () => {
  test("names the two sources with the exact display wording", async () => {
    const { reader } = world();
    // Byte-identical to what the `status` and `result` arms printed before the
    // clause moved here; the lead word ("done ("/"completed (") stays with the arm.
    expect(reader.inferredFromClause("sidecar")).toBe(
      "the .exit sidecar is on disk, not settled by this pane",
    );
    expect(reader.inferredFromClause("answer")).toBe(
      "final answer in transcript, not settled by this pane",
    );
  });
});
