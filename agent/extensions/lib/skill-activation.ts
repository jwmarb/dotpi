/**
 * Skill-activation tracking — which skills are live in this session.
 *
 * pi has no `skill_invoke` event (verified against the installed 0.87.1 event
 * list), and `systemPromptOptions.skills` is the *catalogue*: it lists every
 * discovered skill on every turn, 40 of them here, whether or not any is in use.
 * So "is this skill loaded" has to be inferred, and there are exactly two ways a
 * skill body reaches the model:
 *
 *   1. The human types `/skill:name`. pi expands it into the turn prompt as
 *      `<skill name="..." location="...">…`, so it is visible in
 *      `before_agent_start`'s `event.prompt`.
 *   2. The model invokes one, which shows up as a `read_skill` (or `read`) tool
 *      call whose path ends in `SKILL.md`.
 *
 * This module owns both detections and the resulting live set, so the extensions
 * that care (tool gating, agent advertisement) share one answer instead of each
 * sniffing prompts their own way.
 *
 * Activation is sticky for the session: a skill's guidance stays in context after
 * the turn that loaded it, so its tools must not vanish on the next turn. Nothing
 * deactivates a skill short of a new session — deliberate, because a tool
 * disappearing mid-task is worse than one lingering.
 *
 * Pure module: `node:fs/promises` + `node:path` only, no pi import (the `lib/`
 * rule).
 *
 * @module extensions/lib/skill-activation
 */
import { readFile as fsReadFile } from "node:fs/promises";
import { basename, dirname, sep } from "node:path";

import { extractStringList, frontmatterOf } from "./agents.js";
import { findSkills } from "./skill-tree.js";

/**
 * Matches pi's expanded skill block: `<skill name="x" location="/path/SKILL.md">`.
 * Global so one prompt carrying several blocks yields all of them.
 */
