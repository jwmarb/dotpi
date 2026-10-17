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

import { findSkills } from "./skill-tree.js";

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
  /**
   * Preferred LLM model, or undefined to use the default. The raw frontmatter
   * value: a bare reference, or `ref|level` with a pinned thinking level
   * (e.g. `openai/gpt-5.6-sol|high`). Levels are the seven case-sensitive
   * words `off|minimal|low|medium|high|xhigh|max`; the pin is applied by the
   * child's model-fallback router, so validation lives there — this parser
   * keeps the value verbatim.
   */
  model?: string;
  /**
   * Fallback models, from the file's `fallback_models` key. They feed the
   * child's runtime chain: the child launches on `fallback/auto` and a
   * provider failure *mid-task* hops to the next entry instead of re-asking
   * the one that just failed. An explicit model on the delegation call
   * replaces the whole declaration with a one-entry chain (its own pin kept,
   * no fallbacks appended).
   *
   * Each entry is the raw frontmatter value: a bare reference, or `ref|level`
   * pinning the thinking level that entry should run at (see {@link model}).
   * The pin crosses to the child in `PI_FALLBACK_CHAIN` and is applied by the
   * child's model-fallback router; this parser deliberately does not validate
   * it — one parser per format, and the model-fallback extension owns it.
   */
  fallbackModels?: string[];
  /**
   * Who may spawn this agent, from the file's `callable_by` key
   * (**snake_case** — a camelCase key silently never matches).
   *
   * The grammar (see {@link lineageRejection}, which enforces it):
   * - agent names — only those agents may spawn it as their *direct* child;
   * - `orchestrator` — the human's orchestrator (the empty lineage). It is
   *   always allowed, so writing it is documentation, not a grant;
   * - `any` ({@link ANY_CALLER}) — public: every agent may spawn it.
   *
   * **Absent means orchestrator-only, never public.** Public must be declared,
   * so no delegation edge exists merely because nothing forbids it. Every file
   * in `agents/` declares the key anyway, and `subagent-herdr/lib.test.ts` pins
   * the resulting fleet graph.
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
 * Scans every skill's `agents/` directory for agent definitions, wherever that
 * skill sits in the category tree.
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
 * @param skillsDir - Absolute path to the skills library (skills live under
 *                    category directories; `skill-tree.ts` finds them).
 * @param only - When given, restrict discovery to these skill directory names
 *               (the loaded set) — matched on the skill's own directory name,
 *               not its category path. Omit to scan every skill.
 * @returns A sorted (by name) list of agents, or `[]` on any failure.
 */
