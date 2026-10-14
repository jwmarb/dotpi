/**
 * Wake-path tests for subagent-herdr: coalescing, sweep, dedup, pass-through,
 * and the parent-side health-check path (stall notices, held no-answer
 * briefings, release on health-check completion, spawn-failure fallback, and
 * the liveness backstop tick).
 *
 * Each test gets a fresh module instance (via query-string import bust) and a
 * fresh temp agent dir, so the top-level `runs` registry is isolated per test.
 *
 * The herdr CLI is mocked via `mock.module` so spawns are deterministic and the
 * tests need no live herdr server: `herdrState` is the mutable surface the
 * tests steer (pane creation success/failure, live vs dead panes).
 *
 * Run from the repo root: `bun test agent/extensions/subagent-herdr/wake.test.ts`
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `loadExtensionInDir` repoints PI_CODING_AGENT_DIR at a fresh temp dir per
// test and leaves it set; capture the pre-suite value now and restore it once
// the file's tests are done, so sibling suites in the same process see their
// own env (matching dynamic-prompt.test.ts and ralph-loop/lib.test.ts).
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

// `HERDR_PANE_ID` names the pane herdr injected into this process; the tests
// fix it so every fixture (and every record `spawnRun` stamps) is owned by a
// known pane, and "foreign" means "a different pane id". Capture the
// pre-suite value and restore it once, matching the PI_CODING_AGENT_DIR
// handling above.
const TEST_OWN_PANE = "w9:pOwn";
const originalPaneId = process.env.HERDR_PANE_ID;
process.env.HERDR_PANE_ID = TEST_OWN_PANE;

afterAll(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalPaneId === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = originalPaneId;
});

import * as realHerdr from "./herdr.js";
import { formatExitSidecar, formatNotice, type RunRecord } from "./rundir.js";
import type { SubagentHerdrHooks } from "./index.js";
// ---------------------------------------------------------------------------
// herdr CLI mock
// ---------------------------------------------------------------------------

/**
 * Mutable herdr behaviours for the tests. The mocked module delegates to these
 * at call time, so reassigning a function mid-test takes effect immediately.
 * Defaults: spawns succeed, every pane probe reports the pane as gone
 * (records are then classified from disk).
 */
const herdrState = {
  createChildPane: async (): Promise<{ paneId: string; tabId: string } | null> => ({
    paneId: "w9:pHC",
    tabId: "w9:tHC",
  }),
  renamePane: async (): Promise<boolean> => true,
  startAgent: async (): Promise<{ ok: boolean; error: string | null }> => ({ ok: true, error: null }),
  promptAgent: async (): Promise<{ ok: boolean; error: string | null }> => ({ ok: true, error: null }),
  sendKeys: async (): Promise<boolean> => true,
  waitAgentWorking: async (): Promise<boolean> => true,
  closePane: async (): Promise<boolean> => true,
  getAgent: async (): Promise<{ status: string; name?: string } | null> => null,
  paneLabel: async (): Promise<string | undefined> => undefined,
  readAgent: async (): Promise<string | null> => null,
};

mock.module("./herdr.js", () => ({
  ...realHerdr,
  createChildPane: (cwd: string, label: string, env?: Record<string, string>) =>
    herdrState.createChildPane(cwd, label, env),
  renamePane: (paneId: string, label: string) => herdrState.renamePane(paneId, label),
  startAgent: (name: string, paneId: string, argv: string[], timeoutMs?: number) =>
    herdrState.startAgent(name, paneId, argv, timeoutMs),
  promptAgent: (paneId: string, text: string) => herdrState.promptAgent(paneId, text),
  sendKeys: (paneId: string, ...keys: string[]) => herdrState.sendKeys(paneId, ...keys),
  waitAgentWorking: (paneId: string, timeoutMs: number) =>
    herdrState.waitAgentWorking(paneId, timeoutMs),
  closePane: (paneId: string, timeoutMs?: number) => herdrState.closePane(paneId, timeoutMs),
  getAgent: (paneId: string) => herdrState.getAgent(paneId),
  paneLabel: (paneId: string, timeoutMs?: number) => herdrState.paneLabel(paneId, timeoutMs),
  readAgent: (paneId: string, lines?: number) => herdrState.readAgent(paneId, lines),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RunFixture {
  runId: string;
  agent: string;
  answer?: string;
  hasSession: boolean;
  hasSidecar: boolean;
  /** Registry status; defaults to "running". */
  status?: RunRecord["status"];
  /** false → the session file has no visible assistant text (no answer). */
  visibleAnswer?: boolean;
  /** Set on a health-check record: the target run it diagnoses. */
  healthCheckOf?: string;
  /** Recorded pane id; records without one are classified from disk. */
  paneId?: string;
  /** Raw overrides merged into the written meta.json (e.g. a non-string `healthCheckOf`). */
  rawMeta?: Record<string, unknown>;
  /**
   * Ownership for the fixture's meta.json. Defaults to the suite's test pane
   * (the process owns the record); "legacy" omits the field entirely (a
   * pre-ownership record); any other id is one this process does not own.
   */
  ownerPane?: string | "legacy";
}

/**
 * Creates a temp agent dir with the given run fixtures (plus a `healthcheck`
 * agent definition, so the parent can spawn one programmatically), sets
 * PI_CODING_AGENT_DIR, and imports a fresh instance of the extension factory.
 */
let importCounter = 0;

/**
 * Imports a fresh instance of the extension factory pointed at `dir`, so the
 * module's top-level `loadRegistry` re-runs against that dir's on-disk metas.
 * A restarted orchestrator is exactly this: a fresh factory scope, the same
 * registry on disk.
 */
async function loadExtensionInDir(
  dir: string,
): Promise<(pi: any) => SubagentHerdrHooks> {
  process.env.PI_CODING_AGENT_DIR = dir;
  const mod = await import(`./index.js?wake=${++importCounter}`);
  return mod.default;
}

/**
 * Creates a temp agent dir with the given run fixtures (plus a `healthcheck`
 * agent definition, so the parent can spawn one programmatically), and imports
 * a fresh instance of the extension factory pointed at it.
 */
async function freshExtension(runs: RunFixture[]) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-wake-"));

  const agentsDirPath = join(dir, "agents");
  mkdirSync(agentsDirPath, { recursive: true });
  writeFileSync(
    join(agentsDirPath, "healthcheck.md"),
    [
      "---",
      "name: healthcheck",
      "description: Test health-check agent.",
      "tools: read, bash",
      "model: test/model",
      "---",
      "",
      "You diagnose one delegated subagent run.",
      "",
    ].join("\n"),
  );

  for (const r of runs) {
    const runDir = join(dir, "subagent-runs", r.runId);
    mkdirSync(runDir, { recursive: true });

    const meta: Record<string, unknown> = {
      runId: r.runId,
      agent: r.agent,
      task: "test task",
      cwd: "/",
      status: r.status ?? "running",
      startedAt: Date.now(),
      // Ownership defaults to the suite's test pane, so every fixture is
      // owned by this process unless the test says otherwise.
      ...(r.ownerPane === "legacy" ? {} : { ownerPane: r.ownerPane ?? TEST_OWN_PANE }),
      ...(r.paneId ? { paneId: r.paneId } : {}),
      ...(r.healthCheckOf ? { healthCheckOf: r.healthCheckOf } : {}),
      ...(r.rawMeta ?? {}),
    };
    writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));

    if (r.hasSession) {
      const sessionFile = join(runDir, `1750000000000_${r.runId}.jsonl`);
      writeFileSync(
        sessionFile,
        JSON.stringify({
          message: {
            role: "assistant",
            content: r.visibleAnswer === false ? [] : [{ type: "text", text: r.answer || "done" }],
          },
        }) + "\n",
      );

      if (r.hasSidecar) {
        writeFileSync(sessionFile + ".exit", formatExitSidecar());
      }
    }
  }

  return loadExtensionInDir(dir);
}

/** Minimal pi ExtensionAPI stub. */
function stubPi() {
  const sent: Array<{ text: string; options?: { deliverAs?: string } }> = [];
  let inputHandler: ((e: { text: string }) => { action: string }) | undefined;
  let shutdownHandler: (() => void) | undefined;
  const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];

  const pi = {
    on(event: string, handler: (e: any) => any) {
      if (event === "input") inputHandler = handler as any;
      if (event === "session_shutdown") shutdownHandler = handler as () => void;
    },
    registerTool(def: { name: string; execute: (...args: any[]) => Promise<any> }) {
      tools.push(def);
    },
    sendUserMessage(text: string, options?: { deliverAs?: string }) {
      sent.push({ text, options });
    },
  };

  return {
    pi,
    sent,
    getInputHandler: () => inputHandler!,
    getShutdownHandler: () => shutdownHandler!,
    getTool: (name: string) => tools.find((t) => t.name === name)!,
  };
}

