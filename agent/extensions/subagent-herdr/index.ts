/**
 * subagent-herdr — delegation tools backed by herdr.
 *
 * Registers the two tools the orchestrator prompt (dynamic-prompt.ts) already
 * advertises:
 *
 * - `subagent` — delegate a task to one of the agents in
 *   `agent/agents/*.md`. Each spawn opens a **new herdr agent**: a fresh pane
 *   (`herdr pane split`), a native `pi` TUI in it (`herdr agent start
 *   --kind pi` with the agent's system prompt, tools, and model), and the
 *   task delivered as the child's first prompt (`herdr agent prompt`). The
 *   tool returns a task id (`sub-a3f1`), not a result.
 * - `subagent_tasks` — `status` / `wait` / `result` / `list` / `cancel` for
 *   those tasks.
 *
 * ## Completion handshake
 *
 * The child is loaded with `child-done.ts` (`-e`), which writes a
 * `<session>.exit` sidecar next to its session file when the run finishes
 * cleanly (the `subagent_done` tool, or a clean turn end) and then shuts the
 * child down. The parent waits on herdr's agent state (`agent wait --until
 * done`) and classifies from the sidecar:
 *
 * - sidecar present → **done**; the answer is the last assistant message of
 *   the child's session transcript, and the pane is closed (cleanup).
 * - sidecar absent  → **failed**; the pane is kept open with its scrollback
 *   as evidence (herdr destroys scrollback when a pane is closed).
 *
 * Panes persist after the process exits in herdr 0.9.0 (measured), so the
 * failed pane stays readable until the user closes it.
 *
 * ## State
 *
 * Runs are recorded in `<agentDir>/subagent-runs/<runId>/` (gitignored): the
 * child's session file, its sidecar, `system-prompt.md`, and `meta.json`
 * (the registry). The in-memory registry is rebuilt from `meta.json` at
 * load, so a restarted orchestrator can still `list` / `result` old runs.
 *
 * Do not rename this directory's entry point: pi discovers
 * `extensions/<dir>/index.ts` as an extension that must default-export a
 * factory; `child-done.ts` is a plain factory loaded explicitly with `-e`
 * and must stay out of discovery.
 *
 * @module subagent-herdr
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { buildChildArgv, discoverAgents, extractRunResult, makeRunId, type RunResult } from "./lib.js";
import {
  closePane,
  getAgent,
  promptAgent,
  readAgent,
  renamePane,
  sendKeys,
  splitPane,
  startAgent,
  waitAgent,
  waitAgentWorking,
} from "./herdr.js";

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

/** Where every run's session, sidecar and metadata live (gitignored). */
const RUNS_DIR = join(getAgentDir(), "subagent-runs");

/** Directory of this extension, so `child-done.ts` can be passed to a child by absolute path. */
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

/** How long a single `wait` call blocks by default, and the ceiling it will accept. */
const WAIT_DEFAULT_MS = 300_000;
const WAIT_MAX_MS = 900_000;

/** Chunk size for the poll loop: keeps `agent wait` responsive and re-entrant. */
const WAIT_CHUNK_MS = 30_000;

/** Answers are truncated in tool output at this size; the transcript stays complete on disk. */
const RESULT_MAX_CHARS = 20_000;

/**
 * Settle delay between `agent start` resolving and the first prompt. herdr
 * reports interactive-ready as soon as pi's TUI is up, but the first
 * keypress can still race the input layer; a short pause plus the
 * stall-detecting prompt (see herdr.ts) makes the loss of a submission Enter
 * rare, and the recovery path makes it harmless.
 */
const PROMPT_SETTLE_MS = 1500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type RunStatus = "running" | "done" | "failed" | "cancelled";

/** One delegated run. Also persisted verbatim as `meta.json`. */
export interface RunRecord {
  runId: string;
  agent: string;
  task: string;
  cwd: string;
  model?: string;
  paneId?: string;
  tabId?: string;
  runDir: string;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
}

