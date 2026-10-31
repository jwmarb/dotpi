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

import { LINEAGE_ENV as SHARED_LINEAGE_ENV } from "../lib/agents.js";

// The channel name is a contract with the kanban extension, so it lives in
// the shared `lib/` and not in either sibling (see `lib/todo.ts`).
import { RUN_TODOS_EVENT } from "../lib/todo.js";

import {
  admitSpawn,
  appendCardBrief,
  appendSkillCatalogue,
  buildChildArgv,
  buildChildEnv,
  buildHealthCheckTask,
  childAncestry,
  childNameRejection,
  discoverSkills,
  extractRunResult,
  herdrAgentName,
  makeRunId,
  parseLineage,
  pickSessionName,
  readReports,
  readRunRecordFromDisk,
  type HealthCheckTrigger,
  type RunResult,
  selectSkills,
  type SkillEntry,
  skillEntriesFromPi,
  type SpawnOrigin,
} from "./lib.js";
// The router model id, owned by the extension that registers it.
import { FALLBACK_MODEL_REF, parseChainItem } from "../model-fallback/lib.js";
import {
  type AgentInfo,
  delegationRoster,
} from "../lib/agents.js";
import { agentDir, agentsDir, profileDir, skillsDir } from "../lib/layout.js";
import { personaOverride } from "../lib/persona.js";
import {
  ancestorLabel,
  CARD_ID_PATTERN,
  EVIDENCE_TAIL_BYTES,
  hasExitSidecar,
  isRunRecord,
  metaPath,
  type Notice,
  parseNotice,
  RUN_ID_PATTERN,
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
  runInPane,
  sendKeys,
  sendPrompt,
  startAgent,
  waitAgentIdle,
  waitAgentWorking,
} from "./herdr.js";
import { piShimDir, prependPathCommand, runningCompiled } from "../lib/runtime.js";
import {
  completionSignal,
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

/**
 * The run dir of a run adopted from a directory that is not this process's
 * own (see {@link adoptRunFromDisk}). An in-session profile switch retargets
 * the children's run dir to the switched profile, so an adopted run's
 * transcript, sidecar and meta live there — every read and write for that run
 * must go there, not where this process's dir says they should.
 */
const adoptedRunDirs = new Map<string, string>();

/**
 * This run's directory, derived from its id rather than stored on the record.
 * A run this process spawned lives under its own agent dir; a run adopted
 * from a switched profile's runs dir is answered from `adoptedRunDirs`, where
 * its files actually are.
 */
const dirFor = (runId: string): string => adoptedRunDirs.get(runId) ?? runDir(agentDir(), runId);

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

/**
 * Bounded launch recovery for a stalled first prompt. When the submitting
 * Enter is lost to the TUI (the text sits in the editor and herdr answers
 * `agent_prompt_stalled`), re-send the Enter and observe the state, up to
 * {@link PROMPT_RECOVERY_ATTEMPTS} times. Each observation waits
 * {@link PROMPT_RECOVERY_WAIT_MS} — three 5 s observations keep the existing
 * 15 s maximum recovery budget while allowing repeated Enter delivery, and a
 * launch that cannot start still fails (pane kept as evidence).
 */
const PROMPT_RECOVERY_ATTEMPTS = 3;
const PROMPT_RECOVERY_WAIT_MS = 5_000;

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
const LINEAGE_ENV = SHARED_LINEAGE_ENV;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const runs = new Map<string, RunRecord>();

/**
 * Run ids `spawnRun` is launching right now: registered in `runs`, pane not yet
 * attached. The lifecycle's `isLaunching` reads it so a sweep or query in the
 * launch window observes the run instead of failing it as `no-pane`.
 * Process-local and never persisted: after a restart nothing is in flight, so a
 * paneless record left by a crash mid-spawn still settles.
 */
const launchingRunIds = new Set<string>();

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
      // The load-time trust gate, mirroring `readRunRecordFromDisk` (pattern
      // plus dir-name equality): the shared runs dir is writable by every pi
      // process, so a planted `meta.json` is a realistic input — and `dirFor`
      // joins the id into a path, so an id outside the run-id shape, or one
      // that is not its own dir's name, must not reach the display arms' path
      // joins. `d` from `readdirSync` is always a single component, which is
      // what the equality keeps a planted `runId` of `../x` off; the pattern
      // keeps a dir whose name is not a run id off.
      if (isRunRecord(parsed) && RUN_ID_PATTERN.test(parsed.runId) && parsed.runId === d) {
        runs.set(parsed.runId, parsed);
      }
    } catch {
      // Partial dir (crashed mid-spawn): ignored.
    }
  }
}

loadRegistry();

/**
 * The bases a run this process may never have spawned can live in: this
 * process's own runs dir, plus the switched profile's dir when an in-session
 * profile switch retargeted the children's run dir there. The two deliberate
 * exceptions to own-dir reads in `../lib/layout.ts` — `adoptRunFromDisk`'s
 * rescue retry and the ledger's `parentRunIsFinished` parent lookup — both
 * read through these.
 */
const runDirBases = (): string[] => {
  const bases = [RUNS_DIR];
  const switched = runsDir(profileDir());
  if (switched !== RUNS_DIR) bases.push(switched);
  return bases;
};

