/**
 * Tests for the agent-definition parser (lib/agents.ts) — the single owner
 * of the `agent/agents/*.md` frontmatter grammar.
 *
 * Run from the repo root: `bun test agent/extensions/lib/agents.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  delegationRoster,
  discoverAgents,
  discoverAgentsIn,
  discoverSkillAgents,
  mergeAgents,
  parseAgentFile,
  type AgentInfo,
} from "./agents.js";
import { resourceRoots } from "./project-layer.js";

// ---------------------------------------------------------------------------
// parseAgentFile
// ---------------------------------------------------------------------------

describe("parseAgentFile", () => {
  test("parses name, description, inline tools and model, and captures the prompt body", () => {
    const content = [
      "---",
      "name: worker",
      "description: Implements a single well-specified change",
      "tools: read, write, edit, bash",
      "model: qwen/qwen3.8-27b",
      "---",
      "",
      "# Worker",
      "You implement tasks end to end.",
      "",
    ].join("\n");
    const a = parseAgentFile(content, "worker.md");
    expect(a).not.toBeNull();
    expect(a!.name).toBe("worker");
    expect(a!.description).toBe("Implements a single well-specified change");
    expect(a!.tools).toEqual(["read", "write", "edit", "bash"]);
    expect(a!.model).toBe("qwen/qwen3.8-27b");
    expect(a!.promptBody).toContain("You implement tasks end to end.");
    expect(a!.promptBody).not.toContain("name: worker");
  });

  test("parses block-style tool lists", () => {
    const content = [
      "---",
      "name: explorer",
      "description: Read-only recon",
      "tools:",
      "  - read",
      "  - grep",
      "  - find",
      "---",
      "Body text.",
    ].join("\n");
    const a = parseAgentFile(content, "explorer.md");
    expect(a!.tools).toEqual(["read", "grep", "find"]);
    expect(a!.model).toBeUndefined();
  });

  test("returns null without frontmatter or without a name", () => {
    expect(parseAgentFile("just prose", "x.md")).toBeNull();
    expect(parseAgentFile("---\ndescription: no name here\n---\nbody", "x.md")).toBeNull();
  });

  test("parses the snake_case fallback_models key from the agent files", () => {
    const content = [
      "---",
      "name: oracle",
      "description: High-stakes consultation",
      "model: openai/gpt-5.6-sol",
      "fallback_models: anthropic/claude-opus-5, qwen/qwen3.8-27b",
      "---",
      "You advise.",
    ].join("\n");
    const a = parseAgentFile(content, "oracle.md");
    expect(a!.fallbackModels).toEqual(["anthropic/claude-opus-5", "qwen/qwen3.8-27b"]);
  });

  test("keeps ref|level pins verbatim in model and fallback_models: validation is the model-fallback extension's job", () => {
    // The frontmatter grammar is a regex mini-parser, not YAML: it cannot
    // express the object form settings.json uses, so the pin rides as a text
    // suffix. The parser must preserve it byte-for-byte — the model-fallback
    // extension owns the item grammar (parseChainItem) and applies the pin.
    const content = [
      "---",
      "name: planner",
      "description: Implementation plans",
      "model: openai/gpt-5.6-sol|high",
      "fallback_models: qwen/qwen3.8-flash-next, deepseek/deepseek-v4-flash|low",
      "---",
      "You plan.",
    ].join("\n");
    const a = parseAgentFile(content, "planner.md");
    expect(a!.model).toBe("openai/gpt-5.6-sol|high");
    expect(a!.fallbackModels).toEqual(["qwen/qwen3.8-flash-next", "deepseek/deepseek-v4-flash|low"]);
  });

  test("leaves fallbackModels undefined when the key is absent", () => {
    const content = "---\nname: spiker\n---\nYou spike.";
    const a = parseAgentFile(content, "spiker.md");
    expect(a!.fallbackModels).toBeUndefined();
  });

  test("tolerates CRLF after the closing delimiter", () => {
    const content = "---\nname: worker\ndescription: d\n---\r\nBody.";
    const a = parseAgentFile(content, "worker.md");
    expect(a!.name).toBe("worker");
    expect(a!.promptBody).toBe("Body.");
  });
});

// ---------------------------------------------------------------------------
// discoverAgents
// ---------------------------------------------------------------------------

describe("discoverAgents", () => {
  test("returns [] for a missing directory", async () => {
    expect(await discoverAgents(join(tmpdir(), "no-such-agents-dir-xyz"))).toEqual([]);
  });

  test("skips one unreadable file and keeps the rest", async () => {
    const dir = join(tmpdir(), "agents-test-");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "a-good.md"),
      "---\nname: good-agent\ndescription: fine\n---\nBody.",
    );
    // A directory named like an agent file: readdir lists it, readFile throws.
    mkdirSync(join(dir, "broken.md"), { recursive: true });
    writeFileSync(
      join(dir, "z-good.md"),
      "---\nname: also-good\ndescription: fine\n---\nBody.",
    );

    const agents = await discoverAgents(dir);
    // Sorted by name, corrupt entry gone, nothing else lost.
    expect(agents.map((a) => a.name)).toEqual(["also-good", "good-agent"]);
  });
});

// ---------------------------------------------------------------------------
// discoverSkillAgents
// ---------------------------------------------------------------------------

/**
 * Builds a throwaway skills library shaped like the real one:
 * `<root>/<category>/<skill>/{SKILL.md,agents/<file>.md}`.
 *
 * The `SKILL.md` is not decoration. Discovery identifies a skill by that file
 * (the same rule pi applies), so a fixture without one describes a directory
 * that is not a skill at all — and the agents inside it are correctly ignored.
 * The earlier flat, SKILL.md-less fixture passed only against a reader that
 * assumed every child of the root was a skill.
 *
 * Every skill is filed under `cat-<skill>` so the category differs per skill,
 * which is what proves the identity comes from the skill directory and not from
 * its position.
 */
