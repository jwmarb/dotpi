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
 * - `subagent_tasks` — `status` / `result` / `list` / `cancel` / `message` / `interrupt` for
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
 * - sidecar present → **done**; the answer is the last *visible* assistant
 *   text at or before the `subagent_done` call, with `qualifiesAsAnswer`
 *   (`rundir.ts`) deciding whether it is an answer at all, and two salvage
 *   paths behind that (the done call's arguments, then an earlier message).
 *   The child closes its own pane the moment it finishes; the parent closes it
 *   again as a backstop.
 *   The child will not *reach* completion without a visible answer: the
 *   `subagent_done` gate refuses a bounded number of such calls, and a clean
 *   turn end with nothing visible is nudged once for one. Both halves judge
 *   this with the same shared predicate, against the run's `system-prompt.md`.
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
 * answer. Near-simultaneous notices are coalesced into one turn via a sliding
 * window, and a flush-time registry sweep folds in any sibling that has already
 * finished (sidecar on disk, pane gone) even if its notice has not arrived yet —
 * so a fan-out that finishes together wakes the orchestrator once, not once
 * per child. A later notice for an already-briefed completion is swallowed.
 * `steeringMode: "all"` in settings.json ensures that if two briefings ever
 * queue simultaneously they drain into one response.
 *
 * The briefing is delivered as **steering**, not as a follow-up. An idle
 * orchestrator is woken either way, but a *busy* one — still chaining tool calls
 * after delegating — only ever drains the follow-up queue once that chain is
 * finished, so a finished child stayed invisible for the rest of the turn no
 * matter how long it ran. Steering is drained every turn, so the result
 * interrupts the loop at the next safe boundary instead of waiting behind the
 * work it may well invalidate.
 *
 * ## Health checks
 *
 * A child that stalls (the child-side watchdog's one-shot `stalled` notice)
 * or ends without a readable answer (`extractRunResult` → `answered: false`)
 * is diagnosed before its report reaches the orchestrator: this extension
 * spawns a read-only `healthcheck` child whose task (`buildHealthCheckTask`,
 * lib.ts) names the target run, its run directory, its original task, and
 * what triggered the check.
 *
 * - At most one *running* health check per target (a duplicate stall reuses
 *   the in-flight record), and a health check is never health-checked.
 * - An unanswered target's no-answer block is held back while its health
 *   check runs; the health check's completion delivers both blocks in one
 *   briefing. A health check that cannot launch renders the no-answer block
 *   immediately, exactly as this feature's absence would.
 * - `healthCheckOf` is persisted in meta.json (`isRunRecord` validates it).
 *
 * The ordinary completion path is untouched: the `.exit` sidecar still
 * classifies a run, and the answer gate still decides what counts as an
 * answer — the health check is a diagnosis layered on top, not a second
 * completion mechanism.
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
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  appendSkillCatalogue,
  buildChildArgv,
  buildChildEnv,
  buildHealthCheckTask,
  childFallbackChain,
  childNameRejection,
  discoverSkills,
  extractRunResult,
  herdrAgentName,
  lineageRejection,
  makeRunId,
  parseLineage,
  readReports,
  type HealthCheckTrigger,
  type RunResult,
  selectSkills,
  type SkillEntry,
  skillEntriesFromPi,
} from "./lib.js";
// The router model id, owned by the extension that registers it.
import { FALLBACK_MODEL_REF, parseChainItem } from "../model-fallback/lib.js";
import {
  type AgentInfo,
  discoverAgents,
  discoverSkillAgents,
  mergeAgents,
} from "../lib/agents.js";
import { agentDir, agentsDir, skillsDir } from "../lib/layout.js";
import {
  hasExitSidecar,
  isRunRecord,
  isSessionFileFor,
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
  paneLabel,
  probeAgent,
  promptAgent,
  readAgent,
  renamePane,
  sendKeys,
  sendPrompt,
  startAgent,
  waitAgentIdle,
  waitAgentWorking,
} from "./herdr.js";
import {
  createRunLifecycle,
  type PaneObservation,
  type RunLifecycle,
  type RunObservation,
} from "./run-lifecycle.js";
import {
  createReleaseLedger,
  healthCheckOfId,
  isOwnedBy,
  LIVENESS_BACKSTOP_MS,
  ownerPaneOf,
  type ReleasedTarget,
} from "./release-ledger.js";

// The terminal result cache moved to the release ledger; re-exported so its
// importers keep their path.
export { createTerminalResultCache, type TerminalResultCache } from "./release-ledger.js";

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

/** Where every run's session, sidecar and metadata live (gitignored). */
const RUNS_DIR = runsDir(agentDir());

/** This run's directory, derived from its id rather than stored on the record. */
const dirFor = (runId: string): string => runDir(agentDir(), runId);

/** Directory of this extension, so `child-done.ts` can be passed to a child by absolute path. */
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

/** Answers are truncated in tool output at this size; the transcript stays complete on disk. */
const RESULT_MAX_CHARS = 20_000;

/**
 * Settle delay between `agent start` resolving and the first prompt. herdr
 * reports interactive-ready as soon as pi's TUI is up, but the first
 * keypress can still race the input layer; a short pause plus the
 * stall-detecting prompt (see herdr.ts) makes the loss of a submission Enter
 * rare, and the recovery path makes it harmless.
 */
export const PROMPT_SETTLE_MS = 1500;

/** How long to wait for a turn to start after a recovery Enter. */
const PROMPT_RECOVERY_MS = 15_000;

/**
 * Bounded patience for the interrupt handshake: how long to wait for a pane to
 * report `idle` after an Escape.
 *
 * This is the one deliberate blocking wait in this module, and it is allowed
 * because it is part of an *explicit* `subagent_tasks` operation the user asked
 * for — not a completion wait, not a poll loop. Ending the turn is still how the
 * orchestrator waits for subagents to *finish*; this only bounds the moment an
 * interrupt takes effect.
 */
const INTERRUPT_IDLE_TIMEOUT_MS = 30_000;

/**
 * Tools that can open a skill file. An agent whose allowlist has none of these
 * gets the catalogue as a map only, with the "delegate it" wording instead of
 * paths it cannot read (`--tools` is an allowlist, so an undeclared reader is
 * genuinely absent). `read_skill` is the intended route; a plain `read` works.
 */
const READING_TOOLS = new Set(["read", "read_skill"]);

/**
 * Env var carrying this process's delegation ancestry: the agent names from the
 * human's orchestrator down to and including this one, comma-separated.
 *
 * Absent means the human's orchestrator, which may spawn anything. A child is
 * launched with this set by its *parent*, so no model can forge its own
 * ancestry — which is what makes {@link lineageRejection} trustworthy.
 *
 * This replaced a numeric depth cap. A number had to be tuned (and was wrong
 * once — a cap of 1 silently refused the orchestrator's own child), and it
 * bounded the tree without expressing the actual rule. The lineage encodes the
 * rule directly: no agent may appear twice in its own ancestry, so every
 * generation must introduce a new agent and a finite roster ends the chain by
 * itself. `librarian → librarian` is impossible by construction rather than by
 * arithmetic.
 */
const LINEAGE_ENV = "PI_SUBAGENT_LINEAGE";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const runs = new Map<string, RunRecord>();

/**
 * pi's resolved skill catalogue for this session, captured from the most recent
 * `before_agent_start`.
 *
 * A child's catalogue must cover installed packages and project-local skills, not
 * just `agent/skills/` — and it must respect the human's resource filters. pi has
 * already done both by the time it builds the orchestrator's prompt, so the list
 * is taken from there rather than re-derived from `settings.json` (which would be
 * a second parser of a format pi owns, the mistake `AGENTS.md` warns about).
 *
 * Undefined until the first turn starts, which `spawnRun` falls back around. A
 * spawn can only happen inside a tool call, so in practice it is always set.
 */
let piSkillCatalogue: SkillEntry[] | undefined;

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

/**
 * A cheap fingerprint of a run's completion evidence: its session file's size
 * and mtime. Revival extracts a failed run's transcript only when this moved.
 */
function evidenceStamp(runDirPath: string, runId: string): string | undefined {
  try {
    const name = readdirSync(runDirPath).find((n) => isSessionFileFor(n, runId));
    if (!name) return undefined;
    const stat = statSync(join(runDirPath, name));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * The one production run lifecycle: every owned-run reconciliation, launch
 * failure, cancellation and sweep goes through it (see `run-lifecycle.ts`).
 */
const lifecycle: RunLifecycle = createRunLifecycle({
  probe: probeAgent,
  close: (paneId) => closePane(paneId),
  extract: extractRunResult,
  hasSidecar: hasExitSidecar,
  evidenceStamp,
  saveMeta,
  runDirOf: dirFor,
  now: Date.now,
  delay: sleep,
});

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

interface SpawnParams {
  agent: string;
  task: string;
  cwd?: string;
  model?: string;
  /**
   * Set when this spawn is a health check of another run: the target's run id.
   * Internal — it is not part of the public `subagent` schema.
   */
  healthCheckOf?: string;
}

export interface SpawnOutcome {
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

/** Outcome of the one launch attempt. */
export interface AttemptOutcome {
  ok: boolean;
  paneId?: string;
  tabId?: string;
  /** Set when the attempt failed; the reason to record and to report. */
  error?: string;
}

/**
 * Opens a pane and tries to get a pi child interactive on the fallback router.
 *
 * The child always launches on `fallback/auto` with its chain in the env, so
 * there is no physical-model launch path. A failure here is a *launch*
 * failure — pi exited before its TUI came up, which herdr reports as "did not
 * become interactive". With a non-empty chain the router registers, so pi
 * starts: it exits at startup only when the router does *not* register (the
 * chain-less case `spawnRun` refuses up front), which is why a dead model
 * never reaches this path — an unservable chain fails at the first request.
 *
 * The pane is kept on a genuine failure: herdr destroys scrollback with the
 * pane, and the failure is the one a human needs to read. A *name* refusal is
 * the exception — herdr never ran pi, so there is no scrollback to keep and the
 * pane is always closed.
 *
 * Exported (with `Launcher`) so a test can supply its own world: the name-
 * refusal handling below is the logic that keeps a name refusal from being
 * read as a dead model, and a stub launcher is the only way to pin it without
 * a live herdr.
 */
export async function launchAttempt(
  agent: AgentInfo,
  rec: RunRecord,
  dir: string,
  promptPath: string,
  launcher: Launcher = realLauncher,
  fallbackChain: readonly string[],
): Promise<AttemptOutcome> {
  // The child's pane env: its run identity, and — the key to child →
  // orchestrator messaging — this orchestrator's own pane id, which herdr
  // injects into our process as HERDR_PANE_ID.
  //
  // The child's lineage is ours plus the child: our own comes from the env our
  // parent stamped, so ancestry is accumulated by processes rather than trusted
  // from a model.
  const env = buildChildEnv(
    rec,
    process.env.HERDR_PANE_ID,
    dir,
    [...parseLineage(process.env[LINEAGE_ENV]), rec.agent],
    fallbackChain,
  );
  const label = `${agent.name} ${rec.runId}`;
  const pane = await launcher.createChildPane(rec.cwd, label, env);
  if (!pane) {
    return {
      ok: false,
      error:
        "Could not open a herdr tab: is the herdr server running? Check `herdr status`. Subagents need herdr to spawn their agent tabs.",
    };
  }
  await launcher.renamePane(pane.paneId, label);

  // The child always launches on the router: `fallback/auto` names the router,
  // and the chain in the env tells it what to route between (and applies any
  // pinned thinking level at route time). There is no physical-model path, so
  // the `--model` flag is the constant `buildChildArgv` pushes on its own.
  const argv = buildChildArgv({
    childDonePath: join(SELF_DIR, "child-done.ts"),
    runDir: dir,
    runId: rec.runId,
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
  // and the pane holds nothing but a shell prompt (no scrollback to preserve,
  // hence the unconditional close). Reported without a pane id so the refusal
  // is not read as a dead model.
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
      error:
        `herdr already has a live agent named "${scoped}" (agent_name_taken), so this child could not register. ` +
        `Names are unique among live agents; run \`herdr agent list\` to see what holds it.`,
    };
  }
  if (started.error === "invalid_agent_name") {
    await launcher.closePane(pane.paneId);
    return {
      ok: false,
      error:
        `herdr rejected the name "${scoped}" as malformed (invalid_agent_name). A name must match ` +
        `[a-z][a-z0-9_-]{0,31} — at most 32 characters including the "-${rec.runId}" suffix (9). ` +
        `Rename the agent definition's \`name\` field.`,
    };
  }

  return {
    ok: false,
    paneId: pane.paneId,
    tabId: pane.tabId,
    error: `pi in pane ${pane.paneId} did not become interactive on ${FALLBACK_MODEL_REF}${
      started.error ? ` (herdr said: ${started.error})` : ""
    } (see that pane's output).`,
  };
}

/**
 * Spawns one herdr agent for a subagent definition: a new tab in this
 * workspace (one fresh shell pane, native `pi` child), task prompt.
 *
 * The child launches once, on `fallback/auto` with its chain
 * (`childFallbackChain`) in the env — there is no per-model launch loop, because
 * a launch failure names the router, not one of the chain's models, and hopping
 * is the running child's job. A declaration with no syntactically usable
 * reference is refused up front, before any run dir, registry entry, or pane.
 *
 * With a non-empty chain the router registers, so pi starts and accepts the
 * prompt; a chain the router cannot *serve* (an entry it cannot resolve) fails
 * at the first request, not at the launch. Pi exits at startup only when the
 * router does not register — the chain-less case the up-front refusal covers.
 * The prompt half of the attempt therefore guards a lost keypress (herdr typed
 * the task but the turn never started), not a dead model.
 *
 * The pane is kept on a genuine failure: herdr destroys scrollback with the
 * pane, and the failure is what a human needs to read. A *name* refusal is the
 * exception — herdr never ran pi, so the pane is closed and no pane id is
 * reported (closing the tab's only pane closes the tab).
 *
 * A child that accepted its task and then died has written part of a
 * transcript and burned tokens; re-running it is a decision for the caller,
 * not a reflex here.
 */
async function spawnRun(params: SpawnParams, baseCwd: string): Promise<SpawnOutcome> {
  // Resolve against the global roster PLUS every skill's agents. Unlike the
  // prompt inventory this does not gate on the loaded set: spawning happens with
  // no session context, and a skill loaded mid-session would otherwise be
  // invisible here and fail a delegation the agent was just told to make.
  const agents = mergeAgents(
    await discoverAgents(agentsDir()),
    await discoverSkillAgents(skillsDir()),
  );
  // This process's ancestry, written by whoever spawned us. Drives both the
  // cycle check and `callable_by`, and is the one input here a model cannot
  // influence.
  const lineage = parseLineage(process.env[LINEAGE_ENV]);

  const agent = agents.find((a) => a.name === params.agent);
  if (!agent) {
    // List only what this caller could actually spawn. Advertising a private
    // helper it may not use turns one refusal into two round trips.
    const available =
      agents
        .filter((a) => !lineageRejection(a.name, a.callableBy, lineage))
        .map((a) => (a.skill ? `${a.name} (skill: ${a.skill})` : a.name))
        .join(", ") || "none";
    return { ok: false, error: `Unknown agent "${params.agent}". Available agents: ${available}.` };
  }

  // Refuse before spending anything: no run dir, no registry entry, no pane.
  const lineageProblem = lineageRejection(agent.name, agent.callableBy, lineage);
  if (lineageProblem) return { ok: false, error: lineageProblem };

  // The child's model chain, in its only role now: the router it launches on.
  // A child is started on `fallback/auto` with this chain in its env, so a
  // declaration with no syntactically usable reference is a launch refusal, not
  // a fallback to pi's default — refuse it before any run dir, registry entry,
  // or pane. The two messages split on who is at fault: a bad `model` on the
  // delegation call is the caller's to fix; an empty declaration is the agent
  // file's.
  const chain = childFallbackChain(params.model, agent);
  if (!chain) {
    // A whitespace-only `model` is no request (the chain rule normalises it to
    // nothing), so it is the agent file's declaration that failed, not the
    // caller's.
    const error = params.model?.trim()
      ? `Requested model "${params.model}" is not usable. The accepted grammar is \`provider/id\` or \`provider/id|level\` (level: off|minimal|low|medium|high|xhigh|max); a pi-style \`ref:level\` is translated only when the ref is itself a plain \`provider/id\`, and \`fallback/auto\` is not accepted — the router cannot route to itself. Pass a valid model, or omit \`model\` to use the agent's declaration.`
      : `Agent "${agent.name}" declares no usable model: its model/fallback_models contains no reference the router can serve. Fix the agent definition — children launch on fallback/auto, which needs at least one entry.`;
    return { ok: false, error };
  }
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
    // The parsed head ref, for diagnostics only: the child runs on the router,
    // and which physical model answers is up to it.
    model: parseChainItem(chain[0]!)!.ref,
    status: "running",
    startedAt: Date.now(),
    // The chain handed to the router, recorded so a reader of a finished run
    // can see what the child could hop between.
    fallbackChain: [...chain],
    ...(params.healthCheckOf ? { healthCheckOf: params.healthCheckOf } : {}),
    // The spawning parent's pane, stamped before the record is registered:
    // only this pane's process may autonomously sweep the run (see
    // isOwnedBy). Absent when the process has no pane of its own.
    ...(process.env.HERDR_PANE_ID ? { ownerPane: process.env.HERDR_PANE_ID } : {}),
  };
  const dir = dirFor(runId);
  mkdirSync(dir, { recursive: true });
  // Register in-memory now, not only on disk: subagent_tasks resolves ids
  // from this map, and a fresh spawn must be statusable/waitable within the
  // same process (the disk registry is what a *restarted* parent rebuilds).
  runs.set(rec.runId, rec);

  // The child's system prompt. Its body is the agent definition verbatim, plus
  // a skills catalogue when the agent declared one: pi builds `## Available
  // Skills` for the orchestrator only, so a subagent cannot otherwise know a
  // skill exists. Discovery failing costs the catalogue, never the launch.
  const promptPath = systemPromptPath(dir);
  let promptBody = agent.promptBody;
  if (agent.skills && agent.skills.length > 0) {
    // pi's own resolved list covers packages and project scope and has the
    // human's resource filters already applied; scanning `agent/skills/` is the
    // fallback for the case where no turn has started yet.
    const available = piSkillCatalogue ?? (await discoverSkills(skillsDir()));
    const selected = selectSkills(agent.skills, available);
    const canRead = !agent.tools || agent.tools.length === 0 ||
      agent.tools.some((t) => READING_TOOLS.has(t));
    promptBody = appendSkillCatalogue(promptBody, selected, canRead);
  }
  try {
    writeFileSync(promptPath, promptBody);
  } catch {
    return { ok: false, error: `Could not write the child's system prompt to ${promptPath}.` };
  }

  // One attempt: open the pane, get pi interactive on the router, and get the
  // task accepted. The prompt half is a guard against a lost keypress, not a
  // model check: with a non-empty chain the router registers and pi starts,
  // so an unservable chain fails at the first request, after the prompt is in.
  const attempt = await launchAttempt(agent, rec, dir, promptPath, realLauncher, chain);
  if (!attempt.ok) {
    // Link the record to the kept pane so a reader of meta.json can find the
    // failure's scrollback; a name refusal closed its pane, so it reports none.
    // The attempt ran on the router, so the record names it, not the head ref.
    lifecycle.launchFailed(
      rec,
      { model: FALLBACK_MODEL_REF, error: attempt.error ?? "unknown launch failure" },
      attempt.paneId ? { paneId: attempt.paneId, tabId: attempt.tabId } : undefined,
    );
    return { ok: false, error: attempt.error ?? "The child could not be launched." };
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
  if (!turnStarted) {
    const error = `task prompt not accepted in pane ${attempt.paneId} (herdr said: ${prompted.error ?? "unknown"})`;
    // The pane is kept, so link the record to it like the launch-failure path.
    lifecycle.launchFailed(rec, { model: FALLBACK_MODEL_REF, error }, { paneId: attempt.paneId!, tabId: attempt.tabId });
    return { ok: false, error };
  }

  rec.paneId = attempt.paneId;
  rec.tabId = attempt.tabId;
  saveMeta(rec);
  return { ok: true, rec };
}

/**
 * Spawns the health-check run that diagnoses a target: the release ledger's
 * `spawnHealthCheck` collaborator.
 *
 * A health check is a child like any other — same spawn path, same tools,
 * same wake — with two differences: it is spawned by this module rather than
 * by a model, and its record carries `healthCheckOf`, the target run it
 * exists to diagnose. The `healthcheck` definition's declared model and
 * fallback chain are used as-is.
 *
 * Policy-free by design: the recursion guard (a health check is never
 * health-checked), the reuse of a running check, and the synchronous
 * in-flight marker all live in `release-ledger.ts`, which calls this only
 * once it has decided a spawn is due.
 */
async function spawnHealthCheckRun(
  target: RunRecord,
  trigger: HealthCheckTrigger,
): Promise<SpawnOutcome> {
  return spawnRun(
    {
      agent: "healthcheck",
      cwd: target.cwd,
      task: buildHealthCheckTask(target, dirFor(target.runId), trigger),
      healthCheckOf: target.runId,
    },
    target.cwd,
  );
}

/**
 * How a pane observation reads in `status`/`result` output: the herdr state for
 * a live pane, a named reachability failure for an unreachable herdr, and
 * null for a gone (or never-probed) pane. Unreachable is never shown as gone —
 * absence was not proven.
 */
function paneStateLabel(pane: PaneObservation): string | null {
  if (pane.kind === "state") return pane.status;
  if (pane.kind === "unreachable") return `unreachable (${pane.error ?? "unknown"})`;
  return null;
}

/** Terminal text used as a failure diagnostic when the transcript has nothing. */
async function paneDiagnostic(rec: RunRecord): Promise<string | null> {
  if (!rec.paneId) return null;
  // herdr reuses pane ids, so the recorded id may now belong to a different
  // pane: read it only when it still carries the label this run was given.
  // An unreadable label (pane gone, herdr unreachable) is treated the same —
  // the output could be anyone's, so no pane output at all.
  const label = await paneLabel(rec.paneId);
  if (label !== `${rec.agent} ${rec.runId}`) return null;
  return readAgent(rec.paneId, 40);
}

/**
 * A finite `startedAt` for a record: `startedAt` is non-optional on the
 * type, but a truncated or hand-edited meta.json can still load a record
 * without one (or with a non-numeric one), and arithmetic on it would then
 * yield NaN. Fall back to now (elapsed ≈ 0) so headers and lists stay
 * readable; `Math.max(0, …)` at the call sites keeps a stale `finishedAt`
 * from rendering a negative elapsed (finishedAt older than startedAt).
 */
function startedAtOf(rec: RunRecord, now: number = Date.now()): number {
  return Number.isFinite(rec.startedAt) ? rec.startedAt : now;
}

function formatResultHeader(rec: RunRecord): string {
  const startedAt = startedAtOf(rec);
  const elapsed = rec.finishedAt
    ? `${Math.max(0, Math.round((rec.finishedAt - startedAt) / 1000))}s`
    : "…";
  const healthCheckOf = healthCheckOfId(rec);
  const role = healthCheckOf ? `health check of ${healthCheckOf} — ${rec.status}` : rec.status;
  return `=== ${rec.runId} (${rec.agent}) — ${role} [${elapsed}] ===`;
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
// Sweep: find runs that finished since the last wake
// ---------------------------------------------------------------------------

/**
 * Finds runs in the registry that have finished since the last wake.
 *
 * This is the sweep that makes "multiple subagents finishing at once" produce
 * one response: a notice is a prompt to look, not the evidence. When any notice
 * triggers a flush, every other run that has also finished (sidecar on disk,
 * pane gone) is folded into the same briefing, so a fan-out that finishes
 * together wakes the orchestrator once, not once per child.
 *
 * A thin adapter over {@link RunLifecycle.sweep}, which owns the concurrency,
 * isolation and ordering; kept as an export for callers and tests.
 *
 * @param recs - Snapshot of all registry records.
 * @param exclude - Run ids already covered by the current batch or previously briefed.
 * @param owner - The lifecycle that sweeps; the production one by default.
 * @returns Observations of the runs that finished, in registry order.
 */
export async function collectFinished(
  recs: readonly RunRecord[],
  exclude: ReadonlySet<string>,
  owner: Pick<RunLifecycle, "sweep"> = lifecycle,
): Promise<RunObservation[]> {
  return (await owner.sweep(recs, { exclude })).finished;
}

// ---------------------------------------------------------------------------
// Briefings (the text a notice becomes)
// ---------------------------------------------------------------------------

/**
 * Pushes one completed run's block (header, answer, diagnostics, reports)
 * onto the caller's output array. The caller must have already brought the
 * record up to date (`lifecycle.read`, or a sweep).
 */
async function renderResultBlock(
  rec: RunRecord,
  out: string[],
  /** Pre-fetched result, when the caller already ran the no-answer gate. */
  result?: RunResult,
): Promise<void> {
  out.push(formatResultHeader(rec));
  const resolved = result ?? (await extractRunResult(dirFor(rec.runId), rec.runId));
  // A salvaged answer is labelled rather than passed off as a clean report: the
  // orchestrator should know it is reading something the child stranded in the
  // wrong place, because it may be truncated and the delegation may be worth
  // re-running. A clean answer in the right place gets no label at all.
  const salvageNote: Record<string, string> = {
    "done-arguments":
      "(recovered from this run's subagent_done arguments — the child passed its answer to the tool instead of writing it as a message, so it is very likely truncated)",
    "truncated-answer":
      "(this is the child's final answer, but it does not close its `<result>` element — most likely cut off by the output limit, so treat it as incomplete)",
    "earlier-message":
      "(recovered from an earlier message — the child answered and then kept working, so its final message was not the answer)",
    "non-conforming":
      "(NOT AN ANSWER — this run produced no report, only this line. Everything it concluded is lost; re-delegate the task rather than relying on this.)",
  };
  if (resolved.salvagedFrom) out.push(salvageNote[resolved.salvagedFrom]);
  out.push(resolved.answered ? truncate(resolved.text) : "(no final answer in transcript)");
  if (rec.status === "failed" && !resolved.answered) {
    const diag = await paneDiagnostic(rec);
    if (diag) out.push(`\n--- pane output ---\n${truncate(diag)}`);
  }
  await pushReports(rec, out);
}

/**
 * Renders one completed run's block as a single string (joined with "\n").
 * Used by the wake briefing where each block is an independent paragraph.
 */
async function doneBlock(rec: RunRecord, result?: RunResult): Promise<string> {
  const out: string[] = [];
  await renderResultBlock(rec, out, result);
  return out.join("\n");
}

/**
 * A released target's block when its result read threw: the real header —
 * so the block stays discoverable by the `=== sub-xxxx` header every release
 * assertion pins — plus a pointer to `subagent_tasks`. `readReports` never
 * throws, so the mid-run reports ride the degraded block too.
 */
async function degradedBlock(rec: RunRecord): Promise<string> {
  const out: string[] = [
    formatResultHeader(rec),
    `result block unavailable; read it with subagent_tasks (action "result", ids ["${rec.runId}"])`,
  ];
  await pushReports(rec, out);
  return out.join("\n");
}

/**
 * Minimal briefing used when composing the full one threw.
 *
 * Deliberately does no I/O: this is the path taken *because* I/O failed, and a
 * wake that says only "something happened, go and look" still beats an
 * orchestrator that sleeps through a finished child.
 */
function fallbackBriefing(
  batch: readonly Notice[],
  swept: readonly RunRecord[],
  /**
   * Targets whose release a failed compose for their health check carried:
   * neither a fresh notice nor a swept record, so the caller surfaces them
   * here explicitly.
   */
  releasedTargets: ReadonlyArray<ReleasedTarget>,
): string {
  const ids = new Set<string>();
  const lines: string[] = [];
  for (const n of batch) {
    if (!ids.has(n.runId)) {
      ids.add(n.runId);
      lines.push(`- ${n.runId} (${n.agent}) ${n.kind}${n.text ? `: ${n.text}` : ""}`);
    }
  }
  for (const r of swept) {
    if (!ids.has(r.runId)) {
      ids.add(r.runId);
      lines.push(`- ${r.runId} (${r.agent}) ${r.status}`);
    }
  }
  for (const t of releasedTargets) {
    if (!ids.has(t.runId)) {
      ids.add(t.runId);
      lines.push(
        t.kind === "unregistered"
          ? `- ${t.runId} — release carried by the failed health check's briefing; this id is not in my registry, so I have no record of it — read it from its run dir, or with subagent_tasks (action "result") if it exists`
          : `- ${t.runId} (${t.agent}) ${t.status} — release carried by the failed health check's briefing`,
      );
    }
  }
  return (
    `[subagent update — delivered automatically, not typed by the user]\n\n${lines.join("\n")}\n\n` +
    `I could not read the run details. Use subagent_tasks (action "result") on the ids above to collect them.`
  );
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  // This process's herdr pane, captured once at factory time: ownership is
  // stamped at spawn and compared at sweep time, and the env is the one fact
  // a restarted process can trust to identify itself. `undefined` (no herdr
  // pane) owns nothing — autonomous sweeps are a no-op, queries are not.
  const ownerPane = process.env.HERDR_PANE_ID;

  // -------------------------------------------------------------------------
  // Skill catalogue capture
  // -------------------------------------------------------------------------

  /**
   * Takes pi's resolved skill list for this turn, so a spawned child can be
   * given a catalogue that includes package and project-local skills.
   *
   * Read-only: this handler returns nothing, so it cannot perturb the
   * orchestrator's own prompt. A malformed list costs the catalogue (the spawn
   * path falls back to scanning `agent/skills/`), never the turn.
   */
  pi.on("before_agent_start", (event) => {
    try {
      const skills = event.systemPromptOptions?.skills;
      if (Array.isArray(skills)) piSkillCatalogue = skillEntriesFromPi(skills);
    } catch {
      // Leave the previous catalogue (or undefined) in place.
    }
  });

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
      model: Type.Optional(Type.String({ description: "Model override for the child: `provider/id` or `provider/id|level` (level: off|minimal|low|medium|high|xhigh|max; a pi-style `ref:level` is translated when the ref is plain). `fallback/auto` is not accepted — the router cannot route to itself. Default: the agent's declared model." })),
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
      "Inspect and steer delegated subagent tasks: status (are they still running), result (read a finished task's answer and its reports), list (all tasks), message (queue an instruction for a running subagent without aborting its current work), interrupt (stop a running subagent's current work with Escape, wait for the pane to report idle within a bounded wait, and replace it with a new prompt), cancel (kill a subagent's pane and stop it). None of these wait for a subagent to finish: subagents wake you with a message when they report or finish. A subagent that stalls, or ends without a usable answer, is diagnosed automatically by a read-only health-check agent whose report you receive as a briefing.",
    promptSnippet:
      "Check, re-read, message, list, interrupt, or cancel delegated subagent tasks by their task ids (sub-xxxx).",
    promptGuidelines: [
      "There is no blocking wait, by design. After delegating, end your turn — the subagent wakes you with a new message when it reports or finishes, and that message carries its answer.",
      "Use \"result\" to read a finished task's answer (and any mid-run reports), \"status\" for a quick is-it-still-running check, \"list\" to see everything, and \"cancel\" to stop a running task (kills its pane)",
      "Use \"message\" to answer a subagent's question or redirect it while it is still running — that is the point of being woken by a report rather than at the end.",
      "Never poll: do not call status in a loop and do not spin on a task waiting for it to finish. Ending your turn is how you wait.",
      "Use \"interrupt\" to stop a running subagent's current work (an Escape, which cuts off both streaming and a running tool call) and replace it with a new prompt — the prompt is sent only once the pane reports idle, within a bounded wait. Unlike \"message\" it interrupts; unlike \"cancel\" it leaves the pane alive to do the replacement work.",
      "Health checks run on their own: a subagent that stalls, or ends without a usable answer, is diagnosed by a read-only health-check agent before its report reaches you. Its report names the target's status, what happened, findings/work so far, and a recommendation — act on it by choosing: wait, interrupt with a corrective prompt, cancel, or spawn a fresh subagent whose self-contained task carries the recovered findings.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("status"),
        Type.Literal("result"),
        Type.Literal("list"),
        Type.Literal("cancel"),
        Type.Literal("message"),
        Type.Literal("interrupt"),
      ]),
      ids: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Task ids (sub-xxxx); required for status/result/cancel/message/interrupt, ignored for list",
        }),
      ),
      text: Type.Optional(
        Type.String({
          description:
            "The prompt to deliver for action \"message\" or after action \"interrupt\" reaches idle",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return dispatchTasks(params.action, params.ids ?? [], params.text, ownerPane, { enqueueNotice });
    },
  });

  // -------------------------------------------------------------------------
  // The wake path: a child's notice arrives here as ordinary input
  // -------------------------------------------------------------------------

  // The policy — coalescing, dedup, health-check pairing, ownership, the
  // liveness tick — is the ledger's (release-ledger.ts). The factory keeps
  // only what the ledger must not touch: the timers, the clock, and pi.
  const ledger = createReleaseLedger({
    records: () => [...runs.values()],
    lifecycle,
    ownerPane,
    spawnHealthCheck: spawnHealthCheckRun,
    extractRunResult: (rec) => extractRunResult(dirFor(rec.runId), rec.runId),
    renderer: { done: doneBlock, degraded: degradedBlock, fallback: fallbackBriefing },
  });
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let livenessTimer: ReturnType<typeof setInterval> | undefined;

  /**
   * Delivers a composed briefing.
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
  const deliver = (text: string): void => {
    try {
      // deliverAs "steer", not "followUp" — and the distinction is the whole
      // reason a finished child used to be invisible until the orchestrator was
      // completely done. pi's agent loop drains the two queues from
      // structurally different places (`agent-loop.js`, measured against
      // pi-agent-core 0.99.2):
      //
      //   inner loop, every turn:  pendingMessages = getSteeringMessages()
      //   outer loop, after the inner `while` exits:  getFollowUpMessages()
      //
      // The inner loop runs `while (hasMoreToolCalls || pendingMessages.length)`.
      // So a follow-up is only collected once the orchestrator has stopped
      // calling tools altogether — i.e. when its turn is already over. An
      // orchestrator that delegates and then keeps working (reads a file, greps,
      // spawns a sibling) pauses for each tool result *inside* that inner loop,
      // where the follow-up queue is never consulted, so the briefing sat there
      // until the turn ended on its own. That is the bug: not a late wake, a
      // structurally unreachable one.
      //
      // Steering is drained after the current assistant message's tool results
      // are already in context and before the next LLM call, so it cuts into the
      // tool-call chain at the first safe boundary without ever splitting a
      // tool_call/tool_result pair. Cutting in is the point — a subagent's result
      // is new information that should redirect the loop, not wait politely
      // behind the work it invalidates.
      //
      // This does not change the idle path at all: `deliverAs` is only consulted
      // when `isStreaming` is true (`agent-session.js` `prompt()`), and when the
      // session is idle this still starts a fresh turn exactly as before.
      //
      // `steeringMode` is set to "all" in agent/settings.json, so if two
      // briefings ever land in the steering queue simultaneously (e.g. the
      // second flush fires while the orchestrator is still responding to the
      // first), both drain into the same next turn as one consolidated response.
      //
      // `expandPromptTemplates` is deliberately omitted rather than passed as
      // false: false is already the default. The briefing always starts with "[",
      // so it could never be taken for a slash command anyway.
      pi.sendUserMessage(text, { deliverAs: "steer" });
    } catch {
      // The runtime went away under us. The run's state is on disk either way,
      // so the next `status`/`result` still reports it correctly.
    }
  };

  /**
   * (Re-)arms the one coalesce timer for a deadline the ledger returned.
   *
   * Every caller that can make the ledger enqueue — the input hook, the
   * liveness tick, the `cancel` dispatch — passes its returned deadline
   * through here, so the window is re-armed the same way whatever produced the
   * notice. `undefined` (shutdown, or a tick that enqueued nothing) leaves the
   * current timer alone. Never a wait and never a poll: one timer, one flush.
   */
  const armFlush = (deadline: number | undefined): void => {
    if (deadline === undefined) return;
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined;
      // The timer was armed for exactly this deadline, so the batch is due —
      // even when the timer fires a millisecond early by the clock.
      ledger
        .flush(Math.max(Date.now(), deadline))
        .then((text) => {
          if (text) deliver(text);
        })
        .catch(() => {
          // A flush that rejected outright has nothing to deliver; the run
          // state is on disk, and the next notice or tick re-drives it.
        });
    }, Math.max(0, deadline - Date.now()));
  };

  /** Buffers a notice through the ledger and arms the flush it calls for. */
  const enqueueNotice = (notice: Notice): void => armFlush(ledger.enqueue(notice, Date.now()));

  /** One liveness tick through the ledger, arming the flush its notices call for. */
  const runLivenessTick = async (): Promise<void> => armFlush(await ledger.tick(Date.now()));

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
    enqueueNotice(notice);

    return { action: "handled" as const };
  });

  // A session that goes away mid-window must not fire a timer into a dead
  // runtime; the notices are on disk (reports.jsonl, the sidecar) regardless.
  // The handles are cleared first, then the ledger drops its batch and turns
  // every later call (an in-flight tick or flush finishing) into a no-op.
  pi.on("session_shutdown", () => {
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    if (livenessTimer) clearInterval(livenessTimer);
    livenessTimer = undefined;
    ledger.shutdown();
  });

  // The parent-side liveness backstop: one bounded reconciliation tick per
  // interval. A live child costs one status probe and nothing else; a dead
  // child is classified from its sidecar and woken through the ordinary
  // coalesced path. `unref` keeps a session whose only remaining activity is a
  // quiet fleet from holding the process open.
  // Children load this module too (they get the subagent/subagent_tasks tools)
  // and share the on-disk registry, so a child's tick would reconcile records
  // it does not own: closing siblings' panes (destroying scrollback evidence),
  // overwriting siblings' meta.json, and injecting sibling briefings into the
  // child's own session — it can even mark its own record failed (herdr's
  // `done` means "ready for input"). Guard the interval registration, not the
  // factory: children keep spawning and querying, they just never tick. Same
  // guard as todo.ts and kanban/index.ts.
  if (!process.env.PI_SUBAGENT_RUN_ID) {
    livenessTimer = setInterval(() => {
      void runLivenessTick().catch(() => {});
    }, LIVENESS_BACKSTOP_MS);
    livenessTimer.unref?.();
  }
}