/**
 * The claimed parent's record and the run dir it lives in, from {@link runDirBases} —
 * the first base that has it. Reads the record *without* registering it (no
 * `runs.set`, no `adoptedRunDirs` entry): a reroute marker's `parentRunId` is
 * model text, not a notice addressed to this pane, so it must not enter the
 * registry where `subagent_tasks list` would surface it and `cancel`/
 * `interrupt` could address it. The local `join(base, runId)` is the dir the
 * evidence reads need, standing in for `dirFor` without the mapping.
 */
const findRunRecordInAnyBase = (runId: string): { rec: RunRecord; dir: string } | undefined => {
  for (const base of runDirBases()) {
    const rec = readRunRecordFromDisk(base, runId);
    if (rec) return { rec, dir: join(base, runId) };
  }
  return undefined;
};

/**
 * The completion evidence for one run dir, read *without settling*: the
 * `.exit` sidecar, or a clean transcript answer read as a bounded tail — the
 * {@link completionSignal} rule, spelled once. `parentRunIsFinished` (the
 * reroute proof) and the display-only answer for a foreign `running` record
 * in `status`/`result` both consume it. A read, never a write: no transition,
 * no meta save, no pane close — so a run this pane does not own is never
 * settled by it, and the owning pane's process stays the one to do that.
 *
 * `result` is the extraction the decision rested on (absent when the sidecar
 * decided, since the transcript need not be read), so a caller that renders
 * the answer does not read the transcript twice. The negative arm carries
 * none: no caller renders a negative's extraction (the display arms render
 * mid-run reports from `reports.jsonl` instead), so it is not stored.
 *
 * `from` names the evidence the verdict rested on, `sidecar` or `answer`;
 * the negative arm carries none, and no caller consults `from` without a
 * `finished: true`.
 *
 * Memoized on the dir plus the run id, stamped on the session file's and
 * the prompt file's size/mtime (`evidenceStamp`): without the memo, the display path would
 * pay a bounded 4 MB tail read plus the `system-prompt.md` read for every
 * foreign `running` record on every `status`/`result` call, serially in
 * the id loop — on the answer branch; the sidecar branch pays neither,
 * with or without the memo, because `hasExitSidecar` decides first. The
 * sidecar check runs before the memo, so a sidecar that arrives re-proves;
 * the stamp re-proves a transcript (or prompt file) that moves. No TTL:
 * the verdict is a function of the on-disk bytes the read sees, and both
 * movers invalidate the stamp — the one byte mover the stamp cannot see
 * is an equal-size restore (the Nextcloud sync restore `readSessionTail`
 * documents): a transcript (or prompt file) restored with identical size and mtime serves
 * the cached verdict, which is the right one when the bytes are in fact
 * identical. The map is never pruned: its entries are bounded by the
 * distinct (dir, run id) pairs ever read for evidence (hundreds, not a
 * growth path) — the same bound as `parentProofMemo`, which it contrasts:
 * `parentProofMemo` caches positives only, because a `false` rests on pane
 * liveness the stamp cannot see, so it is never stored, and a cached
 * positive is TTL-bounded — and it stays keyed on the run id alone.
 *
 * The dir is in the key, not left to `dirFor`: `agentDir()` reads
 * `PI_CODING_AGENT_DIR` at call time, so an id whose dir moves (a profile
 * switch, no `adoptedRunDirs` entry) must not serve a verdict stamped in
 * the other dir.
 */
type CompletionEvidence =
  | { finished: true; from: "sidecar" | "answer"; result?: RunResult }
  | { finished: false };

const completionEvidenceMemo = new Map<
  string,
  { stamp: string | undefined; value: CompletionEvidence }
>();

const completionEvidence = async (
  dir: string,
  runId: string,
): Promise<CompletionEvidence> => {
  const sidecar = hasExitSidecar(dir, runId);
  if (sidecar) return { finished: true, from: "sidecar" };
  const stamp = evidenceStamp(dir, runId);
  const key = `${dir}\u0000${runId}`;
  const hit = completionEvidenceMemo.get(key);
  if (hit !== undefined && hit.stamp === stamp) return hit.value;
  const result = await extractRunResult(dir, runId, EVIDENCE_TAIL_BYTES);
  const value: CompletionEvidence = completionSignal(sidecar, result)
    ? { finished: true, from: "answer", result }
    : { finished: false };
  completionEvidenceMemo.set(key, { stamp, value });
  return value;
};

/**
 * Registers a run from its on-disk run dir — the rescue path for a notice
 * that arrives after a parent restart, when the meta file was lost but the
 * run dir (and its session transcript) survived.
 *
 * The meta.json's runId must match the dir name: that identity is what the
 * run dir layout assumes. The pane is not probed here — liveness
 * classification is the same lazy job `loadRegistry` leaves to the next
 * `status` / `wait` / `result` call.
 *
 * The id gate lives in `readRunRecordFromDisk` (the reader derives the dir
 * from the id and validates it), so a model-supplied `../x` never reaches the
 * filesystem through this path. `RUNS_DIR` is this process's own dir, and an
 * in-session profile switch retargets a child's run dir to the switched
 * profile, so a miss here is retried through `profileDir()` — the one other
 * dir the retry covers. Without the retry, a rerouted grandchild notice would
 * brief as an unregistered run. A run found in the switched dir is recorded in
 * `adoptedRunDirs`, so `dirFor` keeps its transcript, sidecar and meta reads
 * where they actually are. (A switch inside a *child's own* session would put
 * a great-grandchild's run dir in a third dir neither base looks, so that
 * notice briefs as unregistered — low likelihood, deep chain.)
 */