function skillsFixture(label: string, layout: Record<string, Record<string, string>>): string {
  const root = join(tmpdir(), `skills-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const [skill, files] of Object.entries(layout)) {
    const skillRoot = join(root, `cat-${skill}`, skill);
    const dir = join(skillRoot, "agents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---\nname: ${skill}\ndescription: ${skill} skill\n---\nBody.`,
    );
    for (const [file, body] of Object.entries(files)) {
      writeFileSync(join(dir, file), body);
    }
  }
  return root;
}

const def = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${name} agent\n${extra}---\nBody for ${name}.`;

describe("discoverSkillAgents", () => {
  test("returns [] for a missing skills directory", async () => {
    expect(await discoverSkillAgents(join(tmpdir(), "no-such-skills-dir-xyz"))).toEqual([]);
  });

  test("finds agents across skills and tags each with its skill", async () => {
    const root = skillsFixture("multi", {
      "technical-analysis": { "observer.md": def("observer"), "reflector.md": def("reflector") },
      research: { "digger.md": def("digger") },
    });
    const agents = await discoverSkillAgents(root);
    expect(agents.map((a) => `${a.name}@${a.skill}`)).toEqual([
      "digger@research",
      "observer@technical-analysis",
      "reflector@technical-analysis",
    ]);
  });

  test("restricts to the loaded skill set when `only` is given", async () => {
    const root = skillsFixture("only", {
      "technical-analysis": { "observer.md": def("observer") },
      research: { "digger.md": def("digger") },
    });
    const agents = await discoverSkillAgents(root, ["technical-analysis"]);
    expect(agents.map((a) => a.name)).toEqual(["observer"]);
  });

  test("an empty loaded set advertises nothing", async () => {
    const root = skillsFixture("empty", {
      "technical-analysis": { "observer.md": def("observer") },
    });
    expect(await discoverSkillAgents(root, [])).toEqual([]);
  });

  test("ignores a skill with no agents/ dir, and non-.md files inside one", async () => {
    const root = skillsFixture("mixed", {
      "technical-analysis": {
        "observer.md": def("observer"),
        // agents/ has long carried this presentation file; it must not become an agent.
        "openai.yaml": "interface:\n  display_name: \"TA\"\n",
      },
    });
    // A real skill (it has a SKILL.md) that ships no agents/ at all.
    const plain = join(root, "cat-plain", "plain-skill");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "SKILL.md"), "---\nname: plain-skill\ndescription: x\n---\n");
    const agents = await discoverSkillAgents(root);
    expect(agents.map((a) => a.name)).toEqual(["observer"]);
  });

  test("carries frontmatter through: tools, model, fallback_models", async () => {
    const root = skillsFixture("front", {
      "technical-analysis": {
        "observer.md": def(
          "observer",
          "tools: read, write\nmodel: fast-1\nfallback_models: slow-1, slow-2\n",
        ),
      },
    });
    const [a] = await discoverSkillAgents(root);
    expect(a.tools).toEqual(["read", "write"]);
    expect(a.model).toBe("fast-1");
    expect(a.fallbackModels).toEqual(["slow-1", "slow-2"]);
    expect(a.skill).toBe("technical-analysis");
    expect(a.promptBody).toBe("Body for observer.");
  });
});
// ---------------------------------------------------------------------------
// discoverAgentsIn
// ---------------------------------------------------------------------------

describe("discoverAgentsIn", () => {
  test("first dir wins a name collision, and origin follows the project root", async () => {
    const project = agentsFixture("in-project", { "worker.md": def("worker") });
    const profile = agentsFixture("in-profile", {
      "worker.md": def("worker"),
      "explorer.md": def("explorer"),
    });
    const agents = await discoverAgentsIn([project, profile], { projectDir: project });
    expect(agents.map((a) => a.name)).toEqual(["explorer", "worker"]);
    const worker = agents.find((a) => a.name === "worker")!;
    expect(worker.origin).toBe("project");
    expect(agents.find((a) => a.name === "explorer")!.origin).toBe("profile");
  });

  test("without a projectDir every dir is profile", async () => {
    const dir = agentsFixture("in-plain", { "worker.md": def("worker") });
    const agents = await discoverAgentsIn([dir]);
    expect(agents[0].origin).toBe("profile");
  });

  test("a dir nested under the project root is project", async () => {
    // The real layout: projectDir = cwd/.pi, the agents dir = projectDir/agents.
    const base = join(tmpdir(), `in-nested-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const projectDir = join(base, ".pi");
    const agentsDir = join(projectDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "worker.md"), def("worker"));
    const agents = await discoverAgentsIn([agentsDir], { projectDir });
    expect(agents[0].origin).toBe("project");
  });

  test("a missing dir costs only itself", async () => {
    const profile = agentsFixture("in-missing", { "explorer.md": def("explorer") });
    const agents = await discoverAgentsIn([join(tmpdir(), "no-such-dir-xyz"), profile]);
    expect(agents.map((a) => a.name)).toEqual(["explorer"]);
    expect(agents[0].origin).toBe("profile");
  });
});


