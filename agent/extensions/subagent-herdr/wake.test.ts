/**
 * Factory-wiring and integration tests for subagent-herdr: the `input` hook
 * and steering delivery, the `collectFinished` adapter, the liveness interval
 * guard, the spawn and query paths, and end-to-end smoke of the release paths
 * (cancel, stranded re-drive, degraded bound, compose-failure fallback) and
 * late-completion revival through the real factory. Release *policy* is pinned
 * with explicit time in `release-ledger.test.ts`.
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
import { formatExitSidecar, formatNotice, systemPromptPath, type RunRecord } from "./rundir.js";
import type { SubagentHerdrHooks } from "./index.js";
import type { RunObservation } from "./run-lifecycle.js";
// ---------------------------------------------------------------------------
// herdr CLI mock
// ---------------------------------------------------------------------------

/**
 * Mutable herdr behaviours for the tests. The mocked module delegates to these
 * at call time, so reassigning a function mid-test takes effect immediately.
 * Defaults: spawns succeed, every pane probe reports the pane as gone
 * (`probeAgent` → `{kind:"gone"}`; records are then classified from disk).
 */
/** A probe proving the pane is gone (herdr's `agent_not_found`). */
const GONE: realHerdr.AgentProbe = { kind: "gone" };
/** A probe of a live pane in the given herdr state. */
const live = (status: realHerdr.AgentState): realHerdr.AgentProbe => ({ kind: "state", status, name: undefined });

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
  probeAgent: async (_paneId: string): Promise<realHerdr.AgentProbe> => GONE,
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
  // Production never asks getAgent (its null cannot tell gone from
  // unreachable); a regression back to it must fail loudly, not pass on null.
  getAgent: async () => {
    throw new Error("getAgent is compatibility-only: production must use probeAgent");
  },
  probeAgent: (paneId: string) => herdrState.probeAgent(paneId),
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
  /**
   * Written to the run's `system-prompt.md` when set. A prompt containing
   * `<result>` puts the child under the `<result>` contract, so `qualifiesAsAnswer`
   * requires a complete `<result>…</result>` element rather than any visible text.
   */
  systemPrompt?: string;
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
async function freshExtensionWithDir(runs: RunFixture[]) {
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
    if (r.systemPrompt) {
      writeFileSync(systemPromptPath(runDir), r.systemPrompt);
    }
  }

  const factory = await loadExtensionInDir(dir);
  return { factory, dir };
}

/**
 * Creates a temp agent dir with the given run fixtures (plus a `healthcheck`
 * agent definition, so the parent can spawn one programmatically), and imports
 * a fresh instance of the extension factory pointed at it. Returns only the
 * factory; use `freshExtensionWithDir` when a test must reach the on-disk run
 * directory (to append a transcript entry or drop a `.exit` sidecar after load).
 */
async function freshExtension(runs: RunFixture[]) {
  return (await freshExtensionWithDir(runs)).factory;
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
  herdrState.probeAgent = async () => GONE;
  herdrState.paneLabel = async () => undefined;
  herdrState.readAgent = async () => null;
});

// ---------------------------------------------------------------------------
// collectFinished unit tests
// ---------------------------------------------------------------------------

