/**
 * subagent-herdr — delegation tools backed by herdr.
 *
 * Registers the two tools the orchestrator prompt (dynamic-prompt.ts) already
 * advertises:
 *
 * - `subagent` — delegate a task to one of the agents in
 *   `agent/agents/*.md`. Each spawn opens a **new herdr tab in this
 *   workspace** (`herdr tab create`, one fresh shell pane per tab, labelled
 *   `<agent> <runId>`), a native `pi` TUI in it (`herdr agent start
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
 * - sidecar present → **done**; the answer is the last assistant message at
 *   or before the `subagent_done` call in the child's transcript. The child
 *   closes its own pane the moment it finishes; the parent closes it again as
 *   a backstop.
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
 * That layout — every path, and the shape of every file — belongs to
 * `rundir.ts`, which the child imports too. A run directory's path is derived
 * from its run id, so `meta.json` does not store one.
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

import {
  buildChildArgv,
  buildChildEnv,
  agentNameRejection,
  candidateModels,
  describeLaunchFailure,
  extractRunResult,
  makeRunId,
  readReports,
  type RunResult,
} from "./lib.js";
import { type AgentInfo, discoverAgents } from "../lib/agents.js";
import {
  exitPath,
  type FailedAttempt,
  isRunRecord,
  metaPath,
  type RunRecord,
  runDir,
  runsDir,
  systemPromptPath,
} from "./rundir.js";
import {
  closePane,
  createChildPane,
  getAgent,
  promptAgent,
  readAgent,
  renamePane,
  sendKeys,
  sendPrompt,
  startAgent,
  waitAgent,
  waitAgentWorking,
} from "./herdr.js";

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

/** Where every run's session, sidecar and metadata live (gitignored). */
const RUNS_DIR = runsDir(getAgentDir());

/** This run's directory, derived from its id rather than stored on the record. */
const dirFor = (runId: string): string => runDir(getAgentDir(), runId);

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

/** How long to wait for a turn to start after a recovery Enter. */
const PROMPT_RECOVERY_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const runs = new Map<string, RunRecord>();

