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
import { basename, dirname, join } from "node:path";

import { frontmatterOf } from "../lib/agents.js";
import { findSkills } from "../lib/skill-tree.js";
// The chain env var's name is owned by the extension that reads it, so the two
// halves of the handoff cannot drift apart (one parser per format).
import { CHAIN_ENV, FALLBACK_MODEL_REF } from "../model-fallback/lib.js";
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
 *
 * `PI_SUBAGENT_LINEAGE` is the delegation-tree bound: the chain of agent names
 * from the human's orchestrator down to and including this child. The parent
 * writes it and only the child reads it, which is what makes
 * {@link lineageRejection} unforgeable — nothing the child's model can say
 * changes its own ancestry.
 *
 * `PI_FALLBACK_CHAIN` is the child's *runtime* fallback chain, read by the
 * `model-fallback` extension (see {@link childFallbackChain}). It crosses as env
 * rather than as an argv flag because the chain belongs to the child's model
 * routing, not to its launch: `--model fallback/auto` names the router, and this
 * tells the router what to route between.
 */
export function buildChildEnv(
  rec: { runId: string; agent: string },
  parentPaneId: string | undefined,
  runDir: string,
  childLineage: string[] = [rec.agent],
  fallbackChain?: readonly string[],
): Record<string, string> {
  const env: Record<string, string> = {
    PI_SUBAGENT_RUN_ID: rec.runId,
    PI_SUBAGENT_AGENT: rec.agent,
    PI_SUBAGENT_RUN_DIR: runDir,
    PI_SUBAGENT_LINEAGE: formatLineage(childLineage),
  };
  if (parentPaneId) env.PI_SUBAGENT_PARENT_PANE = parentPaneId;
  // Only when there is something to hop between: an absent var leaves the
  // child's model selection exactly as it was before this feature.
  if (fallbackChain && fallbackChain.length > 1) {
    env[CHAIN_ENV] = fallbackChain.join(",");
  }
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

/** One skill as the catalogue needs it: what it is, and where to read it. */
export interface SkillEntry {
  /** Skill directory name — the identity `skills:` matches on. */
  dir: string;
  /** `name` from the SKILL.md frontmatter, falling back to the directory. */
  name: string;
  /** `description` from the frontmatter; may be empty. */
  description: string;
  /** Absolute path of the SKILL.md, for the agent to read. */
  path: string;
}

/** `skills: *` — every discovered skill, rather than a named subset. */
export const SKILLS_WILDCARD = "*";

/**
 * Picks the skills one agent may see, in the order the agent declared them.
 *
 * Declaration order is preserved deliberately: an agent that lists its primary
 * skill first should see it first, and alphabetising would bury it. Unknown
 * names are dropped rather than reported — a renamed skill must not break every
 * delegation to an agent that mentions it.
 *
 * @param declared - The agent's `skills` frontmatter, or undefined for none.
 * @param available - Every discovered skill.
 */
export function selectSkills(
  declared: string[] | undefined,
  available: SkillEntry[],
): SkillEntry[] {
  if (!declared || declared.length === 0) return [];
  if (declared.includes(SKILLS_WILDCARD)) return available;

  const byDir = new Map(available.map((s) => [s.dir, s]));
  const out: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const want of declared) {
    const hit = byDir.get(want);
    if (hit && !seen.has(hit.dir)) {
      seen.add(hit.dir);
      out.push(hit);
    }
  }
  return out;
}

/**
 * Appends a skills catalogue to an agent's prompt body.
 *
 * A subagent's system prompt is its prompt body verbatim, so a skill is
 * invisible to it unless named here. The catalogue is a context pointer, not
 * the skill content: it carries each skill's description (the wording that
 * decides whether the agent reaches for it) plus the path to read, which keeps
 * the cost one section instead of inlining whole skills the agent may not use.
 *
 * The framing matches the orchestrator's (`dynamic-prompt.ts`): a declared
 * skill is the expected method, not an optional reference. A child's
 * declaration is already a deliberate act by whoever wrote the agent file —
 * nobody lists a skill hoping it gets ignored — so "read it only if it looks
 * relevant" understated the intent of the key itself.
 *
 * Returns the body unchanged when the agent declared no skills, so an agent
 * without the key is byte-for-byte what it was before this existed.
 *
 * @param promptBody - The agent definition's body.
 * @param skills - The already-selected skills (see {@link selectSkills}).
 * @param canRead - Whether the agent has a tool that can read a file. With no
 * such tool the paths are unusable, so the section says to delegate instead of
 * pointing at files the agent cannot open.
 */
