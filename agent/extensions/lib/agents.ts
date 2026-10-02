/**
 * Agent definition discovery — the single owner of the agent-definition
 * frontmatter grammar, for both `agent/agents/*.md` (global) and
 * `agent/skills/<skill>/agents/*.md` (skill-shipped).
 *
 * Two extensions used to parse these files — dynamic-prompt (the
 * orchestrator prompt's agent inventory) and subagent-herdr (the spawn
 * argv) — each "mirroring" the other's grammar by hand, and the mirrors
 * drifted: the files declare `fallback_models`, one parser read a
 * camelCase key that never matched, the other had no field for it at all.
 * This module applies the same one-parser-per-format rule as `dotenv.ts`:
 * every consumer imports `discoverAgents`, nobody re-implements the grammar.
 *
 * Failure behaviour is part of the contract: a missing or unreadable
 * agents directory yields `[]`, and one unreadable file is skipped (its
 * agent simply isn't discovered) so a single corrupt definition costs
 * itself — not every spawn, not the prompt.
 *
 * Pure module: `node:fs/promises` + `node:path` only, no pi import (the
 * same constraint `dotenv.ts` keeps so it can load from extension
 * top-level code).
 *
 * @module extensions/lib/agents
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Metadata for a subagent definition parsed from `agent/agents/<name>.md`.
 * The union of what both consumers need: the prompt renders
 * name/description/model/tools, the spawn path uses tools/model/promptBody.
 */
export interface AgentInfo {
  name: string;
  description: string;
  /** Allowed tools, or undefined if the agent can use all tools. */
  tools?: string[];
  /** Preferred LLM model, or undefined to use the default. */
  model?: string;
  /**
   * Fallback models, from the file's `fallback_models` key. Tried in order by
   * the spawn path when a child fails to *launch* (an unknown model, or a
   * provider that is down or rate-limiting, makes pi exit before its TUI
   * appears). An explicit model on the delegation call suppresses them.
   */
  fallbackModels?: string[];
  /**
   * Agent names allowed to spawn this one, from the file's `callable_by` key
   * (**snake_case** — a camelCase key silently never matches).
   *
   * Absent means public: anything may spawn it, which is every agent that
   * existed before this key did. Naming callers makes the agent a *private
   * helper* — `callable_by: librarian` is a research sub-agent only the
   * librarian may fan out to, so it never clutters another agent's options and
   * cannot be mistaken for a general-purpose worker.
   *
   * The human's orchestrator is always allowed: it has an empty lineage, which
   * an agent cannot forge because the lineage is written by the parent process.
   */
  callableBy?: string[];
  /**
   * Skill directory names this agent may see, from the file's `skills` key.
   *
   * A subagent's system prompt is its `promptBody` *verbatim* — pi's dynamic
   * prompt (and so the whole `## Available Skills` catalogue) is built for the
   * orchestrator only. Without this key an agent cannot know a skill exists, so
   * the catalogue is opt-in per agent rather than global: a reviewer has no use
   * for the trading-journal skills, and an undeclared skill stays invisible.
   *
   * `skills: *` means every discovered skill. Absent or empty means none, which
   * keeps every existing agent exactly as it was.
   */
  skills?: string[];
  /** The agent's system-prompt body: the markdown after the frontmatter. */
  promptBody: string;
  /** The filename of the agent definition (e.g. `worker.md`). */
  filePath: string;
  /**
   * The skill that ships this agent (its directory name), or undefined for a
   * global agent from `agent/agents/`. Set by {@link discoverSkillAgents}.
   *
   * Provenance, not decoration: a skill agent is only advertised while its skill
   * is loaded, and an unknown-agent error can say which skill to load.
   */
  skill?: string;
}

/**
 * Scans `agentsDir` for `.md` files with parseable frontmatter.
 *
 * @param agentsDir - Absolute path to the agents directory.
 * @returns A sorted (by name) list of agents, or `[]` on any failure
 *          (unreadable files are skipped, not fatal).
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
    let content: string;
    try {
      content = await readFile(join(agentsDir, file), "utf-8");
    } catch {
      continue; // one unreadable file costs only itself
    }
    const parsed = parseAgentFile(content, file);
    if (parsed) agents.push(parsed);
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Scans every `<skillsDir>/<skill>/agents/` for agent definitions.
 *
 * Skills may ship their own subagents beside the skill that drives them — a
 * journal-writing agent belongs with the journal skill, not in the global roster
 * where it is noise to every unrelated session. Each discovered agent carries
 * {@link AgentInfo.skill} so callers can gate on, or report, its origin.
 *
 * `agents/` has long held an optional `openai.yaml` presentation file; only
 * `.md` files with parseable frontmatter become agents, so existing skills are
 * unaffected.
 *
 * @param skillsDir - Absolute path to the skills library (one dir per skill).
 * @param only - When given, restrict discovery to these skill directory names
 *               (the loaded set). Omit to scan every skill.
 * @returns A sorted (by name) list of agents, or `[]` on any failure.
 */
