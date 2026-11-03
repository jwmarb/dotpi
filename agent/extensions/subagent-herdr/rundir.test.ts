/**
 * Contract tests for the shared on-disk pieces of `rundir.ts` that read the run
 * dir: the pending-spawn predicate both halves of the handshake apply, the
 * parent relation it selects on, and the completion-sidecar timestamp reader.
 *
 * These need real directories — "the sidecar is on disk" is decided by a
 * `readdirSync`, and no injected stub would pin the name rule that decides it.
 *
 * Run from the repo root: `bun test agent/extensions/subagent-herdr/rundir.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFER_MAX_MS,
  REVIVAL_WINDOW_MS,
  hasExitSidecar,
  isTerminalRecord,
  launchedBy,
  pendingSpawnsOf,
  readExitSidecarAt,
  type RunRecord,
} from "./rundir.js";

const NOW = 1_700_000_000_000;

/** One record, with the fields the predicates actually consult defaulted. */
function record(over: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    agent: "worker",
    task: "t",
    cwd: "/w",
    status: "running",
    startedAt: NOW - 60_000,
    ...over,
  };
}

/**
 * A run dir named after its id, holding pi's session-file name for that run and
 * — when `sidecarAt` is given — its `.exit` sidecar carrying that `at`.
 */
function makeRunDir(base: string, runId: string, sidecarAt?: unknown): string {
  const dir = join(base, runId);
  mkdirSync(dir, { recursive: true });
  const session = `1700000000000_${runId}.jsonl`;
  writeFileSync(join(dir, session), "{}\n");
  if (sidecarAt !== undefined) {
    writeFileSync(join(dir, `${session}.exit`), JSON.stringify({ type: "done", at: sidecarAt }));
  }
  return dir;
}

/** A candidate in the shape `pendingSpawnsOf` takes, with its dir on disk. */
function candidate(
  base: string,
  over: Partial<RunRecord> & { runId: string },
  /** Write the candidate's `.exit` sidecar on disk (the record says nothing). */
  sidecar = false,
): { rec: RunRecord; dir: string } {
  const dir = makeRunDir(base, over.runId, sidecar ? NOW - 30_000 : undefined);
  return { rec: record(over), dir };
}

