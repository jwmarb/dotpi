/**
 * Tests for the skill-category grouping (`lib/skill-categories.ts`) and the
 * path-derived category (`lib/skill-tree.ts`).
 *
 * Two mechanisms decide a skill's category, and the split is the thing worth
 * pinning: a local skill's category is its *location*, while a package skill's
 * comes from a name-keyed map because its checkout is vendored and gitignored —
 * this repo cannot move it. The precedence between them, and the behaviour when
 * neither answers, is what these tests hold still.
 *
 * Run from the repo root: `bun test agent/extensions/lib/skill-categories.test.ts`
 */
import { describe, expect, test } from "bun:test";

import {
  CATEGORY_ORDER,
  PACKAGE_SKILL_CATEGORIES,
  UNCATEGORIZED,
  categoryFor,
  groupByCategory,
} from "./skill-categories.js";
import { categoryFromPath } from "./skill-tree.js";

// ---------------------------------------------------------------------------
// categoryFor
// ---------------------------------------------------------------------------

describe("categoryFor", () => {
  test("prefers the path category over the map", () => {
    // The tree the human can see wins. If the map could override it, a stale
    // entry would file a skill somewhere its own path contradicts.
    expect(categoryFor("brainstorming", "language-style")).toBe("language-style");
  });

  test("falls back to the map when the path declares nothing", () => {
    expect(categoryFor("test-driven-development")).toBe("review-and-verification");
  });

  test("an unmapped, unfiled skill degrades to the catch-all, never vanishes", () => {
    // The failure mode that matters: a skill missing from the prompt is a
    // capability the model cannot know it has. Being in the wrong group is a
    // far cheaper mistake than being absent.
    expect(categoryFor("some-new-upstream-skill")).toBe(UNCATEGORIZED);
  });
});

// ---------------------------------------------------------------------------
// categoryFromPath
// ---------------------------------------------------------------------------

describe("categoryFromPath", () => {
  const lib = "/home/j/.pi/agent/skills";

  test("reads the category directory out of a nested skill path", () => {
    expect(categoryFromPath(lib, `${lib}/finance/technical-analysis/SKILL.md`)).toBe("finance");
  });

  test("a skill directly in the library root has no category", () => {
    expect(categoryFromPath(lib, `${lib}/loose-skill/SKILL.md`)).toBeUndefined();
  });

  test("joins a deeper nesting into one label rather than losing a tier", () => {
    expect(categoryFromPath(lib, `${lib}/a/b/skill/SKILL.md`)).toBe("a/b");
  });

  test("a path outside the library is not ours to categorize", () => {
    // Package and project-local skills land here, and must fall through to the
    // name-keyed map rather than being assigned a bogus category built out of
    // "..".
    expect(
      categoryFromPath(lib, "/home/j/.pi/agent/git/github.com/obra/superpowers/skills/x/SKILL.md"),
    ).toBeUndefined();
    expect(categoryFromPath(lib, "/elsewhere/x/SKILL.md")).toBeUndefined();
  });

  test("the library root itself yields nothing", () => {
    expect(categoryFromPath(lib, lib)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// groupByCategory
// ---------------------------------------------------------------------------

describe("groupByCategory", () => {
  const mk = (name: string, pathCategory?: string) => ({ name, pathCategory });

  test("groups by category and sorts skills by name within each", () => {
    const groups = groupByCategory([
      mk("rust-style", "language-style"),
      mk("cpp-style", "language-style"),
      mk("technical-analysis", "finance"),
    ]);
    expect(groups.map((g) => g.category)).toEqual(["language-style", "finance"]);
    expect(groups[0].skills.map((s) => s.name)).toEqual(["cpp-style", "rust-style"]);
  });

  test("orders categories by CATEGORY_ORDER, not alphabetically", () => {
    // The order carries meaning (most-reached-for first), so it must not drift
    // into alphabetical just because the map happened to iterate that way.
    const groups = groupByCategory([
      mk("a", "finance"),
      mk("b", "language-style"),
      mk("c", "git-workflow"),
    ]);
    expect(groups.map((g) => g.category)).toEqual([
      "language-style",
      "git-workflow",
      "finance",
    ]);
  });

  test("an unknown category still renders, sorted after the known ones", () => {
    const groups = groupByCategory([mk("x", "zzz-new"), mk("y", "finance")]);
    expect(groups.map((g) => g.category)).toEqual(["finance", "zzz-new"]);
  });

  test("the catch-all sorts last, after even an unknown category", () => {
    const groups = groupByCategory([mk("unmapped-thing"), mk("x", "zzz-new")]);
    expect(groups.map((g) => g.category)).toEqual(["zzz-new", UNCATEGORIZED]);
  });

  test("is byte-stable regardless of input order", () => {
    // The prompt is rebuilt every turn; an unstable rendering would defeat
    // provider prompt caching and make two sessions incomparable.
    const a = groupByCategory([mk("b", "finance"), mk("a", "language-style")]);
    const b = groupByCategory([mk("a", "language-style"), mk("b", "finance")]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("loses nothing: every input appears exactly once", () => {
    const names = ["a", "b", "c", "d"];
    const groups = groupByCategory([
      mk("a", "finance"),
      mk("b"),
      mk("c", "language-style"),
      mk("d", "finance"),
    ]);
    expect(groups.flatMap((g) => g.skills.map((s) => s.name)).sort()).toEqual(names);
  });

  test("handles an empty inventory", () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the map itself
// ---------------------------------------------------------------------------

describe("PACKAGE_SKILL_CATEGORIES", () => {
  test("every mapped category is one the prompt knows how to order", () => {
    // A typo here would silently create a one-skill category that sorts into
    // the unknown tail — visible, but wrong, and easy to miss by eye.
    for (const [skill, category] of Object.entries(PACKAGE_SKILL_CATEGORIES)) {
      expect(CATEGORY_ORDER, `${skill} -> ${category}`).toContain(category);
    }
  });

  test("the catch-all is last in the order", () => {
    expect(CATEGORY_ORDER[CATEGORY_ORDER.length - 1]).toBe(UNCATEGORIZED);
  });

  test("declares no duplicate category spellings", () => {
    // e.g. both "git-workflow" and "git-worktrees" would split a group in two.
    const used = new Set(Object.values(PACKAGE_SKILL_CATEGORIES));
    for (const c of used) expect(CATEGORY_ORDER).toContain(c);
  });
});
