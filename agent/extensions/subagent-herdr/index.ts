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
 * - `subagent_tasks` — `status` / `result` / `list` / `cancel` / `message` for
 *   those tasks.
 *
 * ## Why there is no `wait`
 *
 * There deliberately is not one. A blocking wait ran *inside a tool call*, so
 * the orchestrator's turn stayed open for as long as the child ran — and while
 * a turn is open the orchestrator is streaming, which means a child's report
 * (`herdr agent prompt` into the parent's pane) could only queue as a follow-up
 * and stayed invisible until the blocking call returned. The orchestrator was
 * therefore structurally incapable of reading a message before the child it
 * came from had already died.
 *
 * The inversion: the orchestrator **ends its turn** after delegating. A child's
 * report or completion arrives as input to an *idle* session, which pi starts a
 * fresh turn for. The orchestrator sleeps between events instead of blocking
 * through them, and a mid-run message is actionable while the child is still
 * alive to act on the reply.
 *
 * ## Completion handshake
 *
 * The child is loaded with `child-done.ts` (`-e`), which writes a
 * `<session>.exit` sidecar next to its session file when the run finishes
 * cleanly (the `subagent_done` tool, or a clean turn end), sends a `done`
 * notice to this pane, and then shuts the child down. The parent classifies a
 * run from the sidecar when a notice arrives (or when asked directly):
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
 * ## Waking the orchestrator
 *
 * Notices are typed into this pane by the child, so they arrive as ordinary
 * *input* — which is why this extension hooks `input`: it recognises the notice
 * grammar (`rundir.ts` owns it), swallows the raw text, and re-injects a
 * composed briefing carrying the run's state and, for a finished run, its
 * answer. Near-simultaneous notices are coalesced into one turn, so three
 * children finishing together wake the orchestrator once rather than three
 * times.
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  buildChildArgv,
  buildChildEnv,
  childNameRejection,
  candidateModels,
  describeLaunchFailure,
  extractRunResult,
  herdrAgentName,
  makeRunId,
  readReports,
  type RunResult,
} from "./lib.js";
import { type AgentInfo, discoverAgents } from "../lib/agents.js";
import { agentDir, agentsDir } from "../lib/layout.js";
import {
  exitPath,
  type FailedAttempt,
  isRunRecord,
  metaPath,
  type Notice,
  parseNotice,
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
  waitAgentWorking,
} from "./herdr.js";

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

/** Where every run's session, sidecar and metadata live (gitignored). */
const RUNS_DIR = runsDir(agentDir());

/** This run's directory, derived from its id rather than stored on the record. */
const dirFor = (runId: string): string => runDir(agentDir(), runId);

/** Directory of this extension, so `child-done.ts` can be passed to a child by absolute path. */
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * How long to let notices accumulate before waking the orchestrator.
 *
 * Children finish independently but often together (a fan-out of recon agents
 * launched in one turn). Without a window, each arrival starts its own turn and
 * the orchestrator re-reads its context once per child. One short window
 * collapses that into a single briefing; it is deliberately far shorter than a
 * human would notice and far longer than the spread between two `herdr agent
 * prompt` deliveries.
 */
const NOTICE_COALESCE_MS = 1200;

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
export interface Launcher {
  createChildPane: typeof createChildPane;
  renamePane: typeof renamePane;
  startAgent: typeof startAgent;
  closePane: typeof closePane;
}

const realLauncher: Launcher = { createChildPane, renamePane, startAgent, closePane };