describe("collectFinished", () => {
  // A thin adapter over the lifecycle's sweep: it passes the records and the
  // exclude set through and returns the sweep's finished observations as-is.
  // Concurrency, isolation and ordering are the lifecycle's own contract,
  // pinned in run-lifecycle.test.ts.
  const observation = (rec: RunRecord): RunObservation => ({
    run: rec,
    pane: { kind: "gone" },
    result: async () => ({ found: false, answered: false, text: "" }),
  });

  test("returns the sweep's finished observations, in their order, and forwards the exclude set", async () => {
    const { collectFinished } = await import("./index.js?collect=1");

    const recs: RunRecord[] = [
      { runId: "sub-0001", agent: "a", task: "t", cwd: "/", status: "running", startedAt: 1 },
      { runId: "sub-0002", agent: "b", task: "t", cwd: "/", status: "running", startedAt: 2 },
      { runId: "sub-0003", agent: "c", task: "t", cwd: "/", status: "done", startedAt: 3 },
      { runId: "sub-0004", agent: "d", task: "t", cwd: "/", status: "running", startedAt: 4 },
    ];
    const exclude = new Set(["sub-0002"]);
    let seen: { recs: readonly RunRecord[]; exclude?: ReadonlySet<string> } | undefined;
    const owner = {
      sweep: async (r: readonly RunRecord[], opts?: { exclude?: ReadonlySet<string> }) => {
        seen = { recs: r, exclude: opts?.exclude };
        const finished = [observation(r[0]), observation(r[3])];
        return { transitions: [], finished };
      },
    };

    const result = await collectFinished(recs, exclude, owner);
    expect(result.map((o) => o.run.runId)).toEqual(["sub-0001", "sub-0004"]);
    expect(seen?.recs).toBe(recs);
    expect(seen?.exclude).toBe(exclude);
  });

  test("returns empty when the sweep finishes nothing", async () => {
    const { collectFinished } = await import("./index.js?collect=3");

    const recs: RunRecord[] = [
      { runId: "sub-cccc", agent: "z", task: "t", cwd: "/", status: "done", startedAt: 1 },
    ];

    const result = await collectFinished(recs, new Set(), { sweep: async () => ({ transitions: [], finished: [] }) });
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
      herdrState.probeAgent = async () => live("working");

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
      herdrState.probeAgent = async (paneId: string) =>
        paneId === "w9:pR" || paneId === "w9:pHC" ? live("working") : GONE;

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
      herdrState.probeAgent = async () => GONE;
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
      const savedProbeAgent = herdrState.probeAgent;
      const agentDirOnDisk = process.env.PI_CODING_AGENT_DIR;
      // Hoisted out of the `try` so the `finally` can clear the real 60 s
      // setInterval even on a failing assertion.
      const stub = stubPi();
      try {
        // The target's pane is gone; the health check's pane is alive.
        herdrState.probeAgent = async (paneId: string) =>
          paneId === "w9:pHC" ? live("working") : GONE;

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
        herdrState.probeAgent = savedProbeAgent;
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
        herdrState.probeAgent = async () => GONE;
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
        herdrState.probeAgent = savedProbeAgent;
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
        // The briefed marks and the retired cache entries (the d8523d8 leak
        // regression) are pinned on the ledger itself in release-ledger.test.ts.
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

        // The pair is marked briefed, so the next tick's scan is quiet.
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
    "cancelling a non-health-check run enqueues no wake notice",
    async () => {
      const createExtension = await freshExtension([
        { runId: "sub-eeee", agent: "worker", hasSession: false, hasSidecar: false, status: "running", paneId: "w9:pT" },
      ]);
      // The pane is alive: nothing else classifies the run away.
      herdrState.probeAgent = async () => live("working");

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
      const savedProbeAgent = herdrState.probeAgent;
      const savedClosePane = herdrState.closePane;
      herdrState.probeAgent = async (paneId: string) => {
        probed.push(paneId);
        return GONE; // pane gone: a probe here would classify the record
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
        herdrState.probeAgent = savedProbeAgent;
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
      const savedProbeAgent = herdrState.probeAgent;
      herdrState.probeAgent = async (paneId: string) => {
        probed.push(paneId);
        return GONE; // pane gone: a probe here would classify the record
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
        herdrState.probeAgent = savedProbeAgent;
      }
      stub.getShutdownHandler()();
    },
    20000,
  );
});

describe("issue #1: done-pane completion signals and late-completion revival", () => {
  // A pane reporting `done` is "ready for input", not "run finished". These
  // tests pin the new contract: a run only goes terminal on a real completion
  // signal (the `.exit` sidecar, a qualifying `<result>`, or a gone pane), and
  // a run already mis-marked `failed` is revived when its report appears.
  //
  // Revival is bounded: only a run that actually launched (no
  // `failedAttempts`), only within six liveness intervals of its terminal
  // transition, and only when its session file changed (size/mtime) since the
  // lifecycle last examined it — so an unchanged failed run is not re-read on
  // every tick.

  const RESULT_PROMPT = "Only what is inside <result> reaches the orchestrator.";

  function writeResultTranscript(runDir: string, runId: string, body: string) {
    const sessionFile = join(runDir, `1750000000000_${runId}.jsonl`);
    writeFileSync(
      sessionFile,
      JSON.stringify({
        message: { role: "assistant", content: [{ type: "text", text: body }], stopReason: "stop" },
      }) + "\n",
    );
  }

  test(
    "an unreachable herdr leaves a running record untouched: not failed, not closed, not persisted terminal",
    async () => {
      // THE defect: every herdr failure used to read as "pane gone", so a
      // timeout or a crashed CLI classified a still-working child `failed`.
      const { factory, dir } = await freshExtensionWithDir([
        { runId: "sub-0a0b", agent: "worker", hasSession: true, hasSidecar: false, visibleAnswer: false, status: "running", paneId: "w9:pU" },
      ]);
      herdrState.probeAgent = async () => ({ kind: "unreachable", error: "herdr exited 1" });
      const closedPanes: string[] = [];
      const savedClosePane = herdrState.closePane;
      herdrState.closePane = async (id: string) => { closedPanes.push(id); return true; };
      try {
        const stub = stubPi();
        const hooks = factory(stub.pi);
        await hooks.runLivenessTick();
        await sleep(1500);

        const tasks = await listTasks(stub as any);
        expect(tasks.find((t) => t.task === "sub-0a0b")?.status).toBe("running");
        expect(closedPanes).toEqual([]);
        expect(stub.sent.length).toBe(0);
        expect(tasks.filter((t) => t.agent === "healthcheck").length).toBe(0);
        const onDisk = JSON.parse(readFileSync(join(dir, "subagent-runs", "sub-0a0b", "meta.json"), "utf-8"));
        expect(onDisk.status).toBe("running");
        expect(onDisk.finishedAt).toBeUndefined();

        // The query paths must not dress an unreachable herdr up as a missing pane.
        const tasks2 = stub.getTool("subagent_tasks");
        const status = (await tasks2.execute("t1", { action: "status", ids: ["sub-0a0b"] }, undefined, () => {}, {})) as { content: { text: string }[] };
        expect(status.content[0].text).toContain("sub-0a0b (worker): running");
        expect(status.content[0].text).toContain("unreachable (herdr exited 1)");
        const result = (await tasks2.execute("t1", { action: "result", ids: ["sub-0a0b"] }, undefined, () => {}, {})) as { content: { text: string }[] };
        expect(result.content[0].text).toContain("still running");
        expect(result.content[0].text).toContain("unreachable (herdr exited 1)");
        expect(result.content[0].text).not.toContain("[pane gone]");
        stub.getShutdownHandler()();
      } finally {
        herdrState.closePane = savedClosePane;
      }
    },
    20000,
  );

  test(
    "an examined failed run is quiet while its transcript is unchanged, and revives once it changes",
    async () => {
      const { factory, dir } = await freshExtensionWithDir([
        { runId: "sub-s7a1", agent: "worker", hasSession: true, hasSidecar: false, visibleAnswer: false, status: "failed", paneId: "w9:pS", rawMeta: { finishedAt: Date.now() - 10000 } },
      ]);
      herdrState.probeAgent = async () => GONE;
      const stub = stubPi();
      const hooks = factory(stub.pi);

      // First tick examines it (no signal); the second sees the same stamp.
      await hooks.runLivenessTick();
      await hooks.runLivenessTick();
      await sleep(300);
      expect(stub.sent.length).toBe(0);

      // The late report rewrites the session file: size and mtime move.
      const runDir = join(dir, "subagent-runs", "sub-s7a1");
      writeFileSync(systemPromptPath(runDir), RESULT_PROMPT);
      writeResultTranscript(runDir, "sub-s7a1", "<result>The late report for sub-s7a1.</result>");

      await hooks.runLivenessTick();
      await sleep(1500);
      const rec = (await listTasks(stub as any)).find((t) => t.task === "sub-s7a1");
      expect(rec?.status).toBe("done");
      expect(stub.sent.length).toBe(1);
      expect(stub.sent[0].text).toContain("late report for sub-s7a1");
      stub.getShutdownHandler()();
    },
    20000,
  );

});

