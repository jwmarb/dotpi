/**
 * Wake-path tests for subagent-herdr: coalescing, sweep, dedup, and pass-through.
 *
 * Each test gets a fresh module instance (via query-string import bust) and a
 * fresh temp agent dir, so the top-level `runs` registry is isolated per test.
 *
 * Run from the repo root: `bun test agent/extensions/subagent-herdr/wake.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatExitSidecar, formatNotice, type RunRecord } from "./rundir.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunFixture {
  runId: string;
  agent: string;
  answer?: string;
  hasSession: boolean;
  hasSidecar: boolean;
}

/**
 * Creates a temp agent dir with the given run fixtures, sets
 * PI_CODING_AGENT_DIR, and imports a fresh instance of the extension factory.
 */
let importCounter = 0;

async function freshExtension(runs: RunFixture[]): Promise<(pi: any) => void> {
  const dir = mkdtempSync(join(tmpdir(), "herdr-wake-"));
  process.env.PI_CODING_AGENT_DIR = dir;

  for (const r of runs) {
    const runDir = join(dir, "subagent-runs", r.runId);
    mkdirSync(runDir, { recursive: true });

    const meta: RunRecord = {
      runId: r.runId,
      agent: r.agent,
      task: "test task",
      cwd: "/",
      status: "running",
      startedAt: Date.now(),
    };
    writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));

    if (r.hasSession) {
      const sessionFile = join(runDir, `1750000000000_${r.runId}.jsonl`);
      writeFileSync(
        sessionFile,
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "text", text: r.answer || "done" }],
          },
        }) + "\n",
      );

      if (r.hasSidecar) {
        writeFileSync(sessionFile + ".exit", formatExitSidecar());
      }
    }
  }

  const mod = await import(`./index.js?wake=${++importCounter}`);
  return mod.default;
}

