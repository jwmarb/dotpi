/**
 * Where skills live on disk — the single owner of the skills-tree *layout*.
 *
 * `agent/skills/` is organized by category (`skills/<category>/<skill>/SKILL.md`)
 * rather than flat (`skills/<skill>/SKILL.md`), and this module is the one place
 * that knows how to find a skill in it.
 *
 * It exists because the alternative already bit this repo once. Three readers
 * each did their own one-level `readdir` of `agent/skills/`:
 *
 *   - `loadSkillToolOwners` (`skill-activation.ts`) — tool gating
 *   - `discoverSkillAgents` (`agents.ts`) — skill-shipped subagents
 *   - `discoverSkills` (`subagent-herdr/lib.ts`) — the `skills:` key
 *
 * Nesting breaks all three **silently**. pi's own loader recurses
 * (`dist/core/skills.js`), so a nested skill still appears in the catalogue and
 * still loads when invoked — but a one-level reader never sees its frontmatter,
 * so its `tools:` is never registered and its `agents/` never found. Measured,
 * not assumed: pointing the old readers at a nested fixture returned
 * `tool owners: []` and `skill agents: []` with no error raised.
 *
 * The discovery rule mirrors pi's exactly, because two different answers to
 * "what is a skill directory" is the same drift the one-parser-per-format rule
 * forbids: **a directory containing `SKILL.md` is a skill root and is not
 * descended into**; anything else is a container to recurse through.
 *
 * Pure module: `node:fs/promises` + `node:path` only, no pi import (the `lib/`
 * rule), so extension top-level code can import it.
 *
 * @module extensions/lib/skill-tree
 */
import { readdir as fsReaddir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** The filename that marks a directory as a skill root. */
const SKILL_FILE = "SKILL.md";

/**
 * How deep to search below the skills directory.
 *
 * Two levels covers `<category>/<skill>/` with room for one more nesting tier.
 * The cap is a safety rail, not a feature: `readdir` follows symlinks, and a
 * link pointing at an ancestor would otherwise recurse until the process died.
 * A skill buried deeper than this is simply not found — which the live-tree test
 * (`skill-catalogue.test.ts`) turns into a failure rather than a mystery.
 */
const MAX_DEPTH = 4;

/** A skill located on disk. */
export interface SkillLocation {
  /**
   * The skill directory's own name — `technical-analysis`, never
   * `finance/technical-analysis`.
   *
   * This is the skill's *identity*: the string the `skills:` frontmatter key
   * names, that `skillDirFromPath` derives from a loaded path, and that the tool
   * gate matches on. Keeping it independent of the category is what makes
   * recategorizing a skill a pure move with no edits anywhere else.
   */
  dir: string;
  /** Absolute path to the skill's `SKILL.md`. */
  path: string;
  /** Absolute path to the skill's directory (the parent of `SKILL.md`). */
  root: string;
  /**
   * The category path above the skill, POSIX-separated (`finance`), or
   * undefined for a skill sitting directly in the skills root.
   *
   * Derived from the location rather than declared in frontmatter: one source of
   * truth, so a skill cannot be filed in one place and claim another.
   */
  category?: string;
}

/**
 * Finds every skill under `skillsDirPath`, at any supported depth.
 *
 * Failure behaviour is part of the contract, and matches the readers that call
 * it: an unreadable directory yields no skills from that branch rather than
 * throwing, so one bad subtree costs only itself. A missing skills directory
 * yields `[]`.
 *
 * @param skillsDirPath - Absolute path to the skills library.
 * @param readdir - Injectable lister. Takes the same
 *        `(path) => Promise<string[]>` shape the existing callers already
 *        inject, which is why directories are detected by *listing* an entry
 *        rather than by `stat`: a plain file simply fails to list and is
 *        skipped. Tests pass a fake; the extensions use fs.
 * @returns Skills sorted by identity, so callers get a stable order and
 *          first-wins tie-breaks stay deterministic.
 */
export async function findSkills(
  skillsDirPath: string,
  readdir?: (p: string) => Promise<string[]>,
): Promise<SkillLocation[]> {
  const rd = readdir ?? ((p: string) => fsReaddir(p));
  const out: SkillLocation[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = await rd(dir);
    } catch {
      return; // not a directory, or unreadable: this branch yields nothing
    }

    // pi's rule: a SKILL.md makes this a skill root, and its contents are not
    // searched. Without the early return, a reference doc named SKILL.md inside
    // a skill would register as a second skill shadowing its own parent.
    if (entries.includes(SKILL_FILE)) {
      const rel = relative(skillsDirPath, dir);
      const segments = rel.split(sep).filter(Boolean);
      out.push({
        dir: segments[segments.length - 1] ?? "",
        path: join(dir, SKILL_FILE),
        root: dir,
        category: segments.length > 1 ? segments.slice(0, -1).join("/") : undefined,
      });
      return;
    }

    for (const entry of entries.sort()) {
      // Mirrors pi: dotfiles are config, node_modules is a dependency tree, and
      // scanning either is how a skills scan becomes a disk crawl.
      if (entry.startsWith(".") || entry === "node_modules") continue;
      await walk(join(dir, entry), depth + 1);
    }
  }

  await walk(skillsDirPath, 0);
  // A skill at the root has no category segment and yields dir "" — drop it
  // rather than letting an empty identity match an empty `skills:` entry.
  return out.filter((s) => s.dir !== "").sort((a, b) => a.dir.localeCompare(b.dir));
}
