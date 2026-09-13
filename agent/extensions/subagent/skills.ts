/**
 * Skill resolution and preloading for subagents.
 *
 * The orchestrator can name skills when delegating a task. Those skills are
 * resolved to their SKILL.md files and injected verbatim into the subagent's
 * system prompt, so the subagent starts with the knowledge already in context
 * instead of having to discover and read it (which it often cannot do, since
 * subagents run non-interactively and may not have a read tool).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir, loadSkills, type Skill } from '@mariozechner/pi-coding-agent';

/** Maximum bytes of skill content injected into a single subagent's prompt. */
export const MAX_SKILL_BYTES = 80_000;

/** A skill that was resolved and read successfully. */
export interface PreloadedSkill {
  /** Skill name as declared in its frontmatter. */
  name: string;
  /** Short description from frontmatter. */
  description: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Directory holding the skill and its bundled resources. */
  baseDir: string;
  /** Full Markdown body of SKILL.md (frontmatter included). */
  content: string;
}

/** Outcome of resolving a list of requested skill names. */
export interface SkillResolution {
  /** Skills that were found and read. */
  loaded: PreloadedSkill[];
  /** Requested names that matched no known skill, each with a hint. */
  missing: { name: string; suggestion?: string }[];
  /** Names dropped because the byte budget was already exhausted. */
  skipped: string[];
  /** All discoverable skill names, for error messages. */
  available: string[];
}

/**
 * Discover every skill visible from `cwd` (user-global and project-local).
 *
 * @param cwd - Working directory used to resolve project-local skills.
 * @returns Discovered skills, or an empty list if discovery fails.
 */
function discoverSkills(cwd: string): Skill[] {
  try {
    return loadSkills({
      cwd,
      agentDir: getAgentDir(),
      skillPaths: [],
      includeDefaults: true,
    }).skills;
  } catch {
    return [];
  }
}

/**
 * Normalize a skill name for tolerant matching.
 *
 * Strips a leading `/skill:` prefix and any non-alphanumeric characters so
 * `/skill:code-review`, `code_review`, and `CodeReview` all match `code-review`.
 *
 * @param name - Raw name as supplied by the caller.
 * @returns Lowercase alphanumeric key.
 */
function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/^\/?skill:/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

/**
 * Find the closest available skill name, used to suggest a fix for a typo.
 *
 * Uses a cheap containment heuristic rather than full edit distance.
 *
 * @param requested - Normalized requested name.
 * @param skills - All discovered skills.
 * @returns The best candidate name, or undefined if nothing looks close.
 */
function suggestName(requested: string, skills: Skill[]): string | undefined {
  if (!requested) return undefined;
  for (const skill of skills) {
    const key = normalizeName(skill.name);
    if (key.includes(requested) || requested.includes(key)) return skill.name;
  }
  return undefined;
}

/**
 * Resolve requested skill names to their file contents.
 *
 * Duplicate names are collapsed. Loading is all-or-nothing per skill: a skill is
 * either injected whole or reported in `skipped`. A partially injected skill is
 * worse than an absent one, because the subagent would follow half a methodology
 * while believing it had the whole thing.
 *
 * @param cwd - Working directory used to resolve project-local skills.
 * @param names - Skill names requested by the orchestrator.
 * @returns Loaded skills, unresolved names, over-budget names, and the available list.
 */
export function resolveSkills(cwd: string, names: string[]): SkillResolution {
  const skills = discoverSkills(cwd);
  const available = skills.map((s) => s.name).sort();

  const byKey = new Map<string, Skill>();
  for (const skill of skills) byKey.set(normalizeName(skill.name), skill);

  const loaded: PreloadedSkill[] = [];
  const missing: { name: string; suggestion?: string }[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let budget = MAX_SKILL_BYTES;

  for (const raw of names) {
    const key = normalizeName(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const skill = byKey.get(key);
    if (!skill) {
      missing.push({ name: raw, suggestion: suggestName(key, skills) });
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(skill.filePath, 'utf-8');
    } catch {
      missing.push({ name: raw });
      continue;
    }

    // All-or-nothing: never inject a fragment of a skill.
    const size = Buffer.byteLength(content, 'utf-8');
    if (size > budget) {
      skipped.push(skill.name);
      continue;
    }
    budget -= size;

    loaded.push({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      content,
    });
  }

  return { loaded, missing, skipped, available };
}

/**
 * List the bundled resource files that sit alongside a skill.
 *
 * Subagents are told these paths exist so they can read them on demand rather
 * than having every reference file preloaded.
 *
 * @param baseDir - The skill's directory.
 * @param skillFilePath - Path to SKILL.md, excluded from the listing.
 * @returns Relative paths of sibling files, capped at 20 entries.
 */
function listBundledResources(baseDir: string, skillFilePath: string): string[] {
  const results: string[] = [];

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > 2 || results.length >= 20) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 20) return;
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel, depth + 1);
      } else if (full !== skillFilePath) {
        results.push(rel);
      }
    }
  };

  walk(baseDir, '', 0);
  return results;
}

/**
 * Render preloaded skills as a system-prompt section.
 *
 * @param loaded - Skills resolved by {@link resolveSkills}.
 * @returns Markdown to append to the subagent's system prompt, or "" if none.
 */
export function formatPreloadedSkills(loaded: PreloadedSkill[]): string {
  if (loaded.length === 0) return '';

  const blocks = loaded.map((skill) => {
    const resources = listBundledResources(skill.baseDir, skill.filePath);
    const header = [
      `### Skill: ${skill.name}`,
      '',
      `Source: ${skill.filePath}`,
      resources.length > 0
        ? `Bundled resources (read these from ${skill.baseDir} if the skill refers to them): ${resources.join(', ')}`
        : null,
      '',
    ]
      .filter((line) => line !== null)
      .join('\n');

    return `${header}${skill.content.trim()}`;
  });

  return [
    '# Preloaded Skills',
    '',
    'The orchestrator loaded the following skills for this task. They are already in your context — do not go looking for them.',
    'Treat them as binding instructions for how to do this work, ranked above your own default habits where the two disagree.',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}
