/**
 * Tests for skill activation (lib/skill-activation.ts) — the inference that
 * decides whether a skill's tools and agents are offered.
 *
 * The behaviours pinned here were established by probing the installed pi
 * (0.87.1) rather than read off the types: there is no skill_invoke event,
 * `systemPromptOptions.skills` is the full catalogue and not the loaded set, a
 * `/skill:x` invocation appears only as an expanded `<skill …>` block in the turn
 * prompt, and a model-invoked skill appears only as a read_skill tool call.
 *
 * Run from the repo root: `bun test agent/extensions/lib/skill-activation.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SkillActivation,
  clearSkillToolOwnersCache,
  gateTools,
  isSkillLoad,
  loadSkillToolOwners,
  parseOwnedTools,
  skillDirFromPath,
  skillsInPrompt,
} from "./skill-activation.js";

// ---------------------------------------------------------------------------
// skillDirFromPath
// ---------------------------------------------------------------------------

describe("skillDirFromPath", () => {
  test("takes the directory name, not the file name", () => {
    expect(skillDirFromPath("/home/j/.pi/agent/skills/technical-analysis/SKILL.md")).toBe(
      "technical-analysis",
    );
  });

  test("handles a relative path and Windows separators", () => {
    expect(skillDirFromPath("skills/zoom-out/SKILL.md")).toBe("zoom-out");
    expect(skillDirFromPath("C:\\pi\\skills\\tdd\\SKILL.md")).toBe("tdd");
  });

  test("a sibling reference doc still identifies the skill", () => {
    // journal.md / gamma.md live beside SKILL.md and imply the same skill.
    expect(skillDirFromPath("/skills/technical-analysis/gamma.md")).toBe("technical-analysis");
  });
});

// ---------------------------------------------------------------------------
// skillsInPrompt
// ---------------------------------------------------------------------------

describe("skillsInPrompt", () => {
  const block = (name: string, dir = name) =>
    `<skill name="${name}" location="/home/j/.pi/agent/skills/${dir}/SKILL.md">\nbody\n</skill>`;

  test("finds a skill expanded into the turn prompt", () => {
    expect(skillsInPrompt(block("technical-analysis"))).toEqual(["technical-analysis"]);
  });

  test("finds several, de-duplicated", () => {
    expect(skillsInPrompt(`${block("zoom-out")}\n${block("tdd")}\n${block("tdd")}`)).toEqual([
      "zoom-out",
      "tdd",
    ]);
  });

  test("keys on the location directory, not the frontmatter name", () => {
    // Nothing enforces that a skill's `name` matches its directory.
    expect(skillsInPrompt(block("Fancy Name", "actual-dir"))).toEqual(["actual-dir"]);
  });

  test("a plain prompt yields nothing", () => {
    expect(skillsInPrompt("what is the price of SPY")).toEqual([]);
    expect(skillsInPrompt("")).toEqual([]);
    expect(skillsInPrompt(undefined as unknown as string)).toEqual([]);
  });

  test("prose mentioning a skill name does not activate it", () => {
    expect(skillsInPrompt("use the technical-analysis skill please")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isSkillLoad
// ---------------------------------------------------------------------------

describe("isSkillLoad", () => {
  test("detects read_skill on a SKILL.md", () => {
    expect(isSkillLoad("read_skill", { path: "/skills/technical-analysis/SKILL.md" })).toBe(
      "technical-analysis",
    );
  });

  test("detects a plain read of a SKILL.md, and a bare string input", () => {
    expect(isSkillLoad("read", { path: "/skills/tdd/SKILL.md" })).toBe("tdd");
    expect(isSkillLoad("read_skill", "/skills/tdd/SKILL.md")).toBe("tdd");
  });

  test("ignores other files and other tools", () => {
    expect(isSkillLoad("read", { path: "/skills/tdd/tests.md" })).toBeUndefined();
    expect(isSkillLoad("write", { path: "/skills/tdd/SKILL.md" })).toBeUndefined();
    expect(isSkillLoad("bash", { command: "cat SKILL.md" })).toBeUndefined();
    expect(isSkillLoad("read", {})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SkillActivation
// ---------------------------------------------------------------------------

describe("SkillActivation", () => {
  const block = (dir: string) =>
    `<skill name="${dir}" location="/skills/${dir}/SKILL.md">body</skill>`;

  test("starts empty, so nothing skill-owned is offered by default", () => {
    expect(new SkillActivation().list()).toEqual([]);
    expect(new SkillActivation().has("technical-analysis")).toBe(false);
  });

  test("activates from a prompt and reports what is new", () => {
    const a = new SkillActivation();
    expect(a.notePrompt(block("technical-analysis"))).toEqual(["technical-analysis"]);
    expect(a.has("technical-analysis")).toBe(true);
    // Already active: no longer "new", still active.
    expect(a.notePrompt(block("technical-analysis"))).toEqual([]);
    expect(a.has("technical-analysis")).toBe(true);
  });

  test("activates from a model-invoked tool call", () => {
    const a = new SkillActivation();
    expect(a.noteToolCall("read_skill", { path: "/skills/research/SKILL.md" })).toEqual([
      "research",
    ]);
    expect(a.has("research")).toBe(true);
  });

  test("stays active on later turns that do not mention it", () => {
    // The skill's guidance is still in context, so its tools must not vanish.
    const a = new SkillActivation();
    a.notePrompt(block("technical-analysis"));
    a.notePrompt("a normal follow-up question");
    expect(a.has("technical-analysis")).toBe(true);
  });

  test("reset clears everything, for a new session", () => {
    const a = new SkillActivation();
    a.notePrompt(block("tdd"));
    a.reset();
    expect(a.list()).toEqual([]);
  });

  test("list is sorted", () => {
    // Through the public surface: three skills expanded into one prompt arrive in
    // prompt order, and `list()` is what sorts them.
    const a = new SkillActivation();
    a.notePrompt(`${block("zoom-out")}\n${block("tdd")}\n${block("research")}`);
    expect(a.list()).toEqual(["research", "tdd", "zoom-out"]);
  });
});

// ---------------------------------------------------------------------------
// gateTools
// ---------------------------------------------------------------------------

describe("gateTools", () => {
  const owners = new Map([["trade_journal", "technical-analysis"]]);

  test("withholds an owned tool while its skill is inactive", () => {
    const { kept, gated } = gateTools(["read", "trade_journal", "bash"], owners, () => false);
    expect(kept).toEqual(["read", "bash"]);
    expect(gated).toEqual(["trade_journal"]);
  });

  test("offers it once the skill is active", () => {
    const { kept, gated } = gateTools(
      ["read", "trade_journal", "bash"],
      owners,
      (d) => d === "technical-analysis",
    );
    expect(kept).toEqual(["read", "trade_journal", "bash"]);
    expect(gated).toEqual([]);
  });

  test("an unowned tool is never gated", () => {
    // Ownership is opt-in: no declaration means always offered.
    const { kept, gated } = gateTools(["read", "todo"], new Map(), () => false);
    expect(kept).toEqual(["read", "todo"]);
    expect(gated).toEqual([]);
  });

  test("preserves order and tolerates an empty list", () => {
    expect(gateTools(["c", "a", "b"], new Map(), () => false).kept).toEqual(["c", "a", "b"]);
    expect(gateTools([], owners, () => true)).toEqual({ kept: [], gated: [] });
  });
});

// ---------------------------------------------------------------------------
// parseOwnedTools
// ---------------------------------------------------------------------------

describe("parseOwnedTools", () => {
  test("reads an inline list", () => {
    expect(parseOwnedTools("name: x\ntools: trade_journal, ledger\n")).toEqual(["trade_journal", "ledger"]);
  });

  test("reads a block list", () => {
    expect(parseOwnedTools("name: x\ntools:\n  - trade_journal\n  - ledger\n")).toEqual([
      "trade_journal",
      "ledger",
    ]);
  });

  test("absent key means the skill owns nothing", () => {
    expect(parseOwnedTools("name: x\ndescription: y\n")).toEqual([]);
  });

  test("is not confused by a description mentioning tools", () => {
    expect(parseOwnedTools("description: uses tools: many\nname: x\n")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadSkillToolOwners
// ---------------------------------------------------------------------------

describe("loadSkillToolOwners", () => {
  /**
   * A fake skills tree keyed by path relative to `/skills`.
   *
   * `readdir` is path-aware on purpose. It used to ignore its argument and
   * always return the top-level listing, which worked only because the reader
   * scanned exactly one level; against a recursive walker that fake describes an
   * infinitely self-repeating tree. Deriving each directory's real children is
   * what lets these fixtures describe the nested layout the library actually has.
   */
  const fake = (files: Record<string, string>) => ({
    readdir: async (p: string) => {
      const rel = p.replace(/^\/skills\/?/, "");
      const prefix = rel ? `${rel}/` : "";
      const children = new Set<string>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const next = path.slice(prefix.length).split("/")[0];
        if (next) children.add(next);
      }
      // A path with no children is not a directory; the real readdir throws.
      if (children.size === 0) throw new Error("ENOTDIR");
      return [...children];
    },
    readFile: async (p: string) => {
      const rel = p.replace(/^\/skills\//, "");
      if (!(rel in files)) throw new Error("ENOENT");
      return files[rel];
    },
  });

  test("maps a declared tool to its owning skill directory", async () => {
    const f = fake({
      "finance/technical-analysis/SKILL.md":
        "---\nname: technical-analysis\ntools: trade_journal\n---\nbody",
      "review/tdd/SKILL.md": "---\nname: tdd\ndescription: no tools\n---\nbody",
    });
    const owners = await loadSkillToolOwners("/skills", f.readFile, f.readdir);
    // Keyed by the skill directory, never `finance/technical-analysis`: the
    // category is organizational and must not leak into the identity the gate
    // compares against the active set.
    expect([...owners]).toEqual([["trade_journal", "technical-analysis"]]);
  });

  test("a missing or unreadable SKILL.md costs only that skill", async () => {
    const f = fake({
      "meta/broken/notes.md": "no skill file here",
      "finance/technical-analysis/SKILL.md": "---\nname: ta\ntools: trade_journal\n---\n",
    });
    const owners = await loadSkillToolOwners("/skills", f.readFile, f.readdir);
    expect(owners.get("trade_journal")).toBe("technical-analysis");
  });

  test("first claimant wins a contested tool, so it stays reachable", async () => {
    const f = fake({
      "one/aaa/SKILL.md": "---\nname: aaa\ntools: shared\n---\n",
      "two/zzz/SKILL.md": "---\nname: zzz\ntools: shared\n---\n",
    });
    const owners = await loadSkillToolOwners("/skills", f.readFile, f.readdir);
    // Ordered by skill name, so the winner does not depend on which category
    // happens to sort first.
    expect(owners.get("shared")).toBe("aaa");
  });

  test("still finds a skill sitting directly in the skills root", async () => {
    // Categories are the convention, not a hard requirement: pi itself loads a
    // flat skill, so a newly-added one must not lose its tools before it is
    // filed. The live-tree test is what keeps the real library tidy.
    const f = fake({
      "loose-skill/SKILL.md": "---\nname: loose-skill\ntools: solo\n---\n",
    });
    const owners = await loadSkillToolOwners("/skills", f.readFile, f.readdir);
    expect(owners.get("solo")).toBe("loose-skill");
  });

  test("does not descend into a skill's own directory", async () => {
    // A reference doc named SKILL.md inside a skill would otherwise register as
    // a second skill and could outrank its own parent for a contested tool.
    const f = fake({
      "research/digger/SKILL.md": "---\nname: digger\ntools: shovel\n---\n",
      "research/digger/nested/SKILL.md": "---\nname: nested\ntools: shovel\n---\n",
    });
    const owners = await loadSkillToolOwners("/skills", f.readFile, f.readdir);
    expect(owners.get("shovel")).toBe("digger");
    expect([...owners.values()]).not.toContain("nested");
  });

  test("one root: the first-discovered same-named skill dir owns the tools", async () => {
    // Sorted DFS reaches depth-1 `aaa` before `zzz/aaa`, so the FIRST-discovered
    // dir wins the name — the same rule `findSkillsIn` applies across roots.
    const f = fake({
      "aaa/SKILL.md": "---\nname: aaa\ntools: first_tool\n---\n",
      "zzz/aaa/SKILL.md": "---\nname: aaa\ntools: second_tool\n---\n",
    });
    const owners = await loadSkillToolOwners("/skills", f.readFile, f.readdir);
    expect(owners.get("first_tool")).toBe("aaa");
    expect(owners.has("second_tool")).toBe(false);
  });

  test("an unreadable skills directory yields an empty map, gating nothing", async () => {
    const owners = await loadSkillToolOwners(
      "/nope",
      async () => {
        throw new Error("ENOENT");
      },
      async () => {
        throw new Error("ENOENT");
      },
    );
    expect(owners.size).toBe(0);
  });
  /**
   * A fake of two skills roots, keyed by path under each root.
   *
   * The single-root fake above cannot express "the same tool claimed by two
   * roots": the path prefix would have to distinguish them, and it does not.
   */
  const fakeRoots = (roots: Record<string, Record<string, string>>) => ({
    readdir: async (p: string) => {
      for (const [root, files] of Object.entries(roots)) {
        if (p !== root && !p.startsWith(root + "/")) continue;
        const rel = p.slice(root.length).replace(/^\//, "");
        const prefix = rel ? `${rel}/` : "";
        const children = new Set<string>();
        for (const path of Object.keys(files)) {
          if (!path.startsWith(prefix)) continue;
          const next = path.slice(prefix.length).split("/")[0];
          if (next) children.add(next);
        }
        if (children.size === 0) throw new Error("ENOTDIR");
        return [...children];
      }
      throw new Error("ENOTDIR");
    },
    readFile: async (p: string) => {
      for (const [root, files] of Object.entries(roots)) {
        if (!p.startsWith(root + "/")) continue;
        const rel = p.slice(root.length + 1);
        if (rel in files) return files[rel];
      }
      throw new Error("ENOENT");
    },
  });

  test("merges an ordered dir list, first root winning a contested tool", async () => {
    // The project layer is the first root: a tool owned by both a project
    // skill and a profile skill is owned by the project skill.
    const f = fakeRoots({
      "/proj/.pi/skills": {
        "cat/aaa/SKILL.md": "---\nname: aaa\ntools: shared, proj_only\n---\n",
      },
      "/home/u/.pi/agent/skills": {
        "cat/zzz/SKILL.md": "---\nname: zzz\ntools: shared, prof_only\n---\n",
      },
    });
    const owners = await loadSkillToolOwners(
      ["/proj/.pi/skills", "/home/u/.pi/agent/skills"],
      f.readFile,
      f.readdir,
    );
    expect(owners.get("shared")).toBe("aaa");
    expect(owners.get("proj_only")).toBe("aaa");
    expect(owners.get("prof_only")).toBe("zzz");
  });

  test("a shadowed skill contributes no tools: the shadowing skill's silence wins", async () => {
    // The project `foo` declares no tools; the profile `foo` owns `t`. The
    // profile skill is SHADOWED wholesale, so its tools go dark — they are not
    // re-offered by the hidden skill.
    const f = fakeRoots({
      "/proj/.pi/skills": {
        "cat/foo/SKILL.md": "---\nname: foo\n---\n",
      },
      "/home/u/.pi/agent/skills": {
        "cat/foo/SKILL.md": "---\nname: foo\ntools: t\n---\n",
      },
    });
    const owners = await loadSkillToolOwners(
      ["/proj/.pi/skills", "/home/u/.pi/agent/skills"],
      f.readFile,
      f.readdir,
    );
    expect(owners.has("t")).toBe(false);
  });

  test("a shadowed skill's tools fall to a sibling, not to the hidden skill", async () => {
    // Profile `foo` (shadowed by the project `foo`) owns `x`, and profile
    // `zzz` owns it too: `zzz` is not shadowed, so `x` stays reachable through
    // it.
    const f = fakeRoots({
      "/proj/.pi/skills": {
        "cat/foo/SKILL.md": "---\nname: foo\n---\n",
      },
      "/home/u/.pi/agent/skills": {
        "cat/foo/SKILL.md": "---\nname: foo\ntools: x\n---\n",
        "cat/zzz/SKILL.md": "---\nname: zzz\ntools: x\n---\n",
      },
    });
    const owners = await loadSkillToolOwners(
      ["/proj/.pi/skills", "/home/u/.pi/agent/skills"],
      f.readFile,
      f.readdir,
    );
    expect(owners.get("x")).toBe("zzz");
  });
  test("reversing the root order reverses the winner", async () => {
    const f = fakeRoots({
      "/proj/.pi/skills": {
        "cat/aaa/SKILL.md": "---\nname: aaa\ntools: shared\n---\n",
      },
      "/home/u/.pi/agent/skills": {
        "cat/zzz/SKILL.md": "---\nname: zzz\ntools: shared\n---\n",
      },
    });
    const owners = await loadSkillToolOwners(
      ["/home/u/.pi/agent/skills", "/proj/.pi/skills"],
      f.readFile,
      f.readdir,
    );
    expect(owners.get("shared")).toBe("zzz");
  });

  test("a single dir works through the union signature", async () => {
    const f = fake({
      "finance/technical-analysis/SKILL.md":
        "---\nname: technical-analysis\ntools: trade_journal\n---\n",
    });
    const owners = await loadSkillToolOwners("/skills", f.readFile, f.readdir);
    expect(owners.get("trade_journal")).toBe("technical-analysis");
  });

  test("memoizes per directory, and clearSkillToolOwnersCache forces a re-scan", async () => {
    const root = join(tmpdir(), `skill-owners-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const dir = join(root, "cat", "foo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: foo\ntools: first\n---\n");
    const first = await loadSkillToolOwners(root);
    expect(first.get("first")).toBe("foo");

    // The file changed on disk; the cached map still says what it read.
    writeFileSync(join(dir, "SKILL.md"), "---\nname: foo\ntools: second\n---\n");
    const cached = await loadSkillToolOwners(root);
    expect(cached.get("first")).toBe("foo");
    expect(cached.has("second")).toBe(false);

    clearSkillToolOwnersCache();
    const fresh = await loadSkillToolOwners(root);
    expect(fresh.get("second")).toBe("foo");
    expect(fresh.has("first")).toBe(false);
  });

  test("a list call keeps the per-directory memo, first root winning after a re-scan", async () => {
    const mk = (label: string, skillName: string, tools: string) => {
      const root = join(tmpdir(), `skill-owners-list-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const dir = join(root, "cat", skillName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skillName}\ntools: ${tools}\n---\n`);
      return root;
    };
    const a = mk("a", "foo", "first");
    const b = mk("b", "bar", "other");
    const merged = await loadSkillToolOwners([a, b]);
    expect(merged.get("first")).toBe("foo");
    expect(merged.get("other")).toBe("bar");

    // rootA changed on disk; the per-dir memo keeps the old entry until
    // cleared — the merged result is always rebuilt from the per-dir state.
    const dirA = join(a, "cat", "foo");
    writeFileSync(join(dirA, "SKILL.md"), "---\nname: foo\ntools: first2\n---\n");
    const mergedStale = await loadSkillToolOwners([a, b]);
    expect(mergedStale.get("first")).toBe("foo");
    expect(mergedStale.get("other")).toBe("bar");

    clearSkillToolOwnersCache();
    const mergedFresh = await loadSkillToolOwners([a, b]);
    expect(mergedFresh.get("first2")).toBe("foo");
    expect(mergedFresh.get("other")).toBe("bar");
  });
});