/** Outcome of trying to get one pi child interactive on one model. */
export interface AttemptOutcome {
  ok: boolean;
  paneId?: string;
  tabId?: string;
  /** Set when the attempt failed; the reason to record and to report. */
  error?: string;
  /**
   * True when no other model could possibly help: herdr itself is unavailable
   * (no pane at all), or it refused the agent name outright. Stops the
   * candidate-model loop instead of re-proving the same refusal per model.
   */
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
 * is the one a human needs to read. A *name* refusal is the exception — herdr
 * never ran pi, so there is no scrollback to keep and the pane is always closed.
 *
 * Exported (with `Launcher`) so a test can supply its own world: the `fatal`
 * classification below is the logic that stops a name refusal from being
 * retried against every candidate model, and a stub launcher is the only way to
 * pin it without a live herdr.
 */
export async function launchAttempt(
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
  // Registered under a *run-scoped* name: herdr agent names are globally
  // unique, so the bare `agent.name` let one live child lock out every sibling
  // (see herdrAgentName). The label above stays human-readable.
  const started = await launcher.startAgent(herdrAgentName(agent.name, rec.runId), pane.paneId, argv);
  if (started.ok) {
    return { ok: true, paneId: pane.paneId, tabId: pane.tabId };
  }

  // Name rejections are not launch failures: herdr refused before pi ever ran,
  // so no other model can help, and the pane holds nothing but a shell prompt
  // (no scrollback to preserve, hence the unconditional close). Reported as
  // fatal so the fallback loop stops instead of re-proving it three times.
  //
  // The two codes get different remedies on purpose: they are distinct failures
  // and `herdr agent list` is a dead end for a malformed name. Collapsing them
  // into one message would repeat, one level up, the flattening this whole
  // change exists to undo.
  const scoped = herdrAgentName(agent.name, rec.runId);
  if (started.error === "agent_name_taken") {
    await launcher.closePane(pane.paneId);
    return {
      ok: false,
      fatal: true,
      error:
        `herdr already has a live agent named "${scoped}" (agent_name_taken), so this child could not register. ` +
        `Names are unique among live agents; run \`herdr agent list\` to see what holds it.`,
    };
  }
  if (started.error === "invalid_agent_name") {
    await launcher.closePane(pane.paneId);
    return {
      ok: false,
      fatal: true,
      error:
        `herdr rejected the name "${scoped}" as malformed (invalid_agent_name). A name must match ` +
        `[a-z][a-z0-9_-]{0,31} — at most 32 characters including the "-${rec.runId}" suffix (9). ` +
        `Rename the agent definition's \`name\` field.`,
    };
  }

  if (!keepPaneOnFailure) await launcher.closePane(pane.paneId);
  return {
    ok: false,
    paneId: pane.paneId,
    error: `pi in pane ${pane.paneId} did not become interactive${
      model ? ` on model ${model}` : ""
    }${started.error ? ` (herdr said: ${started.error})` : ""} (see that pane's output).`,
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
  const agents = await discoverAgents(agentsDir());
  const agent = agents.find((a) => a.name === params.agent);
  if (!agent) {
    const available = agents.map((a) => a.name).join(", ") || "none";
    return { ok: false, error: `Unknown agent "${params.agent}". Available agents: ${available}.` };
  }

  const models = candidateModels(params.model, agent);
  const runId = makeRunId();

  // Validate the name herdr will actually receive, not the definition name:
  // scoping costs 9 characters, so a legal bare name can still exceed herdr's
  // 32-char ceiling once scoped. Checking the bare string let that through to
  // fail late, after a pane had been opened and closed.
  const nameProblem = childNameRejection(agent.name, runId);
  if (nameProblem) return { ok: false, error: nameProblem };

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
      // Nothing model-specific went wrong (herdr unavailable, or it refused
      // the name): trying another model would just repeat the same refusal.
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

/**
 * Brings a `running` record up to date without blocking on it.
 *
 * With no blocking `wait`, nothing sits on a child watching it end, so a record
 * can say `running` after the child is already gone — the notice was lost, or
 * the parent restarted. This is the lazy reconciliation every read path goes
 * through first: a child herdr reports `done`, or whose pane has vanished, is
 * classified from its sidecar here and now.
 *
 * One probe, never a loop: a run that really is still working must cost a
 * status check, not a stall.
 *
 * @returns Whether the record is still running after reconciling.
 */
async function reconcile(rec: RunRecord): Promise<boolean> {
  if (rec.status !== "running") return false;
  // No pane was ever recorded: nothing to probe, and nothing will ever report.
  // Classify from disk so the run cannot be stuck as `running` forever.
  if (!rec.paneId) {
    await finishRun(rec);
    return false;
  }
  const live = await getAgent(rec.paneId);
  // Pane gone (herdr reaps it after the child exits) or the turn finished:
  // either way the child is not coming back.
  if (!live || live.status === "done") {
    await finishRun(rec);
    return false;
  }
  return true;
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
// Briefings (the text a notice becomes)
// ---------------------------------------------------------------------------

/**
 * The user message a batch of notices becomes.
 *
 * Written as an instruction to the orchestrator, not as a log line, because it
 * *is* the turn's prompt: this text is the whole reason the orchestrator woke
 * up, so it has to say what happened, carry what the child produced, and be
 * explicit that ending the turn again is the correct move when other children
 * are still running. Otherwise a woken orchestrator reaches for a wait that no
 * longer exists.
 *
 * A `done` notice inlines the child's answer, so the common case costs no
 * follow-up tool call. A `report` does not classify the run — the child is still
 * working and must not be reaped.
 *
 * @param batch - Notices from the closed coalesce window, in arrival order.
 */
async function composeBriefing(batch: readonly Notice[]): Promise<string> {
  const blocks: string[] = [];
  for (const notice of batch) {
    const rec = runs.get(notice.runId);
    if (!rec) {
      // A notice for a run this process never registered (the parent restarted
      // and the meta file was lost). Still worth surfacing verbatim.
      blocks.push(
        `--- ${notice.runId} (${notice.agent}) ${notice.kind} ---\n${
          notice.text || "(no message)"
        }\n(This task is not in my registry — it may predate a restart.)`,
      );
      continue;
    }

    if (notice.kind === "report") {
      blocks.push(
        `--- ${rec.runId} (${rec.agent}) sent a mid-run report ---\n${notice.text || "(no message)"}\n` +
          `It is still working. Reply with subagent_tasks (action "message", ids ["${rec.runId}"]) if it needs an answer or a correction.`,
      );
      continue;
    }

    // A `done` notice: classify now and inline the answer.
    await reconcile(rec);
    const out: string[] = [formatResultHeader(rec)];
    const result = await extractRunResult(dirFor(rec.runId), rec.runId);
    out.push(result.answered ? truncate(result.text) : "(no final answer in transcript)");
    if (rec.status === "failed" && !result.answered) {
      const diag = await paneDiagnostic(rec);
      if (diag) out.push(`\n--- pane output ---\n${truncate(diag)}`);
    }
    await pushReports(rec, out);
    blocks.push(out.join("\n"));
  }

  const stillRunning = [...runs.values()].filter((r) => r.status === "running");
  const tail =
    stillRunning.length > 0
      ? `\n\nStill running: ${stillRunning
          .map((r) => `${r.runId} (${r.agent})`)
          .join(", ")}. Do not wait or poll for them — carry on with what you can do now, then end your turn; they will wake you the same way.`
      : "\n\nNo subagent tasks are still running.";

  return `[subagent update — delivered automatically, not typed by the user]\n\n${blocks.join("\n\n")}${tail}`;
}

/**
 * Minimal briefing used when composing the full one threw.
 *
 * Deliberately does no I/O: this is the path taken *because* I/O failed, and a
 * wake that says only "something happened, go and look" still beats an
 * orchestrator that sleeps through a finished child.
 */
function fallbackBriefing(batch: readonly Notice[]): string {
  const lines = batch.map(
    (n) => `- ${n.runId} (${n.agent}) ${n.kind}${n.text ? `: ${n.text}` : ""}`,
  );
  return (
    `[subagent update — delivered automatically, not typed by the user]\n\n${lines.join("\n")}\n\n` +
    `I could not read the run details. Use subagent_tasks (action "result") on the ids above to collect them.`
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
      "Delegate a self-contained task to a specialized agent; it runs in its own herdr tab and wakes you with a message when it reports or finishes.",
    promptGuidelines: [
      "Pick the agent whose role matches the task; the task text must be self-contained — the child sees no conversation history.",
      "You get a task id back, not the answer. There is no blocking wait: end your turn, and the subagent wakes you with a message carrying its result.",
      "Do not poll, spin, or stall after delegating — and do not ask the user to wait. Ending your turn is how you wait.",
      "You can spawn several subagents in one turn; they run concurrently in their own tabs and their completions are batched into one wake-up.",
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
              `Do NOT wait for it — there is no blocking wait. Finish this turn (do any other work you have first). ` +
              `${rec.agent} will wake you with a new message when it reports something or finishes, and you continue from there.`,
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
      "Inspect and steer delegated subagent tasks: status (are they still running), result (read a finished task's answer and its reports), list (all tasks), message (send a running subagent an instruction), cancel (stop one). None of these block: subagents wake you with a message when they report or finish.",
    promptSnippet:
      "Check, re-read, message, list, or cancel delegated subagent tasks by their task ids (sub-xxxx).",
    promptGuidelines: [
      "There is no blocking wait, by design. After delegating, end your turn — the subagent wakes you with a new message when it reports or finishes, and that message carries its answer.",
      "Use \"result\" to read a finished task's answer (and any mid-run reports), \"status\" for a quick is-it-still-running check, \"list\" to see everything, and \"cancel\" to stop a running task.",
      "Use \"message\" to answer a subagent's question or redirect it while it is still running — that is the point of being woken by a report rather than at the end.",
      "Never poll: do not call status in a loop and do not spin on a task waiting for it to finish. Ending your turn is how you wait.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("result"),
        Type.Literal("list"),
        Type.Literal("cancel"),
        Type.Literal("message"),
      ]),
      ids: Type.Optional(
        Type.Array(Type.String(), { description: "Task ids (sub-xxxx); required for status/result/cancel/message, ignored for list" }),
      ),
      text: Type.Optional(
        Type.String({ description: "The message to deliver, for action \"message\" (arrives at each running subagent as a new instruction in its session)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return dispatchTasks(params.action, params.ids ?? [], params.text);
    },
  });

  // -------------------------------------------------------------------------
  // The wake path: a child's notice arrives here as ordinary input
  // -------------------------------------------------------------------------

  /** Notices seen since the last briefing was dispatched. */
  let pending: Notice[] = [];
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Turns the buffered notices into one user message and sends it.
   *
   * `sendUserMessage` rather than a returned transform, because by the time the
   * window closes the original input event has long since been answered with
   * `handled`. When the orchestrator is idle this starts a turn — which is the
   * entire mechanism: the orchestrator ended its turn after delegating, and this
   * is what wakes it back up.
   *
   * Wrapped, and for the reason ralph-loop documents: `sendUserMessage` calls
   * `assertActive()` synchronously and throws once the runtime is invalidated
   * (`/reload`, a new session, a session switch). An uncaught throw from a timer
   * callback reaches pi's `uncaughtException` handler and exits the process — a
   * subagent finishing must never be able to kill the orchestrator.
   */
  const flushNotices = async (): Promise<void> => {
    coalesceTimer = undefined;
    const batch = pending;
    pending = [];
    if (batch.length === 0) return;
    let briefing: string;
    try {
      briefing = await composeBriefing(batch);
    } catch {
      // Composing reads run dirs and probes herdr; if that fails the orchestrator
      // must still be told something, or the event is silently lost.
      briefing = fallbackBriefing(batch);
    }
    try {
      // deliverAs "followUp": if the orchestrator happens to be mid-turn (a
      // notice landing while it works on something else), the briefing waits for
      // that turn to finish instead of cutting into its tool calls.
      //
      // `expandPromptTemplates` is deliberately omitted rather than passed as
      // false: false is already the default, and the option does not exist in the
      // 0.75.4 type stubs tsc resolves here (the running pi is 0.85.1 — see the
      // root AGENTS.md on that skew). The briefing always starts with "[", so it
      // could never be taken for a slash command anyway.
      pi.sendUserMessage(briefing, { deliverAs: "followUp" });
    } catch {
      // The runtime went away under us. The run's state is on disk either way,
      // so the next `status`/`result` still reports it correctly.
    }
  };

  /**
   * Recognises a child's notice in this session's input and swallows it.
   *
   * The child delivers by typing into this pane (`herdr agent prompt`), so its
   * notice is indistinguishable from a human's message *except* by its grammar,
   * which `rundir.ts` owns. Matching text is answered `handled` — the raw notice
   * never reaches the model — and a composed briefing is sent once the coalesce
   * window closes.
   *
   * Everything else returns `continue` untouched: this hook sees every keystroke
   * the user submits, and eating one would be a far worse bug than a late wake.
   */
  pi.on("input", (event) => {
    const notice = parseNotice(event.text);
    if (!notice) return { action: "continue" as const };

    pending.push(notice);
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(() => {
      void flushNotices();
    }, NOTICE_COALESCE_MS);

    return { action: "handled" as const };
  });

  // A session that goes away mid-window must not fire a timer into a dead
  // runtime; the notices are on disk (reports.jsonl, the sidecar) regardless.
  pi.on("session_shutdown", () => {
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    pending = [];
  });
}

// ---------------------------------------------------------------------------
// subagent_tasks dispatch (top-level so it can live outside the factory)
// ---------------------------------------------------------------------------

async function dispatchTasks(
  action: "status" | "result" | "list" | "cancel" | "message",
  ids: string[],
  text: string | undefined,
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
        // Reconcile first: a status that reports `running` for a child that
        // already exited is the one answer this action must never give.
        await reconcile(rec);
        const live = rec.status === "running" ? await liveStatus(rec) : null;
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

    case "result": {
      const out: string[] = [];
      const details: Record<string, unknown> = {};
      for (const rec of recs) {
        // A result asked for right after a child finished must not answer "still
        // running" just because no notice has been processed yet.
        if (await reconcile(rec)) {
          const live = await liveStatus(rec);
          out.push(`${formatResultHeader(rec)}\nstill running${live ? ` [herdr: ${live}]` : " [pane gone]"}`);
          // Mid-run reports are the only thing a running task has to show; they
          // are why asking early is still worth something.
          await pushReports(rec, out);
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