const SKILL_BLOCK = /<skill\s+name="([^"]+)"\s+location="([^"]+)"/g;

/** A path that identifies a skill: `…/<skill-dir>/SKILL.md` or a sibling doc. */
const SKILL_FILE = /(?:^|[/\\])([^/\\]+)[/\\]SKILL\.md$/i;

/**
 * The skill *directory* name for a skill file path.
 *
 * The directory is the identity, not the frontmatter `name`: agents live in
 * `<dir>/agents/`, so the directory is what other lookups need, and the two are
 * free to drift (nothing enforces that they match).
 *
 * Both current callers pass a `SKILL.md` path — pi's `location` attribute is
 * always `skill.filePath` (`agent-session.js:853`) and {@link isSkillLoad} gates on
 * the filename — so the sibling-doc fallback below is unreachable from them today.
 * It is kept because the function is exported and the rule it encodes is the same
 * one: for any file inside a skill, the skill is its parent directory. Deleting it
 * would make a future caller that passes `strategies.md` silently return
 * undefined, which fails as "my skill never activates" rather than as an error.
 *
 * @returns The directory name, or undefined when the path has no usable parent.
 */
export function skillDirFromPath(path: string): string | undefined {
  const m = path.match(SKILL_FILE);
  if (m) return m[1];
  // Any sibling reference doc (strategies.md, gamma.md) implies the same skill.
  const parent = basename(dirname(path));
  return parent && parent !== "." && parent !== sep ? parent : undefined;
}

/**
 * Extracts skill directory names from an expanded turn prompt.
 *
 * Reads the `location` attribute rather than `name`, so the result is keyed the
 * same way as {@link skillDirFromPath} regardless of frontmatter.
 */
export function skillsInPrompt(prompt: string): string[] {
  const out: string[] = [];
  for (const m of String(prompt ?? "").matchAll(SKILL_BLOCK)) {
    const dir = skillDirFromPath(m[2]) ?? m[1];
    if (dir) out.push(dir);
  }
  return [...new Set(out)];
}

/**
 * True when a tool call is loading a skill file.
 *
 * `read_skill` is the intended path, but a plain `read` of a `SKILL.md` is the
 * same act and is what a model does when it has no `read_skill`.
 */
export function isSkillLoad(toolName: string, input: unknown): string | undefined {
  if (toolName !== "read_skill" && toolName !== "read") return undefined;
  const path =
    typeof input === "string"
      ? input
      : typeof (input as { path?: unknown })?.path === "string"
        ? (input as { path: string }).path
        : undefined;
  if (!path || !/SKILL\.md$/i.test(path)) return undefined;
  return skillDirFromPath(path);
}

/**
 * Session-scoped set of active skills.
 *
 * One instance per extension; each tracks the same session independently, which
 * is fine because both derive from the same observable events.
 */
export class SkillActivation {
  private active = new Set<string>();

  /** Records skills expanded into a turn prompt. Returns the newly added ones. */
  notePrompt(prompt: string): string[] {
    return this.add(skillsInPrompt(prompt));
  }

  /** Records a skill loaded via a tool call. Returns the newly added ones. */
  noteToolCall(toolName: string, input: unknown): string[] {
    const dir = isSkillLoad(toolName, input);
    return dir ? this.add([dir]) : [];
  }

  /**
   * Marks skill directories active.
   *
   * @returns Only the directories this call newly added, so a caller can log a
   *          transition without tracking the previous set itself.
   */
  private add(dirs: Iterable<string>): string[] {
    const added: string[] = [];
    for (const d of dirs) {
      if (d && !this.active.has(d)) {
        this.active.add(d);
        added.push(d);
      }
    }
    return added;
  }

  /** Is this skill directory live in the session? */
  has(dir: string): boolean {
    return this.active.has(dir);
  }

  /** Every active skill directory, sorted. */
  list(): string[] {
    return [...this.active].sort();
  }

  /** Clears the set — call on a new session, never mid-session. */
  reset(): void {
    this.active.clear();
  }
}

/**
 * Splits a tool list into the ones that stay and the ones a skill gates away.
 *
 * `selectedTools` in `before_agent_start` is mutable and is what the model is
 * offered, which makes it the only working gate: `registerTool` has no
 * counterpart (there is no `unregisterTool`), and the `setActiveTools` API the
 * type definitions advertise is absent from this event's context — both verified
 * at runtime, not assumed.
 *
 * @param selected - The tool names currently offered to the model.
 * @param owners - Tool name → the skill directory that must be active for it.
 * @param isActive - Predicate for whether a skill directory is active.
 * @returns `kept` (to assign back) and `gated` (withheld this turn).
 */
export function gateTools(
  selected: readonly string[],
  owners: ReadonlyMap<string, string>,
  isActive: (skillDir: string) => boolean,
): { kept: string[]; gated: string[] } {
  const kept: string[] = [];
  const gated: string[] = [];
  for (const tool of selected) {
    const owner = owners.get(tool);
    if (owner && !isActive(owner)) gated.push(tool);
    else kept.push(tool);
  }
  return { kept, gated };
}

/**
 * Parses a skill's `tools:` frontmatter key into the tool names it owns.
 *
 * A skill declares ownership in its own `SKILL.md`, beside the description that
 * already governs when it loads:
 *
 * ```yaml
 * ---
 * name: technical-analysis
 * description: …
 * tools: trade_journal
 * ---
 * ```
 *
 * Ownership is opt-in and one-directional: a tool nobody claims is always
 * offered, so adding this key to one skill cannot hide anyone else's tool.
 *
 * The list grammar itself comes from `agents.ts`, which owns it for every
 * frontmatter in the repo — `SKILL.md` and `agents/*.md` spell a list the same
 * two ways, and two readers of one grammar is exactly the drift the
 * one-parser-per-format rule forbids.
 */
export function parseOwnedTools(frontmatter: string): string[] {
  return extractStringList(frontmatter, "tools");
}

/**
 * Builds the tool → owning-skill map by reading every skill's frontmatter,
 * across one skills root or an ordered list of roots, highest precedence
 * first.
 *
 * Returns an empty map on any failure, and an unreadable `SKILL.md` costs the
 * skill its tools only (the skill's NAME is still claimed, so it shadows), so a
 * broken skill costs only its own gating rather than every tool in the
 * session.
 *
 * Precedence is FIRST ROOT WINS: within one root, skills are ordered by
 * directory name (the `findSkills` sort); across roots, in the caller's root
 * order. So a tool owned by BOTH a project skill and a profile skill is owned
 * by the project skill — the first root — matching the fleet's project-wins
 * rule (`project-layer.ts`). A contested tool stays reachable through one
 * owner rather than becoming unreachable.
 *
 * Shadowing is whole-skill, not per-tool: a skill name an earlier root already
 * claimed is hidden in the later roots and contributes NO tools — the same way
 * `findSkillsIn` hides a same-named profile skill. So if the shadowing
 * (project) skill declares no tools while the hidden profile one did, the
 * tools go dark: shadowing is wholesale, by design.
 *
 * Finds skills at any depth via `skill-tree.ts`, so a skill keeps its tool
 * when it is filed under a category. The key is always the skill *directory*
 * name, never its category path, because that is what the active set holds.
 *
 * Reads every skill's frontmatter once per process and memoizes the result
 * PER DIRECTORY: the gate runs on every `before_agent_start`, and re-reading
 * 50-odd `SKILL.md` files per turn buys nothing — a new skill needs a pi
 * restart to be loadable anyway. The cache key is always a single dir path, so
 * an ordered list merges the per-directory memo, first root winning; the
 * merged result itself is not cached, so a list call always reflects the
 * current per-dir state. An explicit reader/lister bypasses the cache (and
 * writes nothing to it) so tests stay deterministic.
 *
 * @param skillsDirPath - A skills library, or an ordered list of libraries,
 *                        highest precedence first.
 * @param readFile - Injectable reader (tests pass a fake; the extension uses fs).
 * @param readdir - Injectable directory lister, forwarded to the tree walker.
 */
export async function loadSkillToolOwners(
  skillsDirPath: string | readonly string[],
  readFile?: (p: string) => Promise<string>,
  readdir?: (p: string) => Promise<string[]>,
): Promise<Map<string, string>> {
  const dirs = Array.isArray(skillsDirPath) ? skillsDirPath : [skillsDirPath];
  const injected = Boolean(readFile || readdir);
  const merged = new Map<string, string>();
  const claimed = new Set<string>();
  for (const dir of dirs) {
    let owners = ownersCache.get(dir);
    if (injected || !owners) owners = await scanSkillDir(dir, readFile, readdir);
    if (!injected) ownersCache.set(dir, owners);
    for (const [skill, tools] of owners) {
      if (!claimed.has(skill)) for (const tool of tools) merged.set(tool, merged.get(tool) ?? skill);
    }
    for (const skill of owners.keys()) claimed.add(skill);
  }
  return merged;
}

/**
 * One directory's contribution to the tool-owner map: every DISCOVERED skill,
 * keyed by its directory name, with the tools it declares — an empty list when
 * it declares none. The key is what lets the cross-root merge claim skill
 * NAMES: a shadowing skill must be visible to that claim even when it owns
 * nothing, so shadowed skills are kept in the map, only out of the merged
 * tool map.
 * @param dir - Absolute path to the skills library.
 * @param readFile - Injectable reader (tests pass a fake; the extension uses fs).
 * @param readdir - Injectable directory lister, forwarded to the tree walker.
 */
async function scanSkillDir(
  dir: string,
  readFile?: (p: string) => Promise<string>,
  readdir?: (p: string) => Promise<string[]>,
): Promise<Map<string, string[]>> {
  const rf = readFile ?? ((p: string) => fsReadFile(p, "utf-8"));

  // Location is `skill-tree.ts`'s job, not this module's: a skill is nested
  // under its category, and a local `readdir` here would silently stop finding
  // `tools:` the moment one moved (verified — it returned an empty map).
  const located = await findSkills(dir, readdir);

  // The skill *directory* name, not its path: that is the identity the gate
  // checks against the active set, and the name the cross-root claim keys on.
  const owners = new Map<string, string[]>();
  for (const skill of located) {
    let tools: string[] = [];
    try {
      const fm = frontmatterOf(await rf(skill.path));
      if (fm) tools = parseOwnedTools(fm);
    } catch {
      // unreadable: this skill simply owns nothing
    }
    if (!owners.has(skill.dir)) owners.set(skill.dir, tools); // first-discovered wins the name, matching findSkillsIn (skill-tree.ts)
  }
  return owners;
}

/** Memoized {@link loadSkillToolOwners} per-dir scans, keyed by skills directory. */
const ownersCache = new Map<string, Map<string, string[]>>();

/** Clears the owners cache. For tests, for the reload wiring, and for a deliberate re-scan. */
export function clearSkillToolOwnersCache(): void {
  ownersCache.clear();
}