function adoptRunFromDisk(runId: string): RunRecord | undefined {
  const existing = runs.get(runId);
  if (existing) return existing;
  for (const base of runDirBases()) {
    const rec = readRunRecordFromDisk(base, runId);
    if (!rec) continue;
    runs.set(runId, rec);
    const dir = join(base, runId);
    if (dir !== dirFor(runId)) adoptedRunDirs.set(runId, dir);
    return rec;
  }
  return undefined;
}

/**
 * A cheap fingerprint of a run's completion evidence: its session file's and
 * its `system-prompt.md`'s size and mtime. Revival extracts a failed run's
 * transcript only when this moved, and the memoized evidence verdict re-proves
 * the same way. The prompt file is part of the verdict — it decides the
 * `<result>` contract the answer is judged against — so a rewrite of it must
 * move the fingerprint too; its absence is a stamp value, not an error, a
 * missing prompt degrades the verdict to the weaker rule, and that
 * (non)existence is part of what the verdict rests on.
 */
function evidenceStamp(runDirPath: string, runId: string): string | undefined {
  try {
    // Shared rule with findSessionFile: a resumed dir's fingerprint must
    // move when the transcript the run is READ from moves — the oldest
    // (frozen) transcript would pin revival off forever.
    const name = pickSessionName(readdirSync(runDirPath), runId);
    if (!name) return undefined;
    const stat = statSync(join(runDirPath, name));
    let promptStamp: string;
    try {
      const prompt = statSync(systemPromptPath(runDirPath));
      promptStamp = `${prompt.size}:${prompt.mtimeMs}`;
    } catch {
      promptStamp = "absent";
    }
    return `${stat.size}:${stat.mtimeMs}\u0000${promptStamp}`;
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
  isLaunching: (runId) => launchingRunIds.has(runId),
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
   * The kanban card id this delegation does, when the caller passed one.
   * The child is told it (env + system-prompt block) and its todo list is the
   * card; the board reads that list live from the child's session file.
   */
  card?: string;
  /**
   * Who is asking: a model's tool delegation, or the extension's own health
   * check of `targetRunId`. Internal — it is not part of the public `subagent`
   * schema, and only the system origin relaxes `callable_by`.
   */
  origin: SpawnOrigin;
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
  /**
   * Readies the pane's shell before `startAgent` types `pi` into it. Optional:
   * stubs omit it. The real one makes a compiled pi (Pi-Bolt) launch *itself*
   * as the child (see {@link prepareChildShell}).
   */
  preparePane?: (paneId: string) => Promise<void>;
}

/**
 * Under a compiled pi (Pi-Bolt), `herdr agent start --kind pi` would type a
 * bare `pi` that the pane's rc files resolve to the node install, so the child
 * would silently run a different pi. Put a `pi` symlink to this executable
 * first on the pane shell's PATH. Exported in the shell rather than passed as
 * `--env PATH=`, which `~/.bashrc` re-prepends over. A no-op otherwise.
 */
async function prepareChildShell(paneId: string): Promise<void> {
  if (!runningCompiled()) return;
  const dir = piShimDir();
  const ran = dir ? await runInPane(paneId, prependPathCommand(dir)) : { ok: false, error: "no private shim dir" };
  // Not fatal (the child still starts, as the PATH's pi), but it is the exact
  // silent mis-launch this exists to prevent, so say so.
  if (!ran.ok) console.warn(`subagent-herdr: child may run a non-Pi-Bolt pi (shim: ${ran.error ?? "herdr refused"})`);
}

const realLauncher: Launcher = { createChildPane, renamePane, startAgent, closePane, preparePane: prepareChildShell };

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
    rec.card,
    childAncestry(process.env),
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
  await launcher.preparePane?.(pane.paneId);

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
    card: rec.card,
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
  // This process's ancestry, written by whoever spawned us. Drives both the
  // cycle check and `callable_by`, and is the one input here a model cannot
  // influence.
  const lineage = parseLineage(process.env[LINEAGE_ENV]);
  // Resolve against the global roster PLUS every skill's agents. Unlike the
  // prompt inventory this does not gate on the loaded set: spawning happens with
  // no session context, and a skill loaded mid-session would otherwise be
  // invisible here and fail a delegation the agent was just told to make.
  const roster = await delegationRoster({ agentsDir: agentsDir(), skillsDir: skillsDir(), lineage });

  // Refuse before spending anything: no run dir, no registry entry, no pane.
  const admission = admitSpawn(
    {
      agent: params.agent,
      task: params.task,
      cwd: params.cwd ?? baseCwd,
      model: params.model,
      origin: params.origin,
    },
    roster.all,
    lineage,
  );
  if (!admission.ok) return { ok: false, error: admission.error };
  const { agent, chain } = admission;

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
    task: admission.task,
    cwd: admission.cwd,
    // The parsed head ref, for diagnostics only: the child runs on the router,
    // and which physical model answers is up to it.
    model: parseChainItem(chain[0]!)!.ref,
    status: "running",
    startedAt: Date.now(),
    // The chain handed to the router, recorded so a reader of a finished run
    // can see what the child could hop between.
    fallbackChain: [...chain],
    ...(admission.healthCheckOf ? { healthCheckOf: admission.healthCheckOf } : {}),
    // The spawning parent's pane, stamped before the record is registered:
    // only this pane's process may autonomously sweep the run (see
    // isOwnedBy). Absent when the process has no pane of its own.
    ...(process.env.HERDR_PANE_ID ? { ownerPane: process.env.HERDR_PANE_ID } : {}),
    // The card this run does, when the parent passed one (see SpawnParams).
    ...(params.card !== undefined ? { card: params.card } : {}),
  };
  const dir = dirFor(runId);
  mkdirSync(dir, { recursive: true });
  // Register in-memory now, not only on disk: subagent_tasks resolves ids
  // from this map, and a fresh spawn must be statusable — and cancellable —
  // within the same process before its pane exists (the disk registry is what
  // a *restarted* parent rebuilds). The launch marker goes in first and comes
  // out only once the launch has settled, so no sweep in between reads the
  // pane-less record as evidence.
  launchingRunIds.add(rec.runId);
  runs.set(rec.runId, rec);
  try {
    return await launchRegisteredRun(agent, rec, dir, admission.task, chain);
  } finally {
    launchingRunIds.delete(rec.runId);
  }
}

