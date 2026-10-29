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

import { type AgentInfo, frontmatterOf } from "../lib/agents.js";
import { findSkills } from "../lib/skill-tree.js";
// The chain env var's name is owned by the extension that reads it, so the two
// halves of the handoff cannot drift apart (one parser per format).
import {
  type ChainEntry,
  CHAIN_ENV,
  FALLBACK_MODEL_ID,
  FALLBACK_MODEL_REF,
  formatChainItem,
  isThinkingLevel,
  parseChainItem,
} from "../model-fallback/lib.js";
import {
  counts,
  parseTodoState,
  type TodoCounts,
} from "../lib/todo.js";
import {
  CARD_ID_PATTERN,
  type ChildReport,
  type RunRecord,
  exitPath,
  isSessionFileFor,
  parseReportLine,
  qualifiesAsAnswer,
  qualifiesAsSalvage,
  reportsPath,
  systemPromptPath,
  visibleTextOf,
} from "./rundir.js";

export type { ChildReport };

/** The tool a child calls (via `child-done.ts`) to declare itself finished. */
export const DONE_TOOL_NAME = "subagent_done";

/** The tool a child calls (via `child-done.ts`) to message the orchestrator mid-run. */
export const REPORT_TOOL_NAME = "subagent_report";

/**
 * The simple checklist every subagent gets (`todo.ts`, registered only when
 * `PI_SUBAGENT_RUN_ID` is set). The orchestrator has the kanban board instead.
 */
export const TODO_TOOL_NAME = "todo";

/**
 * The tool a card-bearing child calls to request guidance from the orchestrator
 * about its card (see `child-done.ts`). Registered only when the child was
 * launched with a card — a child without a card has nothing to ask about.
 */
export const ASK_TOOL_NAME = "subagent_ask";

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
  /** The agent's declared tools; `undefined`/empty means "all tools". */
  tools?: string[];
  /** Absolute path to the composed system prompt, passed by file not by value. */
  systemPromptPath?: string;
  /**
   * The card id this run does, when the parent passed one: it adds
   * `subagent_ask` to the allowlist, because the tool is registered in the
   * child only for a card run.
   */
  card?: string;
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
 * `PI_KANBAN_CARD` is the kanban card id the delegation does, when the parent
 * passed one. Only a well-shaped id (`CARD_ID_PATTERN`) crosses: the child's
 * gate and the board both trust it without re-checking, and a malformed one is
 * a parent-side refusal (the `subagent` tool refuses it at spawn), not a
 * child-side mystery.
 */
export function buildChildEnv(
  rec: { runId: string; agent: string },
  parentPaneId: string | undefined,
  runDir: string,
  childLineage: string[] = [rec.agent],
  fallbackChain?: readonly string[],
  card?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PI_SUBAGENT_RUN_ID: rec.runId,
    PI_SUBAGENT_AGENT: rec.agent,
    PI_SUBAGENT_RUN_DIR: runDir,
    PI_SUBAGENT_LINEAGE: formatLineage(childLineage),
  };
  if (parentPaneId) env.PI_SUBAGENT_PARENT_PANE = parentPaneId;
  // The child always launches on `fallback/auto`, so the chain must cross
  // whenever it is non-empty — a single unpinned entry included: without the
  // var the child's router registers nothing and `fallback/auto` is
  // unresolvable. An absent var is only what a chain-less child gets, which
  // `spawnRun` refuses before any pane exists.
  if (fallbackChain && fallbackChain.length > 0) {
    env[CHAIN_ENV] = fallbackChain.join(",");
  }
  if (card !== undefined && CARD_ID_PATTERN.test(card)) {
    env.PI_KANBAN_CARD = card;
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
 * shout from a pane nobody is watching. `todo` is appended too: every
 * subagent gets its private checklist, which is launch policy rather than a
 * capability to copy into each agent's frontmatter (it writes no files, so a
 * read-only agent stays read-only).
 * `subagent_ask` is appended only for a card run: the tool is registered in
 * the child only when `PI_KANBAN_CARD` is set, and an allowlist entry for a
 * tool the child does not have is noise the model would have to look past.
 */