function saveMeta(rec: RunRecord): void {
  try {
    writeFileSync(metaPath(dirFor(rec.runId)), JSON.stringify(rec, null, 2));
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
      const parsed: unknown = JSON.parse(
        readFileSync(metaPath(join(RUNS_DIR, d)), "utf-8"),
      );
      if (isRunRecord(parsed)) runs.set(parsed.runId, parsed);
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

/** What one launch attempt needs from the world, so a test can supply its own. */
interface Launcher {
  createChildPane: typeof createChildPane;
  renamePane: typeof renamePane;
  startAgent: typeof startAgent;
  closePane: typeof closePane;
}

const realLauncher: Launcher = { createChildPane, renamePane, startAgent, closePane };

/** Outcome of trying to get one pi child interactive on one model. */
interface AttemptOutcome {
  ok: boolean;
  paneId?: string;
  tabId?: string;
  /** Set when the attempt failed; the reason to record and to report. */
  error?: string;
  /** True when no pane could be opened at all (herdr itself is unavailable). */
  fatal?: boolean;
}

/**
 * Opens a pane and tries to get a pi child interactive on one model.
 *
 * A failure here is a *launch* failure: pi exits non-zero before its TUI comes
 * up when a model is unknown or its provider refuses, which herdr reports as
 * "did not become interactive". That is the signal a fallback acts on, and the
 * reason the retry lives at this seam rather than around the whole run.
 *
 * The pane is closed on failure unless `keepPaneOnFailure`, which the last
 * attempt sets: herdr destroys scrollback with the pane, and the final failure
 * is the one a human needs to read.
 */
async function launchAttempt(
  agent: AgentInfo,
  rec: RunRecord,
  dir: string,
  promptPath: string,
  model: string | undefined,
  keepPaneOnFailure: boolean,
  launcher: Launcher = realLauncher,
): Promise<AttemptOutcome> {
  // The child's pane env: its run identity, and — the key to child →
  // orchestrator messaging — this orchestrator's own pane id, which herdr
  // injects into our process as HERDR_PANE_ID.
  const env = buildChildEnv(rec, process.env.HERDR_PANE_ID, dir);
  const label = `${agent.name} ${rec.runId}`;
  const pane = await launcher.createChildPane(rec.cwd, label, env);
  if (!pane) {
    return {
      ok: false,
      fatal: true,
      error:
        "Could not open a herdr tab: is the herdr server running? Check `herdr status`. Subagents need herdr to spawn their agent tabs.",
    };
  }
  await launcher.renamePane(pane.paneId, label);

  const argv = buildChildArgv({
    childDonePath: join(SELF_DIR, "child-done.ts"),
    runDir: dir,
    runId: rec.runId,
    model,
    tools: agent.tools,
    systemPromptPath: promptPath,
  });
  if (await launcher.startAgent(agent.name, pane.paneId, argv)) {
    return { ok: true, paneId: pane.paneId, tabId: pane.tabId };
  }

  if (!keepPaneOnFailure) await launcher.closePane(pane.paneId);
  return {
    ok: false,
    paneId: pane.paneId,
    error: `pi in pane ${pane.paneId} did not become interactive${
      model ? ` on model ${model}` : ""
    } (see that pane's output).`,
  };
}

/**
 * Spawns one herdr agent for a subagent definition: a new tab in this
 * workspace (one fresh shell pane, native `pi` child), task prompt. Every
 * failure path cleans up the pane it already created, so a failed spawn
 * leaves no orphan running (closing the tab's only pane closes the tab).
 *
 * Models come from `candidateModels` and are tried in order. The trigger is
 * *prompt rejection*, not launch failure, because a dead model does not fail
 * the launch: pi exits before its TUI appears, the pane's shell survives, and
 * herdr reports `interactive_ready: true` anyway. The task then lands in a bash
 * prompt, which herdr refuses — and that is the first reliable signal. So one
 * attempt spans opening the pane *and* getting the task accepted.
 *
 * A pre-spawn model check was tried and removed: the only pi invocations that
 * validate a model cost ~7s each (`--list-models` ignores `--model` entirely),
 * and this signal catches the same failure a few seconds later for free.
 *
 * The model that actually ran and the ones that failed are both recorded, so a
 * degraded fleet is visible rather than silently slower.
 *
 * Only *getting started* is retried. A child that accepted its task and then
 * died has written part of a transcript and burned tokens; re-running it is a
 * decision for the caller, not a reflex here.
 */
async function spawnRun(params: SpawnParams, baseCwd: string): Promise<SpawnOutcome> {
  const agents = await discoverAgents(join(getAgentDir(), "agents"));
  const agent = agents.find((a) => a.name === params.agent);
  if (!agent) {
    const available = agents.map((a) => a.name).join(", ") || "none";
    return { ok: false, error: `Unknown agent "${params.agent}". Available agents: ${available}.` };
  }

  // herdr refuses some names outright, and that refusal used to surface as
  // "did not become interactive" on every candidate model — a broken name
  // looking exactly like a broken fleet.
  const nameProblem = agentNameRejection(agent.name);
  if (nameProblem) return { ok: false, error: nameProblem };

  const models = candidateModels(params.model, agent);
  const runId = makeRunId();
  const rec: RunRecord = {
    runId,
    agent: agent.name,
    task: params.task,
    cwd: params.cwd ?? baseCwd,
    model: models[0],
    status: "running",
    startedAt: Date.now(),
  };
  const dir = dirFor(runId);
  mkdirSync(dir, { recursive: true });
  // Register in-memory now, not only on disk: subagent_tasks resolves ids
  // from this map, and a fresh spawn must be statusable/waitable within the
  // same process (the disk registry is what a *restarted* parent rebuilds).
  runs.set(rec.runId, rec);

  const promptPath = systemPromptPath(dir);
  try {
    writeFileSync(promptPath, agent.promptBody);
  } catch {
    return { ok: false, error: `Could not write the child's system prompt to ${promptPath}.` };
  }

  const failures: FailedAttempt[] = [];
  // One attempt = open a pane, get pi interactive, and get the task accepted.
  // The prompt is part of the attempt because a dead model does not fail the
  // launch: pi exits, the pane's shell survives, herdr still reports
  // interactive-ready, and the task then lands in a bash prompt instead.
  let launched: AttemptOutcome | undefined;
  for (const [i, model] of models.entries()) {
    const isLast = i === models.length - 1;
    const attempt = await launchAttempt(agent, rec, dir, promptPath, model, isLast);
    if (!attempt.ok) {
      failures.push({ model, error: attempt.error ?? "unknown launch failure" });
      // No pane at all means herdr is unavailable: another model cannot help.
      if (attempt.fatal) break;
      continue;
    }

    // Deliver the task and verify the turn actually started (see promptAgent in
    // herdr.ts for why the plain form is not enough).
    await sleep(PROMPT_SETTLE_MS);
    const prompted = await promptAgent(attempt.paneId!, params.task);
    let turnStarted = prompted.ok;
    if (!turnStarted) {
      // herdr typed the text but the turn never started — most likely the
      // submitting Enter was lost to the TUI, with the task text sitting in the
      // editor. One recovery Enter fixes exactly that.
      await sendKeys(attempt.paneId!, "enter");
      turnStarted = await waitAgentWorking(attempt.paneId!, PROMPT_RECOVERY_MS);
    }
    if (turnStarted) {
      launched = attempt;
      rec.paneId = attempt.paneId;
      rec.tabId = attempt.tabId;
      // Record the fallback only when one was actually used, so the common case
      // leaves no trace to read past.
      if (i > 0 || failures.length > 0) {
        rec.resolvedModel = model;
        rec.failedAttempts = failures;
      }
      break;
    }

    failures.push({
      model,
      error: `task prompt not accepted in pane ${attempt.paneId} (herdr said: ${prompted.error ?? "unknown"})`,
    });
    // The pane is a dead end either way. Keep the last one to read; reclaim the
    // rest so a three-model fallback does not leave three tabs behind.
    if (!isLast) await closePane(attempt.paneId!);
  }

  if (!launched) {
    rec.status = "failed";
    rec.finishedAt = Date.now();
    rec.failedAttempts = failures;
    saveMeta(rec);
    return { ok: false, error: describeLaunchFailure(failures) };
  }

  saveMeta(rec);
  return { ok: true, rec };
}

/**
 * Classifies a run herdr says is `done`: sidecar → done (pane closed as
 * cleanup — closing the tab's only pane closes the tab); no sidecar → failed
 * (pane kept open as evidence).
 *
 * The sidecar is checked a couple of times with a short settle: herdr
 * detects the finished turn from the terminal, and the child's sidecar write
 * races that detection by a few milliseconds.
 */
async function finishRun(rec: RunRecord): Promise<RunResult> {
  const result = await extractRunResult(dirFor(rec.runId), rec.runId);
  const sidecarPresent = (): boolean =>
    !!result.sessionFile && existsSync(exitPath(result.sessionFile));

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

/**
 * Appends the child's mid-run reports (the child → orchestrator leg) to a
 * result output block, when there are any. A report that was also delivered
 * live to this session shows up here too — the log is the durable copy.
 */
async function pushReports(rec: RunRecord, out: string[]): Promise<void> {
  const reports = await readReports(dirFor(rec.runId));
  if (reports.length === 0) return;
  out.push(
    `--- reports sent to you by ${rec.agent} during the run (${reports.length}) ---\n${reports
      .map((r) => `- ${r.message}`)
      .join("\n")}`,
  );
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
      "Delegate a task to a specialized agent (see Available Agents). Spawns a new herdr tab in this workspace running that agent as a pi child with its own system prompt, tools, and model. Returns a task id, not a result — the task keeps running in the background.",
    promptSnippet:
      "Delegate a self-contained task to a specialized agent; it runs in its own herdr tab and returns a task id (use subagent_tasks to collect the result).",
    promptGuidelines: [
      "Pick the agent whose role matches the task; the task text must be self-contained — the child sees no conversation history.",
      "Delegation is asynchronous: you get a task id back, not the answer. Call subagent_tasks with action \"wait\" when you need the result, and keep working meanwhile.",
      "You can spawn several subagents in one turn; they run concurrently in their own tabs.",
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
              `Delegated to ${rec.agent}: task ${rec.runId} is running in tab ${rec.tabId} (pane ${rec.paneId}) of this workspace. ` +
              `Collect it with subagent_tasks (action "wait", ids ["${rec.runId}"]) when you need the result.`,
          },
        ],
        details: { ok: true, task: rec.runId, agent: rec.agent, tabId: rec.tabId, paneId: rec.paneId },
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
        Type.Literal("message"),
      ]),
      ids: Type.Optional(
        Type.Array(Type.String(), { description: "Task ids (sub-xxxx); required for status/wait/result/cancel/message, ignored for list" }),
      ),
      text: Type.Optional(
        Type.String({ description: "The message to deliver, for action \"message\" (arrives at each running subagent as a new instruction in its session)" }),
      ),
      timeout_ms: Type.Optional(
        Type.Number({ description: "Max time to block for action \"wait\", in ms (default 300000, max 900000)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return dispatchTasks(params.action, params.ids ?? [], params.text, params.timeout_ms ?? WAIT_DEFAULT_MS);
    },
  });
}