describe("pendingSpawnsOf", () => {
  test("a spawn stamped with this run and no sidecar is pending", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    const c = candidate(base, { runId: "sub-bbbb", parentRunId: "sub-aaaa" });
    expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [c], NOW).map((r) => r.runId)).toEqual(["sub-bbbb"]);
    expect(hasExitSidecar(c.dir, "sub-bbbb")).toBe(false);
  });

  test("the same spawn with its sidecar on disk is not pending", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    const c = candidate(base, { runId: "sub-bbbb", parentRunId: "sub-aaaa" }, true);
    expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [c], NOW)).toEqual([]);
    expect(hasExitSidecar(c.dir, "sub-bbbb")).toBe(true);
  });

  test("a terminal record with no sidecar releases the parent — no sidecar is ever coming", () => {
    // The rule the strict sidecar-only version got wrong: a cancelled spawn or a
    // launch that died before its process started can never write a sidecar, so
    // holding the worker for the whole DEFER_MAX over it defeated the liveness
    // tick that exists to end the wait. 4 such nested records sit on disk.
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    for (const status of ["done", "cancelled"] as const) {
      const c = candidate(base, { runId: "sub-bbbb", parentRunId: "sub-aaaa", status });
      expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [c], NOW)).toEqual([]);
      expect(hasExitSidecar(c.dir, "sub-bbbb")).toBe(false);
    }
    // `failed` with a failed launch attempt: the process never started, so no
    // sidecar is ever coming either.
    const failed = candidate(base, {
      runId: "sub-bbbb",
      parentRunId: "sub-aaaa",
      status: "failed",
      failedAttempts: [{ model: "test/model", error: "launch failed" }],
    });
    expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [failed], NOW)).toEqual([]);
  });

  test("a bare `failed` (no failedAttempts) is pending inside the revival window, released once it has run", () => {
    // The lifecycle declares `failed → done` legal exactly while failedAttempts is
    // absent AND the revival window has not run. So a bare `failed` keeps holding
    // while it is still recoverable, and releases the waiting parent once
    // `finishedAt` is older than `REVIVAL_WINDOW_MS`.
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    // Inside the window: settled a minute ago → still recoverable → pending.
    const fresh = candidate(base, {
      runId: "sub-bbbb",
      parentRunId: "sub-aaaa",
      status: "failed",
      finishedAt: NOW - 60_000,
    });
    expect(isTerminalRecord(fresh.rec, NOW)).toBe(false);
    expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [fresh], NOW).map((r) => r.runId)).toEqual(["sub-bbbb"]);
    // Exactly at the edge: `now - finishedAt >= REVIVAL_WINDOW_MS` → terminal.
    const atEdge = candidate(base, {
      runId: "sub-bbbb",
      parentRunId: "sub-aaaa",
      status: "failed",
      finishedAt: NOW - REVIVAL_WINDOW_MS,
    });
    expect(isTerminalRecord(atEdge.rec, NOW)).toBe(true);
    expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [atEdge], NOW)).toEqual([]);
    // Past the window: released, regardless of the DEFER_MAX age.
    const past = candidate(base, {
      runId: "sub-bbbb",
      parentRunId: "sub-aaaa",
      status: "failed",
      finishedAt: NOW - REVIVAL_WINDOW_MS - 1,
    });
    expect(isTerminalRecord(past.rec, NOW)).toBe(true);
    expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [past], NOW)).toEqual([]);
  });

  test("a bare `failed` with a missing or non-finite `finishedAt` is still pending", () => {
    // Too broken to say when it closed: the record keeps holding rather than
    // releasing on an untrusted timestamp.
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    for (const finishedAt of [undefined, Number.NaN, Number.POSITIVE_INFINITY] as const) {
      const c = candidate(base, {
        runId: "sub-bbbb",
        parentRunId: "sub-aaaa",
        status: "failed",
        finishedAt: finishedAt as number | undefined,
      });
      expect(isTerminalRecord(c.rec, NOW)).toBe(false);
      expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [c], NOW).map((r) => r.runId)).toEqual(["sub-bbbb"]);
    }
  });

  test("a missing or unrecognised status is NOT terminal — a broken record keeps holding", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    for (const status of [undefined, "bogus", 42]) {
      const c = candidate(base, {
        runId: "sub-bbbb",
        parentRunId: "sub-aaaa",
        status: status as unknown as RunRecord["status"],
      });
      expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [c], NOW).map((r) => r.runId)).toEqual(["sub-bbbb"]);
    }
  });

  test("isTerminalRecord: the pending rule's record-level terminal test", () => {
    const rec = (over: Partial<RunRecord>): RunRecord =>
      ({ runId: "sub-bbbb", agent: "w", task: "t", cwd: "/w", status: "running", startedAt: NOW, ...over });
    expect(isTerminalRecord(rec({ status: "done" }), NOW)).toBe(true);
    expect(isTerminalRecord(rec({ status: "cancelled" }), NOW)).toBe(true);
    // A failed launch attempt is terminal now, regardless of the revival window.
    expect(isTerminalRecord(rec({ status: "failed", failedAttempts: [{ error: "x" }] }), NOW)).toBe(true);
    // A bare `failed` with no usable `finishedAt` is pending (too broken to release).
    expect(isTerminalRecord(rec({ status: "failed" }), NOW)).toBe(false);
    // ...and one settled past the revival window is terminal.
    expect(isTerminalRecord(rec({ status: "failed", finishedAt: NOW - REVIVAL_WINDOW_MS - 1 }), NOW)).toBe(true);
    expect(isTerminalRecord(rec({}), NOW)).toBe(false);
    for (const status of [undefined, "bogus", 42]) {
      expect(isTerminalRecord(rec({ status: status as unknown as RunRecord["status"] }), NOW)).toBe(false);
    }
  });

  test("a legacy record with no stamp matches on its owning pane", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    const c = candidate(base, { runId: "sub-bbbb", ownerPane: "w1:p7" });
    expect(pendingSpawnsOf({ runId: "sub-aaaa", paneId: "w1:p7" }, [c], NOW).map((r) => r.runId)).toEqual([
      "sub-bbbb",
    ]);
    // The same record does not belong to a run that was not in that pane.
    expect(pendingSpawnsOf({ runId: "sub-aaaa", paneId: "w1:p8" }, [c], NOW)).toEqual([]);
    // Or to a process that does not know its own pane.
    expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [c], NOW)).toEqual([]);
  });

  test("a stamped parent wins over a matching pane", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    const c = candidate(base, { runId: "sub-bbbb", parentRunId: "sub-cccc", ownerPane: "w1:p7" });
    expect(pendingSpawnsOf({ runId: "sub-aaaa", paneId: "w1:p7" }, [c], NOW)).toEqual([]);
    expect(pendingSpawnsOf({ runId: "sub-cccc", paneId: "w1:other" }, [c], NOW).map((r) => r.runId)).toEqual([
      "sub-bbbb",
    ]);
  });

  test("a spawn past DEFER_MAX_MS is no longer pending", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    const c = candidate(base, {
      runId: "sub-bbbb",
      parentRunId: "sub-aaaa",
      startedAt: NOW - DEFER_MAX_MS,
    });
    expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [c], NOW)).toEqual([]);
    // One ms inside the bound it is pending again: the bound is the record's
    // own age, not the caller's clock.
    expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [c], NOW - 1).map((r) => r.runId)).toEqual(["sub-bbbb"]);
  });

  test("a record that cannot say when it started is expired, not eternal", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    const c = candidate(base, { runId: "sub-bbbb", parentRunId: "sub-aaaa" });
    c.rec.startedAt = undefined as unknown as number;
    expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [c], NOW)).toEqual([]);
    c.rec.startedAt = Number.NaN;
    expect(pendingSpawnsOf({ runId: "sub-aaaa" }, [c], NOW)).toEqual([]);
  });

  test("a corrupted `parentRunId` falls back to the pane relation", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    const c = candidate(base, { runId: "sub-bbbb", ownerPane: "w1:p7" });
    c.rec.parentRunId = 42 as unknown as string;
    expect(pendingSpawnsOf({ runId: "sub-aaaa", paneId: "w1:p7" }, [c], NOW).map((r) => r.runId)).toEqual([
      "sub-bbbb",
    ]);
  });

  test("a run is never its own spawn", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    const c = candidate(base, { runId: "sub-aaaa", ownerPane: "w1:p7", parentRunId: "sub-aaaa" });
    expect(pendingSpawnsOf({ runId: "sub-aaaa", paneId: "w1:p7" }, [c], NOW)).toEqual([]);
  });

  test("unrelated records are not spawns", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    const c = candidate(base, { runId: "sub-bbbb", parentRunId: "sub-zzzz" });
    const d = candidate(base, { runId: "sub-cccc" });
    expect(pendingSpawnsOf({ runId: "sub-aaaa", paneId: "w1:p7" }, [c, d], NOW)).toEqual([]);
  });

  test("a planted sidecar-less record cannot hold a run open past DEFER_MAX_MS", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-pending-"));
    // Hostile shape: a valid-looking record whose pane relation matches, stamped
    // a moment ago. It holds the parent open for DEFER_MAX_MS and no longer.
    const c = candidate(base, { runId: "sub-bbbb", ownerPane: "w1:p7", startedAt: NOW });
    expect(pendingSpawnsOf({ runId: "sub-aaaa", paneId: "w1:p7" }, [c], NOW).map((r) => r.runId)).toEqual([
      "sub-bbbb",
    ]);
    expect(
      pendingSpawnsOf({ runId: "sub-aaaa", paneId: "w1:p7" }, [c], NOW + DEFER_MAX_MS + 1),
    ).toEqual([]);
  });
});