const runs = new Map<string, RunRecord>();

function metaPath(rec: RunRecord): string {
  return join(rec.runDir, "meta.json");
}

function saveMeta(rec: RunRecord): void {
  try {
    writeFileSync(metaPath(rec), JSON.stringify(rec, null, 2));
  } catch {
    // Losing the meta file degrades a run to "unknown after restart"; the
    // session transcript on disk is unaffected, so this never blocks work.
  }
}

/**
 * Rebuilds the in-memory registry from `meta.json` files. A record that says
 * `running` may be stale (the parent restarted, or the child died silently);
 * it is reclassified lazily by the next `status` / `wait` / `result` call,
 * not at load — probing herdr at extension load would slow every pi start.
 */
function loadRegistry(): void {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(RUNS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return;
  }
  for (const d of dirs) {
    try {
      const rec = JSON.parse(readFileSync(join(RUNS_DIR, d, "meta.json"), "utf-8")) as RunRecord;
      if (rec && typeof rec.runId === "string") runs.set(rec.runId, rec);
    } catch {
      // Partial dir (crashed mid-spawn): ignored.
    }
  }
}

loadRegistry();

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

interface SpawnParams {
  agent: string;
  task: string;
  cwd?: string;
  model?: string;
}

interface SpawnOutcome {
  ok: boolean;
  rec?: RunRecord;
  error?: string;
}

/**
 * Spawns one herdr agent for a subagent definition: new pane, native `pi`
 * child, task prompt. Every failure path cleans up the pane it already
 * created, so a failed spawn leaves no orphan running.
 */
async function spawnRun(params: SpawnParams, baseCwd: string): Promise<SpawnOutcome> {
  const agents = await discoverAgents(join(getAgentDir(), "agents"));
  const agent = agents.find((a) => a.name === params.agent);
  if (!agent) {
    const available = agents.map((a) => a.name).join(", ") || "none";
    return { ok: false, error: `Unknown agent "${params.agent}". Available agents: ${available}.` };
  }

  const runId = makeRunId();
  const rec: RunRecord = {
    runId,
    agent: agent.name,
    task: params.task,
    cwd: params.cwd ?? baseCwd,
    model: params.model ?? agent.model,
    runDir: join(RUNS_DIR, runId),
    status: "running",
    startedAt: Date.now(),
  };
  mkdirSync(rec.runDir, { recursive: true });

  const promptPath = join(rec.runDir, "system-prompt.md");
  try {
    writeFileSync(promptPath, agent.promptBody);
  } catch {
    return { ok: false, error: `Could not write the child's system prompt to ${promptPath}.` };
  }

  const pane = await splitPane(rec.cwd);
  if (!pane) {
    return {
      ok: false,
      error:
        "Could not open a herdr pane: is the herdr server running? Check `herdr status`. Subagents need herdr to spawn their agent panes.",
    };
  }
  rec.paneId = pane.paneId;
  rec.tabId = pane.tabId;
  await renamePane(pane.paneId, `${agent.name} ${rec.runId}`);
  saveMeta(rec);

  const argv = buildChildArgv({
    childDonePath: join(SELF_DIR, "child-done.ts"),
    runDir: rec.runDir,
    runId: rec.runId,
    model: rec.model,
    tools: agent.tools,
    systemPromptPath: promptPath,
  });
  if (!(await startAgent(agent.name, pane.paneId, argv))) {
    await closePane(pane.paneId);
    rec.status = "failed";
    rec.finishedAt = Date.now();
    saveMeta(rec);
    return {
      ok: false,
      error: `herdr reported the pi child in pane ${pane.paneId} did not become interactive (see that pane's output).`,
    };
  }

  // Deliver the task and verify the turn actually started (see promptAgent in
  // herdr.ts for why the plain form is not enough).
  await sleep(PROMPT_SETTLE_MS);
  const prompted = await promptAgent(pane.paneId, params.task);
  let turnStarted = prompted.ok;
  if (!turnStarted) {
    // herdr typed the text but the turn never started — most likely the
    // submitting Enter was lost to the TUI, with the task text sitting in the
    // editor. One recovery Enter fixes exactly that; if the turn is not
    // running afterwards the submission was lost more deeply and the pane is
    // left open for a human to read.
    await sendKeys(pane.paneId, "enter");
    turnStarted = await waitAgentWorking(pane.paneId, 15_000);
  }
  if (!turnStarted) {
    rec.status = "failed";
    rec.finishedAt = Date.now();
    saveMeta(rec);
    return {
      ok: false,
      error: `The task prompt was not accepted by the child in pane ${pane.paneId} (herdr said: ${prompted.error ?? "unknown"}); the pane is left open to read.`,
    };
  }

  saveMeta(rec);
  return { ok: true, rec };
}


