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
  discoverAgents,
  discoverSkillAgents,
  mergeAgents,
  parseAgentFile,
  type AgentInfo,
} from "./agents.js";

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

/** Builds a throwaway skills library: <root>/<skill>/agents/<file>.md */
function skillsFixture(label: string, layout: Record<string, Record<string, string>>): string {
  const root = join(tmpdir(), `skills-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  for (const [skill, files] of Object.entries(layout)) {
    const dir = join(root, skill, "agents");
    mkdirSync(dir, { recursive: true });
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
    mkdirSync(join(root, "plain-skill"), { recursive: true }); // no agents/ at all
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
// mergeAgents
// ---------------------------------------------------------------------------

describe("mergeAgents", () => {
  const mk = (name: string, skill?: string): AgentInfo => ({
    name,
    description: "",
    promptBody: "",
    filePath: `${name}.md`,
    ...(skill ? { skill } : {}),
  });

  test("merges and sorts by name", () => {
    const merged = mergeAgents([mk("worker"), mk("explorer")], [mk("observer", "ta")]);
    expect(merged.map((a) => a.name)).toEqual(["explorer", "observer", "worker"]);
  });

  test("a global agent wins a name collision", () => {
    const merged = mergeAgents([mk("worker")], [mk("worker", "ta"), mk("observer", "ta")]);
    expect(merged.map((a) => `${a.name}:${a.skill ?? "global"}`)).toEqual([
      "observer:ta",
      "worker:global",
    ]);
  });

  test("handles either side being empty", () => {
    expect(mergeAgents([], [mk("observer", "ta")]).map((a) => a.name)).toEqual(["observer"]);
    expect(mergeAgents([mk("worker")], []).map((a) => a.name)).toEqual(["worker"]);
    expect(mergeAgents([], [])).toEqual([]);
  });
});