export function appendSkillCatalogue(
  promptBody: string,
  skills: SkillEntry[],
  canRead: boolean,
): string {
  if (skills.length === 0) return promptBody;

  const lines = [
    "",
    "## Available Skills",
    "",
    "These skills were declared for you deliberately: they are distilled procedure for",
    "exactly the kind of work you have been given. **Check this list before you start.**",
    "When one matches the task, follow it rather than improvising — and if you skip a",
    "skill that plausibly applies, say which one and why in your report.",
    "",
  ];

  for (const s of skills) {
    const desc = s.description.trim();
    lines.push(`- **${s.name}** — ${desc || "(no description)"}`);
    lines.push(`  \`${s.path}\``);
  }

  lines.push("");
  lines.push(
    canRead
      ? "Read a skill's file before acting on it: these lines are routing signals, not the " +
          "skill. Several can apply to one task."
      : "You have no file-reading tool, so you cannot open these. Treat them as a map of " +
          "what exists and delegate the work that needs one.",
  );

  return `${promptBody.trimEnd()}\n${lines.join("\n")}\n`;
}

/**
 * Reads every skill's identity out of its `SKILL.md`.
 *
 * Uses the shared frontmatter grammar (`frontmatterOf` + `extractString`) rather
 * than a local regex, because this repo has already been bitten by two readers
 * of the same format drifting apart. A skill with no readable `SKILL.md` is
 * skipped: one broken skill must not cost an agent its whole catalogue.
 *
 * Locating the skills is `../lib/skill-tree.ts`'s job for the same reason: they
 * are nested under category directories, and the one-level scan this used to do
 * silently returned nothing for a skill that had moved. The entry's `dir` stays
 * the skill's own directory name — the identity `skills:` and
 * `skill-activation.ts` both match on — never its category path.
 *
 * This is the **fallback** path — normally a child's catalogue comes from pi's
 * own resolved skill list via {@link skillEntriesFromPi}, which also covers
 * packages and project scope.
 *
 * @param skillsDirPath - Absolute path to the skills library.
 */
export async function discoverSkills(skillsDirPath: string): Promise<SkillEntry[]> {
  const located = await findSkills(skillsDirPath);

  const out: SkillEntry[] = [];
  for (const skill of located) {
    const { dir, path } = skill;
    let text: string;
    try {
      text = await readFile(path, "utf-8");
    } catch {
      continue; // unreadable: skip this skill, keep the rest of the catalogue
    }
    const fm = frontmatterOf(text);
    if (!fm) continue;
    out.push({
      dir,
      name: extractSkillString(fm, "name") || dir,
      description: extractSkillString(fm, "description"),
      path,
    });
  }
  return out;
}

/**
 * Converts pi's own resolved skill list into catalogue entries.
 *
 * pi resolves skills from every source — `agent/skills/`, each installed
 * package's declared `pi.skills`, and project-local `.pi/skills` — and hands the
 * result to `before_agent_start` as `systemPromptOptions.skills`. Reusing that
 * list is what lets a subagent declare a package skill at all: discovery here
 * reads `agent/skills/` alone, so `skills: test-driven-development` (a
 * superpowers skill) used to resolve to *nothing*, and {@link selectSkills} drops
 * unknown names by design — no error, the agent just silently lacked its skill.
 *
 * Taking pi's list rather than re-deriving it also means the human's resource
 * filters are already applied: a `-skills/foo` exclusion, an include-list, or
 * `autoload: false` have all been honoured upstream, so a child can never be
 * handed a skill the orchestrator itself was denied. Re-reading `settings.json`
 * here would be a second parser of a format pi already owns, and this repo has
 * been bitten by exactly that (see `skill-activation.ts` in `AGENTS.md`).
 *
 * Keyed on the **directory** name, not the frontmatter `name`: `selectSkills`
 * matches `SkillEntry.dir`, and the two are free to drift. Skills whose
 * frontmatter sets `disable-model-invocation` are kept — pi filters those only
 * when *rendering* the orchestrator's prompt, and a subagent that explicitly
 * declares one should still get it.
 *
 * Pure and defensive: a malformed entry is skipped rather than throwing, because
 * this runs on the launch path.
 *
 * @param skills - `systemPromptOptions.skills` from `before_agent_start`.
 */