/** The `subagent_tasks` list action, used to inspect the in-memory registry. */
async function listTasks(stub: ReturnType<typeof stubPi>): Promise<Array<Record<string, any>>> {
  const out = (await stub.getTool("subagent_tasks").execute(
    "t1",
    { action: "list" },
    undefined,
    () => {},
    {},
  )) as { details: { tasks: Array<Record<string, any>> } };
  return out.details.tasks;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  herdrState.createChildPane = async () => ({ paneId: "w9:pHC", tabId: "w9:tHC" });
  herdrState.getAgent = async () => null;
  herdrState.paneLabel = async () => undefined;
  herdrState.readAgent = async () => null;
});

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

    const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
    createExtension(pi);

    const handler = getInputHandler();
    handler({ text: formatNotice("sub-aaaa", "explorer", "done") });
    handler({ text: formatNotice("sub-bbbb", "librarian", "done") });

    await sleep(1500);

    expect(sent.length).toBe(1);
    expect(sent[0].options?.deliverAs).toBe("steer");
    expect(sent[0].text).toContain("the map is here");
    expect(sent[0].text).toContain("the docs say so");
    getShutdownHandler()();
  });

  test("sweeps a finished sibling whose notice has not arrived", async () => {
    const createExtension = await freshExtension([
      { runId: "sub-1111", agent: "explorer", answer: "result A", hasSession: true, hasSidecar: true },
      { runId: "sub-2222", agent: "worker", answer: "result B", hasSession: true, hasSidecar: true },
    ]);

    const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
    createExtension(pi);

    const handler = getInputHandler();
    // Only submit notice for sub-1111; sub-2222 has no notice
    handler({ text: formatNotice("sub-1111", "explorer", "done") });

    await sleep(1500);

    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("result A");
    expect(sent[0].text).toContain("result B"); // swept in
    getShutdownHandler()();
  });

  test("does not brief a swept run again when its delayed notice arrives", async () => {
    const createExtension = await freshExtension([
      { runId: "sub-3333", agent: "explorer", answer: "first result", hasSession: true, hasSidecar: true },
      { runId: "sub-4444", agent: "worker", answer: "second result", hasSession: true, hasSidecar: true },
    ]);

    const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
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
    getShutdownHandler()();
  });

  test("renders a finished report notice as a result block", async () => {
    const createExtension = await freshExtension([
      { runId: "sub-5555", agent: "librarian", answer: "final answer", hasSession: true, hasSidecar: true },
    ]);

    const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
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
    getShutdownHandler()();
  });

  test("passes non-notice input through without sending a briefing", async () => {
    const createExtension = await freshExtension([]);

    const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
    createExtension(pi);

    const handler = getInputHandler();
    const result = handler({ text: "hello human" });
    expect(result.action).toBe("continue");

    await sleep(1500);
    expect(sent.length).toBe(0);
    getShutdownHandler()();
  });

  test("deduplicates repeated done notices for the same run in one batch", async () => {
    const createExtension = await freshExtension([
      { runId: "sub-6666", agent: "worker", answer: "only once", hasSession: true, hasSidecar: true },
    ]);

    const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
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
    getShutdownHandler()();
  });

  // -------------------------------------------------------------------------
  // Health checks
  // -------------------------------------------------------------------------

  test(
    "a stalled notice spawns a health check and sends no immediate briefing",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-eeee", agent: "explorer", hasSession: false, hasSidecar: false, paneId: "w9:pT" },
      ]);
      // The spawned health check's pane must stay "alive" so the sweep does not
      // classify it dead within the same flush.
      herdrState.getAgent = async () => ({ status: "working" });

      const { pi, sent, getInputHandler, getShutdownHandler, getTool } = stubPi();
      createExtension(pi);

      const handler = getInputHandler();
      handler({
        text: formatNotice("sub-eeee", "explorer", "stalled", "phase=tool elapsedMs=600000 tool=bash"),
      });

      await sleep(3000);

      // The raw stall was consumed: no briefing, no raw notice text.
      expect(sent.length).toBe(0);

      // One running health check, targeted at the stalled run.
      const tasks = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      expect(tasks).toHaveLength(2); // target + its health check
      const hcs = tasks.filter((t) => t.agent === "healthcheck" && t.status === "running");
      expect(hcs.length).toBe(1);
      expect(hcs[0].healthCheckOf).toBe("sub-eeee");
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "duplicate stalled notices spawn at most one health check per target",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-eeee", agent: "explorer", hasSession: false, hasSidecar: false, paneId: "w9:pT" },
      ]);
      herdrState.getAgent = async () => ({ status: "working" });

      const { pi, sent, getInputHandler, getShutdownHandler, getTool } = stubPi();
      createExtension(pi);

      const handler = getInputHandler();
      handler({ text: formatNotice("sub-eeee", "explorer", "stalled", "phase=streaming elapsedMs=300000 charsGenerated=412") });
      handler({ text: formatNotice("sub-eeee", "explorer", "stalled", "phase=tool elapsedMs=600000 tool=bash") });

      await sleep(3000);

      expect(sent.length).toBe(0);
      const tasks = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      const hcs = tasks.filter((t) => t.agent === "healthcheck" && t.status === "running");
      expect(hcs.length).toBe(1);
      expect(hcs[0].healthCheckOf).toBe("sub-eeee");
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "an ended-without-result target is deferred while its health check runs",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-eeee", agent: "worker", hasSession: true, hasSidecar: true, visibleAnswer: false, status: "done" },
      ]);
      herdrState.getAgent = async () => ({ status: "working" });

      const { pi, sent, getInputHandler, getShutdownHandler, getTool } = stubPi();
      createExtension(pi);

      const handler = getInputHandler();
      handler({ text: formatNotice("sub-eeee", "worker", "done") });

      await sleep(3000);

      // The no-answer block is withheld behind the health check: no briefing.
      expect(sent.length).toBe(0);

      const tasks = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      const hcs = tasks.filter((t) => t.agent === "healthcheck" && t.status === "running");
      expect(hcs.length).toBe(1);
      expect(hcs[0].healthCheckOf).toBe("sub-eeee");
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "a health check's completion releases the deferred target in one steering wake",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-eeee", agent: "worker", hasSession: true, hasSidecar: true, visibleAnswer: false, status: "done" },
        {
          runId: "sub-ffff",
          agent: "healthcheck",
          answer: "HC REPORT: target stuck in a bash call",
          hasSession: true,
          hasSidecar: true,
          status: "running",
          healthCheckOf: "sub-eeee",
          paneId: "w9:pHC",
        },
      ]);
      // The target's pane is gone (it's done); the HC's pane is still alive.
      herdrState.getAgent = async (paneId: string) =>
        paneId === "w9:pHC" ? { status: "working" } : null;
      const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
      createExtension(pi);

      const handler = getInputHandler();
      // The target finishes without an answer: deferred, no wake.
      handler({ text: formatNotice("sub-eeee", "worker", "done") });
      await sleep(3000);
      expect(sent.length).toBe(0);

      // The health check finishes: its pane is now gone, so reconcile will
      // classify it done, and one wake carries both blocks.
      herdrState.getAgent = async () => null;
      handler({ text: formatNotice("sub-ffff", "healthcheck", "done") });
      await sleep(1500);

      expect(sent.length).toBe(1);
      expect(sent[0].options?.deliverAs).toBe("steer");
      expect(sent[0].text).toContain("health check of sub-eeee");
      // The target's own block header: the target's id otherwise appears only in
      // the health check's header, so this is what pins the release.
      expect(sent[0].text).toContain("=== sub-eeee");
      expect(sent[0].text).toContain("HC REPORT: target stuck in a bash call");
      expect(sent[0].text).toContain("(no final answer in transcript)");

      // A delayed duplicate for the released target is swallowed.
      handler({ text: formatNotice("sub-eeee", "worker", "done") });
      await sleep(1500);
      expect(sent.length).toBe(1);
      getShutdownHandler()();
    },
    20000,
  );
  test(
    "a cancelled health check releases the deferred target through the production cancel path",
    async () => {
      const createExtension = await freshExtension([
        // The target: it has ended, with no visible answer (pane gone).
        { runId: "sub-eeee", agent: "worker", hasSession: true, hasSidecar: true, visibleAnswer: false, status: "running", paneId: "w9:pT" },
        // An unrelated run that is still live and finishes afterwards.
        { runId: "sub-9999", agent: "librarian", answer: "unrelated result", hasSession: true, hasSidecar: true, status: "running", paneId: "w9:pR" },
      ]);
      // sub-eeee's pane is gone; sub-9999's pane and any spawned health-check
      // pane are alive.
      herdrState.getAgent = async (paneId: string) =>
        paneId === "w9:pR" || paneId === "w9:pHC" ? { status: "working" } : null;

      const { pi, sent, getInputHandler, getShutdownHandler, getTool } = stubPi();
      createExtension(pi);

      const handler = getInputHandler();
      // The target ends without an answer: deferred behind its health check, no wake.
      handler({ text: formatNotice("sub-eeee", "worker", "done") });
      await sleep(3000);
      expect(sent.length).toBe(0);

      // Cancel the health check through the real dispatch: the cancel action
      // enqueues the check's own done notice — the production release.
      const tasks = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      const hcs = tasks.filter((t) => t.agent === "healthcheck" && t.status === "running");
      expect(hcs.length).toBe(1);
      const hcId = hcs[0].task;
      await getTool("subagent_tasks").execute("t1", { action: "cancel", ids: [hcId] }, undefined, () => {}, {});

      // The unrelated child finishes now: its done notice rides the same
      // coalesce window the cancel's release notice opened, driving the flush.
      herdrState.getAgent = async () => null;
      handler({ text: formatNotice("sub-9999", "librarian", "done") });
      await sleep(1500);

      // One steering wake carrying the health check's block, the released
      // target's no-answer block, and the unrelated result — no hand-fed
      // duplicate notice for the target anywhere.
      expect(sent.length).toBe(1);
      expect(sent[0].options?.deliverAs).toBe("steer");
      expect(sent[0].text).toContain("=== sub-eeee");
      expect(sent[0].text).toContain("(no final answer in transcript)");
      expect(sent[0].text).toContain("unrelated result");

      // No second health check was spawned, and a further duplicate for the
      // target is swallowed (it is briefed now).
      const tasks2 = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      expect(tasks2.filter((t) => t.agent === "healthcheck" && t.status === "running")).toHaveLength(0);
      handler({ text: formatNotice("sub-eeee", "worker", "done") });
      await sleep(1500);
      expect(sent.length).toBe(1);
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "a target that recovers and answers is not re-rendered when its health check finishes",
    async () => {
      const createExtension = await freshExtension([
        // The target stalls, then recovers and ends WITH an answer.
        { runId: "sub-eeee", agent: "worker", answer: "the recovered answer", hasSession: true, hasSidecar: true, status: "running", paneId: "w9:pT" },
      ]);
      // Both panes are alive at first: the target is working (its pane only
      // dies when its own done notice arrives), and the health check's pane is
      // alive while the check runs.
      herdrState.getAgent = async (paneId: string) =>
        paneId === "w9:pT" || paneId === "w9:pHC" ? { status: "working" } : null;

      const { pi, sent, getInputHandler, getShutdownHandler, getTool } = stubPi();
      createExtension(pi);

      const handler = getInputHandler();
      // The stall trigger spawns the health check (consumed, no briefing).
      handler({ text: formatNotice("sub-eeee", "worker", "stalled", "phase=tool elapsedMs=600000 tool=bash") });
      await sleep(3000);
      expect(sent.length).toBe(0);

      // The target has now finished (with an answer); only the health check's
      // pane is still alive.
      herdrState.getAgent = async (paneId: string) =>
        paneId === "w9:pHC" ? { status: "working" } : null;
      // The target recovers and finishes WITH an answer: rendered and marked
      // in the factory's dedup set.
      handler({ text: formatNotice("sub-eeee", "worker", "done") });
      await sleep(1500);
      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain("=== sub-eeee");
      expect(sent[0].text).toContain("the recovered answer");

      // The health check finishes afterwards: its block is briefed, but the
      // target must not be rendered a second time.
      herdrState.getAgent = async () => null;
      const tasks = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      const hcs = tasks.filter((t) => t.agent === "healthcheck" && t.status === "running");
      expect(hcs.length).toBe(1);
      handler({ text: formatNotice(hcs[0].task, "healthcheck", "done") });
      await sleep(1500);

      expect(sent.length).toBe(2);
      expect(sent[1].text).toContain("health check of sub-eeee");
      // Across ALL briefings, the target's block appears exactly once.
      const all = sent.map((s) => s.text).join("\n");
      expect(all.match(/=== sub-eeee/g)?.length).toBe(1);
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "a terminal stall check does not block a fresh check for a later no-answer ending",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-eeee", agent: "worker", hasSession: true, hasSidecar: true, visibleAnswer: false, status: "running", paneId: "w9:pT" },
      ]);
      // Both panes are alive at first: the target is working, and the spawned
      // health check's pane stays up while the check runs.
      herdrState.getAgent = async (paneId: string) =>
        paneId === "w9:pT" || paneId === "w9:pHC" ? { status: "working" } : null;

      const { pi, sent, getInputHandler, getShutdownHandler, getTool } = stubPi();
      createExtension(pi);

      const handler = getInputHandler();
      // The stall trigger spawns the first health check (consumed, no briefing).
      handler({ text: formatNotice("sub-eeee", "worker", "stalled", "phase=tool elapsedMs=600000 tool=bash") });
      await sleep(3000);
      expect(sent.length).toBe(0);

      // The first check's pane is gone; the target is still working.
      herdrState.getAgent = async (paneId: string) =>
        paneId === "w9:pT" ? { status: "working" } : null;
      const tasks = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      const hcs = tasks.filter((t) => t.agent === "healthcheck" && t.status === "running");
      expect(hcs.length).toBe(1);
      handler({ text: formatNotice(hcs[0].task, "healthcheck", "done") });
      await sleep(1500);

      // One briefing carrying the first check's block; the target is still
      // running, so it is not rendered.
      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain("health check of sub-eeee");
      expect(sent[0].text).not.toContain("=== sub-eeee");

      // The target then ends WITHOUT an answer: a fresh health check is
      // spawned for the no-answer ending — not an immediate render, and not a
      // reuse of the terminal first check.
      herdrState.getAgent = async () => null;
      handler({ text: formatNotice("sub-eeee", "worker", "done") });
      await sleep(3000);
      expect(sent.length).toBe(1); // the target's block is held behind the new check

      const tasks2 = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      const runningHcs = tasks2.filter((t) => t.agent === "healthcheck" && t.status === "running");
      expect(runningHcs.length).toBe(1);
      expect(runningHcs[0].healthCheckOf).toBe("sub-eeee");
      // The fresh check was triggered by the no-answer ending, not a second stall.
      const meta = JSON.parse(
        readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "subagent-runs", runningHcs[0].task, "meta.json"), "utf-8"),
      );
      expect(meta.task).toContain("extractRunResult returned answered: false");
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "a health check that cannot launch briefs the target immediately",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-eeee", agent: "worker", hasSession: true, hasSidecar: true, visibleAnswer: false, status: "done" },
      ]);
      herdrState.createChildPane = async () => null;

      const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
      createExtension(pi);

      const handler = getInputHandler();
      handler({ text: formatNotice("sub-eeee", "worker", "done") });

      await sleep(1500);

      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain("=== sub-eeee");
      expect(sent[0].text).toContain("(no final answer in transcript)");
      expect(sent[0].text).not.toContain("health check of sub-eeee");
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "a no-answer health check releases the deferred target without recursing",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-eeee", agent: "worker", hasSession: true, hasSidecar: true, visibleAnswer: false, status: "done" },
        {
          runId: "sub-ffff",
          agent: "healthcheck",
          hasSession: true,
          hasSidecar: true,
          visibleAnswer: false,
          status: "running",
          healthCheckOf: "sub-eeee",
          paneId: "w9:pHC",
        },
      ]);
      // The target's pane is gone (it's done); the HC's pane is still alive.
      herdrState.getAgent = async (paneId: string) =>
        paneId === "w9:pHC" ? { status: "working" } : null;

      const { pi, sent, getInputHandler, getShutdownHandler, getTool } = stubPi();
      createExtension(pi);

      const handler = getInputHandler();
      handler({ text: formatNotice("sub-eeee", "worker", "done") });
      await sleep(3000);
      expect(sent.length).toBe(0);

      herdrState.getAgent = async () => null;
      handler({ text: formatNotice("sub-ffff", "healthcheck", "done") });
      await sleep(1500);

      // One wake: the (no-answer) health check block plus the released target.
      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain("health check of sub-eeee");
      // The target's own block header, for the same reason as above.
      expect(sent[0].text).toContain("=== sub-eeee");
      expect(sent[0].text).toContain("(no final answer in transcript)");

      // No recursion: nothing health-checks the health check.
      const tasks = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      const hcsOfHc = tasks.filter((t) => t.healthCheckOf === "sub-ffff" && t.status === "running");
      expect(hcsOfHc.length).toBe(0);

      // A delayed duplicate for the health check is swallowed too.
      handler({ text: formatNotice("sub-ffff", "healthcheck", "done") });
      await sleep(1500);
      expect(sent.length).toBe(1);
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "the liveness tick wakes a dead answered child, leaves a live child alone, and defers a dead unanswered child",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-aaaa", agent: "worker", answer: "AAA answered", hasSession: true, hasSidecar: true, status: "running", paneId: "w9:pA" },
        { runId: "sub-bbbb", agent: "worker", hasSession: false, hasSidecar: false, status: "running", paneId: "w9:pB" },
        { runId: "sub-cccc", agent: "worker", hasSession: true, hasSidecar: true, visibleAnswer: false, status: "running", paneId: "w9:pC" },
      ]);
      // sub-bbbb's pane and any spawned health-check pane are live; sub-aaaa and sub-cccc are gone.
      herdrState.getAgent = async (paneId: string) =>
        paneId === "w9:pB" || paneId === "w9:pHC" ? { status: "working" } : null;

      const { pi, sent, getInputHandler, getShutdownHandler, getTool } = stubPi();
      const hooks = createExtension(pi);
      void getInputHandler();

      // One bounded tick: no coalescing window involved for the tick itself.
      await hooks.runLivenessTick();
      await sleep(1500);

      // One normal wake, carrying only the answered child's result.
      expect(sent.length).toBe(1);
      expect(sent[0].options?.deliverAs).toBe("steer");
      expect(sent[0].text).toContain("AAA answered");
      expect(sent[0].text).not.toContain("(no final answer in transcript)");

      const tasks = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      // The dead unanswered child is deferred behind a running health check.
      const hcs = tasks.filter((t) => t.agent === "healthcheck" && t.status === "running");
      expect(hcs.length).toBe(1);
      expect(hcs[0].healthCheckOf).toBe("sub-cccc");
      // The live child is untouched.
      const bbbb = tasks.find((t) => t.task === "sub-bbbb");
      expect(bbbb?.status).toBe("running");
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "a cancelled run is rendered immediately without spawning a health check",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-cafe", agent: "worker", hasSession: true, hasSidecar: true, visibleAnswer: false, status: "cancelled" },
      ]);

      const { pi, sent, getInputHandler, getShutdownHandler, getTool } = stubPi();
      createExtension(pi);

      const handler = getInputHandler();
      handler({ text: formatNotice("sub-cafe", "worker", "done") });

      await sleep(1500);

      // Cancelled runs render their block immediately — no health check spawned.
      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain("=== sub-cafe");
      expect(sent[0].text).toContain("(no final answer in transcript)");
      expect(sent[0].text).not.toContain("health check of sub-cafe");

      const tasks = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      const hcs = tasks.filter((t) => t.agent === "healthcheck");
      expect(hcs.length).toBe(0);
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "the liveness tick defers a dead unanswered child and the health-check completion releases both blocks",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-d00d", agent: "worker", hasSession: true, hasSidecar: true, visibleAnswer: false, status: "running", paneId: "w9:pD" },
      ]);
      // The target's pane is gone (dead); any spawned health-check pane stays alive.
      herdrState.getAgent = async (paneId: string) =>
        paneId === "w9:pHC" ? { status: "working" } : null;

      const { pi, sent, getInputHandler, getShutdownHandler, getTool } = stubPi();
      const hooks = createExtension(pi);

      // Tick 1: the dead unanswered child is classified, a health check is
      // spawned, and the target is deferred — no briefing yet.
      await hooks.runLivenessTick();
      await sleep(3000);
      expect(sent.length).toBe(0);

      const tasks = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      const hcs = tasks.filter((t) => t.agent === "healthcheck" && t.status === "running");
      expect(hcs.length).toBe(1);
      expect(hcs[0].healthCheckOf).toBe("sub-d00d");

      // The health check's pane is now gone too: its done notice will classify it.
      herdrState.getAgent = async () => null;

      // Feed the health check's done notice through the input hook.
      const hcId = hcs[0].task;
      getInputHandler()({ text: formatNotice(hcId, "healthcheck", "done") });
      await sleep(1500);

      // One steering wake carrying BOTH the health-check block and the target's
      // no-answer block.
      expect(sent.length).toBe(1);
      expect(sent[0].options?.deliverAs).toBe("steer");
      expect(sent[0].text).toContain("health check of sub-d00d");
      // The TARGET's own block header: the target's id otherwise appears only in
      // the health check's header, so this is what pins the release.
      expect(sent[0].text).toContain("=== sub-d00d");
      expect(sent[0].text).toContain("(no final answer in transcript)");

      // A duplicate notice for the target is swallowed (already briefed).
      getInputHandler()({ text: formatNotice("sub-d00d", "worker", "done") });
      await sleep(1500);
      expect(sent.length).toBe(1);
      getShutdownHandler()();
    },
    20000,
  );
  test(
    "the liveness tick re-drives a release for a target stranded behind a cancelled health check whose notice was lost",
    async () => {
      const createExtension = await freshExtension([
        // The target: it has ended, with no visible answer (pane gone).
        {
          runId: "sub-eeee",
          agent: "worker",
          hasSession: true,
          hasSidecar: true,
          visibleAnswer: false,
          status: "running",
          paneId: "w9:pT",
        },
        // Its health check, still running when the target is deferred.
        {
          runId: "sub-ffff",
          agent: "healthcheck",
          hasSession: true,
          hasSidecar: true,
          status: "running",
          healthCheckOf: "sub-eeee",
          paneId: "w9:pHC",
        },
      ]);
      const savedGetAgent = herdrState.getAgent;
      const agentDirOnDisk = process.env.PI_CODING_AGENT_DIR;
      // Hoisted out of the `try` so the `finally` can clear the real 60 s
      // setInterval even on a failing assertion.
      const stub = stubPi();
      try {
        // The target's pane is gone; the health check's pane is alive.
        herdrState.getAgent = async (paneId: string) =>
          paneId === "w9:pHC" ? { status: "working" } : null;

        createExtension(stub.pi);

        const handler = stub.getInputHandler();
        // The target ends without an answer: deferred behind the running health
        // check (reused, not spawned), no wake.
        handler({ text: formatNotice("sub-eeee", "worker", "done") });
        await sleep(3000);
        expect(stub.sent.length).toBe(0);

        // Cancel the health check through the production path: the cancel
        // action enqueues the check's own done notice — the release.
        const tasks = await listTasks(stub as any);
        const hcs = tasks.filter((t) => t.agent === "healthcheck" && t.status === "running");
        expect(hcs.length).toBe(1);
        const hcId = hcs[0].task;
        await stub.getTool("subagent_tasks").execute("t1", { action: "cancel", ids: [hcId] }, undefined, () => {}, {});

        // The release notice is lost: the session goes away before the coalesce
        // window fires, clearing `pending`.
      } finally {
        // In the `finally` so the real 60 s setInterval is cleared even on a
        // failing assertion.
        stub.getShutdownHandler()();
        herdrState.getAgent = savedGetAgent;
      }
      // The orchestrator restarts from DISK: a fresh module instance (so the
      // top-level `loadRegistry` re-runs) pointed at the same temp agent dir,
      // where the metas the first half wrote are the on-disk contract this
      // half pins — terminal target, terminal check, no briefed mark. Both
      // records are terminal and nothing is running, so no tick's
      // collectFinished ever sees them again; only the stranded-release scan
      // can re-drive the release.
      const restartedFactory = await loadExtensionInDir(agentDirOnDisk!);
      const restarted = stubPi();
      const hooks = restartedFactory(restarted.pi);
      try {
        // All panes are gone: the restarted registry's records are terminal.
        herdrState.getAgent = async () => null;
        void restarted.getInputHandler();

        // The tick's stranded-release scan re-enqueues the lost release.
        await hooks.runLivenessTick();
        await sleep(3000);

        // One steering wake carrying the health check's block and the released
        // target's no-answer block.
        expect(restarted.sent.length).toBe(1);
        expect(restarted.sent[0].options?.deliverAs).toBe("steer");
        expect(restarted.sent[0].text).toContain("health check of sub-eeee");
        expect(restarted.sent[0].text).toContain("=== sub-eeee");
        expect(restarted.sent[0].text).toContain("(no final answer in transcript)");
        restarted.getShutdownHandler()();
      } finally {
        herdrState.getAgent = savedGetAgent;
      }
    },
    20000,
  );
  test(
    "a degraded target block is delivered, re-driven by the scan, and bounded by MAX_DEGRADED_RELEASE_ATTEMPTS",
    async () => {
      const createExtension = await freshExtension([
        // The target: terminal (failed), no session file. Its block degrades
        // because the pane diagnostic (readAgent) throws — doneBlock probes
        // the pane when a failed target has no answer.
        {
          runId: "sub-eeee",
          agent: "worker",
          hasSession: false,
          hasSidecar: false,
          status: "failed",
          paneId: "w9:pT",
        },
        // Its health check: terminal, with an answer.
        {
          runId: "sub-ffff",
          agent: "healthcheck",
          answer: "HC REPORT: target transcript unreadable",
          hasSession: true,
          hasSidecar: true,
          status: "done",
          healthCheckOf: "sub-eeee",
          paneId: "w9:pHC",
        },
      ]);
      const { pi, sent, getShutdownHandler } = stubPi();
      const hooks = createExtension(pi);
      const savedReadAgent = herdrState.readAgent;
      const savedPaneLabel = herdrState.paneLabel;
      try {
        // The seam the tests use for herdr reads: the target's block degrades
        // when the pane probe throws.
        herdrState.paneLabel = async (paneId: string) =>
          paneId === "w9:pT" ? "worker sub-eeee" : undefined;
        herdrState.readAgent = async () => {
          throw new Error("pane gone");
        };
        // Tick 1: the scan re-enqueues the release; the flush delivers the
        // check's block plus the degraded target block (pointing at
        // subagent_tasks), and marks NEITHER id briefed.
        await hooks.runLivenessTick();
        await sleep(1500);

        expect(sent.length).toBe(1);
        expect(sent[0].options?.deliverAs).toBe("steer");
        expect(sent[0].text).toContain("health check of sub-eeee");
        // The degraded block carries the real header, not a hand-rolled one.
        expect(sent[0].text).toContain("=== sub-eeee");
        expect(sent[0].text).toContain("result block unavailable");
        expect(sent[0].text).toContain("subagent_tasks");

        // Ticks 2 and 3: the scan re-drives the degraded release — two more
        // deliveries (attempts 2 and 3).
        await hooks.runLivenessTick();
        await sleep(1500);
        await hooks.runLivenessTick();
        await sleep(1500);
        expect(sent.length).toBe(3);
        expect(sent[2].text).toContain("result block unavailable");

        // Tick 4: the bound is burned — the scan marks both ids briefed and the
        // last degraded block stands as the final delivery. No re-enqueue.
        await hooks.runLivenessTick();
        await sleep(1500);
        expect(sent.length).toBe(3);

        // Tick 5: the pair is quiet (briefed) — no further re-enqueue.
        await hooks.runLivenessTick();
        await sleep(1500);
        expect(sent.length).toBe(3);
        getShutdownHandler()();
      } finally {
        herdrState.readAgent = savedReadAgent;
        herdrState.paneLabel = savedPaneLabel;
      }
    },
    30000,
  );

  test(
    "a compose failure on the health check's own block marks the pair briefed and names the target in the fallback briefing",
    async () => {
      const createExtension = await freshExtension([
        // The target: terminal (failed), no session file — its block degrades
        // (readAgent throws), exactly as in the bound-burning test above.
        {
          runId: "sub-eeee",
          agent: "worker",
          hasSession: false,
          hasSidecar: false,
          status: "failed",
          paneId: "w9:pT",
        },
        // Its health check: terminal (failed), no answer — its own block
        // probes the pane (paneDiagnostic → readAgent), which throws, so the
        // compose itself throws and the fallback briefing goes out.
        {
          runId: "sub-ffff",
          agent: "healthcheck",
          hasSession: false,
          hasSidecar: false,
          status: "failed",
          healthCheckOf: "sub-eeee",
          paneId: "w9:pHC",
        },
      ]);

      const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
      const hooks = createExtension(pi);
      const savedReadAgent = herdrState.readAgent;
      const savedPaneLabel = herdrState.paneLabel;
      try {
        herdrState.paneLabel = async (paneId: string) =>
          paneId === "w9:pT" ? "worker sub-eeee" : paneId === "w9:pHC" ? "healthcheck sub-ffff" : undefined;
        herdrState.readAgent = async () => {
          throw new Error("pane gone");
        };

        // The check's done notice drives the flush; the compose throws on the
        // check's own block, so the fallback briefing is what goes out.
        getInputHandler()({ text: formatNotice("sub-ffff", "healthcheck", "done") });
        await sleep(1500);

        expect(sent.length).toBe(1);
        // BOTH ids are in the fallback text. The target is neither a fresh
        // notice nor a swept record, so only the explicit release line
        // surfaces it.
        expect(sent[0].text).toContain("sub-ffff");
        expect(sent[0].text).toContain("sub-eeee");
        expect(sent[0].text).toContain("release carried by the failed health check's briefing");

        // The pair is marked briefed — the scan cannot re-drive it.
        expect(hooks.briefedFinishedRunIds.has("sub-ffff")).toBe(true);
        expect(hooks.briefedFinishedRunIds.has("sub-eeee")).toBe(true);

        // The next tick's scan is quiet.
        await hooks.runLivenessTick();
        await sleep(1500);
        expect(sent.length).toBe(1);
      } finally {
        herdrState.readAgent = savedReadAgent;
        herdrState.paneLabel = savedPaneLabel;
      }
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "a compose failure with an unregistered target names the bare target id in the fallback briefing",
    async () => {
      // Only the health check is on disk: its `healthCheckOf` points at an id
      // with no runs-map entry (a meta.json that failed to parse at
      // loadRegistry, or a check pointing at a run this process never
      // registered). The check's own block degrades (readAgent throws), so
      // the compose throws and the fallback briefing goes out.
      const createExtension = await freshExtension([
        {
          runId: "sub-ffff",
          agent: "healthcheck",
          hasSession: false,
          hasSidecar: false,
          status: "failed",
          healthCheckOf: "sub-0000",
          paneId: "w9:pHC",
        },
      ]);

      const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
      const hooks = createExtension(pi);
      const savedReadAgent = herdrState.readAgent;
      const savedPaneLabel = herdrState.paneLabel;
      try {
        herdrState.paneLabel = async (paneId: string) =>
          paneId === "w9:pHC" ? "healthcheck sub-ffff" : undefined;
        herdrState.readAgent = async () => {
          throw new Error("pane gone");
        };

        getInputHandler()({ text: formatNotice("sub-ffff", "healthcheck", "done") });
        await sleep(1500);

        expect(sent.length).toBe(1);
        // The check id arrives as the fresh notice; the target — neither a
        // fresh notice nor a swept record, with no registry entry at all — is
        // surfaced only by the unregistered-target release line.
        expect(sent[0].text).toContain("sub-ffff");
        expect(sent[0].text).toContain("sub-0000");
        expect(sent[0].text).toContain("not in my registry");

        // The check is marked briefed; there is no target record to mark, and
        // no record the scan could re-drive from.
        expect(hooks.briefedFinishedRunIds.has("sub-ffff")).toBe(true);

        // The next tick's scan is quiet: it loops over targets in the
        // registry, and there is none for this pair.
        await hooks.runLivenessTick();
        await sleep(1500);
        expect(sent.length).toBe(1);
      } finally {
        herdrState.readAgent = savedReadAgent;
        herdrState.paneLabel = savedPaneLabel;
      }
      getShutdownHandler()();
    },
    20000,
  );
  test(
    "a swept health check whose compose fails names and releases its target in the fallback briefing",
    async () => {
      const createExtension = await freshExtension([
        // The target: terminal (failed), no session file.
        {
          runId: "sub-eeee",
          agent: "worker",
          hasSession: false,
          hasSidecar: false,
          status: "failed",
          paneId: "w9:pT",
        },
        // Its health check: RUNNING, no sidecar, so the flush's sweep
        // classifies it failed. It has no notice of its own — the sweep is
        // what surfaces it, and its own block degrades (readAgent throws),
        // which is what makes the compose throw.
        {
          runId: "sub-ffff",
          agent: "healthcheck",
          hasSession: false,
          hasSidecar: false,
          status: "running",
          healthCheckOf: "sub-eeee",
          paneId: "w9:pHC",
        },
        // An unrelated run that drives the flush: terminal and answered, so
        // it renders without spawning anything of its own.
        {
          runId: "sub-9999",
          agent: "worker",
          answer: "unrelated answer",
          hasSession: true,
          hasSidecar: true,
          status: "done",
          paneId: "w9:pR",
        },
      ]);

      const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
      const hooks = createExtension(pi);
      const savedReadAgent = herdrState.readAgent;
      const savedPaneLabel = herdrState.paneLabel;
      try {
        herdrState.paneLabel = async (paneId: string) =>
          paneId === "w9:pT" ? "worker sub-eeee" : paneId === "w9:pHC" ? "healthcheck sub-ffff" : undefined;
        herdrState.readAgent = async () => {
          throw new Error("pane gone");
        };

        // Only the unrelated run's notice is in the batch; the check is swept.
        getInputHandler()({ text: formatNotice("sub-9999", "worker", "done") });
        await sleep(1500);

        expect(sent.length).toBe(1);
        // The swept check's release rides the fallback: the target is neither
        // a fresh notice nor a swept record, so only the explicit release
        // line surfaces it — and the pair retires together.
        expect(sent[0].text).toContain("sub-ffff");
        expect(sent[0].text).toContain("sub-eeee");
        expect(sent[0].text).toContain("release carried by the failed health check's briefing");

        // "HC briefed ⇒ target released": both ids are marked briefed.
        expect(hooks.briefedFinishedRunIds.has("sub-ffff")).toBe(true);
        expect(hooks.briefedFinishedRunIds.has("sub-eeee")).toBe(true);

        // The next tick's scan is quiet.
        await hooks.runLivenessTick();
        await sleep(1500);
        expect(sent.length).toBe(1);
      } finally {
        herdrState.readAgent = savedReadAgent;
        herdrState.paneLabel = savedPaneLabel;
      }
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "a running health check's notice during a failed compose does not release its target",
    async () => {
      const createExtension = await freshExtension([
        // The target: terminal, with a visible answer — its real block is
        // what a bogus release would strand.
        {
          runId: "sub-eeee",
          agent: "worker",
          answer: "target answer",
          hasSession: true,
          hasSidecar: true,
          status: "done",
          paneId: "w9:pT",
        },
        // Its health check: still RUNNING — a mid-run report notice is not a
        // release.
        {
          runId: "sub-ffff",
          agent: "healthcheck",
          hasSession: false,
          hasSidecar: false,
          status: "running",
          healthCheckOf: "sub-eeee",
          paneId: "w9:pHC",
        },
        // A terminal health check whose own block degrades (readAgent
        // throws): it is what makes the compose throw. Its target is
        // unregistered, so the fallback also exercises the bare-id line.
        {
          runId: "sub-9999",
          agent: "healthcheck",
          hasSession: false,
          hasSidecar: false,
          status: "failed",
          healthCheckOf: "sub-0000",
          paneId: "w9:pR",
        },
      ]);
      // The running check's pane is alive; everything else is gone.
      const savedGetAgent = herdrState.getAgent;
      herdrState.getAgent = async (paneId: string) =>
        paneId === "w9:pHC" ? { status: "working" } : null;

      const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
      const hooks = createExtension(pi);
      const savedReadAgent = herdrState.readAgent;
      const savedPaneLabel = herdrState.paneLabel;
      try {
        herdrState.paneLabel = async (paneId: string) =>
          paneId === "w9:pR" ? "healthcheck sub-9999" : undefined;
        herdrState.readAgent = async () => {
          throw new Error("pane gone");
        };

        // The running check's mid-run report, plus the terminal check's done
        // notice (whose block throws, so the fallback briefing goes out).
        getInputHandler()({ text: formatNotice("sub-ffff", "healthcheck", "report", "mid-run update") });
        getInputHandler()({ text: formatNotice("sub-9999", "healthcheck", "done") });
        await sleep(1500);

        expect(sent.length).toBe(1);
        expect(sent[0].text).toContain("sub-ffff");
        expect(sent[0].text).toContain("mid-run update");
        // The terminal check's unregistered target still gets its bare-id line.
        expect(sent[0].text).toContain("sub-0000");
        // The RUNNING check's target is not released: it is neither a fresh
        // notice nor a swept record, so its id must not appear at all.
        expect(sent[0].text).not.toContain("sub-eeee");

        // Neither id of the running pair is marked briefed — the release is
        // not retired, and the target is not.
        expect(hooks.briefedFinishedRunIds.has("sub-ffff")).toBe(false);
        expect(hooks.briefedFinishedRunIds.has("sub-eeee")).toBe(false);
        expect(hooks.briefedFinishedRunIds.has("sub-9999")).toBe(true);

        // The next successful flush delivers the target's real block: the
        // check finishes (pane gone) and its done notice releases the target.
        herdrState.readAgent = savedReadAgent;
        herdrState.getAgent = async () => null;
        getInputHandler()({ text: formatNotice("sub-ffff", "healthcheck", "done") });
        await sleep(1500);

        expect(sent.length).toBe(2);
        expect(sent[1].text).toContain("health check of sub-eeee");
        expect(sent[1].text).toContain("=== sub-eeee");
        expect(sent[1].text).toContain("target answer");
        expect(hooks.briefedFinishedRunIds.has("sub-ffff")).toBe(true);
        expect(hooks.briefedFinishedRunIds.has("sub-eeee")).toBe(true);
      } finally {
        herdrState.readAgent = savedReadAgent;
        herdrState.paneLabel = savedPaneLabel;
        herdrState.getAgent = savedGetAgent;
      }
      getShutdownHandler()();
    },
    20000,
  );
  test(
    "a terminal check's failed compose does not release a running target — its own done notice delivers the block",
    async () => {
      const createExtension = await freshExtension([
        // The target: still RUNNING, with a visible answer — its real block
        // is what a bogus release would strand behind the dedup set.
        {
          runId: "sub-1a01",
          agent: "worker",
          answer: "target answer",
          hasSession: true,
          hasSidecar: true,
          status: "running",
          paneId: "w9:pT",
        },
        // Its health check: terminal (failed), no answer — its own block
        // probes the pane (paneDiagnostic → readAgent), which throws, so the
        // compose itself throws and the fallback briefing goes out.
        {
          runId: "sub-1a02",
          agent: "healthcheck",
          hasSession: false,
          hasSidecar: false,
          status: "failed",
          healthCheckOf: "sub-1a01",
          paneId: "w9:pHC",
        },
      ]);

      const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
      const hooks = createExtension(pi);
      const savedReadAgent = herdrState.readAgent;
      const savedGetAgent = herdrState.getAgent;
      const savedPaneLabel = herdrState.paneLabel;
      try {
        // The target's pane is alive (it is genuinely still running); the
        // check is terminal, so the sweep never probes it.
        herdrState.getAgent = async (paneId: string) =>
          paneId === "w9:pT" ? { status: "working" } : null;
        herdrState.paneLabel = async (paneId: string) =>
          paneId === "w9:pHC" ? "healthcheck sub-1a02" : undefined;
        herdrState.readAgent = async () => {
          throw new Error("pane gone");
        };

        // The check's done notice drives the flush; the compose throws on the
        // check's own block, so the fallback briefing goes out.
        getInputHandler()({ text: formatNotice("sub-1a02", "healthcheck", "done") });
        await sleep(1500);

        expect(sent.length).toBe(1);
        expect(sent[0].text).toContain("sub-1a02");
        // The RUNNING target is not released: it is neither a fresh notice
        // nor a swept record, so its id must not appear at all — and it is
        // not marked briefed, or its real answer would be suppressed.
        expect(sent[0].text).not.toContain("sub-1a01");
        expect(hooks.briefedFinishedRunIds.has("sub-1a02")).toBe(true);
        expect(hooks.briefedFinishedRunIds.has("sub-1a01")).toBe(false);

        // The target then finishes: its pane goes and its done notice
        // arrives. The flush classifies it and delivers the full block.
        herdrState.readAgent = savedReadAgent;
        herdrState.getAgent = async () => null;
        getInputHandler()({ text: formatNotice("sub-1a01", "worker", "done") });
        await sleep(1500);

        expect(sent.length).toBe(2);
        expect(sent[1].text).toContain("=== sub-1a01");
        expect(sent[1].text).toContain("target answer");
        expect(hooks.briefedFinishedRunIds.has("sub-1a01")).toBe(true);
      } finally {
        herdrState.readAgent = savedReadAgent;
        herdrState.getAgent = savedGetAgent;
        herdrState.paneLabel = savedPaneLabel;
      }
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "the liveness tick enqueues a check's release exactly once when the check goes terminal in the tick",
    async () => {
      const createExtension = await freshExtension([
        // The target: already terminal, no session file. Its block degrades
        // (readAgent throws), so the compose's local dedup marks neither id —
        // a duplicate release notice would render the pair twice.
        {
          runId: "sub-1b01",
          agent: "worker",
          hasSession: false,
          hasSidecar: false,
          status: "failed",
          paneId: "w9:pT",
        },
        // Its health check: running with a sidecar, so the tick's reconcile
        // classifies it done in this tick.
        {
          runId: "sub-1b02",
          agent: "healthcheck",
          answer: "HC REPORT: target stuck",
          hasSession: true,
          hasSidecar: true,
          status: "running",
          healthCheckOf: "sub-1b01",
        },
      ]);
      const savedReadAgent = herdrState.readAgent;
      const savedPaneLabel = herdrState.paneLabel;
      try {
        herdrState.paneLabel = async (paneId: string) =>
          paneId === "w9:pT" ? "worker sub-1b01" : undefined;
        herdrState.readAgent = async () => {
          throw new Error("pane gone");
        };

        const { pi, sent, getShutdownHandler } = stubPi();
        const hooks = createExtension(pi);

        // The tick classifies the check done, enqueues its release, and then
        // runs the stranded-release scan — which must NOT enqueue the same
        // release a second time in the same tick (the flush is ~1200 ms away,
        // so the check is still terminal-and-unbriefed when the scan runs).
        await hooks.runLivenessTick();
        await sleep(1500);

        expect(sent.length).toBe(1);
        // Exactly one of each block: a duplicate release notice would render
        // the degraded pair twice in the same briefing.
        expect(sent[0].text.match(/=== sub-1b02/g)?.length).toBe(1);
        expect(sent[0].text.match(/=== sub-1b01/g)?.length).toBe(1);
        expect(sent[0].text.match(/result block unavailable/g)?.length).toBe(1);
        getShutdownHandler()();
      } finally {
        herdrState.readAgent = savedReadAgent;
        herdrState.paneLabel = savedPaneLabel;
      }
    },
    20000,
  );

  test(
    "the liveness tick does not re-enqueue a stranded release whose check finished long ago (age gate)",
    async () => {
      const createExtension = await freshExtension([
        // The target: terminal, with no visible answer.
        {
          runId: "sub-eeee",
          agent: "worker",
          hasSession: true,
          hasSidecar: true,
          visibleAnswer: false,
          status: "done",
          paneId: "w9:pT",
          rawMeta: { finishedAt: Date.now() - 7 * 60_000 },
        },
        // Its health check: terminal, but its terminal transition is older
        // than the scan's 6 * LIVENESS_BACKSTOP_MS age gate — a historical
        // pair, not a release stranded this tick.
        {
          runId: "sub-ffff",
          agent: "healthcheck",
          answer: "HC REPORT: an old diagnosis",
          hasSession: true,
          hasSidecar: true,
          status: "done",
          healthCheckOf: "sub-eeee",
          paneId: "w9:pHC",
          rawMeta: { finishedAt: Date.now() - 7 * 60_000 },
        },
      ]);

      const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
      const hooks = createExtension(pi);
      void getInputHandler();

      // A fresh process (fresh briefed set) must not re-brief this historical
      // pair: the check's finishedAt is older than 6 * LIVENESS_BACKSTOP_MS,
      // so the scan skips it.
      await hooks.runLivenessTick();
      await sleep(1500);
      expect(sent.length).toBe(0);

      // The next tick is equally quiet.
      await hooks.runLivenessTick();
      await sleep(1500);
      expect(sent.length).toBe(0);
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "a child process (PI_SUBAGENT_RUN_ID set) registers no liveness interval",
    async () => {
      const createExtension = await freshExtension([]);
      const realSetInterval = globalThis.setInterval;
      const realClearInterval = globalThis.clearInterval;
      const captured: number[] = [];
      (globalThis as Record<string, unknown>).setInterval = (_cb: unknown, ms: unknown) => {
        captured.push(ms as number);
        return { unref: () => {} };
      };
      (globalThis as Record<string, unknown>).clearInterval = () => {};
      // Control the env var explicitly: this suite normally runs in the
      // orchestrator (unset), but a delegated agent running its own tests has
      // the var set, and the test must be hermetic either way.
      const savedRunId = process.env.PI_SUBAGENT_RUN_ID;
      delete process.env.PI_SUBAGENT_RUN_ID;
      try {
        // Orchestrator (env var unset): exactly one 60 s interval.
        const orch = stubPi();
        createExtension(orch.pi);
        expect(captured).toEqual([60_000]);
        orch.getShutdownHandler()();
        captured.length = 0;

        // Child (env var set): the factory still runs (children spawn and query),
        // but registers no tick — a child's tick would reconcile the shared
        // registry's records it does not own.
        process.env.PI_SUBAGENT_RUN_ID = "sub-child-tick";
        const child = stubPi();
        createExtension(child.pi);
        expect(captured).toHaveLength(0);
        child.getShutdownHandler()();
      } finally {
        if (savedRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
        else process.env.PI_SUBAGENT_RUN_ID = savedRunId;
        (globalThis as Record<string, unknown>).setInterval = realSetInterval;
        (globalThis as Record<string, unknown>).clearInterval = realClearInterval;
      }
    },
    20000,
  );

  test(
    "two concurrent spawnHealthCheck entrants for the same target spawn exactly one health check",
    async () => {
      const createExtension = await freshExtension([]);
      // Every pane stays alive so nothing reconciles the spawned check away.
      herdrState.getAgent = async () => ({ status: "working" });

      const { pi, sent, getShutdownHandler, getTool } = stubPi();
      const hooks = createExtension(pi);

      // Two entrants for the same target in the same synchronous block: the
      // first adds the in-flight marker before its first await, so the second
      // must bail with `{ ok: true }` and no record. Without the marker both
      // would proceed to spawnRun and two checks would register.
      const target: RunRecord = {
        runId: "sub-c0c0",
        agent: "worker",
        task: "test task",
        cwd: "/",
        status: "running",
        startedAt: Date.now(),
      };
      const [r1, r2] = await Promise.all([
        hooks.spawnHealthCheck(target, { kind: "ended-without-result" }),
        hooks.spawnHealthCheck(target, { kind: "stalled", detail: "phase=tool elapsedMs=600000 tool=bash" }),
      ]);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      // The collision entrant carries no record — the first entrant owns it.
      expect([r1, r2].filter((r) => r.rec !== undefined).length).toBe(1);

      // Exactly ONE running health check for the target.
      const tasks = await listTasks({ pi, sent, getShutdownHandler, getTool } as any);
      const hcs = tasks.filter((t) => t.agent === "healthcheck" && t.status === "running");
      expect(hcs.length).toBe(1);
      expect(hcs[0].healthCheckOf).toBe("sub-c0c0");
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "the liveness tick does not re-spawn a health check for a record that is running but already in the exclude set",
    async () => {
      const createExtension = await freshExtension([
        // No answer, dead pane, no health check in flight: a tick that
        // reconciles this record would spawn a fresh health check.
        { runId: "sub-e1e1", agent: "worker", hasSession: true, hasSidecar: true, visibleAnswer: false, status: "running", paneId: "w9:pE1" },
      ]);
      // The pane is gone (reconcile would classify the run from its sidecar).
      herdrState.getAgent = async () => null;

      const { pi, sent, getShutdownHandler, getTool } = stubPi();
      const hooks = createExtension(pi);

      // Plant the id in the exclude set while the record is still `running` in
      // the registry — the state the exclude set exists for (a run already
      // briefed whose terminal status this process has not observed yet).
      // Without the exclude set the tick would reconcile it and spawn a
      // fresh health check for it.
      hooks.briefedFinishedRunIds.add("sub-e1e1");

      await hooks.runLivenessTick();
      await sleep(1500);

      // No health check was spawned, and nothing was briefed.
      const tasks = await listTasks({ pi, sent, getShutdownHandler, getTool } as any);
      expect(tasks.filter((t) => t.agent === "healthcheck")).toHaveLength(0);
      expect(sent.length).toBe(0);
      getShutdownHandler()();
    },
    20000,
  );
  test(
    "a run already marked briefed in the factory dedup set is not rendered again when a later compose re-includes it",
    async () => {
      const createExtension = await freshExtension([
        {
          runId: "sub-aaaa",
          agent: "worker",
          answer: "AAA answer",
          hasSession: true,
          hasSidecar: true,
          status: "running",
          paneId: "w9:pA",
        },
      ]);

      const { pi, sent, getInputHandler, getShutdownHandler } = stubPi();
      const hooks = createExtension(pi);

      const handler = getInputHandler();

      // The record is marked briefed in the factory's dedup set while it is
      // still `running` — the state the set's test seam exists to plant, and
      // the only one that drives renderFinished' top dedup through the
      // `briefedFinishedRunIds` clause: at flush time the record is running,
      // so its notice survives the flush-level fresh filter, and the record
      // is in the sweep's exclude set, so it is not swept either. The clause
      // is the only thing that keeps the block out.
      hooks.briefedFinishedRunIds.add("sub-aaaa");

      // The record then finishes; its notice drives the second compose.
      herdrState.getAgent = async () => null;
      handler({ text: formatNotice("sub-aaaa", "worker", "done") });
      await sleep(1500);

      // The one briefing the mark stands for is not rendered a second time:
      // no briefing goes out at all in this session, so the block's total
      // across the session stays at the single prior delivery.
      expect(sent.length).toBe(0);
      expect(sent.map((s) => s.text).join("\n").match(/=== sub-aaaa/g)?.length ?? 0).toBe(0);
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "a non-string healthCheckOf is not treated as a health check (recursion guard ignores it)",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-b0b2", agent: "worker", hasSession: false, hasSidecar: false, paneId: "w9:pB2", rawMeta: { healthCheckOf: 42 } },
      ]);
      herdrState.getAgent = async () => ({ status: "working" });

      const { pi, sent, getInputHandler, getShutdownHandler, getTool } = stubPi();
      createExtension(pi);

      // If the read sites used bare truthiness, the numeric 42 would trip the
      // recursion guard and no health check would spawn.
      getInputHandler()({ text: formatNotice("sub-b0b2", "worker", "stalled", "phase=tool elapsedMs=600000 tool=bash") });
      await sleep(1500);

      const tasks = await listTasks({ pi, sent, getInputHandler, getShutdownHandler, getTool } as any);
      const hcs = tasks.filter((t) => t.agent === "healthcheck" && t.status === "running");
      expect(hcs.length).toBe(1);
      expect(hcs[0].healthCheckOf).toBe("sub-b0b2");
      getShutdownHandler()();
    },
    20000,
  );

  test(
    "cancelling a non-health-check run enqueues no wake notice",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-eeee", agent: "worker", hasSession: false, hasSidecar: false, status: "running", paneId: "w9:pT" },
      ]);
      // The pane is alive: nothing else classifies the run away.
      herdrState.getAgent = async () => ({ status: "working" });

      const { pi, sent, getShutdownHandler, getTool } = stubPi();
      const hooks = createExtension(pi);

      // Cancel through the real dispatch.
      await getTool("subagent_tasks").execute("t1", { action: "cancel", ids: ["sub-eeee"] }, undefined, () => {}, {});
      const tasks = await listTasks({ pi, sent, getShutdownHandler, getTool } as any);
      expect(tasks.find((t) => t.task === "sub-eeee")?.status).toBe("cancelled");

      // An unrelated liveness tick drives the flush path: with no notice
      // enqueued by the cancel, nothing is composed and nothing is sent — a
      // cancelled ordinary run is not a wake (only a cancelled health check
      // is, because its done notice carries the deferred target's release).
      await hooks.runLivenessTick();
      await sleep(1500);
      expect(sent.length).toBe(0);
      getShutdownHandler()();
    },
    20000,
  );
});

