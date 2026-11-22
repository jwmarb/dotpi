/**
 * Contract tests for the briefing blocks, against an in-memory world: no temp
 * dirs, no `mock.module`, no herdr, no filesystem, no clock changes. Every read
 * a renderer performs is one line in a log, so each block is pinned by the text
 * it produced **and** by whether the read happened at all (a pre-supplied
 * answer must not re-read the transcript) and in what order (a spawns header
 * that says "snapshot at" is a promise the scan is fresh).
 *
 * `wake.test.ts` pins the same text through the real factory and the real run
 * dirs; this file pins the renderers' own contracts, one per behaviour.
 *
 * Run from the repo root: `bun test agent/extensions/subagent-herdr/briefing.test.ts`
 */
import { describe, expect, test } from "bun:test";
import type { RunResult } from "./lib.js";
import type { ChildReport, Notice, RunRecord } from "./rundir.js";
import type { ReleasedTarget, ReleaseRenderer } from "./release-ledger.js";
import type { TodoCounts } from "../lib/todo.js";
import {
  COLLECTED_DONE_IDS,
  createBriefing,
  formatResultHeader,
  RESULT_MAX_CHARS,
  startedAtOf,
  truncate,
  type BriefingEffects,
} from "./briefing.js";

const T0 = 1_700_000_000_000;

const NO_ANSWER: RunResult = { found: true, answered: false, text: "", sessionFile: "s.jsonl" };
const answer = (text: string, todos?: TodoCounts): RunResult => ({
  found: true,
  answered: true,
  text,
  sessionFile: "s.jsonl",
  ...(todos ? { todos } : {}),
});

/** A completed worker run, 12 s long, answered by the fixture it is given. */
function rec(over: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    agent: "worker",
    task: "t",
    cwd: "/w",
    paneId: `pane-${over.runId}`,
    status: "done",
    startedAt: T0 - 12_000,
    finishedAt: T0,
    ownerPane: "w9:pOwn",
    ...over,
  };
}

/** A run `sub-aaaa` launched — the relation the spawns block selects on. */
const spawn = (runId: string, status: RunRecord["status"]): { rec: RunRecord; dir: string } => ({
  rec: rec({ runId, status, parentRunId: "sub-aaaa", startedAt: T0 - 6_000, finishedAt: status === "done" ? T0 - 1_000 : undefined }),
  // A path that cannot exist: `hasExitSidecar` reads the real disk and answers
  // "no sidecar" for it, so the finished child is labelled by its status alone.
  dir: `/nonexistent-run-dir/${runId}`,
});

/**
 * The fake world: the six effects, each logging its call and its arguments, and
 * the briefing bound to them. Answers, reports, pane labels and pane text are
 * keyed by id; anything unset reads as "nothing there".
 */
function world() {
  const log: string[] = [];
  const results = new Map<string, RunResult>();
  const reports = new Map<string, ChildReport[]>();
  const labels = new Map<string, string | undefined>();
  const panes = new Map<string, string | null>();
  let candidates: { rec: RunRecord; dir: string }[] = [];

  const effects: BriefingEffects = {
    extractResult: async (r) => {
      log.push(`extract ${r.runId}`);
      return results.get(r.runId) ?? NO_ANSWER;
    },
    reports: async (r) => {
      log.push(`reports ${r.runId}`);
      return reports.get(r.runId) ?? [];
    },
    runCandidates: () => {
      log.push("runCandidates");
      return candidates;
    },
    invalidateRunScan: () => {
      log.push("invalidateRunScan");
    },
    paneLabel: async (paneId) => {
      log.push(`paneLabel ${paneId}`);
      return labels.get(paneId);
    },
    readAgent: async (paneId, lines) => {
      log.push(`readAgent ${paneId} ${lines}`);
      return panes.get(paneId) ?? null;
    },
  };

  return {
    log,
    results,
    reports,
    labels,
    panes,
    briefing: createBriefing(effects),
    setCandidates: (c: { rec: RunRecord; dir: string }[]) => {
      candidates = c;
    },
  };
}