/**
 * Classifies a run herdr says is `done`: sidecar → done (pane closed as
 * cleanup); no sidecar → failed (pane kept open as evidence).
 *
 * The sidecar is checked a couple of times with a short settle: herdr
 * detects the finished turn from the terminal, and the child's sidecar write
 * races that detection by a few milliseconds.
 */
async function finishRun(rec: RunRecord): Promise<RunResult> {
  const result = await extractRunResult(rec.runDir, rec.runId);
  const sidecarPresent = (): boolean =>
    !!result.sessionFile && existsSync(`${result.sessionFile}.exit`);

  let clean = sidecarPresent();
  if (!clean && result.found) {
    for (let i = 0; i < 2 && !clean; i++) {
      await new Promise((r) => setTimeout(r, 750));
      clean = sidecarPresent();
    }
  }

  rec.finishedAt = Date.now();
  if (clean) {
    rec.status = "done";
    if (rec.paneId) await closePane(rec.paneId);
  } else {
    rec.status = "failed";
    // Deliberately NOT closed: herdr destroys scrollback with the pane, and a
    // failure nobody can read is a diagnosis nobody can do.
  }
  saveMeta(rec);
  return result;
}

/** Live herdr status for a record, null when the pane is gone. */
async function liveStatus(rec: RunRecord): Promise<string | null> {
  if (!rec.paneId) return null;
  const a = await getAgent(rec.paneId);
  return a ? a.status : null;
}

/** Terminal text used as a failure diagnostic when the transcript has nothing. */
async function paneDiagnostic(rec: RunRecord): Promise<string | null> {
  if (!rec.paneId) return null;
  return readAgent(rec.paneId, 40);
}

function formatResultHeader(rec: RunRecord): string {
  const elapsed = rec.finishedAt ? `${Math.round((rec.finishedAt - rec.startedAt) / 1000)}s` : "…";
  return `=== ${rec.runId} (${rec.agent}) — ${rec.status} [${elapsed}] ===`;
}