// ---------------------------------------------------------------------------
// subagent_tasks dispatch (top-level so it can live outside the factory)
// ---------------------------------------------------------------------------

/**
 * The effects one interrupt needs, so the seam is testable without a live
 * herdr. `read` is the lifecycle's own (it classifies a finished pane from
 * its sidecar before an Escape is ever sent).
 */
export interface InterruptEffects {
  sendKeys: typeof sendKeys;
  waitAgentIdle: typeof waitAgentIdle;
  sendPrompt: typeof sendPrompt;
  /** Bring the record up to date (the lifecycle's `read`). */
  read: (rec: RunRecord) => Promise<RunObservation>;
}

/**
 * The effects the dispatch needs from factory scope. `cancel` is the one
 * action with a wake side effect — a cancelled health check enqueues its done
 * notice, the release that carries the deferred target's block through the
 * ordinary coalesced path — and `enqueueNotice` is factory-scoped, so the
 * seam is threaded the way `interruptRun` takes its `InterruptEffects`.
 */
export interface DispatchEffects {
  enqueueNotice: (notice: Notice) => void;
}

/**
 * Interrupts one run: read (reconcile), send Escape, wait (bounded) for the pane to
 * report idle, then deliver the replacement prompt — and only then.
 *
 * The order is load-bearing. Reconcile first, because an Escape typed into a
 * pane whose child already finished goes nowhere and a run that is `done`
 * must be reported as `done`, not "interrupted". Escape before the idle wait,
 * because the wait is what makes the prompt safe: pi's bash tool kills its
 * process tree on abort, so once the pane reports `idle`, no streaming response
 * or tool call is mid-flight and the replacement prompt lands on a ready
 * prompt. (herdr's `idle` and `done` both mean "ready for input" and are
 * distinguished by seen-state — a pane that finished just before the Escape
 * may answer the wait with `done` instead of `idle`; the post-timeout
 * reconcile below is what catches that case.) If the pane does not report idle within
 * `timeoutMs`, the record is reconciled once more — a run that finished while
 * we waited is reported by its real status, and a run that is genuinely stuck
 * is reported as an idle timeout — and in *neither* case is the replacement
 * prompt sent, so an interrupted child never sees two prompts racing.
 *
 * Never throws: every failure resolves into the structured result.
 *
 * @param rec - The run to interrupt.
 * @param text - The replacement prompt; must be non-empty.
 * @param timeoutMs - Bounded patience for the idle handshake.
 * @param effects - The herdr calls (injected for tests).
 */