describe("briefing: the header", () => {
  test("it names the run, its agent, its role and its elapsed — and nothing else", () => {
    expect(formatResultHeader(rec({ runId: "sub-aaaa" }))).toBe("=== sub-aaaa (worker) — done [12s] ===");
    // Still running: no elapsed to report, so the cell is the ellipsis.
    expect(formatResultHeader(rec({ runId: "sub-aaaa", status: "running", finishedAt: undefined }))).toBe(
      "=== sub-aaaa (worker) — running […] ===",
    );
    // A stale `finishedAt` older than `startedAt` never renders a negative time.
    expect(
      formatResultHeader(rec({ runId: "sub-aaaa", startedAt: T0, finishedAt: T0 - 60_000 })),
    ).toBe("=== sub-aaaa (worker) — done [0s] ===");
    // A health check says what it diagnoses instead of repeating its own status.
    expect(
      formatResultHeader(
        rec({ runId: "sub-cccc", agent: "healthcheck", status: "done", healthCheckOf: "sub-bbbb" }),
      ),
    ).toBe("=== sub-cccc (healthcheck) — health check of sub-bbbb — done [12s] ===");
  });

  test("a `startedAt` that is not a number is measured off the injected now", () => {
    const broken = rec({ runId: "sub-aaaa", startedAt: Number.NaN });
    expect(startedAtOf(broken, T0)).toBe(T0);
    expect(startedAtOf(rec({ runId: "sub-aaaa", startedAt: undefined as unknown as number }), T0)).toBe(T0);
    // A finite one is never touched, and the default really is `Date.now()`.
    expect(startedAtOf(rec({ runId: "sub-aaaa" }))).toBe(T0 - 12_000);
    expect(startedAtOf(rec({ runId: "sub-aaaa", startedAt: "1700000000000" as unknown as number }), T0)).toBe(T0);
  });
});

describe("briefing: truncation", () => {
  test("the limit is inclusive, and the cut names where the rest lives", () => {
    expect(truncate("x".repeat(RESULT_MAX_CHARS))).toBe("x".repeat(RESULT_MAX_CHARS));
    expect(truncate("y".repeat(RESULT_MAX_CHARS + 1))).toBe(
      `${"y".repeat(RESULT_MAX_CHARS)}\n…[truncated; full transcript: see run dir]`,
    );
  });
});

