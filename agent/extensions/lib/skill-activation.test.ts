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

import {
  SkillActivation,
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
  const fake = (files: Record<string, string>) => ({
    readdir: async () => [...new Set(Object.keys(files).map((p) => p.split("/")[0]))],
    readFile: async (p: string) => {
      const rel = p.replace(/^\/skills\//, "");
      if (!(rel in files)) throw new Error("ENOENT");
      return files[rel];
    },
  });

  test("maps a declared tool to its owning skill directory", async () => {
    const f = fake({
      "technical-analysis/SKILL.md": "---\nname: technical-analysis\ntools: trade_journal\n---\nbody",
      "tdd/SKILL.md": "---\nname: tdd\ndescription: no tools\n---\nbody",
    });
    const owners = await loadSkillToolOwners("/skills", f.readFile, f.readdir);
    expect([...owners]).toEqual([["trade_journal", "technical-analysis"]]);
  });

  test("a missing or unreadable SKILL.md costs only that skill", async () => {
    const f = fake({
      "broken/notes.md": "no skill file here",
      "technical-analysis/SKILL.md": "---\nname: ta\ntools: trade_journal\n---\n",
    });
    const owners = await loadSkillToolOwners("/skills", f.readFile, f.readdir);
    expect(owners.get("trade_journal")).toBe("technical-analysis");
  });

  test("first claimant wins a contested tool, so it stays reachable", async () => {
    const f = fake({
      "aaa/SKILL.md": "---\nname: aaa\ntools: shared\n---\n",
      "zzz/SKILL.md": "---\nname: zzz\ntools: shared\n---\n",
    });
    const owners = await loadSkillToolOwners("/skills", f.readFile, f.readdir);
    expect(owners.get("shared")).toBe("aaa");
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
});