export async function discoverSkillAgents(
  skillsDir: string,
  only?: Iterable<string>,
): Promise<AgentInfo[]> {
  // Locating skills belongs to `skill-tree.ts`: skills are nested under a
  // category, and the one-level readdir this used to do returned no agents at
  // all once a skill moved — with no error, so the agents just vanished.
  let skills = await findSkills(skillsDir);
  if (only) {
    // Filter on the skill directory name, not the path, so `skills:
    // technical-analysis` keeps working regardless of which category files it.
    const allowed = new Set(only);
    skills = skills.filter((s) => allowed.has(s.dir));
  }
  const agents: AgentInfo[] = [];
  for (const skill of skills) {
    // One skill's unreadable agents/ dir costs only that skill: discoverAgents
    // already returns [] rather than throwing.
    for (const agent of await discoverAgents(join(skill.root, "agents"))) {
      agents.push({ ...agent, skill: skill.dir });
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
 * `model` and each `fallback_models` entry may carry a pinned thinking level
 * as `ref|level` (e.g. `openai/gpt-5.6-sol|high`); the levels are the seven
 * case-sensitive words `off|minimal|low|medium|high|xhigh|max`. The parser
 * keeps these values verbatim — validation and application belong to the
 * model-fallback extension, which owns the item grammar
 * (`parseChainItem`). An explicit model on the delegation call replaces the
 * whole declaration with a one-entry chain (its own pin kept, no fallbacks).
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

/**
 * Single scalar frontmatter value (`key: value`, first match).
 *
 * Deliberately does NOT strip surrounding quotes or fold block scalars: agent
 * files (`agents/*.md`) never quote scalar values, and adding those rules here
 * would silently widen the grammar the spawn path parses. The SKILL.md-specific
 * reader — `extractSkillString` in `subagent-herdr/lib.ts`, which does strip
 * quotes and fold `|`/`>` blocks — owns the wider format; do not merge the two.
 */
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

// ---------------------------------------------------------------------------
// Delegation lineage and the `callable_by` guard
//
// Lives here, beside the key it enforces, so the spawn path (`subagent-herdr`)
// and the advertised roster (`dynamic-prompt.ts`) apply one rule — an agent is
// never told about a delegation its `subagent` call would have refused.
// ---------------------------------------------------------------------------

/**
 * The env var a parent stamps into every child with the child's ancestry
 * (oldest first, the child included). Unset in the human's orchestrator.
 */
export const LINEAGE_ENV = "PI_SUBAGENT_LINEAGE";

/** The `callable_by` sentinel that makes an agent public. */
export const ANY_CALLER = "any";

/**
 * The `callable_by` name for the human's orchestrator (the empty lineage). It
 * names no agent file and is always allowed; writing it documents intent.
 */
export const ORCHESTRATOR_CALLER = "orchestrator";

/**
 * Parses a delegation lineage out of a raw env value (`PI_SUBAGENT_LINEAGE`).
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
 * 2. **`callable_by` is honoured.** The human's orchestrator (empty lineage,
 *    which an agent cannot forge — the parent process writes it) may spawn
 *    anything. Any other caller must be named in the callee's `callable_by`,
 *    or the callee must declare `any`. An absent or empty `callable_by` admits
 *    the orchestrator alone: public is a declaration, not a default.
 *
 * Both refusals name the rule and the fix, because a bare denial reads as a
 * broken tool and invites a retry loop.
 *
 * @param callee - The agent being spawned.
 * @param calleeCallableBy - Its `callable_by` frontmatter (undefined = orchestrator-only).
 * @param lineage - Ancestry of the spawning process, oldest first.
 * @param opts.system - The spawn is the extension's own (a health check), not a
 *   model's delegation: `callable_by` restricts which *agents* may delegate, so
 *   it is skipped, but the cycle rule still applies.
 */
export function lineageRejection(
  callee: string,
  calleeCallableBy: string[] | undefined,
  lineage: string[],
  opts: { system?: boolean } = {},
): string | undefined {
  if (lineage.includes(callee)) {
    const chain = [...lineage, callee].join(" → ");
    return (
      `"${callee}" is already in this delegation's ancestry (${chain}), so spawning it ` +
      `again would be a cycle. Do this part with your own tools, or report what you ` +
      `need so the agent above you can take it from here.`
    );
  }

  const caller = lineage.at(-1);
  if (caller === undefined || opts.system) return undefined;
  const allowed = calleeCallableBy ?? [];
  if (allowed.includes(ANY_CALLER) || allowed.includes(caller)) return undefined;

  const named = allowed.length > 0 ? allowed.join(", ") : ORCHESTRATOR_CALLER;
  return (
    `"${callee}" can only be spawned by: ${named}. ` +
    `You are "${caller}", so this delegation was refused. Do this part with your own ` +
    `tools, or report what you need so the agent above you can delegate it.`
  );
}

/**
 * The agents a process with this lineage may actually spawn — the same rule
 * {@link lineageRejection} enforces, applied to a roster. Used for the
 * advertised inventory and the "Available agents" error list alike.
 */
export function spawnableAgents<T extends Pick<AgentInfo, "name" | "callableBy">>(
  agents: readonly T[],
  lineage: string[],
): T[] {
  return agents.filter((a) => !lineageRejection(a.name, a.callableBy, lineage));
}