/**
 * The launch half of {@link spawnRun}, for a record already registered and
 * marked as launching: system prompt, pane, pi, task prompt.
 *
 * A terminal transition during the launch wins. The only one possible is a
 * `subagent_tasks` cancel (sweeps and reads leave an in-flight launch alone),
 * and it finds no pane to close — so after every await this checks the record
 * again, and a superseded launch closes whatever pane it got, records nothing,
 * and reports an error. Never `launchFailed` (which rejects a non-running
 * record), never a stale `saveMeta` over the cancellation, never `ok`.
 */
async function launchRegisteredRun(
  agent: AgentInfo,
  rec: RunRecord,
  dir: string,
  task: string,
  chain: readonly string[],
): Promise<SpawnOutcome> {
  // A closure, not an inline comparison: TypeScript keeps `rec.status`
  // narrowed across awaits, and the cancel that changes it happens elsewhere.
  const superseded = (): boolean => rec.status !== "running";
  const abandon = async (paneId: string | undefined): Promise<SpawnOutcome> => {
    // The run is already terminal and durable; this pane belongs to no one.
    if (paneId) await closePane(paneId);
    return {
      ok: false,
      error: `Run ${rec.runId} was ${rec.status} while it was launching${
        paneId ? `; its pane ${paneId} was closed` : ""
      }.`,
    };
  };

  // The child's system prompt. Its body is the agent definition verbatim, plus
  // a skills catalogue when the agent declared one: pi builds `## Available
  // Skills` for the orchestrator only, so a subagent cannot otherwise know a
  // skill exists. A card run additionally gets the `## Assigned Kanban Card`
  // block: the child sees no board, so the card and its rules cross in the
  // prompt. Discovery failing costs the catalogue, never the launch.
  const promptPath = systemPromptPath(dir);
  let promptBody = agent.promptBody;
  if (agent.skills && agent.skills.length > 0) {
    // pi's own resolved list covers packages and project scope and has the
    // human's resource filters already applied; scanning `agent/skills/` is the
    // fallback for the case where no turn has started yet. Under a profile
    // switch the process's catalogue is the *home* profile's, not the
    // target's, so the switch always scans the (retargeted) skills dir
    // instead of reusing it.
    const available = personaOverride()
      ? await discoverSkills(skillsDir())
      : (piSkillCatalogue ?? (await discoverSkills(skillsDir())));
    const selected = selectSkills(agent.skills, available);
    const canRead = !agent.tools || agent.tools.length === 0 ||
      agent.tools.some((t) => READING_TOOLS.has(t));
    promptBody = appendSkillCatalogue(promptBody, selected, canRead);
  }
  // The card id came off disk (a revival re-renders the prompt): the spawn
  // site validated it, this reader guards too — a malformed id would write a
  // prompt promising a card the child's env never carries (inert gate).
  const cardId = typeof rec.card === "string" && CARD_ID_PATTERN.test(rec.card) ? rec.card : undefined;
  if (cardId) promptBody = appendCardBrief(promptBody, cardId);
  if (superseded()) return abandon(undefined);
  try {
    writeFileSync(promptPath, promptBody);
  } catch {
    // A launch failure like any other, recorded through the lifecycle: left
    // `running` with no pane, the next sweep would fail it as `no-pane` and
    // health-check a run that never started. Synchronous since the check above.
    const error = `Could not write the child's system prompt to ${promptPath}.`;
    lifecycle.launchFailed(rec, { model: FALLBACK_MODEL_REF, error });
    return { ok: false, error };
  }

  // One attempt: open the pane, get pi interactive on the router, and get the
  // task accepted. The prompt half is a guard against a lost keypress, not a
  // model check: with a non-empty chain the router registers and pi starts,
  // so an unservable chain fails at the first request, after the prompt is in.
  const attempt = await launchAttempt(agent, rec, dir, promptPath, realLauncher, chain);
  // Cancelled mid-launch: the cancel closed nothing, so a pane opened since —
  // even a failed attempt's, normally kept as evidence — is closed here.
  if (superseded()) return abandon(attempt.paneId);
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
  if (superseded()) return abandon(attempt.paneId);
  const prompted = await promptAgent(attempt.paneId!, task);
  let turnStarted = prompted.ok;
  if (!turnStarted) {
    // herdr typed the text but the turn never started — the submitting Enter
    // was lost to the TUI, with the task text sitting in the editor. Re-send
    // the Enter and observe, bounded: a single recovery Enter can itself be
    // lost or consumed by a transient TUI state (measured: 5 runs stalled
    // exactly this way), so retry up to PROMPT_RECOVERY_ATTEMPTS times. Success
    // exits immediately; a launch that cannot start still fails below with the
    // pane kept as evidence.
    // The observation watches `working` only (herdr's stall criterion also
    // accepts `blocked`); a turn that reaches `blocked` without ever reporting
    // `working` fails the launch — a pre-existing edge of `waitAgentWorking`,
    // not of this loop.
    for (let i = 0; i < PROMPT_RECOVERY_ATTEMPTS && !turnStarted; i++) {
      await sendKeys(attempt.paneId!, "enter");
      if (superseded()) return abandon(attempt.paneId);
      turnStarted = await waitAgentWorking(attempt.paneId!, PROMPT_RECOVERY_WAIT_MS);
      if (superseded()) return abandon(attempt.paneId);
    }
  }
  if (superseded()) return abandon(attempt.paneId);
  if (!turnStarted) {
    const error = `task prompt not accepted in pane ${attempt.paneId} (herdr said: ${prompted.error ?? "unknown"})`;
    // The pane is kept, so link the record to it like the launch-failure path.
    lifecycle.launchFailed(rec, { model: FALLBACK_MODEL_REF, error }, { paneId: attempt.paneId!, tabId: attempt.tabId });
    return { ok: false, error };
  }

  // Synchronous from the check above to the return: nothing can cancel the
  // run between the status guard and publishing its pane.
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
      origin: { kind: "system-health-check", targetRunId: target.runId },
    },
    target.cwd,
  );
}