describe("briefing: one completed run's block", () => {
  test("header, todos, answer, spawns snapshot, reports — and the scan is fresh", async () => {
    const w = world();
    w.setCandidates([spawn("sub-cccc", "done"), spawn("sub-bbbb", "running")]);
    w.results.set("sub-aaaa", answer("the answer", { total: 3, done: 1, inProgress: 1, blocked: 0, pending: 1 }));
    w.reports.set("sub-aaaa", [{ at: T0 - 5_000, message: "mid-run report" }]);
    const target = rec({ runId: "sub-aaaa" });

    const block = await w.briefing.done(target);
    const lines = block.split("\n");
    // The snapshot line names the instant this call took the scan, in full ISO
    // form, so a stale record set cannot be printed as "as of now".
    const snapshot = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
    const at = /^runs this child launched \(snapshot at (.+)\):$/.exec(lines[3]);
    expect(at).not.toBeNull();
    expect(snapshot.test(at![1])).toBe(true);
    expect(Math.abs(Date.now() - Date.parse(at![1]))).toBeLessThan(10_000);
    expect(lines).toEqual([
      "=== sub-aaaa (worker) — done [12s] ===",
      "todos: 1/3 done, 1 in progress, 1 pending",
      "the answer",
      `runs this child launched (snapshot at ${at![1]}):`,
      // Sorted by id: the running child has nothing to say about delivery.
      "sub-bbbb (worker): running",
      // Nothing is ever proven collected — `COLLECTED_DONE_IDS` is empty on
      // purpose, so the finished child carries the honesty label.
      "sub-cccc (worker): done — delivery not provable from disk",
      "--- reports sent to you by worker during the run (1) ---",
      "- mid-run report",
    ]);
    expect([...COLLECTED_DONE_IDS]).toEqual([]);
    // The header says "snapshot at", so the memo is dropped BEFORE the scan.
    expect(w.log.indexOf("invalidateRunScan")).toBeLessThan(w.log.indexOf("runCandidates"));

    // `renderResultBlock` is the same block on an array, so the `result` arm's
    // "\n\n" join and the wake's "\n" join can never disagree about its parts.
    // Only the snapshot cell may differ between the two calls (each takes its
    // own `Date.now()`), so everything else is compared byte for byte.
    const mask = (s: string): string =>
      s.replace(/snapshot at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, "snapshot at <now>");
    const out: string[] = [];
    const before = w.log.length;
    await w.briefing.renderResultBlock(target, out, answer("the answer", { total: 3, done: 1, inProgress: 1, blocked: 0, pending: 1 }));
    // `out`'s five entries are the header, the todos line, the answer, the
    // multi-line spawns block and the multi-line reports block — the same parts
    // `done` joined with "\n" above.
    expect(out.map(mask)).toEqual(
      [lines[0], lines[1], lines[2], lines.slice(3, 6).join("\n"), lines.slice(6).join("\n")].map(mask),
    );
    // The caller already read the transcript: the gate is not run a second time.
    expect(w.log.slice(before)).not.toContain("extract sub-aaaa");

    // The 4th positional argument is the display-only inference note, and it
    // rides directly under the header (`dispatchTasks` passes it positionally).
    const noted: string[] = [];
    await w.briefing.renderResultBlock(target, noted, undefined, "completed (the .exit sidecar is on disk, not settled by this pane)");
    expect(noted.slice(0, 2)).toEqual([
      "=== sub-aaaa (worker) — done [12s] ===",
      "completed (the .exit sidecar is on disk, not settled by this pane)",
    ]);
  });

  test("the todos line counts only what is there, and a zero-total list says nothing", async () => {
    const w = world();
    const block = async (todos: TodoCounts | undefined): Promise<string[]> => {
      w.results.set("sub-aaaa", answer("the answer", todos));
      const out: string[] = [];
      await w.briefing.renderResultBlock(rec({ runId: "sub-aaaa" }), out);
      return out;
    };

    expect((await block({ total: 4, done: 2, inProgress: 0, blocked: 1, pending: 1 }))[1]).toBe(
      "todos: 2/4 done, 1 blocked, 1 pending",
    );
    expect((await block({ total: 1, done: 0, inProgress: 0, blocked: 0, pending: 1 }))[1]).toBe(
      "todos: 0/1 done, 1 pending",
    );
    for (const todos of [{ total: 0, done: 0, inProgress: 0, blocked: 0, pending: 0 }, undefined]) {
      expect((await block(todos)).some((l) => l.startsWith("todos:"))).toBe(false);
    }
  });

  test("every salvage source is labelled with its own sentence, and a clean answer with none", async () => {
    const w = world();
    const sentences: Record<string, string> = {
      "done-arguments":
        "(recovered from this run's subagent_done arguments — the child passed its answer to the tool instead of writing it as a message, so it is very likely truncated)",
      "truncated-answer":
        "(this is the child's final answer, but it does not close its `<result>` element — most likely cut off by the output limit, so treat it as incomplete)",
      "earlier-message":
        "(recovered from an earlier message — the child answered and then kept working, so its final message was not the answer)",
      "non-conforming":
        "(NOT AN ANSWER — this run produced no report, only this line. Everything it concluded is lost; re-delegate the task rather than relying on this.)",
    };
    for (const [source, sentence] of Object.entries(sentences)) {
      w.results.set("sub-aaaa", { ...answer("the answer"), salvagedFrom: source as RunResult["salvagedFrom"] });
      const out: string[] = [];
      await w.briefing.renderResultBlock(rec({ runId: "sub-aaaa" }), out);
      expect(out[1]).toBe(sentence);
    }
    w.results.set("sub-aaaa", answer("the answer"));
    const clean: string[] = [];
    await w.briefing.renderResultBlock(rec({ runId: "sub-aaaa" }), clean);
    expect(clean.some((b) => Object.values(sentences).includes(b))).toBe(false);
  });

  test("an unanswered failed run shows its pane — but only while the pane is still its own", async () => {
    const w = world();
    w.results.set("sub-aaaa", NO_ANSWER);
    const failed = rec({ runId: "sub-aaaa", status: "failed" });
    const rendered = async (): Promise<string[]> => {
      const out: string[] = [];
      await w.briefing.renderResultBlock(failed, out);
      return out;
    };

    // The label still says `worker sub-aaaa`, so the scrollback is this run's.
    w.labels.set("pane-sub-aaaa", "worker sub-aaaa");
    w.panes.set("pane-sub-aaaa", "traceback: it died here");
    const shown = await rendered();
    expect(shown).toContain("\n--- pane output ---\ntraceback: it died here");
    // herdr is asked for exactly the last 40 lines, as everywhere else.
    expect(w.log).toContain("readAgent pane-sub-aaaa 40");

    // The id was reused by another pane: the label fails the guard and herdr is
    // never read, because the text could be anyone's.
    w.log.length = 0;
    w.labels.set("pane-sub-aaaa", "worker sub-9999");
    expect((await rendered()).some((b) => b.includes("--- pane output ---"))).toBe(false);
    expect(w.log.some((l) => l.startsWith("readAgent"))).toBe(false);

    // An unanswered run that is not `failed` (a `done` with no answer, say) has
    // no diagnostic to show either.
    w.labels.set("pane-sub-aaaa", "worker sub-aaaa");
    w.log.length = 0;
    const doneOut: string[] = [];
    await w.briefing.renderResultBlock(rec({ runId: "sub-aaaa" }), doneOut);
    expect(doneOut).toContain("(no final answer in transcript)");
    expect(doneOut.some((b) => b.includes("--- pane output ---"))).toBe(false);
  });
});