export function buildChildArgv(opts: ChildLaunchOptions): string[] {
  const argv: string[] = [
    "-e",
    opts.childDonePath,
    "--session-dir",
    opts.runDir,
    "--session-id",
    opts.runId,
    // The child always launches on the router: `fallback/auto` names it, and
    // the chain in the env (see `buildChildEnv`) tells it what to route
    // between. There is no physical-model launch path, so the flag is a
    // constant, not an option.
    "--model",
    FALLBACK_MODEL_REF,
  ];
  if (opts.tools && opts.tools.length > 0) {
    // `subagent_ask` is registered in the child only for a pattern-valid card
    // (`buildChildEnv` gates the same way) — an allowlisted tool the child
    // never registers would be a promise the argv breaks.
    const tools = [...new Set([...opts.tools, DONE_TOOL_NAME, REPORT_TOOL_NAME, TODO_TOOL_NAME, ...(opts.card !== undefined && CARD_ID_PATTERN.test(opts.card) ? [ASK_TOOL_NAME] : [])])];
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
 * The `## Assigned Kanban Card` block a card-bearing child's system prompt gets.
 *
 * The child sees no conversation and no board: the card id and the rules of
 * engagement with it have to cross in its system prompt, the way the skills
 * catalogue does. The list the child keeps *is* the card — one item per step —
 * which is what makes the board's live view and the child's completion gate
 * read the same fact (the child's own session).
 *
 * Deliberately never contains the string `<result>`: the run's answer contract
 * is judged against this composed prompt, and a quoted `<result>` in the
 * framing text is how `requiresResultBlock` would start requiring a block the
 * agent was only told about in passing.
 *
 * @param promptBody - The agent definition's body, after any skills catalogue.
 * @param card - The card id, already validated against `CARD_ID_PATTERN`.
 */
export function appendCardBrief(promptBody: string, card: string): string {
  const lines = [
    "",
    "## Assigned Kanban Card",
    "",
    `This delegation does kanban card **${card}**. Your list of work is the card:`,
    "",
    "- FIRST ACTION: `todo` with op `add`, one item per step of this card — before any other work.",
    "- `start` an item before working it; `complete` it immediately after, with a note naming how you checked it.",
    "- `block` (with a note) anything you are waiting on, so the board can show it as blocked.",
    "- `subagent_ask` to request guidance from the orchestrator about the card — it wakes the orchestrator, your run keeps working, and the reply arrives as a normal message here.",
    "- Do not finish the run with items open: complete, block-with-note, or drop every one.",
    `- Name the card id (${card}) in your final report.`,
  ];
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

// The lineage grammar and the spawn guard live in `../lib/agents.ts`, beside
// the `callable_by` key they enforce, so `dynamic-prompt.ts` can advertise
// exactly the roster this guard permits without importing this module's deps.
import { formatLineage, lineageRejection, parseLineage, spawnableAgents } from "../lib/agents.js";
export { formatLineage, lineageRejection, parseLineage, spawnableAgents };

/**
 * Where an answer was found, when it was not where it should have been.
 *
 * Absent means the normal path: visible text in the message that called
 * `subagent_done` (or the last visible text of a clean turn). The other two are
 * salvage, and worth naming because they are evidence of a child that did not
 * honour the handshake — a pattern worth seeing in the briefing rather than
 * silently repairing.
 */
export type AnswerSource =
  /** Recovered from a string argument on the `subagent_done` call. */
  | "done-arguments"
  /** The final answer itself, but below the strict bar — typically truncated. */
  | "truncated-answer"
  /** The model answered, then carried on; the answer is an earlier message. */
  | "earlier-message"
  /**
   * Nothing resembling a report: all that exists is a short line, usually the
   * model narrating ("Compiling the report now."). Forwarded anyway, because
   * it is strictly more than nothing and the orchestrator can judge it, but
   * labelled so it is never mistaken for the answer.
   */
  | "non-conforming";

/**
 * What the parent can recover from a finished (or dead) run's session file.
 */
export interface RunResult {
  /** A `*_<runId>.jsonl` session file exists in the run directory. */
  found: boolean;
  /** A qualifying answer was recovered (see `qualifiesAsAnswer`). */
  answered: boolean;
  /** The answer text. */
  text: string;
  /** Stop reason of the assistant message the answer came from, when recorded. */
  stopReason?: string;
  /** The session file the answer came from, when found. */
  sessionFile?: string;
  /** Set only when the answer had to be salvaged from somewhere unintended. */
  salvagedFrom?: AnswerSource;
  /**
   * The child's final todo counts, from the newest valid `todo` tool result
   * in the same transcript the answer came from (shared `parseTodoState`).
   * Present when the child built a list; the wake briefing renders it so the
   * orchestrator sees what the run settled even when its prose is a one-liner.
   */
  todos?: TodoCounts;
}

/**
 * Reads the child's transcript and recovers the answer the orchestrator should
 * see.
 *
 * The session file is `*_<runId>.jsonl` inside `runDir` (pi mints the
 * timestamp prefix itself), so ownership by runId is unambiguous and a
 * resumed session cannot be mistaken for a different run.
 *
 * ## What counts as an answer
 *
 * `qualifiesAsAnswer` (in `rundir.ts`, shared with the child's completion gate)
 * decides, against the run's own `system-prompt.md`: an agent whose prompt puts
 * its output under a `<result>` contract must have produced a complete
 * `<result>` element, and any other agent needs only non-empty visible text.
 * **Thinking is never considered** — reasoning does not reach the orchestrator,
 * so a report composed there is not an answer, however complete it looks in the
 * child's pane.
 *
 * ## Where it looks, in order
 *
 * 1. The newest strictly-qualifying visible text at or before the completion
 *    boundary (the `subagent_done` call, or the last assistant message when
 *    there is none). A strict answer wins over anything merely salvageable,
 *    wherever each sits, so an interim note cannot shadow the real report.
 * 2. String values in that call's own `arguments`, preferring `message`. The
 *    tool declares no parameters, but typebox accepts extra properties, so a
 *    model that "passed" its report to the tool produced a *valid* call whose
 *    payload would otherwise be dropped on the floor. Restricted to the
 *    matching call so an unrelated tool's argument can never be read as an
 *    answer.
 * 3. The newest *salvageable* visible text at or before the boundary — a real
 *    report the strict rule turned down, usually truncated mid-document.
 * 4. Failing all that, any visible text at all, labelled `non-conforming`, so
 *    that nothing the previous implementation surfaced is silently dropped.
 *
 * Steps 2 and 3 use `qualifiesAsSalvage`, which is deliberately looser than the
 * gate: all three recorded runs that handed their write-up to the tool had
 * spent their output budget on it and were cut off without a closing tag, so
 * requiring a complete element here would discard 7-17 KB reports in favour of
 * "(no final answer in transcript)". Short filler still never qualifies.
 *
 * Text *after* the done call is still excluded: the model frequently emits one
 * short closing remark ("Done.") that would otherwise shadow the real answer.
 * When the child finished by ending its turn cleanly there is no tool call, and
 * the search simply starts at the final message.
 *
 * Salvage (2 and 3) sets `salvagedFrom`; the normal path leaves it unset.
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

  interface ContentPart {
    type?: string;
    text?: string;
    name?: string;
    arguments?: unknown;
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

  // The child's final todo state, walked back from the end of the SAME parsed
  // entries (no second read): the newest VALID todo tool result wins,
  // malformed ones skipped — the shared `parseTodoState` rule the board and
  // the child's own gate apply.
  let todos: TodoCounts | undefined;
  for (let i = parsed.length - 1; i >= 0 && !todos; i--) {
    const m = (parsed[i] as { message?: { role?: string; toolName?: string; details?: unknown } }).message;
    if (m?.role !== "toolResult" || m.toolName !== "todo") continue;
    const state = parseTodoState((m.details as { state?: unknown } | undefined)?.state);
    if (state) todos = counts(state);
  }

  // The contract the child was launched under. Unreadable (a historical run, a
  // corrupt dir) degrades to the weaker rule rather than declaring every such
  // run unanswered.
  let systemPrompt: string | undefined;
  try {
    systemPrompt = await readFile(systemPromptPath(runDir), "utf-8");
  } catch {
    systemPrompt = undefined;
  }

  const partsOf = (m: { content?: unknown }): ContentPart[] =>
    (Array.isArray(m.content) ? m.content : []).filter(
      (c): c is ContentPart => !!c && typeof c === "object",
    );

  const doneCallIn = (m: { content?: unknown }): ContentPart | undefined =>
    partsOf(m).find((c) => c.type === "toolCall" && c.name === DONE_TOOL_NAME);

  // The message that declared completion, and the boundary for every search
  // below. With no `subagent_done` call, that boundary is the last *assistant*
  // message — not the last entry, which is frequently a `toolResult` and would
  // exclude the real final answer from every step.
  let doneIdx = -1;
  let doneCall: ContentPart | undefined;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const m = parsed[i].message;
    if (m?.role !== "assistant") continue;
    const call = doneCallIn(m);
    if (call) {
      doneIdx = i;
      doneCall = call;
      break;
    }
  }
  if (doneIdx < 0) {
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].message?.role === "assistant") {
        doneIdx = i;
        break;
      }
    }
  }

  // 1. The contract: a qualifying visible answer at or before the completion
  //    boundary, newest first. A strictly-qualifying answer wins over anything
  //    salvageable, wherever each sits, so an interim note cannot shadow the
  //    real report that came after it (sub-7864: a 565-char note at entry 97
  //    and the genuine 15,430-char answer at 101).
  const doneMessage = doneIdx >= 0 ? parsed[doneIdx].message : undefined;
  for (let i = doneIdx; i >= 0; i--) {
    const m = parsed[i].message;
    if (m?.role !== "assistant") continue;
    const text = visibleTextOf(m);
    if (qualifiesAsAnswer(text, systemPrompt)) {
      return {
        found: true,
        answered: true,
        text,
        stopReason: m.stopReason,
        sessionFile,
        ...(todos ? { todos } : {}),
        // Only the boundary message is "where the answer belongs"; anything
        // earlier is the model having answered and then carried on.
        ...(i === doneIdx ? {} : { salvagedFrom: "earlier-message" as const }),
      };
    }
  }

  // 2. Salvage: the report handed to the tool as a fabricated argument.
  if (doneCall && typeof doneCall.arguments === "object" && doneCall.arguments !== null) {
    const args = doneCall.arguments as Record<string, unknown>;
    // `message` first (the name every observed case invented), then insertion
    // order, so a model that picked a different key is still recovered.
    const keys = ["message", ...Object.keys(args).filter((k) => k !== "message")];
    for (const key of keys) {
      const value = args[key];
      if (typeof value !== "string") continue;
      const text = value.trim();
      if (qualifiesAsSalvage(text, systemPrompt)) {
        return {
          found: true,
          answered: true,
          text,
          stopReason: doneMessage?.stopReason,
          sessionFile,
          ...(todos ? { todos } : {}),
          salvagedFrom: "done-arguments",
        };
      }
    }
  }

  // 3. Salvage: a substantial report the strict rule turned down, newest first.
  //
  // Starts **at** `doneIdx`, not below it. The done-calling message's own
  // visible text gets a second, looser look here — a 15 KB `<result>` truncated
  // by the output budget is still the report, and excluding it is what made an
  // earlier draft of this function lose 47 KB across seven recorded runs while
  // every test passed. A `<result>` contract agent that merely ran out of room
  // is the single most common real shape, and it has no done call at all.
  for (let i = doneIdx; i >= 0; i--) {
    const m = parsed[i].message;
    if (m?.role !== "assistant") continue;
    const text = visibleTextOf(m);
    if (qualifiesAsSalvage(text, systemPrompt)) {
      return {
        found: true,
        answered: true,
        text,
        stopReason: m.stopReason,
        sessionFile,
        ...(todos ? { todos } : {}),
        salvagedFrom: i === doneIdx ? "truncated-answer" : "earlier-message",
      };
    }
  }

  // 4. Last resort: any visible text at all, labelled as not an answer.
  //
  // This exists so the fix cannot lose information the old code surfaced. The
  // old behaviour presented whatever text it found *as the answer*, which is
  // how a filler line came to stand in for a report; the rule above refuses
  // that, and this step forwards the same bytes with an honest label instead.
  // Measured over the 164 recorded runs, this is the difference between losing
  // 13 short texts (three of which carry real partial findings) and losing
  // none.
  for (let i = doneIdx; i >= 0; i--) {
    const m = parsed[i].message;
    if (m?.role !== "assistant") continue;
    const text = visibleTextOf(m);
    if (text) {
      return {
        found: true,
        answered: true,
        text,
        stopReason: m.stopReason,
        sessionFile,
        ...(todos ? { todos } : {}),
        salvagedFrom: "non-conforming",
      };
    }
  }

  return { found: true, answered: false, text: "", sessionFile, ...(todos ? { todos } : {}) };
}

/**
 * The one transcript-selection rule, as a pure function over a directory
 * listing: the `.exit`-settled transcript wins, else the newest (ISO-prefixed
 * names sort chronologically). `findSessionFile` and the lifecycle's
 * `evidenceStamp` (a sync reader) share it so a resumed dir fingerprints and
 * answers from the same file.
 */
export function pickSessionName(names: readonly string[], runId: string): string | undefined {
  const own = names.filter((n) => isSessionFileFor(n, runId));
  if (own.length === 0) return undefined;
  own.sort();
  const settled = own.filter((n) => names.includes(exitPath(n)));
  return settled.length > 0 ? settled[settled.length - 1] : own[own.length - 1];
}

async function findSessionFile(runDir: string, runId: string): Promise<string | undefined> {
  let dirEntries: string[];
  try {
    dirEntries = await readdir(runDir);
  } catch {
    return undefined;
  }
  // A run dir can hold more than one session file (a resumed session): 3 of
  // 443 recorded dirs do (18 is the naive *.jsonl glob, which counts foreign-
  // id transcripts; the isSessionFileFor-scoped count is what matters). Names are ISO-timestamp-prefixed, so lexicographic
  // order is chronological. The transcript the child settled — the one with
  // the `.exit` sidecar — IS the run's answer, and a post-completion resume
  // (a newer transcript, no sidecar) must not overwrite it: measured on
  // sub-2ea3, where the newest file is a resume days after the settled run.
  // With no settled transcript (the run is live) the newest wins — the same
  // rule kanban/runs.ts uses to render the card sub-row, so the answer and
  // the progress line are read from the same transcript while the run runs.
  const name = pickSessionName(dirEntries, runId);
  return name === undefined ? undefined : join(runDir, name);
}

/**
 * What asked for a health check.
 *
 * - `stalled` — the child's watchdog noticed its child stopped making
 *   progress while the pane is still alive. `detail` is the watchdog's full
 *   notice text (`phase=… elapsedMs=…` plus the chars/tool detail), passed
 *   through verbatim so the health check sees exactly what the watchdog saw.
 * - `ended-without-result` — the run ended, but `extractRunResult` returned
 *   `answered: false`: the transcript carries no answer the orchestrator can
 *   read.
 */
export type HealthCheckTrigger =
  | { kind: "stalled"; detail: string }
  | { kind: "ended-without-result" };

/**
 * The task text for a programmatically spawned health-check run.
 *
 * Self-contained by contract — the health-check child sees no conversation,
 * so this names the target run id, the target's run directory (absolute), the
 * target agent, the target's complete original task, and what triggered the
 * check. It also states the inspection method (incremental, bounded reads of
 * the JSONL — never the whole transcript) and the four sections the child
 * must return.
 *
 * It is a formatter, not a policy: it says what to look at and what to
 * report, never what the orchestrator should do about the answer — that
 * choice stays with the orchestrator, which reads the report.
 */
export function buildHealthCheckTask(
  target: Pick<RunRecord, "runId" | "agent" | "task">,
  targetRunDir: string,
  trigger: HealthCheckTrigger,
): string {
  const triggerText =
    trigger.kind === "stalled"
      ? `The child's watchdog signalled that the run is stalled: ${trigger.detail}`
      : "The run ended, but extractRunResult returned answered: false — the transcript carries no answer the orchestrator can read.";

  return [
    `You are diagnosing a delegated subagent run. The target run is ${target.runId} (agent: ${target.agent}).`,
    "",
    `Its run directory is ${targetRunDir}. It is the source of truth: read its meta.json, system-prompt.md, reports.jsonl if present, and its session transcript (<timestamp>_${target.runId}.jsonl, plus the .exit sidecar when present).`,
    "",
    "The target's original task, verbatim:",
    "",
    "```",
    target.task,
    "```",
    "",
    `Trigger: ${triggerText}`,
    "",
    "The transcript may be several megabytes. Do not read it wholesale. Inspect it incrementally: file names and sizes first, then bounded ranges around the newest messages, the current tool call, errors, and any visible findings (wc, tail, and bounded greps are for this). Never write, edit, or delete anything in the run directory.",
    "",
    "Report exactly these four sections, in a single <result> element:",
    "1. Target status — still streaming, stuck in which tool, idle, done, failed, or indeterminate.",
    "2. What happened — the sequence that led to this check, including the trigger and any relevant errors.",
    "3. Findings/work so far — conclusions, partial output, files, and decisions recoverable from the run; \"none recovered\" if there are none.",
    "4. Recommendation — wait, interrupt with a corrective prompt, cancel, continue from the recovered work, or spawn a fresh subagent carrying it.",
  ].join("\n");
}

/**
 * Normalise a model requested on the delegation call.
 *
 * A whitespace-only request is no request. pi's own `ref:level` form is
 * translated to this module's `ref|level` item form before parsing — but only
 * when the ref itself is a plain reference (no other `:`): `openai/gpt-5.6-sol:high`
 * is `openai/gpt-5.6-sol|high`, while `bad:ref:high` keeps its `:` and fails
 * the item grammar, as any other malformed ref does.
 */
function normalizeRequestedModel(requested: string | undefined): string | undefined {
  const raw = requested?.trim();
  if (!raw) return undefined;
  const match = raw.match(/^(.+):(off|minimal|low|medium|high|xhigh|max)$/);
  if (match && !match[1].includes(":")) return `${match[1]}|${match[2]}`;
  return raw;
}

/**
 * The model chain a child launches on, as chain items for {@link CHAIN_ENV}.
 *
 * Every launch goes through the router: the child is started on
 * `fallback/auto`, and this is what the router serves. So the chain is the
 * declaration, canonicalised, never filtered by "worth routing": a single
 * unpinned model is a legal chain, because the parent has already committed
 * the launch to the router and a child without a registered router cannot
 * resolve `fallback/auto` at all.
 *
 * An explicit `model` on the delegation call is a one-entry chain with its
 * `|level` pin kept verbatim: the caller chose exactly this model for this
 * run, so no agent fallbacks are appended — a silent switch mid-run would be
 * a surprise rather than a recovery.
 *
 * The router's own reference is unusable in every position: `fallback/auto`
 * names the router, not a physical model, and the router cannot route to
 * itself — a chain that advertises it is a dead child. It is matched
 * case-insensitively, and a request for it yields `undefined` so the caller
 * refuses the launch with a message.
 *
 * Items are canonicalised through the child's own item grammar
 * ({@link parseChainItem} → {@link formatChainItem}), so a `ref|level` pin in
 * the agent file survives the handoff verbatim. An entry the grammar rejects
 * is dropped: keeping it would advertise a chain the child's router does not
 * serve, and the two halves of the handoff disagreeing is the drift this
 * module exists to prevent. Dedup is by ref, case-insensitively, first
 * occurrence winning.
 *
 * Returns `undefined` only when no valid reference exists at all — nothing
 * requested (or a request that normalises to nothing, names the router, is a
 * bare `auto`, carries an invalid `|level` pin, or parses to nothing) and
 * nothing declared that the item grammar accepts. The caller must then refuse
 * the launch: there is no model the router could serve.
 *
 * @param requested - The model named on the delegation call, if any.
 * @param agent - The agent definition, for its model and fallbacks.
 * @returns Chain items in priority order, or `undefined` when nothing parses.
 */
export function childFallbackChain(
  requested: string | undefined,
  agent: { model?: string; fallbackModels?: string[] },
): string[] | undefined {
  const req = normalizeRequestedModel(requested);
  if (req) {
    // A bare `auto` is the router's own model id, not a physical model: it
    // cannot serve a request, so an explicit request for it is refused like
    // any other unusable reference.
    if (req.toLowerCase() === FALLBACK_MODEL_ID) return undefined;
    const entry = parseChainItem(req);
    if (!entry) return undefined;
    // An explicit request names exactly this model for this run, so a pin it
    // wrote must be one the router applies: an invalid `|level` is refused
    // here rather than silently dropped by the item grammar's degradation.
    const bar = req.indexOf("|");
    if (bar !== -1 && !isThinkingLevel(req.slice(bar + 1))) return undefined;
    if (entry.ref.toLowerCase() === FALLBACK_MODEL_REF.toLowerCase()) return undefined;
    return [formatChainItem(entry)];
  }
  const chain: ChainEntry[] = [];
  const seen = new Set<string>();
  for (const raw of [agent.model, ...(agent.fallbackModels ?? [])]) {
    if (raw === undefined) continue;
    const entry = parseChainItem(raw);
    if (!entry) continue;
    if (entry.ref.toLowerCase() === FALLBACK_MODEL_REF.toLowerCase()) continue;
    const key = entry.ref.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push(entry);
  }
  return chain.length > 0 ? chain.map(formatChainItem) : undefined;
}

/**
 * Who is asking for a spawn. A model's `subagent` call is a tool delegation;
 * a health check is the extension's own spawn of a diagnosis for `targetRunId`,
 * which bypasses `callable_by` (never the cycle rule) — see {@link admitSpawn}.
 */
export type SpawnOrigin =
  | { kind: "tool-delegation" }
  | { kind: "system-health-check"; targetRunId: string };

/** One spawn request, as {@link admitSpawn} judges it. */
export interface SpawnAdmissionRequest {
  /** The agent definition name asked for. */
  agent: string;
  task: string;
  /** The child's working directory, already resolved against the caller's. */
  cwd: string;
  /** An explicit model on the delegation call, if any. */
  model?: string;
  origin: SpawnOrigin;
}

/**
 * The verdict on a spawn request: the resolved agent and its router chain, or
 * the exact refusal to hand back to the caller.
 */
export type SpawnAdmission =
  | {
      ok: true;
      agent: AgentInfo;
      /** Chain items for `PI_FALLBACK_CHAIN`, non-empty, in priority order. */
      chain: string[];
      task: string;
      cwd: string;
      /** The diagnosed run's id, set only for a `system-health-check` origin. */
      healthCheckOf?: string;
    }
  | { ok: false; error: string };

/**
 * Decides whether a spawn may proceed, before anything is spent: no run dir,
 * no registry entry, no pane. Pure — the roster and lineage come in.
 *
 * Three checks, in this order: the agent must exist in `rosterAll` (the
 * refusal lists what this lineage may spawn under normal rules), then
 * {@link lineageRejection} (with `{ system: true }` only for a health check),
 * then {@link childFallbackChain} must yield a chain. The herdr name check is
 * not here: it depends on the run id, which only the caller allocates.
 *
 * @param request - What was asked for, and by whom.
 * @param rosterAll - Every known agent (`delegationRoster(...).all`).
 * @param lineage - The spawning process's ancestry, oldest first.
 */
export function admitSpawn(
  request: SpawnAdmissionRequest,
  rosterAll: readonly AgentInfo[],
  lineage: string[],
): SpawnAdmission {
  // Looked up in the whole roster, not the spawnable part: a known agent this
  // caller may not spawn must get lineageRejection's specific refusal, not
  // "Unknown agent".
  const agent = rosterAll.find((a) => a.name === request.agent);
  if (!agent) {
    // List only what this caller could actually spawn. Advertising a private
    // helper it may not use turns one refusal into two round trips. Normal
    // (non-system) lineage rules, whatever the origin.
    const available =
      spawnableAgents(rosterAll, lineage)
        .map((a) => (a.skill ? `${a.name} (skill: ${a.skill})` : a.name))
        .join(", ") || "none";
    return { ok: false, error: `Unknown agent "${request.agent}". Available agents: ${available}.` };
  }

  // A health check is the extension's own spawn, not a delegation the model
  // chose, so it must work from any depth: a worker whose reviewer stalls gets
  // its diagnosis like the orchestrator does. `callable_by: orchestrator` on
  // `healthcheck` still keeps every agent from delegating to it by hand.
  const lineageProblem = lineageRejection(agent.name, agent.callableBy, lineage, {
    system: request.origin.kind === "system-health-check",
  });
  if (lineageProblem) return { ok: false, error: lineageProblem };

  // The child's model chain, in its only role now: the router it launches on.
  // A child is started on `fallback/auto` with this chain in its env, so a
  // declaration with no syntactically usable reference is a launch refusal, not
  // a fallback to pi's default — refuse it before any run dir, registry entry,
  // or pane. The two messages split on who is at fault: a bad `model` on the
  // delegation call is the caller's to fix; an empty declaration is the agent
  // file's.
  const chain = childFallbackChain(request.model, agent);
  if (!chain) {
    // A whitespace-only `model` is no request (the chain rule normalises it to
    // nothing), so it is the agent file's declaration that failed, not the
    // caller's.
    const error = request.model?.trim()
      ? `Requested model "${request.model}" is not usable. The accepted grammar is \`provider/id\` or \`provider/id|level\` (level: off|minimal|low|medium|high|xhigh|max); a pi-style \`ref:level\` is translated only when the ref is itself a plain \`provider/id\`, and \`fallback/auto\` is not accepted — the router cannot route to itself. Pass a valid model, or omit \`model\` to use the agent's declaration.`
      : `Agent "${agent.name}" declares no usable model: its model/fallback_models contains no reference the router can serve. Fix the agent definition — children launch on fallback/auto, which needs at least one entry.`;
    return { ok: false, error };
  }

  return {
    ok: true,
    agent,
    chain,
    task: request.task,
    cwd: request.cwd,
    ...(request.origin.kind === "system-health-check"
      ? { healthCheckOf: request.origin.targetRunId }
      : {}),
  };
}

/**
 * herdr's rule for an agent name, verified against herdr 0.9.0 by asking it.
 *
 * `agent start` rejects a name outside this shape with `invalid_agent_name`,
 * which the spawn path used to surface as "did not become interactive" — a
 * failure that looks like a broken model and is not.
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
 * the old per-model launch loop burned every candidate model in under 100 ms
 * and the run reported "did not become interactive" on all of them, which
 * read as a dead fleet and was really a name collision.
 *
 * Scoping by run id makes the name unique by construction, which is the same
 * reason pane and tab ids are never predicted: identity comes from the thing
 * that is actually unique, not from a label that happens to be free.
 *
 * @param agentName - The agent definition's `name` (e.g. `librarian`).
 * @param runId - The run id (e.g. `sub-9622`). {@link makeRunId} draws from
 *        ~65k values without a registry check, so uniqueness is overwhelmingly
 *        likely rather than guaranteed; a collision now surfaces as a clear
 *        `agent_name_taken` instead of the fake fleet outage above.
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
 * The late path still closes the pane on `invalid_agent_name` and reports it
 * without a pane id, so this check is defence in depth — it converts a late,
 * pane-wasting failure into an immediate and clearer one.
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