export async function interruptRun(
  rec: RunRecord,
  text: string,
  timeoutMs: number,
  effects: InterruptEffects,
): Promise<{
  interrupted: boolean;
  delivered: boolean;
  status: RunRecord["status"];
  error?: string;
}> {
  if (!text.trim()) {
    return {
      interrupted: false,
      delivered: false,
      status: rec.status,
      error: "no replacement prompt: \"text\" must be non-empty for an interrupt",
    };
  }

  // Reconcile before touching the pane: a run that already finished (sidecar on
  // disk, pane gone) must be reported by its real status, not interrupted.
  await effects.read(rec);
  if (rec.status !== "running" || !rec.paneId) {
    return { interrupted: false, delivered: false, status: rec.status };
  }

  const escaped = await effects.sendKeys(rec.paneId, "esc");
  if (!escaped) {
    return {
      interrupted: false,
      delivered: false,
      status: rec.status,
      error: "escape key not delivered",
    };
  }

  // The bounded interrupt handshake — part of this explicit operation, not a
  // completion wait (see INTERRUPT_IDLE_TIMEOUT_MS).
  const idle = await effects.waitAgentIdle(rec.paneId, timeoutMs);
  if (!idle) {
    // The run may have finished while we waited; one reconcile tells us.
    await effects.read(rec);
    if (rec.status !== "running") {
      return { interrupted: true, delivered: false, status: rec.status };
    }
    return {
      interrupted: true,
      delivered: false,
      status: "running",
      error: `idle timeout: pane did not report idle within ${timeoutMs}ms`,
    };
  }

  const sent = await effects.sendPrompt(rec.paneId, text);
  if (sent.ok) {
    // A child that finished between the idle wait and the prompt would be
    // reported stale as "running"; one more reconcile catches that case.
    // Failure-tolerant: a reconcile that throws keeps the pre-prompt status.
    try {
      await effects.read(rec);
    } catch {
      // Keep the pre-prompt status.
    }
  }
  return {
    interrupted: true,
    delivered: sent.ok,
    status: rec.status,
    ...(sent.ok ? {} : { error: sent.error ?? "unknown" }),
  };
}