describe("briefing: a degraded release", () => {
  test("the header and a pointer to subagent_tasks, plus the reports — and no transcript read", async () => {
    const w = world();
    w.reports.set("sub-aaaa", [{ at: T0 - 5_000, message: "mid-run report" }]);
    const block = await w.briefing.degraded(rec({ runId: "sub-aaaa" }));
    expect(block).toBe(
      [
        "=== sub-aaaa (worker) — done [12s] ===",
        'result block unavailable; read it with subagent_tasks (action "result", ids ["sub-aaaa"])',
        "--- reports sent to you by worker during the run (1) ---",
        "- mid-run report",
      ].join("\n"),
    );
    // The whole point of this block is that the read already failed.
    expect(w.log.some((l) => l.startsWith("extract"))).toBe(false);
  });
});

describe("briefing: the fallback", () => {
  test("notices, then swept records, then released targets — each id once, with no I/O at all", () => {
    const w = world();
    const batch: Notice[] = [
      { runId: "sub-aaaa", agent: "worker", kind: "done", text: "" },
      { runId: "sub-aaaa", agent: "worker", kind: "report", text: "already listed" },
      { runId: "sub-bbbb", agent: "reviewer", kind: "stalled", text: "no answer" },
    ];
    const swept: RunRecord[] = [rec({ runId: "sub-aaaa" }), rec({ runId: "sub-cccc", agent: "worker", status: "cancelled" })];
    const released: ReleasedTarget[] = [
      { kind: "registered", runId: "sub-aaaa", agent: "worker", status: "done" },
      { kind: "registered", runId: "sub-dddd", agent: "worker", status: "done" },
      { kind: "unregistered", runId: "sub-eeee" },
    ];

    expect(w.briefing.fallback(batch, swept, released)).toBe(
      [
        "[subagent update — delivered automatically, not typed by the user]",
        "",
        "- sub-aaaa (worker) done",
        "- sub-bbbb (reviewer) stalled: no answer",
        "- sub-cccc (worker) cancelled",
        "- sub-dddd (worker) done — release carried by the failed health check's briefing",
        "- sub-eeee — release carried by the failed health check's briefing; this id is not in my registry, so I have no record of it — read it from its run dir, or with subagent_tasks (action \"result\") if it exists",
        "",
        'I could not read the run details. Use subagent_tasks (action "result") on the ids above to collect them.',
      ].join("\n"),
    );
    // This is the path taken *because* the reads failed: it performs none.
    expect(w.log).toEqual([]);
  });
});

describe("briefing: the seam", () => {
  test("the factory's result IS the ledger's renderer — done, degraded, fallback", async () => {
    const w = world();
    w.results.set("sub-aaaa", answer("the answer"));
    const asRenderer: ReleaseRenderer = w.briefing;
    const done: ReleaseRenderer["done"] = asRenderer.done;
    const degraded: ReleaseRenderer["degraded"] = asRenderer.degraded;
    const fallback: ReleaseRenderer["fallback"] = asRenderer.fallback;

    expect(await done(rec({ runId: "sub-aaaa" }))).toBe("=== sub-aaaa (worker) — done [12s] ===\nthe answer");
    expect(await degraded(rec({ runId: "sub-aaaa" }))).toContain(
      'result block unavailable; read it with subagent_tasks (action "result", ids ["sub-aaaa"])',
    );
    expect(fallback([{ runId: "sub-ffff", agent: "worker", kind: "done", text: "" }], [], [])).toContain(
      "- sub-ffff (worker) done",
    );
    // And the two extra methods the wake and `result` arms call directly.
    expect(typeof w.briefing.renderResultBlock).toBe("function");
    expect(typeof w.briefing.pushReports).toBe("function");
  });
});