export async function discoverSkillAgents(
  skillsDir: string,
  only?: Iterable<string>,
): Promise<AgentInfo[]> {
  let skills: string[];
  try {
    skills = await readdir(skillsDir);
  } catch {
    return [];
  }
  if (only) {
    const allowed = new Set(only);
    skills = skills.filter((s) => allowed.has(s));
  }
  const agents: AgentInfo[] = [];
  for (const skill of skills) {
    // One skill's unreadable agents/ dir costs only that skill: discoverAgents
    // already returns [] rather than throwing.
    for (const agent of await discoverAgents(join(skillsDir, skill, "agents"))) {
      agents.push({ ...agent, skill });
    }
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Merges global and skill-shipped agents into one roster.
 *
 * A global agent wins a name collision: the roster in `agent/agents/` is the
 * stable contract every session depends on, and a skill must not be able to
 * silently redirect `worker` or `reviewer` by shipping a file with that name.
 * The shadowed skill agent is dropped, not renamed, so the collision shows up
 * as "my agent isn't there" rather than as a subtly different `worker`.
 *
 * @param global - Agents from `agent/agents/`.
 * @param skillAgents - Agents from every `<skill>/agents/`, across skills (not one
 *                      skill's — {@link discoverSkillAgents} returns them merged).
 * @returns One sorted roster, global definitions taking precedence.
 */
export function mergeAgents(global: AgentInfo[], skillAgents: AgentInfo[]): AgentInfo[] {
  const taken = new Set(global.map((a) => a.name));
  return [...global, ...skillAgents.filter((a) => !taken.has(a.name))].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Parses one agent definition: YAML-ish frontmatter (name, description,
 * tools, model, fallback_models) plus the markdown body that becomes the
 * child's system prompt.
 *
 * @returns The parsed agent, or `null` when the frontmatter is missing or
 *          has no `name` (such a file is skipped by discovery).
 */
export function parseAgentFile(content: string, fileName: string): AgentInfo | null {
  // CRLF-tolerant on both fences: a `\n`-only opening fence reads a CRLF file
  // as having no frontmatter, which drops the definition silently.
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const raw = match[1];
  const name = extractString(raw, "name");
  if (!name) return null;

  const fallbackModels = extractStringList(raw, "fallback_models");
  const skills = extractStringList(raw, "skills");
  const callableBy = extractStringList(raw, "callable_by");

  return {
    name,
    description: extractString(raw, "description"),
    tools: extractStringList(raw, "tools"),
    model: extractString(raw, "model") || undefined,
    fallbackModels: fallbackModels.length > 0 ? fallbackModels : undefined,
    callableBy: callableBy.length > 0 ? callableBy : undefined,
    skills: skills.length > 0 ? skills : undefined,
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
 *
 * Exported because the same two spellings appear in `SKILL.md` frontmatter, and
 * this module is the one owner of the grammar (see the module docstring — the
 * drift that rule exists to prevent has already happened once here). A second
 * copy in `skill-activation.ts` had *already* diverged on whether to `.trim()`
 * before the `-` test, so a skill writing `tools:  - a` was read differently by
 * the two readers.
 *
 * @param yaml - The frontmatter body (between the `---` fences).
 * @param key - The frontmatter key to read.
 */
export function extractStringList(yaml: string, key: string): string[] {
  const inline = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (inline && !inline[1].trim().startsWith("-")) {
    return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
  }
  const block = yaml.match(new RegExp(`^${key}:\\n((?:\\s+- .+\\n?)+)`, "m"));
  if (block) {
    return block[1].split("\n").map((l) => l.replace(/^\s+-\s*/, "").trim()).filter(Boolean);
  }
  return [];
}

/**
 * The frontmatter block of a markdown file (between the leading `---` fences),
 * or undefined when there is none.
 *
 * Shared with `skill-activation.ts` so "what counts as frontmatter" has one
 * answer for agent files and `SKILL.md` alike.
 *
 * Tolerates CRLF. Four `SKILL.md` files in this repo are CRLF-encoded, and a
 * `\n`-only pattern silently read them as having no frontmatter at all — so they
 * vanished from every consumer rather than failing loudly. A line-ending is not
 * a reason to drop a skill.
 */
export function frontmatterOf(content: string): string | undefined {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
}