describe("launchedBy", () => {
  test("an absent pane on the asking side matches nothing", () => {
    expect(launchedBy(record({ runId: "sub-bbbb", ownerPane: "w1:p7" }), { runId: "sub-aaaa" })).toBe(false);
    expect(launchedBy(record({ runId: "sub-bbbb" }), { runId: "sub-aaaa", paneId: undefined })).toBe(false);
  });

  test("an empty `parentRunId` is a present value, and it matches no run", () => {
    expect(
      launchedBy(record({ runId: "sub-bbbb", parentRunId: "", ownerPane: "w1:p7" }), {
        runId: "sub-aaaa",
        paneId: "w1:p7",
      }),
    ).toBe(false);
  });
});

describe("readExitSidecarAt", () => {
  test("reads the `at` of the sidecar beside the run's session file", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-sidecar-"));
    const dir = makeRunDir(base, "sub-a3f1", 123);
    expect(readExitSidecarAt(dir, "sub-a3f1")).toBe(123);
  });

  test("malformed JSON, a non-numeric `at`, and a missing sidecar are all undefined", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-sidecar-"));
    const dir = makeRunDir(base, "sub-a3f1");
    const session = join(dir, "1700000000000_sub-a3f1.jsonl");
    expect(readExitSidecarAt(dir, "sub-a3f1")).toBeUndefined();

    writeFileSync(`${session}.exit`, "{not json");
    expect(readExitSidecarAt(dir, "sub-a3f1")).toBeUndefined();

    writeFileSync(`${session}.exit`, JSON.stringify({ type: "done", at: "x" }));
    expect(readExitSidecarAt(dir, "sub-a3f1")).toBeUndefined();

    writeFileSync(`${session}.exit`, JSON.stringify({ type: "done", at: Infinity }));
    expect(readExitSidecarAt(dir, "sub-a3f1")).toBeUndefined();

    writeFileSync(`${session}.exit`, "null");
    expect(readExitSidecarAt(dir, "sub-a3f1")).toBeUndefined();
  });

  test("a missing or unreadable directory is undefined, not a throw", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-sidecar-"));
    expect(readExitSidecarAt(join(base, "sub-nope"), "sub-nope")).toBeUndefined();
    const dir = makeRunDir(base, "sub-b0b0");
    // A sidecar for a session file that is not this run's does not count.
    writeFileSync(join(dir, "1700000000000_sub-other.jsonl.exit"), JSON.stringify({ type: "done", at: 1 }));
    expect(readExitSidecarAt(dir, "sub-b0b0")).toBeUndefined();
  });

  test("the sidecar reader agrees with `hasExitSidecar`", () => {
    const base = mkdtempSync(join(tmpdir(), "rundir-sidecar-"));
    const withSidecar = makeRunDir(base, "sub-1111", 7);
    expect(hasExitSidecar(withSidecar, "sub-1111")).toBe(true);
    expect(readExitSidecarAt(withSidecar, "sub-1111")).toBe(7);
    const bare = makeRunDir(base, "sub-2222");
    expect(hasExitSidecar(bare, "sub-2222")).toBe(false);
    expect(readExitSidecarAt(bare, "sub-2222")).toBeUndefined();
  });

  test("a resumed dir with two settled transcripts answers from the newest sidecar", () => {
    // `pickSessionName`'s rule: the newest settled transcript is the run's
    // answer, so its sidecar's `at` is what gets stamped — not whichever
    // file the directory enumeration surfaced first.
    const base = mkdtempSync(join(tmpdir(), "rundir-sidecar-"));
    const dir = makeRunDir(base, "sub-c1c1", 100);
    const newer = `1700000009999_sub-c1c1.jsonl`;
    writeFileSync(join(dir, newer), "{}\n");
    writeFileSync(join(dir, `${newer}.exit`), JSON.stringify({ type: "done", at: 200 }));
    expect(readExitSidecarAt(dir, "sub-c1c1")).toBe(200);

    // A broken newest sidecar is the settled transcript's sidecar: a sidecar
    // nobody can read proves nothing, so the older one's `at` does not shadow
    // it.
    writeFileSync(join(dir, `${newer}.exit`), "{not json");
    expect(readExitSidecarAt(dir, "sub-c1c1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The cost of the record-level terminal rule, checked against the recorded
// corpus — read-only: a scan of meta.json and sidecars, nothing written.
// ---------------------------------------------------------------------------

const REAL_RUNS = join(import.meta.dir, "..", "..", "subagent-runs");

describe.skipIf(!existsSync(REAL_RUNS))("isTerminalRecord against the recorded corpus", () => {
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

  test("the four nested records the terminal arm legitimately releases are all released", () => {
    const names = readdirSync(REAL_RUNS).filter((n) => /^sub-[0-9a-f]{4}$/.test(n));
    const recs: RunRecord[] = [];
    const sidecarAt = new Map<string, number | undefined>();
    for (const name of names) {
      const dir = join(REAL_RUNS, name);
      try {
        const rec = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8")) as RunRecord;
        if (rec.runId === name) recs.push(rec);
      } catch {
        continue;
      }
      let at: number | undefined;
      try {
        for (const n of readdirSync(dir)) {
          if (n.endsWith(`_${name}.jsonl`) && readdirSync(dir).includes(`${n}.exit`)) {
            at = (JSON.parse(readFileSync(join(dir, `${n}.exit`), "utf-8")) as { at?: unknown }).at;
            if (!finite(at)) at = undefined;
          }
        }
      } catch {
        at = undefined;
      }
      sidecarAt.set(name, at);
    }

    const nested = (r: RunRecord) =>
      typeof r.parentRunId === "string" || typeof r.ownerPane === "string";

    // The 4 such nested records on disk (3 cancelled + 1 failed WITH a failed
    // launch attempt): the terminal arm releases them, and none may be lost by
    // the record-level rule.
    const cancelled = recs.filter((r) => r.status === "cancelled" && nested(r));
    const failedWithAttempt = recs.filter(
      (r) => r.status === "failed" && r.failedAttempts !== undefined && nested(r),
    );
    // Floors, not exact counts: the live dir grows with every nested run, so an
    // exact pin turns the next cancelled grader into a red suite. What must hold
    // on ANY corpus is the loop below — every such record releases its parent.
    // The exact quadruple is pinned on the frozen fixture in settle-stuck.test.ts.
    expect(cancelled.length).toBeGreaterThanOrEqual(3);
    expect(failedWithAttempt.length).toBeGreaterThanOrEqual(1);
    for (const r of [...cancelled, ...failedWithAttempt]) expect(isTerminalRecord(r, Date.now())).toBe(true);

    // The other half, on the same corpus: 19 records settled `failed` went on to
    // write a sidecar; the 12 WITHOUT failedAttempts are the lifecycle's
    // recoverable state. The rule now releases them only once REVIVAL_WINDOW_MS
    // has run since they settled (`finishedAt`) — every one here is far older
    // than six minutes, so at the current time the rule releases all 12. (The
    // old rule held each for the whole DEFER_MAX; this is the intended change.)
    const failedThenSidecar = recs.filter(
      (r) => r.status === "failed" && sidecarAt.get(r.runId) !== undefined,
    );
    expect(failedThenSidecar.length).toBeGreaterThanOrEqual(19);
    const recoverable = failedThenSidecar.filter((r) => r.failedAttempts === undefined);
    expect(recoverable.length).toBeGreaterThanOrEqual(12);
    // Released only once the revival window has run since the settle: a record
    // settled `failed` moments ago is still the lifecycle's recoverable state.
    const now = Date.now();
    for (const r of recoverable) {
      const settled = r.finishedAt;
      const pastWindow = finite(settled) && now - settled >= REVIVAL_WINDOW_MS;
      expect(isTerminalRecord(r, now)).toBe(pastWindow);
    }
  });
});