export function skillEntriesFromPi(skills: readonly unknown[]): SkillEntry[] {
  const out: SkillEntry[] = [];
  const seen = new Set<string>();
  for (const s of skills ?? []) {
    if (!s || typeof s !== "object") continue;
    const { name, description, filePath, baseDir } = s as Record<string, unknown>;
    if (typeof filePath !== "string" || !filePath) continue;
    // `baseDir` is the skill's own directory; fall back to the SKILL.md's parent.
    const dirPath = typeof baseDir === "string" && baseDir ? baseDir : dirname(filePath);
    const dir = basename(dirPath);
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push({
      dir,
      name: typeof name === "string" && name ? name : dir,
      description: typeof description === "string" ? description : "",
      path: filePath,
    });
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * One scalar frontmatter value, unwrapping the quotes a `description:` often
 * carries and collapsing a folded multi-line value onto one line.
 *
 * `agents.ts` keeps its own private `extractString` for agent files, which never
 * quote or fold; a `SKILL.md` description does both, and the catalogue renders
 * it on a single line.
 */
function extractSkillString(frontmatter: string, key: string): string {
  const inline = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  if (!inline) return "";

  let value = inline[1].trim();

  // Block scalar (`description: |` or `>`): take the indented lines below it.
  if (value === "|" || value === ">" || value === "|-" || value === ">-") {
    const after = frontmatter.slice(inline.index! + inline[0].length);
    const block: string[] = [];
    for (const line of after.split("\n").slice(1)) {
      if (!/^\s+\S/.test(line)) break;
      block.push(line.trim());
    }
    value = block.join(" ");
  }

  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    value = value.slice(1, -1);
  }
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Parses a delegation lineage out of a raw env value.
 *
 * The lineage is the chain of agent names from the human's orchestrator down to
 * this process, comma-separated — `worker,librarian` means a worker spawned the
 * librarian this code is running inside. Absent or empty means "nothing above
 * me": the human's orchestrator.
 *
 * @param raw - The env var's value, or undefined when unset.
 */
export function parseLineage(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Renders a lineage for the env var the child reads back. */
export function formatLineage(lineage: string[]): string {
  return lineage.join(",");
}

/**
 * Why `callee` may not be spawned from this lineage, or undefined to allow it.
 *
 * Two rules, in the order they are reported:
 *
 * 1. **No cycles.** An agent already in its own ancestry may not be spawned
 *    again. This is what makes `librarian → librarian` structurally impossible
 *    rather than merely discouraged, and it bounds the tree without an arbitrary
 *    depth number: every generation must introduce a *new* agent, and the roster
 *    is finite. `lib/dotenv.ts` records a fork bomb in this repo's history; a
 *    self-spawning agent is exactly that shape.
 * 2. **`callable_by` is honoured.** An agent that declares callers may only be
 *    spawned by one of them (or by the human's orchestrator, which has an empty
 *    lineage and is never something an agent can forge). This is what makes a
 *    helper agent private to the one agent that owns it.
 *
 * Both refusals name the rule and the fix, because a bare denial reads as a
 * broken tool and invites a retry loop.
 *
 * @param callee - The agent being spawned.
 * @param calleeCallableBy - Its `callable_by` frontmatter, or undefined for public.
 * @param lineage - Ancestry of the spawning process, oldest first.
 */
export function lineageRejection(
  callee: string,
  calleeCallableBy: string[] | undefined,
  lineage: string[],
): string | undefined {
  if (lineage.includes(callee)) {
    const chain = [...lineage, callee].join(" → ");
    return (
      `"${callee}" is already in this delegation's ancestry (${chain}), so spawning it ` +
      `again would be a cycle. Do this part with your own tools, or report what you ` +
      `need so the agent above you can take it from here.`
    );
  }

  if (calleeCallableBy && calleeCallableBy.length > 0) {
    // An empty lineage is the human's orchestrator: it may spawn anything, and
    // an agent cannot fake it (the value is written by the parent process).
    const caller = lineage.at(-1);
    if (caller !== undefined && !calleeCallableBy.includes(caller)) {
      return (
        `"${callee}" can only be spawned by: ${calleeCallableBy.join(", ")}. ` +
        `You are "${caller}", so this delegation was refused. It is a helper owned by ` +
        `another agent, not a general-purpose one.`
      );
    }
  }

  return undefined;
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
  let sessionFile: string | undefined;
  try {
    sessionFile = await findSessionFile(runDir, runId);
    if (!sessionFile) return { found: false, answered: false, text: "" };
    const content = await readFile(sessionFile, "utf-8");
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
      return { found: true, answered: true, text, stopReason: m.stopReason, sessionFile };
    }
  }

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
 * The runtime fallback chain for a child, or `undefined` for none.
 *
 * This is the *second* job of an agent's `fallback_models`. {@link candidateModels}
 * uses the same list to get the child **launched** — one attempt per model until
 * one accepts the task. That covered a model being unreachable at spawn time
 * and nothing after: once a child was running, its own mid-task provider errors
 * were pi's generic retry, which asks the same failing model again.
 *
 * So the list is also handed to the child as {@link CHAIN_ENV}, where the
 * `model-fallback` extension turns it into `fallback/auto` and hops on error.
 * One declaration, two jobs: the launcher's and the running child's.
 *
 * Returns `undefined` when there is nothing to hop *between* — an explicit
 * `model` on the delegation call (the caller pinned it, so a silent switch would
 * be a surprise, the same rule {@link candidateModels} applies), or an agent
 * with no declared fallbacks. In both cases the child launches exactly as it
 * did before this feature existed.
 *
 * @param requested - The model named on the delegation call, if any.
 * @param agent - The agent definition, for its model and fallbacks.
 * @returns Model references in priority order, or `undefined`.
 */
export function childFallbackChain(
  requested: string | undefined,
  agent: { model?: string; fallbackModels?: string[] },
): string[] | undefined {
  if (requested) return undefined;
  if (!agent.model || !agent.fallbackModels || agent.fallbackModels.length === 0) return undefined;
  const chain = [agent.model];
  for (const m of agent.fallbackModels) {
    if (!chain.includes(m)) chain.push(m);
  }
  // A chain of one is the no-fallback case: nothing to hop to.
  return chain.length > 1 ? chain : undefined;
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
