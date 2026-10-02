/**
 * Which category a skill belongs to — the map from skill identity to the group
 * the orchestrator prompt renders it under.
 *
 * Local skills carry their category in their *path*
 * (`skills/<category>/<skill>/SKILL.md`), which `skill-tree.ts` reads. That is
 * the preferred mechanism: one source of truth, and refiling a skill is a pure
 * `git mv` with no edit anywhere else.
 *
 * Package skills cannot work that way. The 15 skills from the `superpowers`
 * package live in a gitignored vendored checkout (`agent/git/github.com/...`)
 * that this repo does not own and must not edit — upstream decides their layout,
 * and a package update would revert anything written there. Their category
 * therefore has to live here, keyed by name.
 *
 * The cost of this file is drift: a skill upstream renames, or a new one arrives,
 * and the map silently says nothing about it. That is handled by degrading rather
 * than failing — an unmapped skill falls into {@link UNCATEGORIZED} and still
 * appears in the prompt, just under a catch-all heading. A skill the model can
 * see in the wrong group is a small problem; a skill that vanishes from the
 * catalogue is a capability the model cannot know it has.
 *
 * Pure module: no imports at all, so anything may read it.
 *
 * @module extensions/lib/skill-categories
 */

/**
 * Heading for skills with no declared category.
 *
 * Deliberately plain rather than apologetic: it is a real group in the prompt,
 * not an error state.
 */
export const UNCATEGORIZED = "other";

/**
 * Category for each **package** skill, keyed by the skill name pi reports.
 *
 * Grouped to match the local categories so a skill sits with its peers rather
 * than in a "superpowers" bucket that describes where it came from instead of
 * what it does — provenance is already rendered elsewhere, and the model is
 * choosing by capability.
 *
 * Only package skills belong here. A local skill listed here would be a second,
 * competing answer to a question its path already answers.
 */
export const PACKAGE_SKILL_CATEGORIES: Readonly<Record<string, string>> = {
  // superpowers (git:github.com/obra/superpowers)
  brainstorming: "architecture-and-design",
  "writing-plans": "planning-and-tickets",
  "executing-plans": "planning-and-tickets",
  "subagent-driven-development": "planning-and-tickets",
  "dispatching-parallel-agents": "planning-and-tickets",
  "requesting-code-review": "review-and-verification",
  "receiving-code-review": "review-and-verification",
  "test-driven-development": "review-and-verification",
  "systematic-debugging": "review-and-verification",
  "verification-before-completion": "review-and-verification",
  "using-git-worktrees": "git-workflow",
  "finishing-a-development-branch": "git-workflow",
  "writing-skills": "authoring-and-meta",
  "using-superpowers": "authoring-and-meta",
  "diagnosing-superpowers": "authoring-and-meta",
};

/**
 * The order categories appear in the prompt.
 *
 * Fixed rather than alphabetical so the ordering carries meaning: the groups a
 * coding session reaches for most sit at the top, and `other` is last because it
 * is a fallback. A category missing from this list still renders — it sorts after
 * the known ones — so adding a directory never silently hides it.
 */
export const CATEGORY_ORDER: readonly string[] = [
  "language-style",
  "architecture-and-design",
  "planning-and-tickets",
  "review-and-verification",
  "git-workflow",
  "dialogue-and-handoff",
  "research",
  "finance",
  "authoring-and-meta",
  UNCATEGORIZED,
];

/**
 * The category for one skill.
 *
 * Path wins over the map: a local skill's location is authoritative, and
 * consulting the map first would let a stale entry override the tree the human
 * can actually see. Only when there is no category in the path (a package skill,
 * or a local one not yet filed) does the map get a say.
 *
 * @param skill - The skill's name, as pi reports it.
 * @param pathCategory - The category derived from its location, when it has one.
 */
export function categoryFor(skill: string, pathCategory?: string): string {
  if (pathCategory) return pathCategory;
  return PACKAGE_SKILL_CATEGORIES[skill] ?? UNCATEGORIZED;
}

/**
 * Groups skills into categories, ready to render.
 *
 * Sorting is total — categories by {@link CATEGORY_ORDER} then alphabetically,
 * skills by name within each — so the prompt text is byte-stable across runs.
 * An unstable prompt would defeat provider prompt caching and make two sessions
 * incomparable when debugging why a skill was or was not chosen.
 *
 * @param skills - Each skill's name with the category from its path, if any.
 * @returns Non-empty categories in render order.
 */
export function groupByCategory<T extends { name: string; pathCategory?: string }>(
  skills: readonly T[],
): Array<{ category: string; skills: T[] }> {
  const groups = new Map<string, T[]>();
  for (const skill of skills) {
    const category = categoryFor(skill.name, skill.pathCategory);
    const bucket = groups.get(category);
    if (bucket) bucket.push(skill);
    else groups.set(category, [skill]);
  }

  const rank = (c: string) => {
    // The catch-all is last by definition, below even an unrecognized category:
    // a real group the author named is more informative than "other", so it
    // should be read first. Taking its position from CATEGORY_ORDER instead put
    // it *above* unknown categories, since its index there is lower than the
    // unknown rank — the kind of off-by-one that only a test notices.
    if (c === UNCATEGORIZED) return CATEGORY_ORDER.length + 1;
    const i = CATEGORY_ORDER.indexOf(c);
    // Unknown categories sort after known ones, alphabetically among themselves.
    return i === -1 ? CATEGORY_ORDER.length : i;
  };

  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([category, list]) => ({
      category,
      skills: [...list].sort((x, y) => x.name.localeCompare(y.name)),
    }));
}
