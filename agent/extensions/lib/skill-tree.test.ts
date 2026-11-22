/**
 * Tests for the skills-tree walker (lib/skill-tree.ts) — the single owner of
 * the skills-tree layout — including `findSkillsIn`, the ordered-roots union
 * the project layer scans through.
 *
 * Every fixture is a tmpdir tree shaped like the real library
 * (`<root>/<category>/<skill>/SKILL.md`), because a flat, SKILL.md-less
 * fixture describes a tree that is not a skills tree at all.
 *
 * Run from the repo root: `bun test agent/extensions/lib/skill-tree.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findSkills, findSkillsIn, isUnder } from "./skill-tree.js";

/** A throwaway skills root: `<root>/<category>/<skill>/SKILL.md`. */
function skillRoot(label: string, skills: Record<string, string>): string {
  const root = join(tmpdir(), `skills-tree-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const [skill, body] of Object.entries(skills)) {
    const dir = join(root, `cat-${skill}`, skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), body);
  }
  return root;
}

const skill = (name: string, tools = "") =>
  `---\nname: ${name}\ndescription: ${name} skill\n${tools}---\nBody.`;

describe("findSkills", () => {
  test("finds nested skills, keyed by directory name", async () => {
    const root = skillRoot("nested", {
      "technical-analysis": skill("technical-analysis"),
      tdd: skill("tdd"),
    });
    const skills = await findSkills(root);
    expect(skills.map((s) => s.dir)).toEqual(["tdd", "technical-analysis"]);
    expect(skills[1].category).toBe("cat-technical-analysis");
    expect(skills[1].root).toBe(join(root, "cat-technical-analysis", "technical-analysis"));
  });

  test("a missing root yields []", async () => {
    expect(await findSkills(join(tmpdir(), "no-such-skill-root-xyz"))).toEqual([]);
  });
});

describe("findSkillsIn", () => {
  test("first root wins a same-named skill, wholesale", async () => {
    // The project layer is the first root: a project skill `foo` replaces the
    // profile's `foo` entirely — the returned location must be the first
    // root's copy, so its agents/ and tools: are what the fleet sees.
    const a = skillRoot("first-wins-a", {
      foo: skill("foo", "tools: a_tool\n"),
      bar: skill("bar"),
    });
    const b = skillRoot("first-wins-b", {
      foo: skill("foo", "tools: b_tool\n"),
      baz: skill("baz"),
    });
    const skills = await findSkillsIn([a, b]);
    expect(skills.map((s) => s.dir)).toEqual(["bar", "baz", "foo"]);
    const foo = skills.find((s) => s.dir === "foo")!;
    expect(foo.root).toBe(join(a, "cat-foo", "foo"));
    expect(foo.path).toBe(join(a, "cat-foo", "foo", "SKILL.md"));
  });

  test("keeps distinct skills from every root", async () => {
    const a = skillRoot("union-a", { alpha: skill("alpha") });
    const b = skillRoot("union-b", { beta: skill("beta") });
    expect((await findSkillsIn([a, b])).map((s) => s.dir)).toEqual(["alpha", "beta"]);
  });

  test("a missing root costs only that branch", async () => {
    const a = skillRoot("missing-branch", { alpha: skill("alpha") });
    const skills = await findSkillsIn([join(tmpdir(), "no-such-root-xyz"), a]);
    expect(skills.map((s) => s.dir)).toEqual(["alpha"]);
  });

  test("an empty list yields []", async () => {
    expect(await findSkillsIn([])).toEqual([]);
  });
  test("an empty list yields []", async () => {
    expect(await findSkillsIn([])).toEqual([]);
  });
});

describe("isUnder", () => {
  test("a path is under its own root, and nesting is under too", () => {
    expect(isUnder("/a/b", "/a/b")).toBe(true);
    expect(isUnder("/a/b", "/a/b/c")).toBe(true);
    expect(isUnder("/a/b", "/a/b/c/d/e")).toBe(true);
  });

  test("a sibling with a shared prefix is NOT under the root (the separator is honored)", () => {
    // The live bug this exists for: "/a/bc" starts with "/a/b" but is not
    // inside it — a bare startsWith would claim the sibling's skills.
    expect(isUnder("/a/b", "/a/bc")).toBe(false);
    expect(isUnder("/proj/.pi/skills", "/proj/.pi/skills-x/foo/SKILL.md")).toBe(false);
  });

  test("ancestors and unrelated paths are not under", () => {
    expect(isUnder("/a/b", "/a")).toBe(false);
    expect(isUnder("/x/y", "/a/b")).toBe(false);
  });

  test("unresolved dots are honored textually — callers pass resolved paths", () => {
    // Pure string logic: "/a/b/../c" is textually under "/a/b/". The callers
    // (agents.ts:159 and project-layer.ts resourceRoots resolve) pass
    // normalized paths, so the dot case never reaches the function in the wild.
    expect(isUnder("/a/b", "/a/b/../c")).toBe(true);
  });

  test("a root spelled with a trailing separator does not double it", () => {
    // The formula is the spec's: `p === root || startsWith(root + sep)`, so a
    // trailing-sep root matches same-spelling paths and nesting, nothing else.
    expect(isUnder("/a/b/", "/a/b/")).toBe(true);
    expect(isUnder("/a/b/", "/a/b/c")).toBe(true);
    expect(isUnder("/a/b/", "/a/bc")).toBe(false);
  });
});