async function dispatchTasks(
  action: "status" | "result" | "list" | "cancel" | "message" | "interrupt",
  ids: string[],
  text: string | undefined,
  ownerPane: string | undefined,
  effects: DispatchEffects,
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
        // Read first: a status that reports `running` for a child that
        // already exited is the one answer this action must never give.
        // A read mutates (a finish may close the pane and saves meta), and
        // the herdr probe is a round-trip, so it runs only for records this
        // pane owns; a foreign or legacy record reports its on-disk state
        // untouched. The displayed herdr state comes from that same probe.
        const owned = isOwnedBy(rec, ownerPane);
        const observation = owned ? await lifecycle.read(rec) : undefined;
        const live = observation && rec.status === "running" ? paneStateLabel(observation.pane) : null;
        lines.push(`${rec.runId} (${rec.agent}): ${rec.status}${live ? ` [herdr: ${live}]` : ""}`);
        details[rec.runId] = { status: rec.status, herdr: live, owned };
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
        // running" just because no notice has been processed yet. A read
        // mutates (a finish may close the pane and saves meta), so it runs only
        // for records this pane owns; a foreign or legacy record reports its
        // on-disk state without probing herdr on this arm (a foreign terminal
        // record may still be read via the result block's pane diagnostic;
        // reads do not mutate).
        const owned = isOwnedBy(rec, ownerPane);
        const observation = owned ? await lifecycle.read(rec) : undefined;
        if (rec.status === "running") {
          const live = observation ? paneStateLabel(observation.pane) : null;
          // A foreign or legacy record was not probed: the marker keeps its
          // "still running" legible as unverified on-disk state, not a live
          // probe. Legacy (no `ownerPane`) and foreign (someone else's pane)
          // are named distinctly.
          out.push(
            `${formatResultHeader(rec)}\nstill running` +
              (live
                ? ` [herdr: ${live}]`
                : owned
                  ? " [pane gone]"
                  : ` [not probed: ${ownerPaneOf(rec) === undefined ? "no owner recorded" : "owned by another session"}]`),
          );
          // Mid-run reports are the only thing a running task has to show; they
          // are why asking early is still worth something.
          await pushReports(rec, out);
          details[rec.runId] = { status: "running" };
          continue;
        }
        await renderResultBlock(rec, out, observation ? await observation.result() : undefined);
        details[rec.runId] = { status: rec.status };
      }
      return { content: [{ type: "text", text: unknownNote + out.join("\n\n") }], details };
    }

    case "cancel": {
      const out: string[] = [];
      const details: Record<string, unknown> = {};
      for (const rec of recs) {
        // The lifecycle persists the cancellation before it closes the pane
        // (closing is destructive and can hang or fail; the cancel must stay
        // durable either way). A non-running record does not transition.
        const observation = await lifecycle.cancel(rec);
        if (observation.transition?.to === "cancelled") {
          // A cancelled health check releases its deferred target: its done
          // notice is what carries the release through the ordinary
          // coalesced path, exactly as the liveness tick enqueues one for a
          // finished check. A non-health-check run enqueues nothing — the
          // orchestrator already knows it cancelled.
          if (healthCheckOfId(rec)) {
            effects.enqueueNotice({ runId: rec.runId, agent: rec.agent, kind: "done", text: "" });
          }
        }
        out.push(`${rec.runId} (${rec.agent}): ${rec.status}`);
        details[rec.runId] = { status: rec.status };
      }
      return { content: [{ type: "text", text: unknownNote + out.join("\n") }], details };
    }

    case "interrupt": {
      const out: string[] = [];
      const details: Record<string, unknown> = {};
      if (!text || !text.trim()) {
        return {
          content: [{ type: "text", text: 'Error: action "interrupt" needs a non-empty "text".' }],
          details: { ok: false },
        };
      }
      for (const rec of recs) {
        const r = await interruptRun(rec, text ?? "", INTERRUPT_IDLE_TIMEOUT_MS, {
          sendKeys,
          waitAgentIdle,
          sendPrompt,
          read: lifecycle.read,
        });
        if (!r.interrupted) {
          const why =
            r.error ??
            (r.status !== "running" ? `not running (${r.status})` : !rec.paneId ? "no pane recorded" : "unknown");
          out.push(`${rec.runId} (${rec.agent}): interrupt not sent — ${why}`);
        } else if (r.delivered) {
          out.push(`${rec.runId} (${rec.agent}): interrupted; replacement prompt delivered to pane ${rec.paneId}`);
        } else if (r.status !== "running") {
          out.push(`${rec.runId} (${rec.agent}): run ${r.status} while interrupting — no prompt sent`);
        } else {
          out.push(`${rec.runId} (${rec.agent}): interrupted, but no prompt sent (${r.error ?? "unknown"})`);
        }
        details[rec.runId] = {
          interrupted: r.interrupted,
          delivered: r.delivered,
          status: r.status,
          ...(r.error ? { error: r.error } : {}),
        };
      }
      return { content: [{ type: "text", text: unknownNote + out.join("\n") }], details };
    }
  }
}