/** Minimal pi ExtensionAPI stub. */
function stubPi() {
  const sent: Array<{ text: string; options?: { deliverAs?: string } }> = [];
  let inputHandler: ((e: { text: string }) => { action: string }) | undefined;

  const pi = {
    on(event: string, handler: (e: any) => any) {
      if (event === "input") inputHandler = handler as any;
    },
    registerTool() {},
    sendUserMessage(text: string, options?: { deliverAs?: string }) {
      sent.push({ text, options });
    },
  };

  return { pi, sent, getInputHandler: () => inputHandler! };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// collectFinished unit tests
// ---------------------------------------------------------------------------

describe("collectFinished", () => {
  test("returns only newly-finished runs, preserving order", async () => {
    const { collectFinished } = await import("./index.js?collect=1");

    const recs: RunRecord[] = [
      { runId: "sub-0001", agent: "a", task: "t", cwd: "/", status: "running", startedAt: 1 },
      { runId: "sub-0002", agent: "b", task: "t", cwd: "/", status: "running", startedAt: 2 },
      { runId: "sub-0003", agent: "c", task: "t", cwd: "/", status: "done", startedAt: 3 },
      { runId: "sub-0004", agent: "d", task: "t", cwd: "/", status: "running", startedAt: 4 },
    ];
    const exclude = new Set(["sub-0002"]);

    // sub-0001 and sub-0004 are "no longer running" (reconcile returns false)
    const finishedIds = new Set(["sub-0001", "sub-0004"]);
    const reconcileOne = async (rec: RunRecord) => !finishedIds.has(rec.runId);

    const result = await collectFinished(recs, exclude, reconcileOne);
    expect(result.map((r) => r.runId)).toEqual(["sub-0001", "sub-0004"]);
  });

  test("isolates a rejected reconciliation to that record", async () => {
    const { collectFinished } = await import("./index.js?collect=2");

    const recs: RunRecord[] = [
      { runId: "sub-aaaa", agent: "x", task: "t", cwd: "/", status: "running", startedAt: 1 },
      { runId: "sub-bbbb", agent: "y", task: "t", cwd: "/", status: "running", startedAt: 2 },
    ];

    const reconcileOne = async (rec: RunRecord) => {
      if (rec.runId === "sub-aaaa") throw new Error("probe failed");
      return false; // sub-bbbb finished
    };

    const result = await collectFinished(recs, new Set(), reconcileOne);
    expect(result.map((r) => r.runId)).toEqual(["sub-bbbb"]);
  });

  test("returns empty when nothing is running", async () => {
    const { collectFinished } = await import("./index.js?collect=3");

    const recs: RunRecord[] = [
      { runId: "sub-cccc", agent: "z", task: "t", cwd: "/", status: "done", startedAt: 1 },
    ];

    const result = await collectFinished(recs, new Set(), async () => false);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Extension factory wake-path tests
// ---------------------------------------------------------------------------

describe("wake path (extension factory)", () => {
  test("coalesces two done notices into one steering briefing", async () => {
    const createExtension = await freshExtension([
      { runId: "sub-aaaa", agent: "explorer", answer: "the map is here", hasSession: true, hasSidecar: true },
      { runId: "sub-bbbb", agent: "librarian", answer: "the docs say so", hasSession: true, hasSidecar: true },
    ]);

    const { pi, sent, getInputHandler } = stubPi();
    createExtension(pi);

    const handler = getInputHandler();
    handler({ text: formatNotice("sub-aaaa", "explorer", "done") });
    handler({ text: formatNotice("sub-bbbb", "librarian", "done") });

    await sleep(1500);

    expect(sent.length).toBe(1);
    expect(sent[0].options?.deliverAs).toBe("steer");
    expect(sent[0].text).toContain("the map is here");
    expect(sent[0].text).toContain("the docs say so");
  });

  test("sweeps a finished sibling whose notice has not arrived", async () => {
    const createExtension = await freshExtension([
      { runId: "sub-1111", agent: "explorer", answer: "result A", hasSession: true, hasSidecar: true },
      { runId: "sub-2222", agent: "worker", answer: "result B", hasSession: true, hasSidecar: true },
    ]);

    const { pi, sent, getInputHandler } = stubPi();
    createExtension(pi);

    const handler = getInputHandler();
    // Only submit notice for sub-1111; sub-2222 has no notice
    handler({ text: formatNotice("sub-1111", "explorer", "done") });

    await sleep(1500);

    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("result A");
    expect(sent[0].text).toContain("result B"); // swept in
  });

  test("does not brief a swept run again when its delayed notice arrives", async () => {
    const createExtension = await freshExtension([
      { runId: "sub-3333", agent: "explorer", answer: "first result", hasSession: true, hasSidecar: true },
      { runId: "sub-4444", agent: "worker", answer: "second result", hasSession: true, hasSidecar: true },
    ]);

    const { pi, sent, getInputHandler } = stubPi();
    createExtension(pi);

    const handler = getInputHandler();

    // First flush: sub-3333 notice, sub-4444 swept
    handler({ text: formatNotice("sub-3333", "explorer", "done") });
    await sleep(1500);

    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("first result");
    expect(sent[0].text).toContain("second result");

    // Second: delayed notice for sub-4444 (already briefed via sweep)
    handler({ text: formatNotice("sub-4444", "worker", "done") });
    await sleep(1500);

    // No second briefing
    expect(sent.length).toBe(1);
  });

  test("renders a finished report notice as a result block", async () => {
    const createExtension = await freshExtension([
      { runId: "sub-5555", agent: "librarian", answer: "final answer", hasSession: true, hasSidecar: true },
    ]);

    const { pi, sent, getInputHandler } = stubPi();
    createExtension(pi);

    const handler = getInputHandler();
    // Submit a report notice (child reported mid-run, but finished before flush)
    handler({ text: formatNotice("sub-5555", "librarian", "report", "interim update") });

    await sleep(1500);

    expect(sent.length).toBe(1);
    // Should contain the result header and answer, not a stale "still working" line
    expect(sent[0].text).toContain("=== sub-5555");
    expect(sent[0].text).toContain("final answer");
    expect(sent[0].text).not.toContain("It is still working");
  });

  test("passes non-notice input through without sending a briefing", async () => {
    const createExtension = await freshExtension([]);

    const { pi, sent, getInputHandler } = stubPi();
    createExtension(pi);

    const handler = getInputHandler();
    const result = handler({ text: "hello human" });
    expect(result.action).toBe("continue");

    await sleep(1500);
    expect(sent.length).toBe(0);
  });

  test("deduplicates repeated done notices for the same run in one batch", async () => {
    const createExtension = await freshExtension([
      { runId: "sub-6666", agent: "worker", answer: "only once", hasSession: true, hasSidecar: true },
    ]);

    const { pi, sent, getInputHandler } = stubPi();
    createExtension(pi);

    const handler = getInputHandler();
    // Submit the same notice twice (simulating a duplicate delivery)
    handler({ text: formatNotice("sub-6666", "worker", "done") });
    handler({ text: formatNotice("sub-6666", "worker", "done") });

    await sleep(1500);

    expect(sent.length).toBe(1);
    // The result header should appear exactly once
    const matches = sent[0].text.match(/=== sub-6666/g);
    expect(matches?.length).toBe(1);
  });
});