/**
 * How a pane observation reads in `status`/`result` output: the herdr state for
 * a live pane, a named reachability failure for an unreachable herdr,
 * `launching` for a spawn still attaching its pane, and null for a gone (or
 * never-probed) pane. Unreachable is never shown as gone — absence was not
 * proven.
 */
function paneStateLabel(pane: PaneObservation): string | null {
  if (pane.kind === "state") return pane.status;
  if (pane.kind === "unreachable") return `unreachable (${pane.error ?? "unknown"})`;
  if (pane.kind === "launching") return "launching";
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
// Briefings (the text a notice becomes)
// ---------------------------------------------------------------------------

/**
 * Pushes one completed run's block (header, optional inference note, salvage
 * note, todos line, answer text, diagnostics, reports)
 * onto the caller's output array. The caller must have already brought the
 * record up to date (`lifecycle.read`, or a sweep) — except the display-only
 * foreign-record path, which passes its inference note: the status is inferred
 * from on-disk evidence, not settled by this pane.
 */
async function renderResultBlock(
  rec: RunRecord,
  out: string[],
  /** Pre-fetched result, when the caller already ran the no-answer gate. */
  result?: RunResult,
  /** Display-only note under the header (the foreign-record inference label). */
  note?: string,
): Promise<void> {
  out.push(formatResultHeader(rec));
  if (note) out.push(note);
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
  // The child's checklist rides the briefing itself: what the run settled
  // is orchestrator-relevant even when its prose is one line. Counts come
  // from extractRunResult's single pass (the shared parseTodoState rule),
  // so this costs no extra read.
  const td = resolved.todos;
  if (td && td.total > 0) {
    const bits = [`${td.done}/${td.total} done`];
    if (td.inProgress) bits.push(`${td.inProgress} in progress`);
    if (td.blocked) bits.push(`${td.blocked} blocked`);
    if (td.pending) bits.push(`${td.pending} pending`);
    out.push(`todos: ${bits.join(", ")}`);
  }
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

/**
/**
 * Patience for the wake path's parent probe. `probeAgent` shares the
 * module-wide 30 s herdr timeout, but this probe runs on the serialized
 * wake path — one probe per marker-carrying notice whose parent is not
 * proven finished, each bounded at `WAKE_PROBE_TIMEOUT_MS` (5 s) — so a
 * hung herdr would stall every briefing behind it. 5 s is far longer than
 * a healthy local round-trip (measured sub-millisecond) and far shorter
 * than the stall it bounds; a timeout kills the CLI with no reply document,
 * so `probeFromCall` answers `unreachable` (herdr.ts behaviour 10) — "not
 * gone", the conservative direction: the note is stripped, never a pane
 * proven gone.
 */
export const WAKE_PROBE_TIMEOUT_MS = 5_000;

/**
 * How long a cached POSITIVE inference from the running-parent proof
 * stands. A foreign `running` parent no process ever ticks (the documented
 * nested-owner case) would otherwise re-probe on every flush. The memo is
 * reached only after the terminal-status return, so every cached value is a
 * `true`: a `true` proven by the `.exit` sidecar is a completion record and
 * stands without the expiry (terminal is terminal); a `true` inferred from
 * the transcript tail is an inference, not a record, and it expires here —
 * a hit past the TTL re-proves. `false` answers are never cached: a
 * negative is a liveness inference that goes stale the moment the parent
 * exits, and serving it silently deletes a reroute note, so a notice from a
 * live parent pays one probe — `probeAgent` at `WAKE_PROBE_TIMEOUT_MS` (5 s
 * cap) — and that runs only for notices that carry a reroute marker, which
 * is rare. One liveness tick: the wake path's own clocks are the 1.2 s
 * coalesce window and this 60 s tick, so a stale entry dies within a tick
 * of whatever re-proves it.
 */
export const PARENT_PROOF_TTL_MS = LIVENESS_BACKSTOP_MS;

export default function (pi: ExtensionAPI): void {
  // This process's herdr pane, captured once at factory time: ownership is
  // stamped at spawn and compared at sweep time, and the env is the one fact
  // a restarted process can trust to identify itself. `undefined` (no herdr
  // pane) owns nothing — autonomous sweeps are a no-op, queries are not.
  const ownerPane = process.env.HERDR_PANE_ID;
  // The label the delivery walker stamps on a notice it delivers to THIS
  // process — `orchestrator` for the root, `agent runId` for a nested child.
  // The ledger compares it against a reroute marker's `deliveredTo` before
  // the note prints the marker as measured provenance; a process with no pane
  // has no label, and receives no herdr prompt in the first place.
  const selfLabel = process.env.HERDR_PANE_ID
    ? ancestorLabel({
        pane: process.env.HERDR_PANE_ID,
        runId: process.env.PI_SUBAGENT_RUN_ID ?? "",
        agent: process.env.PI_SUBAGENT_AGENT ?? "",
      })
    : undefined;

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
      "Pass `card` on every delegation that answers to a board card (the `k`-id from `/kanban`), then `link` the returned run id to that card — the child sees the card, builds its todo list from it, and the board shows that list live.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Name of the agent to delegate to (see Available Agents)" }),
      task: Type.String({
        description:
          "The task, self-contained: the child has no access to this conversation. Include every path, constraint, and definition it needs.",
      }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the child (default: the orchestrator's cwd)" })),
      model: Type.Optional(Type.String({ description: "Model override for the child: `provider/id` or `provider/id|level` (level: off|minimal|low|medium|high|xhigh|max; a pi-style `ref:level` is translated when the ref is plain). `fallback/auto` is not accepted — the router cannot route to itself. Default: the agent's declared model." })),
      card: Type.Optional(Type.String({ description: "Kanban card id (`k3`) this delegation does. Advisory: the shape is validated only — a card the board lacks yields a run the board cannot match — and `card` does NOT link the run to the card; the delegator must also `kanban op link` it. The child is told the id and must build its todo list from the card before any work; the board shows that list live. Refused if not a well-formed card id." })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Only the public schema's fields cross: `origin` is internal and a system
      // origin relaxes the `callable_by` guard, so a model must not be able to
      // smuggle one in as an extra property. Never spread `params`.
      const { agent, task, cwd, model, card } = params;
      if (card !== undefined && !CARD_ID_PATTERN.test(card)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: card "${card}" is not a kanban card id: the shape is k + a positive integer, no leading zero (k3). Pass the card's id from the board, or omit card.`,
            },
          ],
          details: { ok: false },
        };
      }
      const out = await spawnRun(
        { agent, task, cwd, model, card, origin: { kind: "tool-delegation" } },
        ctx.cwd,
      );
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
              `Delegated to ${rec.agent}: task ${rec.runId}${rec.card ? ` card ${rec.card}` : ""} is running in tab ${rec.tabId} (pane ${rec.paneId}) of this workspace. ` +
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
  // ---------------------------------------------------------------------------

  // Cross-flush memo for the running-parent proof, keyed on the id alone:
  // the memo is reached only on the `running` branch (a terminal answer
  // skips it entirely — the status check precedes it), so a status in the
  // key would be a constant. It caches ONLY `finished: true` proofs: a
  // `false` is a liveness inference that goes stale the moment the parent
  // exits, and serving it silently deletes a reroute note — a pair's done
  // lands inside the 1.2 s coalesce window, so a parent that finishes
  // between the pair's report and its done would lose the note for the
  // whole TTL — while a positive is terminal. The entry records the proof's
  // source, because that decides the expiry: a sidecar-proven `true` is a
  // completion record and stands; an answer-inferred `true` expires with
  // `PARENT_PROOF_TTL_MS`. The map is never pruned, so a sidecar-proven
  // entry lives for the process lifetime — fine: it is bounded by the
  // distinct run ids ever proven (hundreds, not a growth path), and keying
  // on `runId` alone already shrank it versus the old `${id}:${status}` key.
  const parentProofMemo = new Map<
    string,
    { at: number; from: "sidecar" | "answer" }
  >();
  // The policy — coalescing, dedup, health-check pairing, ownership, the
  // liveness tick — is the ledger's (release-ledger.ts). The factory keeps
  // only what the ledger must not touch: the timers, the clock, and pi.
  const ledger = createReleaseLedger({
    records: () => [...runs.values()],
    lifecycle,
    ownerPane,
    selfLabel,
    // Parent-side half of the reroute marker's provenance: the claimed parent
    // must resolve to a real *terminal* run — `done`, `failed` and `cancelled`
    // all count; the parent has stopped, which is all the note claims. The
    // registry copy is trusted only when it is this pane's own and already
    // terminal: `loadRegistry` runs once at module load and never refreshes a
    // record this pane does not sweep, so after a restart a foreign `running`
    // copy — and an owned one the same one-shot load left behind — sits stale
    // in exactly the `running` → terminal direction, and a stale `running`
    // strips every genuine reroute from a finished parent's child. Anything
    // else falls through to the disk read (this pane's own dir and the
    // in-session switch target) — read *without registering*: the id comes
    // from a model-authored marker, not a notice addressed to this pane, so
    // the parent must not enter `runs` (where `subagent_tasks list` would
    // surface it) or become addressable by `cancel`/`interrupt`; registration
    // is what the notices this pane was addressed to get. A record that
    // resolves but is still `running` is answered from the pane first — a
    // probe is a pure read, so it touches none of the ownership rules — and
    // any state that is not `gone` answers `false`: a live pane (any state,
    // including `done`, which is readiness) is the parent's own process still
    // running, and `unreachable` says nothing about the child, mirroring
    // `readNow`. Only a `gone` pane (or a paneless record) leaves the
    // completion evidence the one completion predicate (`completionSignal`,
    // the rule the lifecycle's `completed()` applies) consumes — the `.exit`
    // sidecar, or a clean transcript answer read as a bounded tail — as the
    // answer, read *without settling* in either case: a foreign parent the
    // receiver never writes or closes (the scrollback is the failure
    // evidence), and an owned one whose own notice settles it through the
    // ordinary path, not this proof. A `running` record whose pane is alive,
    // or whose evidence is absent, is answered `false` — conservative, and
    // exactly what an unreachable herdr already means. The pane probe runs
    // at `WAKE_PROBE_TIMEOUT_MS`, not the module-wide 30 s, because it sits
    // on the serialized wake path: a hung herdr would stall every briefing
    // behind it, and a timeout answers `unreachable` — the same
    // conservative `false` (herdr.ts behaviour 10). The running-parent
    // proof (probe + evidence) is memoized cross-flush in `parentProofMemo`
    // under the id, positives only: a sidecar-proven `true` stands (terminal
    // is terminal), an answer-inferred `true` never outlives
    // `PARENT_PROOF_TTL_MS`, and a `false` is computed, returned and not
    // stored — a liveness inference that goes stale the moment the parent
    // exits, and serving it would silently delete a reroute note (a pair's
    // done lands inside the 1.2 s coalesce window).
    // The lookup is total — an evidence read that throws answers `false`
    // from the record in hand (its observed status) — so the flush can
    // never reject on it. Ownership is deliberately not part
    // of the *test* (a foreign parent is valid lineage; in the canonical
    // single-hop case the receiver IS the parent's owner, and the live-parent
    // forge is the `direct` check's job, not this one's) — it is part of the
    // cache *trust* only. I/O lives here, keeping the ledger free of
    // filesystem reads. The answer carries the status it was read from
    // (the record's, or `"absent"` when nothing resolves) for the caller's
    // log line. The memo below is keyed on the run id ALONE — a status in the
    // key would be a constant, since the terminal early return runs before the
    // lookup, so the memo is reached only on the `running` branch. That order
    // is what keeps a status out of the key (a status component would be the
    // constant `running`).
    // The memo caches positives only, so a re-probe of a running parent is
    // suppressed for at most `PARENT_PROOF_TTL_MS` while a proven `true`
    // stands: a `false` is never stored, so a parent that finishes between
    // a pair's two notices (one 1.2 s coalesce window) is re-proven for the
    // second, and the note is not served away — `wake.test.ts` pins exactly
    // that (both notices keep the note; a live parent pays one probe per
    // notice). What the ledger guarantees is narrower: it memoizes nothing,
    // so each notice pays its own call.
    parentRunIsFinished: async (runId) => {
      let status: RunRecord["status"] | "absent" = "absent";
      try {
        const cached = runs.get(runId);
        const found =
          cached !== undefined && cached.status !== "running" && isOwnedBy(cached, ownerPane)
            ? { rec: cached, dir: dirFor(runId) }
            : findRunRecordInAnyBase(runId);
        if (found === undefined) return { finished: false, status };
        const { rec, dir } = found;
        status = rec.status;
        if (rec.status !== "running") return { finished: true, status };
        const at = Date.now();
        const hit = parentProofMemo.get(runId);
        if (
          hit !== undefined &&
          (hit.from === "sidecar" || at - hit.at < PARENT_PROOF_TTL_MS)
        ) {
          return { finished: true, status };
        }
        const proof = await (async (): Promise<
          | { finished: true; from: "sidecar" | "answer" }
          | { finished: false }
        > => {
          if (rec.paneId !== undefined) {
            const pane = await probeAgent(rec.paneId, WAKE_PROBE_TIMEOUT_MS);
            if (pane.kind !== "gone") return { finished: false };
          }
          const evidence = await completionEvidence(dir, runId);
          return evidence.finished
            ? { finished: true, from: evidence.from }
            : { finished: false };
        })();
        // Positives only: a `false` is a liveness inference that goes stale
        // the moment the parent exits, and serving it silently deletes a
        // reroute note (a pair's done lands inside the 1.2 s coalesce
        // window), so it is computed, returned and not stored.
        if (proof.finished) parentProofMemo.set(runId, { at, from: proof.from });
        return { finished: proof.finished, status };
      } catch {
        // Last resort, not a failure path: `findRunRecordInAnyBase`,
        // `probeAgent`, `hasExitSidecar` and `extractRunResult` each
        // swallow their own failures (a missing record, an unreachable
        // herdr, an unreadable sidecar, an unreadable transcript are all
        // answers, not throws), so a throw reaching here means a real bug.
        // The flush contract still gets its conservative `false`.
        return { finished: false, status };
      }
    },
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
          // A child's todo list may have moved since the board last read it
          // (the flush coalesces on a deadline, and the tick enqueues its own
          // notices): ask the kanban board to re-read the runs. No-op when no
          // board is listening.
          pi.events?.emit(RUN_TODOS_EVENT, undefined);
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
  const runLivenessTick = async (): Promise<void> => {
    armFlush(await ledger.tick(Date.now()));
    // The tick is the board's other heartbeat: even with no notices queued, a
    // child's todo list may have moved, so ask the kanban board to re-read the
    // runs. No-op when no board is listening.
    pi.events?.emit(RUN_TODOS_EVENT, undefined);
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
    // Every parsed notice names a run this process may have lost — always the
    // case for a re-routed one, often for a direct one after a parent restart:
    // adopt it from the run dir (transcript and all) before it is enqueued, so
    // the briefing renders the real block instead of the unregistered-run text.
    if (RUN_ID_PATTERN.test(notice.runId)) adoptRunFromDisk(notice.runId);
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

  // A run lost to a parent restart may still exist on disk (run dir and
  // transcript); the ids here came from a notice, so they are worth a read.
  for (const id of ids) if (RUN_ID_PATTERN.test(id)) adoptRunFromDisk(id);
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
        if (!owned && rec.status === "running") {
          // A foreign (or legacy) record is never settled by this pane —
          // settling is a write, and the write is the owner's — so
          // `running` is its on-disk state, not a live probe. The run may
          // have finished since its owner stopped settling it (a record
          // adopted from disk by a grandchild's rerouted notice is exactly
          // that), so answer from the completion evidence already on disk:
          // display-only, no transition, no meta write, no pane close; the
          // `result` arm below nests the same evidence test.
          const evidence = await completionEvidence(dirFor(rec.runId), rec.runId);
          if (evidence.finished) {
            lines.push(
              `${rec.runId} (${rec.agent}): done (${
                evidence.from === "sidecar"
                  ? "the .exit sidecar is on disk"
                  : "final answer in transcript"
              }, not settled by this pane)`,
            );
            details[rec.runId] = {
              status: "done",
              herdr: null,
              owned: false,
              inferredFrom: evidence.from,
            };
            continue;
          }
        }
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
          const why =
            rec.status !== "running"
              ? `not running (${rec.status})`
              : launchingRunIds.has(rec.runId)
                ? "still launching"
                : "no pane recorded";
          lines.push(`${rec.runId} (${rec.agent}): ${why} — message not delivered`);
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
          if (!owned) {
            // A foreign (or legacy) record is never settled by this pane —
            // settling is a write (the transition, the meta save, the pane
            // close), and the write is the owner's — so `running` is its
            // on-disk state. The run may have finished since its owner
            // stopped settling it (a record adopted from disk by a
            // grandchild's rerouted notice is exactly that), so answer from
            // the completion evidence already on disk, display-only: the
            // record is not touched, so the owning pane's process stays the
            // one to settle it. The label says the status is inferred.
            const evidence = await completionEvidence(dirFor(rec.runId), rec.runId);
            if (evidence.finished) {
              const note =
                evidence.from === "sidecar"
                  ? "completed (the .exit sidecar is on disk, not settled by this pane)"
                  : "completed (final answer in transcript, not settled by this pane)";
              await renderResultBlock(rec, out, evidence.result, note);
              details[rec.runId] = { status: "done", owned: false, inferredFrom: evidence.from };
              continue;
            }
          }
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
            (r.status !== "running"
              ? `not running (${r.status})`
              : !rec.paneId
                ? launchingRunIds.has(rec.runId)
                  ? "still launching"
                  : "no pane recorded"
                : "unknown");
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
    return `${rec.runId} (${rec.agent}): ${rec.status} [${age}s]${rec.tabId ? ` tab ${rec.tabId}` : ""}${rec.paneId ? ` pane ${rec.paneId}` : ""}${rec.card ? ` card ${rec.card}` : ""}`;
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
        ...(r.card ? { card: r.card } : {}),
      })),
    },
  };
}
