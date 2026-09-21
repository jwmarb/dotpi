/**
 * Pure helpers for the subagent-herdr extension.
 *
 * Everything here is side-effect free (except the documented fs reads in
 * `discoverAgents` / `extractRunResult`), so the whole launch contract can be
 * unit-tested by calling the functions and reading what comes back. The herdr
 * CLI calls live in `herdr.ts`; the tool wiring in `index.ts`.
 *
 * @module subagent-herdr/lib
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** The tool a child calls (via `child-done.ts`) to declare itself finished. */
export const DONE_TOOL_NAME = "subagent_done";

/** The tool a child calls (via `child-done.ts`) to message the orchestrator mid-run. */
export const REPORT_TOOL_NAME = "subagent_report";

/**
 * Metadata for a subagent definition parsed from `agent/agents/<name>.md`.
 * Same frontmatter contract as dynamic-prompt.ts's agent discovery.
 */
export interface AgentInfo {
  name: string;
  description: string;
  /** Allowed tools, or undefined if the agent can use all tools. */
  tools?: string[];
  /** Preferred LLM model, or undefined to use the default. */
  model?: string;
  /** The agent's system-prompt body: the markdown after the frontmatter. */
  promptBody: string;
  filePath: string;
}

/**
 * A run id in the `sub-a3f1` shape that the orchestrator prompt advertises.
 * Four hex chars: plenty for a handful of concurrent runs, short enough to
 * read aloud.
 */
export function makeRunId(): string {
  return `sub-${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
}

/**
 * Scans `agentsDir` for `.md` files with parseable frontmatter.
 * @param agentsDir - Absolute path to the agents directory.
 * @returns A sorted (by name) list of agents, or `[]` on any failure.
 */
export async function discoverAgents(agentsDir: string): Promise<AgentInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return [];
  }
  const agents: AgentInfo[] = [];
  for (const file of entries.filter((e) => e.endsWith(".md"))) {
    const content = await readFile(join(agentsDir, file), "utf-8");
    const parsed = parseAgentFile(content, file);
    if (parsed) agents.push(parsed);
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parses one agent definition: YAML-ish frontmatter (name, description,
 * tools, model) plus the markdown body that becomes the child's system
 * prompt. Mirrors dynamic-prompt.ts's frontmatter grammar so the two
 * discoveries never drift.
 *
 * @returns The parsed agent, or `null` when the frontmatter is missing or
 *          has no `name` (such a file is skipped by discovery).
 */
export function parseAgentFile(content: string, fileName: string): AgentInfo | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const raw = match[1];
  const name = extractString(raw, "name");
  if (!name) return null;

  return {
    name,
    description: extractString(raw, "description"),
    tools: extractStringList(raw, "tools"),
    model: extractString(raw, "model") || undefined,
    promptBody: match[2].trim(),
    filePath: fileName,
  };
}

/** Single scalar frontmatter value (`key: value`, first match). */
function extractString(yaml: string, key: string): string {
  const match = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : "";
}

/**
 * List frontmatter value supporting both the inline (`tools: a, b`) and
 * block (`tools:\n  - a`) spellings used in the agent files.
 */
function extractStringList(yaml: string, key: string): string[] {
  const inline = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (inline && !inline[1].startsWith("-")) {
    return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
  }
  const block = yaml.match(new RegExp(`^${key}:\\n((?:\\s+- .+\\n?)+)`, "m"));
  if (block) {
    return block[1].split("\n").map((l) => l.replace(/^\s+-\s*/, "").trim()).filter(Boolean);
  }
  return [];
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
 */
export function buildChildEnv(
  rec: { runId: string; agent: string; runDir: string },
  parentPaneId: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    PI_SUBAGENT_RUN_ID: rec.runId,
    PI_SUBAGENT_AGENT: rec.agent,
    PI_SUBAGENT_RUN_DIR: rec.runDir,
  };
  if (parentPaneId) env.PI_SUBAGENT_PARENT_PANE = parentPaneId;
  return env;
}

/** One message a child sent to the orchestrator via `subagent_report`. */
export interface ChildReport {
  /** When it was written (ms), for ordering. */
  at: number;
  message: string;
}

/**
 * Reads the child's report log (`<runDir>/reports.jsonl`, appended by the
 * child's report tool). Empty array when the child never reported — the
 * common case, which must stay cheap.
 */
export async function readReports(runDir: string): Promise<ChildReport[]> {
  let content: string;
  try {
    content = await readFile(join(runDir, "reports.jsonl"), "utf-8");
  } catch {
    return [];
  }
  const out: ChildReport[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r: unknown = JSON.parse(line);
      if (typeof r === "object" && r !== null && typeof (r as { message?: unknown }).message === "string") {
        const ro = r as { at?: unknown; message: string };
        out.push({ at: typeof ro.at === "number" ? ro.at : 0, message: ro.message });
      }
    } catch {
      // partial line: a report being written as we read — drop it
    }
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
  const file = dirEntries.find((e) => e.endsWith(`_${runId}.jsonl`));
  return file ? join(runDir, file) : undefined;
}
