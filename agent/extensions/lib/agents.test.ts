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

import { discoverAgents, parseAgentFile } from "./agents.js";

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