async function listRuns(): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
  // One `Date.now()` per sort call: `startedAtOf` falls back to `now` for a
  // record missing `startedAt`, and probing the clock inside the comparator
  // would let the two operands of one comparison disagree.
  const now = Date.now();
  const all = [...runs.values()].sort((a, b) => startedAtOf(b, now) - startedAtOf(a, now));
  if (all.length === 0) {
    return { content: [{ type: "text", text: "No subagent tasks recorded." }], details: { tasks: [] } };
  }
  const running = all.filter((r) => r.status === "running").length;
  const lines = all.map((rec) => {
    const age = Math.max(0, Math.round(((rec.finishedAt ?? Date.now()) - startedAtOf(rec)) / 1000));
    return `${rec.runId} (${rec.agent}): ${rec.status} [${age}s]${rec.tabId ? ` tab ${rec.tabId}` : ""}${rec.paneId ? ` pane ${rec.paneId}` : ""}`;
  });
  return {
    content: [{ type: "text", text: `${all.length} task(s), ${running} running.\n${lines.join("\n")}` }],
    details: {
      tasks: all.map((r) => ({
        task: r.runId,
        agent: r.agent,
        status: r.status,
        tabId: r.tabId,
        paneId: r.paneId,
        ...(healthCheckOfId(r) ? { healthCheckOf: healthCheckOfId(r) } : {}),
      })),
    },
  };
}