function truncate(text: string): string {
  if (text.length <= RESULT_MAX_CHARS) return text;
  return `${text.slice(0, RESULT_MAX_CHARS)}\n…[truncated; full transcript: see run dir]`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // -------------------------------------------------------------------------
  // subagent
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a task to a specialized agent (see Available Agents). Spawns a new herdr agent pane running that agent as a pi child with its own system prompt, tools, and model. Returns a task id, not a result — the task keeps running in the background.",
    promptSnippet:
      "Delegate a self-contained task to a specialized agent; it runs in its own herdr pane and returns a task id (use subagent_tasks to collect the result).",
    promptGuidelines: [
      "Pick the agent whose role matches the task; the task text must be self-contained — the child sees no conversation history.",
      "Delegation is asynchronous: you get a task id back, not the answer. Call subagent_tasks with action \"wait\" when you need the result, and keep working meanwhile.",
      "You can spawn several subagents in one turn; they run concurrently in their own panes.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Name of the agent to delegate to (see Available Agents)" }),
      task: Type.String({
        description:
          "The task, self-contained: the child has no access to this conversation. Include every path, constraint, and definition it needs.",
      }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the child (default: the orchestrator's cwd)" })),
      model: Type.Optional(Type.String({ description: "Model override for the child (default: the agent's declared model)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const out = await spawnRun(params, ctx.cwd);
      if (!out.ok || !out.rec) {
        return {
          content: [{ type: "text", text: `Error: ${out.error}` }],
          details: { ok: false },
        };
      }
      const rec = out.rec;
      return {
        content: [
          {
            type: "text",
            text:
              `Delegated to ${rec.agent}: task ${rec.runId} is running in herdr pane ${rec.paneId}. ` +
              `Collect it with subagent_tasks (action "wait", ids ["${rec.runId}"]) when you need the result.`,
          },
        ],
        details: { ok: true, task: rec.runId, agent: rec.agent, paneId: rec.paneId },
      };
    },
  });

  // -------------------------------------------------------------------------
  // subagent_tasks
  // -------------------------------------------------------------------------

  pi.registerTool({
    name: "subagent_tasks",
    label: "Subagent Tasks",
    description:
      "Manage delegated subagent tasks: status (check), wait (block until finished and return results), result (re-read a finished task), list (all tasks), cancel (stop one).",
    promptSnippet:
      "Check, wait on, re-read, list, or cancel delegated subagent tasks by their task ids (sub-xxxx).",
    promptGuidelines: [
      "Use action \"wait\" with all ids you need in one call — it blocks until they finish and returns their results; waiting on several ids is one round trip.",
      "Use \"status\" for a non-blocking peek, \"result\" to re-read a finished task, \"list\" to see everything, and \"cancel\" to stop a running task.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("wait"),
        Type.Literal("result"),
        Type.Literal("list"),
        Type.Literal("cancel"),
      ]),
      ids: Type.Optional(
        Type.Array(Type.String(), { description: "Task ids (sub-xxxx); required for status/wait/result/cancel, ignored for list" }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({ description: "Max time to block for action \"wait\", in ms (default 300000, max 900000)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return dispatchTasks(params.action, params.ids ?? [], params.timeout_ms ?? WAIT_DEFAULT_MS);
    },
  });
}

// ---------------------------------------------------------------------------
// subagent_tasks dispatch (top-level so it can live outside the factory)
// ---------------------------------------------------------------------------

async function dispatchTasks(
  action: "status" | "wait" | "result" | "list" | "cancel",
  ids: string[],
  timeoutMs: number,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  if (action === "list") return listRuns();

  if (ids.length === 0) {
    return {
      content: [{ type: "text", text: `Error: action "${action}" needs at least one task id (see action "list").` }],
      details: { ok: false },
    };
  }

  const unknown = ids.filter((id) => !runs.has(id));
  const recs = ids.map((id) => runs.get(id)).filter((r): r is RunRecord => !!r);
  const unknownNote = unknown.length > 0 ? `Unknown task ids: ${unknown.join(", ")}.\n` : "";

  switch (action) {
    case "status": {
      const lines: string[] = [];
      const details: Record<string, unknown> = {};
      for (const rec of recs) {
        const live = await liveStatus(rec);
        lines.push(`${rec.runId} (${rec.agent}): ${rec.status}${live ? ` [herdr: ${live}]` : ""}`);
        details[rec.runId] = { status: rec.status, herdr: live };
      }
      return { content: [{ type: "text", text: unknownNote + lines.join("\n") }], details };
    }

    case "wait": {
      const deadline = Date.now() + Math.min(Math.max(1, timeoutMs), WAIT_MAX_MS);
      const out: string[] = [];
      const details: Record<string, unknown> = {};
      for (const rec of recs) {
        if (rec.status === "running") {
          let terminal = false;
          while (rec.status === "running" && Date.now() < deadline) {
            const chunk = Math.min(WAIT_CHUNK_MS, deadline - Date.now());
            if (chunk < 1000) break;
            const reached = rec.paneId ? await waitAgent(rec.paneId, chunk) : true;
            if (reached) {
              terminal = true;
              break;
            }
            // herdr destroys the pane shortly after the child exits, so a
            // missing pane is terminal: classify from disk instead of waiting
            // out the deadline.
            const live = rec.paneId ? await getAgent(rec.paneId) : null;
            if (!live) {
              terminal = true;
              break;
            }
          }
          if (terminal) await finishRun(rec);
        }
        // Report from disk in every case (freshly finished, previously
        // finished, or still running past the deadline).
        if (rec.status === "running") {
          const live = await liveStatus(rec);
          out.push(`${formatResultHeader(rec)}\nstill running${live ? ` [herdr: ${live}]` : " [pane gone]"}`);
          details[rec.runId] = { status: "running" };
        } else {
          const result = await extractRunResult(rec.runDir, rec.runId);
          out.push(formatResultHeader(rec));
          out.push(result.answered ? truncate(result.text) : "(no final answer in transcript)");
          if (rec.status === "failed" && !result.answered) {
            const diag = await paneDiagnostic(rec);
            if (diag) out.push(`\n--- pane output ---\n${truncate(diag)}`);
          }
          details[rec.runId] = { status: rec.status };
        }
      }
      return { content: [{ type: "text", text: unknownNote + out.join("\n\n") }], details };
    }

    case "result": {
      const out: string[] = [];
      const details: Record<string, unknown> = {};
      for (const rec of recs) {
        const live = rec.status === "running" ? await liveStatus(rec) : null;
        if (rec.status === "running") {
          out.push(`${formatResultHeader(rec)}\nstill running${live ? ` [herdr: ${live}]` : " [pane gone]"}`);
          details[rec.runId] = { status: "running" };
          continue;
        }
        const result = await extractRunResult(rec.runDir, rec.runId);
        out.push(formatResultHeader(rec));
        out.push(result.answered ? truncate(result.text) : "(no final answer in transcript)");
        if (rec.status === "failed" && !result.answered) {
          const diag = await paneDiagnostic(rec);
          if (diag) out.push(`\n--- pane output ---\n${truncate(diag)}`);
        }
        details[rec.runId] = { status: rec.status };
      }
      return { content: [{ type: "text", text: unknownNote + out.join("\n\n") }], details };
    }

    case "cancel": {
      const out: string[] = [];
      const details: Record<string, unknown> = {};
      for (const rec of recs) {
        if (rec.status === "running") {
          if (rec.paneId) await closePane(rec.paneId);
          rec.status = "cancelled";
          rec.finishedAt = Date.now();
          saveMeta(rec);
        }
        out.push(`${rec.runId} (${rec.agent}): ${rec.status}`);
        details[rec.runId] = { status: rec.status };
      }
      return { content: [{ type: "text", text: unknownNote + out.join("\n") }], details };
    }
  }
}

async function listRuns(): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  const all = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  if (all.length === 0) {
    return { content: [{ type: "text", text: "No subagent tasks recorded." }], details: { tasks: [] } };
  }
  const running = all.filter((r) => r.status === "running").length;
  const lines = all.map((rec) => {
    const age = Math.round(((rec.finishedAt ?? Date.now()) - rec.startedAt) / 1000);
    return `${rec.runId} (${rec.agent}): ${rec.status} [${age}s]${rec.paneId ? ` pane ${rec.paneId}` : ""}`;
  });
  return {
    content: [{ type: "text", text: `${all.length} task(s), ${running} running.\n${lines.join("\n")}` }],
    details: { tasks: all.map((r) => ({ task: r.runId, agent: r.agent, status: r.status, paneId: r.paneId })) },
  };
}