// ---------------------------------------------------------------------------
// subagent_tasks dispatch (top-level so it can live outside the factory)
// ---------------------------------------------------------------------------

async function dispatchTasks(
  action: "status" | "wait" | "result" | "list" | "cancel" | "message",
  ids: string[],
  text: string | undefined,
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

    case "message": {
      if (!text || !text.trim()) {
        return {
          content: [{ type: "text", text: 'Error: action "message" needs a non-empty "text".' }],
          details: { ok: false },
        };
      }
      const lines: string[] = [];
      const details: Record<string, unknown> = {};
      for (const rec of recs) {
        if (rec.status !== "running" || !rec.paneId) {
          lines.push(`${rec.runId} (${rec.agent}): not running (${rec.status}) — message not delivered`);
          details[rec.runId] = { delivered: false, status: rec.status };
          continue;
        }
        const sent = await sendPrompt(rec.paneId, text);
        lines.push(
          sent.ok
            ? `${rec.runId} (${rec.agent}): message delivered to pane ${rec.paneId}`
            : `${rec.runId} (${rec.agent}): delivery failed (${sent.error ?? "unknown"})`,
        );
        details[rec.runId] = { delivered: sent.ok, status: rec.status };
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
          const result = await extractRunResult(dirFor(rec.runId), rec.runId);
          out.push(formatResultHeader(rec));
          out.push(result.answered ? truncate(result.text) : "(no final answer in transcript)");
          if (rec.status === "failed" && !result.answered) {
            const diag = await paneDiagnostic(rec);
            if (diag) out.push(`\n--- pane output ---\n${truncate(diag)}`);
          }
          await pushReports(rec, out);
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
        const result = await extractRunResult(dirFor(rec.runId), rec.runId);
        out.push(formatResultHeader(rec));
        out.push(result.answered ? truncate(result.text) : "(no final answer in transcript)");
        if (rec.status === "failed" && !result.answered) {
          const diag = await paneDiagnostic(rec);
          if (diag) out.push(`\n--- pane output ---\n${truncate(diag)}`);
        }
        await pushReports(rec, out);
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
    return `${rec.runId} (${rec.agent}): ${rec.status} [${age}s]${rec.tabId ? ` tab ${rec.tabId}` : ""}${rec.paneId ? ` pane ${rec.paneId}` : ""}`;
  });
  return {
    content: [{ type: "text", text: `${all.length} task(s), ${running} running.\n${lines.join("\n")}` }],
    details: { tasks: all.map((r) => ({ task: r.runId, agent: r.agent, status: r.status, tabId: r.tabId, paneId: r.paneId })) },
  };
}