// ---------------------------------------------------------------------------
// mergeAgents
// ---------------------------------------------------------------------------

describe("mergeAgents", () => {
  const mk = (name: string, opts?: { skill?: string; origin?: "project" | "profile" }): AgentInfo => ({
    name,
    description: "",
    promptBody: "",
    filePath: `${name}.md`,
    ...(opts?.skill ? { skill: opts.skill } : {}),
    ...(opts?.origin ? { origin: opts.origin } : {}),
  });

  test("merges layers in order and sorts by name", () => {
    const { agents } = mergeAgents(
      [mk("worker", { origin: "project" }), mk("explorer", { origin: "profile" })],
      [mk("observer", { skill: "ta", origin: "profile" })],
    );
    expect(agents.map((a) => a.name)).toEqual(["explorer", "observer", "worker"]);
  });

  test("the first layer wins a name collision, and the loser is reported", () => {
    const { agents, shadowed } = mergeAgents(
      [mk("worker", { origin: "project" })],
      [mk("worker", { origin: "profile" }), mk("observer", { origin: "profile" })],
    );
    expect(agents.map((a) => a.name)).toEqual(["observer", "worker"]);
    expect(agents.find((a) => a.name === "worker")!.origin).toBe("project");
    expect(shadowed).toEqual([{ name: "worker", winner: "project", loser: "profile" }]);
  });

  test("skill provenance rides along in the shadow report", () => {
    const { shadowed } = mergeAgents(
      [mk("worker", { origin: "project", skill: "pfoo" })],
      [mk("worker", { origin: "profile", skill: "pfoo" })],
    );
    expect(shadowed).toEqual([
      { name: "worker", winner: "project", loser: "profile", winnerSkill: "pfoo", loserSkill: "pfoo" },
    ]);
  });

  test("later layers cannot reclaim a name an earlier layer took", () => {
    // The old global-wins rule, now expressed as layer order: whatever layer
    // owns the name first keeps it, no matter what the rest of the stack says.
    const { agents, shadowed } = mergeAgents(
      [mk("worker", { origin: "project" })],
      [mk("digger", { origin: "profile" })],
      [mk("worker", { origin: "profile", skill: "research" })],
    );
    expect(agents.map((a) => a.name)).toEqual(["digger", "worker"]);
    expect(agents.find((a) => a.name === "worker")!.origin).toBe("project");
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0].name).toBe("worker");
    expect(shadowed[0].loserSkill).toBe("research");
  });

  test("handles empty layers", () => {
    expect(mergeAgents([], [mk("observer", { skill: "ta" })]).agents.map((a) => a.name)).toEqual([
      "observer",
    ]);
    expect(mergeAgents([mk("worker")], []).agents.map((a) => a.name)).toEqual(["worker"]);
    expect(mergeAgents([], []).agents).toEqual([]);
    expect(mergeAgents([], []).shadowed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// delegationRoster
// ---------------------------------------------------------------------------

/** A global `agents/` dir holding the given `file -> content` entries. */
function agentsFixture(label: string, files: Record<string, string>): string {
  const dir = join(tmpdir(), `agents-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
  return dir;
}

describe("delegationRoster", () => {
  test("merges profile and skill agents, sorted by name", async () => {
    const agentsDir = agentsFixture("merge", {
      "worker.md": def("worker"),
      "explorer.md": def("explorer"),
    });
    const skillsDir = skillsFixture("roster-merge", {
      "technical-analysis": { "observer.md": def("observer") },
    });
    const roster = await delegationRoster({ roots: { agentsDirs: [agentsDir], skillsDirs: [skillsDir] }, lineage: [] });
    expect(roster.all.map((a) => `${a.name}:${a.skill ?? "global"}`)).toEqual([
      "explorer:global",
      "observer:technical-analysis",
      "worker:global",
    ]);
    // The empty lineage is the orchestrator, which may spawn anything.
    expect(roster.spawnable.map((a) => a.name)).toEqual(["explorer", "observer", "worker"]);
  });

  test("a profile agent wins over a same-named skill agent", async () => {
    const agentsDir = agentsFixture("collide", { "worker.md": def("worker") });
    const skillsDir = skillsFixture("roster-collide", {
      research: { "worker.md": def("worker"), "digger.md": def("digger") },
    });
    const roster = await delegationRoster({ roots: { agentsDirs: [agentsDir], skillsDirs: [skillsDir] }, lineage: [] });
    expect(roster.all.map((a) => `${a.name}:${a.skill ?? "global"}`)).toEqual([
      "digger:research",
      "worker:global",
    ]);
    // The legacy path is a profile-only root set: the profile layer still
    // sits above the profile-skill layer, and the shadow is reported.
    expect(roster.shadowed).toEqual([
      { name: "worker", winner: "profile", loser: "profile", loserSkill: "research" },
    ]);
  });

  test("omitting activeSkills includes every skill's agents", async () => {
    const agentsDir = agentsFixture("all-skills", {});
    const skillsDir = skillsFixture("roster-all", {
      "technical-analysis": { "observer.md": def("observer") },
      research: { "digger.md": def("digger") },
    });
    const roster = await delegationRoster({ roots: { agentsDirs: [agentsDir], skillsDirs: [skillsDir] }, lineage: [] });
    expect(roster.all.map((a) => a.name)).toEqual(["digger", "observer"]);
  });

  test("activeSkills restricts to those skill directory names", async () => {
    const agentsDir = agentsFixture("some-skills", { "worker.md": def("worker") });
    const skillsDir = skillsFixture("roster-some", {
      "technical-analysis": { "observer.md": def("observer") },
      research: { "digger.md": def("digger") },
    });
    // Matched on the skill's directory name, not its category path (`cat-research`).
    const roster = await delegationRoster({
      roots: { agentsDirs: [agentsDir], skillsDirs: [skillsDir] },
      lineage: [],
      activeSkills: ["technical-analysis"],
    });
    expect(roster.all.map((a) => a.name)).toEqual(["observer", "worker"]);
    const byCategory = await delegationRoster({
      roots: { agentsDirs: [agentsDir], skillsDirs: [skillsDir] },
      lineage: [],
      activeSkills: ["cat-research"],
    });
    expect(byCategory.all.map((a) => a.name)).toEqual(["worker"]);
  });

  test("an agent the lineage rejects is in .all but not in .spawnable", async () => {
    const agentsDir = agentsFixture("lineage", {
      "worker.md": def("worker", "callable_by: orchestrator\n"),
      "reviewer.md": def("reviewer", "callable_by: worker\n"),
      "oracle.md": def("oracle", "callable_by: orchestrator\n"),
    });
    const skillsDir = skillsFixture("roster-lineage", {});
    const roster = await delegationRoster({ roots: { agentsDirs: [agentsDir], skillsDirs: [skillsDir] }, lineage: ["worker"] });
    expect(roster.all.map((a) => a.name)).toEqual(["oracle", "reviewer", "worker"]);
    // worker is a cycle and oracle is orchestrator-only; reviewer names worker.
    expect(roster.spawnable.map((a) => a.name)).toEqual(["reviewer"]);
  });
});
// ---------------------------------------------------------------------------
// delegationRoster with roots (the project layer)
// ---------------------------------------------------------------------------

describe("delegationRoster with roots", () => {
  /**
   * A project tree the way the trust gate sees it: `<base>/.pi/agents/*.md`
   * plus `<base>/.pi/skills/<category>/<skill>/{SKILL.md,agents/*.md}`.
   * Returns `base`, so `resourceRoots({ cwd: base })` finds its `.pi`.
   */
  function projectTree(label: string): string {
    const base = join(tmpdir(), `pl-proj-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const projectDir = join(base, ".pi");
    mkdirSync(join(projectDir, "agents"), { recursive: true });
    writeFileSync(join(projectDir, "agents", "worker.md"), def("worker"));
    const foo = join(projectDir, "skills", "cat-foo", "foo");
    mkdirSync(join(foo, "agents"), { recursive: true });
    writeFileSync(join(foo, "SKILL.md"), "---\nname: foo\ndescription: foo\n---\nBody.");
    writeFileSync(join(foo, "agents", "journal.md"), def("journal"));
    return base;
  }

  /** A profile tree: `<dir>/agents/*.md` plus `<dir>/skills/<category>/<skill>/…`. */
  function profileTree(label: string): string {
    const profileDir = join(tmpdir(), `pl-prof-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(profileDir, "agents"), { recursive: true });
    writeFileSync(join(profileDir, "agents", "worker.md"), def("worker"));
    writeFileSync(join(profileDir, "agents", "explorer.md"), def("explorer"));
    const foo = join(profileDir, "skills", "cat-foo", "foo");
    mkdirSync(join(foo, "agents"), { recursive: true });
    writeFileSync(join(foo, "SKILL.md"), "---\nname: foo\ndescription: foo (profile)\n---\nBody.");
    writeFileSync(join(foo, "agents", "journal.md"), def("journal"));
    const research = join(profileDir, "skills", "cat-research", "research");
    mkdirSync(join(research, "agents"), { recursive: true });
    writeFileSync(join(research, "SKILL.md"), "---\nname: research\ndescription: research\n---\nBody.");
    writeFileSync(join(research, "agents", "digger.md"), def("digger"));
    return profileDir;
  }

  test("a project agent and a project-skill agent shadow their profile twins", async () => {
    const base = projectTree("shadow");
    const profileDir = profileTree("shadow");
    const roster = await delegationRoster({
      roots: resourceRoots({ profileDir, cwd: base, projectTrusted: true }),
      lineage: [],
    });
    // worker: the project agent beats the profile agent — a real merge
    // collision, reported.
    // journal: the project skill foo replaces the profile skill foo WHOLESALE
    // (findSkillsIn), so the profile copy of its agent is never discovered at
    // all: the roster carries the project journal with no shadow entry, the
    // skill shadowing is the reason.
    // digger/explorer: profile-only, untouched.
    expect(roster.all.map((a) => `${a.name}:${a.origin}:${a.skill ?? "core"}`)).toEqual([
      "digger:profile:research",
      "explorer:profile:core",
      "journal:project:foo",
      "worker:project:core",
    ]);
    expect(roster.shadowed).toEqual([{ name: "worker", winner: "project", loser: "profile" }]);
    expect(roster.spawnable.map((a) => a.name)).toEqual(["digger", "explorer", "journal", "worker"]);
  });

  test("an untrusted project is invisible: profile-only roots, nothing shadowed", async () => {
    const base = projectTree("untrusted");
    const profileDir = profileTree("untrusted");
    const roster = await delegationRoster({
      roots: resourceRoots({ profileDir, cwd: base, projectTrusted: false }),
      lineage: [],
    });
    expect(roster.all.map((a) => `${a.name}:${a.origin}`)).toEqual([
      "digger:profile",
      "explorer:profile",
      "journal:profile",
      "worker:profile",
    ]);
    expect(roster.shadowed).toEqual([]);
  });
});