describe("run ownership (cross-process sweep)", () => {
  // The registry at ~/.pi/agent/subagent-runs is global: every pi process
  // loads every record, so only the owning pane's process may act on a run
  // autonomously. These tests pin that boundary on every autonomous path —
  // the liveness tick, the flush sweep, the stranded-release scan, the
  // "Still running" tail — and on the query paths, which stay visible to
  // every record but probe (and so may mutate) only the owned ones.

  test(
    "the liveness tick briefs an owned terminal run and leaves a foreign-owned twin untouched",
    async () => {
      const createExtension = await freshExtension([
        // Owned: running, dead pane, sidecar on disk, answered.
        { runId: "sub-aaaa", agent: "worker", answer: "owned answer", hasSession: true, hasSidecar: true, status: "running", paneId: "w9:pA" },
        // Otherwise identical, but owned by another pane.
        { runId: "sub-bbbb", agent: "worker", answer: "foreign answer", hasSession: true, hasSidecar: true, status: "running", paneId: "w9:pB", ownerPane: "w9:pForeign" },
      ]);

      const probed: string[] = [];
      const savedGetAgent = herdrState.getAgent;
      herdrState.getAgent = async (paneId: string) => {
        probed.push(paneId);
        return null; // both panes are gone
      };

      const stub = stubPi();
      const hooks = createExtension(stub.pi);
      try {
        await hooks.runLivenessTick();
        await sleep(1500);

        // The owned run was probed, classified, and briefed.
        expect(probed).toContain("w9:pA");
        expect(stub.sent.length).toBe(1);
        expect(stub.sent[0].text).toContain("owned answer");
        expect(stub.sent[0].text).not.toContain("foreign answer");

        // The foreign twin was never probed and is still running.
        expect(probed).not.toContain("w9:pB");
        const tasks = await listTasks(stub as any);
        expect(tasks.find((t) => t.task === "sub-bbbb")?.status).toBe("running");
      } finally {
        herdrState.getAgent = savedGetAgent;
      }
      stub.getShutdownHandler()();
    },
    20000,
  );

  test(
    "the liveness tick leaves a legacy running record (no ownerPane) unreconciled",
    async () => {
      const createExtension = await freshExtension([
        // Legacy: no ownerPane. Dead pane, sidecar on disk — a tick that
        // reconciled it would classify it done and brief it.
        { runId: "sub-cccc", agent: "worker", answer: "legacy answer", hasSession: true, hasSidecar: true, status: "running", paneId: "w9:pC", ownerPane: "legacy" },
      ]);

      const probed: string[] = [];
      const savedGetAgent = herdrState.getAgent;
      herdrState.getAgent = async (paneId: string) => {
        probed.push(paneId);
        return null;
      };

      const stub = stubPi();
      const hooks = createExtension(stub.pi);
      try {
        await hooks.runLivenessTick();
        await sleep(1500);

        // Nothing was probed, nothing was sent, and the record is untouched.
        expect(probed).toHaveLength(0);
        expect(stub.sent.length).toBe(0);
        const tasks = await listTasks(stub as any);
        expect(tasks.find((t) => t.task === "sub-cccc")?.status).toBe("running");
      } finally {
        herdrState.getAgent = savedGetAgent;
      }
      stub.getShutdownHandler()();
    },
    20000,
  );

  test(
    "a flush sweep folds in an owned finished run, not foreign or legacy ones",
    async () => {
      const createExtension = await freshExtension([
        // The driver: owned, done notice in the batch.
        { runId: "sub-1111", agent: "worker", answer: "driver answer", hasSession: true, hasSidecar: true, status: "running", paneId: "w9:p1" },
        // Owned, finished since the last wake: swept into the same briefing.
        { runId: "sub-2222", agent: "worker", answer: "owned swept answer", hasSession: true, hasSidecar: true, status: "running", paneId: "w9:p2" },
        // Foreign-owned, finished: not swept.
        { runId: "sub-3333", agent: "worker", answer: "foreign swept answer", hasSession: true, hasSidecar: true, status: "running", paneId: "w9:p3", ownerPane: "w9:pForeign" },
        // Legacy, finished: not swept.
        { runId: "sub-4444", agent: "worker", answer: "legacy swept answer", hasSession: true, hasSidecar: true, status: "running", paneId: "w9:p4", ownerPane: "legacy" },
      ]);

      const stub = stubPi();
      createExtension(stub.pi);

      stub.getInputHandler()({ text: formatNotice("sub-1111", "worker", "done") });
      await sleep(1500);

      expect(stub.sent.length).toBe(1);
      expect(stub.sent[0].text).toContain("driver answer");
      expect(stub.sent[0].text).toContain("owned swept answer");
      expect(stub.sent[0].text).not.toContain("foreign swept answer");
      expect(stub.sent[0].text).not.toContain("legacy swept answer");

      // The foreign and legacy records are untouched: still running.
      const tasks = await listTasks(stub as any);
      expect(tasks.find((t) => t.task === "sub-3333")?.status).toBe("running");
      expect(tasks.find((t) => t.task === "sub-4444")?.status).toBe("running");
      stub.getShutdownHandler()();
    },
    20000,
  );

  test(
    "the stranded-release scan re-drives an owned pair, not foreign or legacy pairs",
    async () => {
      const createExtension = await freshExtension([
        // Owned pair: terminal target (no answer) + terminal check (with one).
        { runId: "sub-eeee", agent: "worker", hasSession: true, hasSidecar: true, status: "done", paneId: "w9:pT" },
        { runId: "sub-ffff", agent: "healthcheck", answer: "HC REPORT: owned diagnosis", hasSession: true, hasSidecar: true, status: "done", paneId: "w9:pHC", healthCheckOf: "sub-eeee" },
        // Foreign pair: same shape, different owner.
        { runId: "sub-5555", agent: "worker", hasSession: true, hasSidecar: true, status: "done", paneId: "w9:p5", ownerPane: "w9:pForeign" },
        { runId: "sub-6666", agent: "healthcheck", answer: "HC REPORT: foreign diagnosis", hasSession: true, hasSidecar: true, status: "done", paneId: "w9:p6", healthCheckOf: "sub-5555", ownerPane: "w9:pForeign" },
        // Legacy pair: same shape, no owner.
        { runId: "sub-7777", agent: "worker", hasSession: true, hasSidecar: true, status: "done", paneId: "w9:p7", ownerPane: "legacy" },
        { runId: "sub-8888", agent: "healthcheck", answer: "HC REPORT: legacy diagnosis", hasSession: true, hasSidecar: true, status: "done", paneId: "w9:p8", healthCheckOf: "sub-7777", ownerPane: "legacy" },
      ]);

      const stub = stubPi();
      const hooks = createExtension(stub.pi);

      // First tick: the scan enqueues the owned pair's release, and the
      // flush delivers it as a combined check + target briefing.
      await hooks.runLivenessTick();
      await sleep(1500);
      expect(stub.sent.length).toBe(1);
      expect(stub.sent[0].text).toContain("HC REPORT: owned diagnosis");
      expect(stub.sent[0].text).toContain("=== sub-eeee");
      expect(stub.sent[0].text).not.toContain("foreign diagnosis");
      expect(stub.sent[0].text).not.toContain("legacy diagnosis");
      expect(stub.sent[0].text).not.toContain("sub-5555");
      expect(stub.sent[0].text).not.toContain("sub-7777");

      // Second tick: the owned pair is briefed; the foreign and legacy pairs
      // are never driven — the flush stays quiet.
      await hooks.runLivenessTick();
      await sleep(1500);
      expect(stub.sent.length).toBe(1);
      stub.getShutdownHandler()();
    },
    30000,
  );

  test(
    "the 'Still running' tail names only owned runs",
    async () => {
      const createExtension = await freshExtension([
        // The driver finishes (with an answer) so the flush composes a tail.
        { runId: "sub-a1a1", agent: "worker", answer: "owned done", hasSession: true, hasSidecar: true, status: "running", paneId: "w9:pA1" },
        // Owned, still running: named in the tail.
        { runId: "sub-b2b2", agent: "worker", hasSession: false, hasSidecar: false, status: "running", paneId: "w9:pB2" },
        // Foreign, still running: not named.
        { runId: "sub-c3c3", agent: "worker", hasSession: false, hasSidecar: false, status: "running", paneId: "w9:pC3", ownerPane: "w9:pForeign" },
        // Legacy, still running: not named.
        { runId: "sub-d4d4", agent: "worker", hasSession: false, hasSidecar: false, status: "running", paneId: "w9:pD4", ownerPane: "legacy" },
      ]);

      // The driver's pane is gone (it finishes); the others are alive.
      const savedGetAgent = herdrState.getAgent;
      herdrState.getAgent = async (paneId: string) =>
        paneId === "w9:pA1" ? null : { status: "working" };

      const stub = stubPi();
      createExtension(stub.pi);
      try {
        stub.getInputHandler()({ text: formatNotice("sub-a1a1", "worker", "done") });
        await sleep(1500);

        expect(stub.sent.length).toBe(1);
        expect(stub.sent[0].text).toContain("owned done");
        const tail = stub.sent[0].text.slice(stub.sent[0].text.indexOf("Still running:"));
        expect(tail).toContain("sub-b2b2");
        expect(tail).not.toContain("sub-c3c3");
        expect(tail).not.toContain("sub-d4d4");
      } finally {
        herdrState.getAgent = savedGetAgent;
      }
      stub.getShutdownHandler()();
    },
    20000,
  );

  test(
    "a spawn through the subagent tool stamps ownerPane with this process's pane",
    async () => {
      const createExtension = await freshExtension([]);
      const stub = stubPi();
      createExtension(stub.pi);

      const out = (await stub
        .getTool("subagent")
        .execute("t1", { agent: "healthcheck", task: "a self-contained task" }, undefined, () => {}, {})) as {
        details: { ok: boolean; task: string };
      };
      expect(out.details.ok).toBe(true);
      const runId = out.details.task;

      // The on-disk record carries this process's pane, so the record is
      // owned by exactly the process that spawned it.
      const meta = JSON.parse(
        readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "subagent-runs", runId, "meta.json"), "utf-8"),
      ) as Record<string, unknown>;
      expect(meta.ownerPane).toBe(process.env.HERDR_PANE_ID);
      stub.getShutdownHandler()();
    },
    20000,
  );

  test(
    "a failed launch records the router attempt and links the kept pane in meta.json",
    async () => {
      const createExtension = await freshExtension([]);
      const stub = stubPi();
      createExtension(stub.pi);

      const closed: string[] = [];
      const realClose = herdrState.closePane;
      herdrState.closePane = async (paneId: string) => {
        closed.push(paneId);
        return realClose(paneId);
      };
      const realStart = herdrState.startAgent;
      herdrState.startAgent = async () => ({ ok: false, error: null });

      try {
        const out = (await stub
          .getTool("subagent")
          .execute("t1", { agent: "healthcheck", task: "a self-contained task" }, undefined, () => {}, {})) as {
          details: { ok: boolean };
        };
        expect(out.details.ok).toBe(false);

        // The one run dir on disk is this failed spawn's.
        const runsDir = join(process.env.PI_CODING_AGENT_DIR!, "subagent-runs");
        const entries = readdirSync(runsDir);
        expect(entries.length).toBe(1);
        const meta = JSON.parse(readFileSync(join(runsDir, entries[0]!, "meta.json"), "utf-8")) as Record<
          string,
          unknown
        >;
        expect(meta.status).toBe("failed");
        // The attempt ran on the router, so the record names it.
        const attempts = meta.failedAttempts as Array<{ model: string; error: string }>;
        expect(attempts).toEqual([
          { model: "fallback/auto", error: expect.stringContaining("did not become interactive") },
        ]);
        // The pane is kept (it is the evidence), and the record links to it.
        expect(meta.paneId).toBe("w9:pHC");
        expect(meta.tabId).toBe("w9:tHC");
        expect(closed).toEqual([]);
      } finally {
        herdrState.startAgent = realStart;
        herdrState.closePane = realClose;
      }
      stub.getShutdownHandler()();
    },
    20000,
  );

  test(
    "a spawn hands its chain to the child's env and records it in meta.json",
    async () => {
      const createExtension = await freshExtension([]);
      const stub = stubPi();
      createExtension(stub.pi);

      let seenEnv: Record<string, string> | undefined;
      const realCreate = herdrState.createChildPane;
      herdrState.createChildPane = async (cwd: string, label: string, env?: Record<string, string>) => {
        seenEnv = env;
        return realCreate(cwd, label, env);
      };

      try {
        const readMeta = (runId: string) =>
          JSON.parse(
            readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "subagent-runs", runId, "meta.json"), "utf-8"),
          ) as Record<string, unknown>;

        // No `model` on the call: the agent's declared model is the chain.
        const out1 = (await stub
          .getTool("subagent")
          .execute("t1", { agent: "healthcheck", task: "a self-contained task" }, undefined, () => {}, {})) as {
          details: { ok: boolean; task: string };
        };
        expect(out1.details.ok).toBe(true);
        expect(seenEnv?.PI_FALLBACK_CHAIN).toBe("test/model");
        const meta1 = readMeta(out1.details.task);
        expect(meta1.model).toBe("test/model");
        expect(meta1.fallbackChain).toEqual(["test/model"]);

        // A pinned explicit model: a one-entry chain with the pin, and the
        // record's `model` is the head ref the pin was stripped from.
        const out2 = (await stub
          .getTool("subagent")
          .execute(
            "t2",
            { agent: "healthcheck", task: "a self-contained task", model: "openai/x|high" },
            undefined,
            () => {},
            {},
          )) as { details: { ok: boolean; task: string } };
        expect(out2.details.ok).toBe(true);
        expect(seenEnv?.PI_FALLBACK_CHAIN).toBe("openai/x|high");
        const meta2 = readMeta(out2.details.task);
        expect(meta2.model).toBe("openai/x");
        expect(meta2.fallbackChain).toEqual(["openai/x|high"]);
      } finally {
        herdrState.createChildPane = realCreate;
      }
      stub.getShutdownHandler()();
    },
    20000,
  );

  test(
    "pane output renders only when the pane still carries this run's label",
    async () => {
      const createExtension = await freshExtension([
        // A terminal health check with no answer: its block probes the pane.
        // Its pane id was reused by herdr: the label no longer matches, so no
        // pane output may be attributed to this run.
        {
          runId: "sub-c1c1",
          agent: "healthcheck",
          healthCheckOf: "sub-a001",
          hasSession: false,
          hasSidecar: false,
          status: "failed",
          paneId: "w9:pReused",
        },
        // Its pane still carries the run's label: the output is read.
        {
          runId: "sub-d2d2",
          agent: "healthcheck",
          healthCheckOf: "sub-a002",
          hasSession: false,
          hasSidecar: false,
          status: "failed",
          paneId: "w9:pKeep",
        },
      ]);
      const stub = stubPi();
      createExtension(stub.pi);

      const savedPaneLabel = herdrState.paneLabel;
      const savedReadAgent = herdrState.readAgent;
      try {
        herdrState.paneLabel = async (paneId: string) =>
          paneId === "w9:pReused" ? "explorer sub-other" : paneId === "w9:pKeep" ? "healthcheck sub-d2d2" : undefined;
        herdrState.readAgent = async () => "PANE OUTPUT MARKER";

        stub.getInputHandler()({ text: formatNotice("sub-c1c1", "healthcheck", "done") });
        stub.getInputHandler()({ text: formatNotice("sub-d2d2", "healthcheck", "done") });
        await sleep(1500);

        expect(stub.sent.length).toBe(1);
        const text = stub.sent[0].text;
        expect(text).toContain("=== sub-c1c1");
        expect(text).toContain("=== sub-d2d2");
        // The marker appears exactly once: only the labelled pane's output.
        expect(text.split("PANE OUTPUT MARKER").length - 1).toBe(1);
      } finally {
        herdrState.paneLabel = savedPaneLabel;
        herdrState.readAgent = savedReadAgent;
      }
      stub.getShutdownHandler()();
    },
    20000,
  );

  test(
    "a model the router cannot serve is refused before any run dir or pane",
    async () => {
      const createExtension = await freshExtension([]);
      const stub = stubPi();
      createExtension(stub.pi);

      let paneCreates = 0;
      const realCreate = herdrState.createChildPane;
      herdrState.createChildPane = async (...args: Parameters<typeof realCreate>) => {
        paneCreates++;
        return realCreate(...args);
      };

      try {
        // `fallback/auto` is the router itself: a child cannot route to it, so
        // the delegation is refused up front, and the message names the
        // requested model, not the agent file.
        const out = (await stub
          .getTool("subagent")
          .execute("t1", { agent: "healthcheck", task: "a self-contained task", model: "fallback/auto" }, undefined, () => {}, {})) as {
          content: { text: string }[];
          details: { ok: boolean };
        };
        expect(out.details.ok).toBe(false);
        expect(out.content[0].text).toContain('Requested model "fallback/auto"');

        // A ref the item grammar rejects is refused the same way.
        const out2 = (await stub
          .getTool("subagent")
          .execute("t2", { agent: "healthcheck", task: "a self-contained task", model: "bad ref:" }, undefined, () => {}, {})) as {
          content: { text: string }[];
          details: { ok: boolean };
        };
        expect(out2.details.ok).toBe(false);
        expect(out2.content[0].text).toContain("bad ref:");
      } finally {
        herdrState.createChildPane = realCreate;
      }

      // The refusal spends nothing: no pane was created, and no run dir exists.
      expect(paneCreates).toBe(0);
      const runsDir = join(process.env.PI_CODING_AGENT_DIR!, "subagent-runs");
      expect(existsSync(runsDir) ? readdirSync(runsDir) : []).toEqual([]);
      stub.getShutdownHandler()();
    },
    20000,
  );

  test(
    "ownership is an autonomous-sweep boundary, not an authorization boundary",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-o111", agent: "explorer", answer: "owned result", hasSession: true, hasSidecar: true, status: "done", paneId: "w9:pO" },
        { runId: "sub-f222", agent: "worker", answer: "foreign result", hasSession: true, hasSidecar: true, status: "done", paneId: "w9:pF", ownerPane: "w9:pForeign" },
        { runId: "sub-l333", agent: "librarian", answer: "legacy result", hasSession: true, hasSidecar: true, status: "done", paneId: "w9:pL", ownerPane: "legacy" },
      ]);
      const stub = stubPi();
      createExtension(stub.pi);

      // list returns every run, owned or not — the registry is global.
      const list = await listTasks(stub as any);
      expect(list.map((t) => t.task).sort()).toEqual(["sub-f222", "sub-l333", "sub-o111"]);

      // status works for foreign and legacy ids.
      const status = (await stub.getTool("subagent_tasks").execute("t1", { action: "status", ids: ["sub-f222", "sub-l333"] }, undefined, () => {}, {})) as { content: { text: string }[] };
      expect(status.content[0].text).toContain("sub-f222 (worker): done");
      expect(status.content[0].text).toContain("sub-l333 (librarian): done");

      // result works for foreign and legacy ids too.
      const result = (await stub.getTool("subagent_tasks").execute("t1", { action: "result", ids: ["sub-f222", "sub-l333"] }, undefined, () => {}, {})) as { content: { text: string }[] };
      expect(result.content[0].text).toContain("foreign result");
      expect(result.content[0].text).toContain("legacy result");
      stub.getShutdownHandler()();
    },
    20000,
  );
  test(
    "a status/result query for a foreign-owned running record neither probes nor mutates it",
    async () => {
      const createExtension = await freshExtension([
        // Foreign-owned, running: a query that reconciled it would probe
        // herdr, and with the pane gone would classify it and save meta.
        { runId: "sub-f222", agent: "worker", hasSession: false, hasSidecar: false, status: "running", paneId: "w9:pF", ownerPane: "w9:pForeign" },
      ]);
      const stub = stubPi();
      createExtension(stub.pi);

      const probed: string[] = [];
      const closed: string[] = [];
      const savedGetAgent = herdrState.getAgent;
      const savedClosePane = herdrState.closePane;
      herdrState.getAgent = async (paneId: string) => {
        probed.push(paneId);
        return null; // pane gone: a probe here would classify the record
      };
      herdrState.closePane = async (paneId: string) => {
        closed.push(paneId);
        return true;
      };

      try {
        const status = (await stub.getTool("subagent_tasks").execute("t1", { action: "status", ids: ["sub-f222"] }, undefined, () => {}, {})) as { content: { text: string }[]; details: Record<string, unknown> };
        // On-disk state, reported without probing herdr — and the details
        // say so (`owned: false`), so the orchestrator can tell it from a
        // probed status.
        expect(status.content[0].text).toBe("sub-f222 (worker): running");
        expect(status.details["sub-f222"]).toEqual({ status: "running", herdr: null, owned: false });
        expect(probed).not.toContain("w9:pF");

        const result = (await stub.getTool("subagent_tasks").execute("t1", { action: "result", ids: ["sub-f222"] }, undefined, () => {}, {})) as { content: { text: string }[] };
        // The "not probed" marker pins the foreign-ownership distinction:
        // this is unverified on-disk state, not a live probe.
        expect(result.content[0].text).toContain("still running");
        expect(result.content[0].text).toContain(" [not probed: owned by another session]");
        expect(probed).not.toContain("w9:pF");

        // The record is untouched on disk and its pane is still open.
        const meta = JSON.parse(
          readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "subagent-runs", "sub-f222", "meta.json"), "utf-8"),
        ) as Record<string, unknown>;
        expect(meta.status).toBe("running");
        expect(closed).not.toContain("w9:pF");
      } finally {
        herdrState.getAgent = savedGetAgent;
        herdrState.closePane = savedClosePane;
      }
      stub.getShutdownHandler()();
    },
    20000,
  );
  test(
    "a status/result query for a legacy running record (no ownerPane) neither probes nor mutates it",
    async () => {
      const createExtension = await freshExtension([
        // Legacy: no ownerPane. Running, pane gone — a query that reconciled
        // it would probe herdr and classify it from disk.
        { runId: "sub-l999", agent: "worker", hasSession: false, hasSidecar: false, status: "running", paneId: "w9:pL9", ownerPane: "legacy" },
      ]);
      const stub = stubPi();
      createExtension(stub.pi);

      const probed: string[] = [];
      const savedGetAgent = herdrState.getAgent;
      herdrState.getAgent = async (paneId: string) => {
        probed.push(paneId);
        return null; // pane gone: a probe here would classify the record
      };

      try {
        const status = (await stub.getTool("subagent_tasks").execute("t1", { action: "status", ids: ["sub-l999"] }, undefined, () => {}, {})) as { content: { text: string }[]; details: Record<string, unknown> };
        // On-disk state, reported without probing herdr — and the details
        // say so (`owned: false`), so the orchestrator can tell it from a
        // probed status.
        expect(status.content[0].text).toBe("sub-l999 (worker): running");
        expect(status.details["sub-l999"]).toEqual({ status: "running", herdr: null, owned: false });
        expect(probed).not.toContain("w9:pL9");

        const result = (await stub.getTool("subagent_tasks").execute("t1", { action: "result", ids: ["sub-l999"] }, undefined, () => {}, {})) as { content: { text: string }[] };
        // The legacy arm of the "not probed" marker: no ownerPane is
        // recorded, which is named distinctly from foreign ownership.
        expect(result.content[0].text).toContain("still running");
        expect(result.content[0].text).toContain(" [not probed: no owner recorded]");
        expect(probed).not.toContain("w9:pL9");

        // The record is untouched on disk.
        const meta = JSON.parse(
          readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "subagent-runs", "sub-l999", "meta.json"), "utf-8"),
        ) as Record<string, unknown>;
        expect(meta.status).toBe("running");
      } finally {
        herdrState.getAgent = savedGetAgent;
      }
      stub.getShutdownHandler()();
    },
    20000,
  );
});

