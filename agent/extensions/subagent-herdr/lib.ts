/**
 * Pure helpers for the subagent-herdr extension.
 *
 * Everything here is side-effect free (except the documented fs reads in
 * `readReports` / `extractRunResult`), so the whole launch contract can be
 * unit-tested by calling the functions and reading what comes back. Agent
 * definition parsing lives in `../lib/agents.ts` (the single parser); the
 * herdr CLI calls live in `herdr.ts`; the tool wiring in `index.ts`.
 *
 * @module subagent-herdr/lib
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type ChildReport,
  type FailedAttempt,
  isSessionFileFor,
  parseReportLine,
  reportsPath,
} from "./rundir.js";

export type { ChildReport };

/** The tool a child calls (via `child-done.ts`) to declare itself finished. */
export const DONE_TOOL_NAME = "subagent_done";

/** The tool a child calls (via `child-done.ts`) to message the orchestrator mid-run. */
export const REPORT_TOOL_NAME = "subagent_report";

/**
 * A run id in the `sub-a3f1` shape that the orchestrator prompt advertises.
 * Four hex chars: plenty for a handful of concurrent runs, short enough to
 * read aloud.
 */
export function makeRunId(): string {
  return `sub-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
}

/** Inputs for planning one child launch (see `buildChildArgv`). */
export interface ChildLaunchOptions {
  /** Absolute path to `child-done.ts`, passed to the child with `-e`. */
  childDonePath: string;
  /** The run directory, used as the child's `--session-dir`. */
  runDir: string;
  /** The run id, used as the child's `--session-id`. */
  runId: string;
  /** Model override, e.g. `openai/gpt-5.6-sol`. */
  model?: string;
  /** The agent's declared tools; `undefined`/empty means "all tools". */
  tools?: string[];
  /** Absolute path to the composed system prompt, passed by file not by value. */
  systemPromptPath?: string;
}

/**
 * Env for the child's pane, set with `pane split --env` so herdr injects it
 * into the launched shell and (by inheritance) the pi child.
 *
 * `PI_SUBAGENT_PARENT_PANE` is what makes child → orchestrator messaging
 * possible: it names the orchestrator's own pane (read from the parent
 * process's `HERDR_PANE_ID`), and the child's report tool prompts it. The
 * other vars let the child's extensions identify the run without guessing.
 *
 * `runDir` is passed alongside the record rather than read off it: the path is
 * derived from the run id (see `rundir.ts`), so the record does not carry it,
 * but the child is a separate process and cannot derive it without knowing
 * pi's agent directory — so it crosses as env.
 */
export function buildChildEnv(
  rec: { runId: string; agent: string },
  parentPaneId: string | undefined,
  runDir: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PI_SUBAGENT_RUN_ID: rec.runId,
    PI_SUBAGENT_AGENT: rec.agent,
    PI_SUBAGENT_RUN_DIR: runDir,
  };
  if (parentPaneId) env.PI_SUBAGENT_PARENT_PANE = parentPaneId;
  return env;
}

/**
 * Reads the child's report log ({@link reportsPath}, appended by the child's
 * report tool). Empty array when the child never reported — the common case,
 * which must stay cheap.
 *
 * The line format belongs to `rundir.ts`, which the child's writer shares: a
 * reader that re-derived the shape here is how the two halves would drift.
 */
export async function readReports(runDir: string): Promise<ChildReport[]> {
  let content: string;
  try {
    content = await readFile(reportsPath(runDir), "utf-8");
  } catch {
    return [];
  }
  const out: ChildReport[] = [];
  for (const line of content.split("\n")) {
    const report = parseReportLine(line);
    if (report) out.push(report);
  }
  return out;
}

/**
 * Builds the `pi` argv a herdr `agent start` hands to the child (everything
 * after its `--`).
 *
 * Deliberately no positional prompt: the task is delivered with
 * `herdr agent prompt` after the TUI is up, which keeps this argv independent
 * of the task's quoting hazards and means a child that never receives a prompt
 * is an empty TUI a human can read, not a half-quoted launch.
 *
 * `subagent_done` and `subagent_report` are always appended to the tool
 * allowlist: a child that cannot report completion cannot finish, and a
 * child that cannot message the orchestrator is a subagent that can only
 * shout from a pane nobody is watching.
 */
export function buildChildArgv(opts: ChildLaunchOptions): string[] {
  const argv: string[] = [
    "-e",
    opts.childDonePath,
    "--session-dir",
    opts.runDir,
    "--session-id",
    opts.runId,
  ];
  if (opts.model) argv.push("--model", opts.model);
  if (opts.tools && opts.tools.length > 0) {
    const tools = [...new Set([...opts.tools, DONE_TOOL_NAME, REPORT_TOOL_NAME])];
    argv.push("--tools", tools.join(","));
  }
  if (opts.systemPromptPath) argv.push("--append-system-prompt", opts.systemPromptPath);
  return argv;
}

/**
 * What the parent can recover from a finished (or dead) run's session file.
 */
export interface RunResult {
  /** A `*_<runId>.jsonl` session file exists in the run directory. */
  found: boolean;
  /** The last assistant message carries text. */
  answered: boolean;
  /** The last assistant message's text (the answer). */
  text: string;
  /** Stop reason of that last assistant message, when the session records one. */
  stopReason?: string;
  /** The session file the answer came from, when found. */
  sessionFile?: string;
}

/**
 * Reads the child's transcript and returns its last assistant message.
 *
 * The session file is `*_<runId>.jsonl` inside `runDir` (pi mints the
 * timestamp prefix itself), so ownership by runId is unambiguous and a
 * resumed session cannot be mistaken for a different run.
 */
export async function extractRunResult(runDir: string, runId: string): Promise<RunResult> {
  let entries: string[];
  try {
    const file = await findSessionFile(runDir, runId);
    if (!file) return { found: false, answered: false, text: "" };
    const content = await readFile(file, "utf-8");
    entries = content.split("\n");
  } catch {
    return { found: false, answered: false, text: "" };
  }

  interface Entry {
    type?: string;
    message?: { role?: string; content?: unknown; stopReason?: string };
  }
  const parsed: Entry[] = [];
  for (const line of entries) {
    if (!line.trim()) continue;
    try {
      const e: unknown = JSON.parse(line);
      if (typeof e === "object" && e !== null) parsed.push(e as Entry);
    } catch {
      // partial final line: the run is probably still writing — skip it
    }
  }

  /**
   * The answer is the last assistant text at or before the `subagent_done`
   * call — not the transcript's final assistant message. After the tool result
   * the model frequently emits one short closing remark ("Done."), which would
   * otherwise shadow the real answer. The call rides in the same assistant
   * message as the answer, so that message is included. When the child
   * finished via a clean turn without the tool, there is no tool call and the
   * final assistant text is the answer.
   */
  let doneIdx = parsed.length - 1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const m = parsed[i].message;
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      const called = (m.content as Array<{ type?: string; name?: string }>).some(
        (c) => c?.type === "toolCall" && c?.name === DONE_TOOL_NAME,
      );
      if (called) {
        doneIdx = i;
        break;
      }
    }
  }

  for (let i = doneIdx; i >= 0; i--) {
    const m = parsed[i].message;
    if (m?.role !== "assistant") continue;
    const text = (Array.isArray(m.content) ? m.content : [])
      .filter((c): c is { type: string; text: string } => !!c && c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (text) {
      const sessionFile = await findSessionFile(runDir, runId);
      return { found: true, answered: true, text, stopReason: m.stopReason, sessionFile };
    }
  }

  const sessionFile = await findSessionFile(runDir, runId);
  return { found: true, answered: false, text: "", sessionFile };
}
async function findSessionFile(runDir: string, runId: string): Promise<string | undefined> {
  let dirEntries: string[];
  try {
    dirEntries = await readdir(runDir);
  } catch {
    return undefined;
  }
  const file = dirEntries.find((e) => isSessionFileFor(e, runId));
  return file ? join(runDir, file) : undefined;
}

/**
 * Every model to try for one run, in order: the requested (or declared) model
 * first, then the agent file's `fallback_models`.
 *
 * An explicit `model` on the delegation call suppresses the fallbacks: the
 * caller named a model, and silently running a different one would be a
 * surprise rather than a recovery. Duplicates are dropped so a fallback that
 * repeats the primary does not buy a second identical attempt.
 *
 * @param requested - The model named on the delegation call, if any.
 * @param agent - The agent definition, for its model and fallbacks.
 * @returns At least one entry; `[undefined]` means "pi's default model".
 */
export function candidateModels(
  requested: string | undefined,
  agent: { model?: string; fallbackModels?: string[] },
): (string | undefined)[] {
  if (requested) return [requested];
  const out: (string | undefined)[] = [agent.model];
  for (const m of agent.fallbackModels ?? []) {
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

/**
 * The error text for a spawn where every candidate model failed to launch.
 *
 * Names each model tried, because "did not become interactive" on its own sends
 * a reader to the pane when the cause may simply be that no declared model is
 * reachable.
 */
export function describeLaunchFailure(failures: readonly FailedAttempt[]): string {
  const first = failures[0];
  if (failures.length <= 1) {
    return first?.error ?? "The child could not be launched.";
  }
  const tried = failures
    .map((f) => `  - ${f.model ?? "(default model)"}: ${f.error}`)
    .join("\n");
  return `All ${failures.length} candidate models failed to launch:\n${tried}`;
}

/**
 * herdr's rule for an agent name, verified against herdr 0.9.0 by asking it.
 *
 * `agent start` rejects a name outside this shape with `invalid_agent_name`,
 * which the spawn path used to surface as "did not become interactive" on every
 * candidate model — a failure that looks like a broken model and is not.
 *
 * The 32-character ceiling is why {@link herdrAgentName} appends `-sub-xxxx`
 * (9 chars) to the *agent* name rather than embedding anything longer: the
 * longest definition name here is `librarian` (18 with the suffix), so the
 * budget is not tight, but a future long name must stay inside this rule.
 */
const HERDR_AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * The name to register one child under with `herdr agent start`.
 *
 * **herdr agent names are globally unique across the whole server**: `agent
 * start` answers `agent_name_taken` when a name is already held by a live
 * pane. Registering a child under its bare definition name therefore let the
 * *first* live `librarian` own the name and made every concurrent or
 * overlapping `librarian` unlaunchable — the failure is instant (measured 4-11 ms), so
 * all candidate models were burned in under 100 ms and the run reported
 * "did not become interactive" on every one of them, which reads as a dead
 * fleet and is really a name collision.
 *
 * Scoping by run id makes the name unique by construction, which is the same
 * reason pane and tab ids are never predicted: identity comes from the thing
 * that is actually unique, not from a label that happens to be free.
 *
 * @param agentName - The agent definition's `name` (e.g. `librarian`).
 * @param runId - The run id (e.g. `sub-9622`). {@link makeRunId} draws from
 *        ~65k values without a registry check, so uniqueness is overwhelmingly
 *        likely rather than guaranteed; a collision now surfaces as a clear
 *        fatal `agent_name_taken` instead of the fake fleet outage above.
 */
export function herdrAgentName(agentName: string, runId: string): string {
  return `${agentName}-${runId}`;
}

/**
 * Why herdr would refuse the name this child will actually be registered
 * under, or `undefined` if it is usable.
 *
 * This is the pre-spawn check, and it deliberately validates the **scoped**
 * name: scoping costs 9 characters, so a definition name can be legal on its
 * own (24 chars) and illegal once scoped (33). Checking the bare name let that
 * through to fail after a pane had already been opened and closed.
 *
 * The late path still classifies `invalid_agent_name` as fatal, so this check
 * is defence in depth — it converts a late, pane-wasting failure into an
 * immediate and clearer one.
 *
 * @param agentName - The agent definition's `name`.
 * @param runId - The run id this child will use.
 */
export function childNameRejection(agentName: string, runId: string): string | undefined {
  return agentNameRejection(herdrAgentName(agentName, runId));
}

/**
 * Why herdr would refuse this agent name, or `undefined` if it is usable.
 *
 * @param name - The name to check. The spawn path must pass the **scoped** name
 *        (what herdr actually receives), so call {@link childNameRejection}
 *        rather than handing this a bare definition name — a name that is legal
 *        alone but illegal once scoped would otherwise slip through and fail
 *        late, after a pane had already been opened.
 */
export function agentNameRejection(name: string): string | undefined {
  if (HERDR_AGENT_NAME.test(name)) return undefined;
  return `Agent name "${name}" is not usable by herdr: a name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters). Rename the agent definition file's \`name\` field.`;
}
