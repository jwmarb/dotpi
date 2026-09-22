/**
 * Agent definition discovery — the single owner of the `agent/agents/*.md`
 * frontmatter grammar.
 *
 * Two extensions used to parse these files — dynamic-prompt (the
 * orchestrator prompt's agent inventory) and subagent-herdr (the spawn
 * argv) — each "mirroring" the other's grammar by hand, and the mirrors
 * drifted: the files declare `fallback_models`, one parser read a
 * camelCase key that never matched, the other had no field for it at all.
 * This module applies the same one-parser-per-format rule as `dotenv.ts`:
 * every consumer imports `discoverAgents`, nobody re-implements the grammar.
 *
 * Failure behaviour is part of the contract: a missing or unreadable
 * agents directory yields `[]`, and one unreadable file is skipped (its
 * agent simply isn't discovered) so a single corrupt definition costs
 * itself — not every spawn, not the prompt.
 *
 * Pure module: `node:fs/promises` + `node:path` only, no pi import (the
 * same constraint `dotenv.ts` keeps so it can load from extension
 * top-level code).
 *
 * @module extensions/lib/agents
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Metadata for a subagent definition parsed from `agent/agents/<name>.md`.
 * The union of what both consumers need: the prompt renders
 * name/description/model/tools, the spawn path uses tools/model/promptBody.
 */
export interface AgentInfo {
  name: string;
  description: string;
  /** Allowed tools, or undefined if the agent can use all tools. */
  tools?: string[];
  /** Preferred LLM model, or undefined to use the default. */
  model?: string;
  /**
   * Fallback models, from the file's `fallback_models` key. Tried in order by
   * the spawn path when a child fails to *launch* (an unknown model, or a
   * provider that is down or rate-limiting, makes pi exit before its TUI
   * appears). An explicit model on the delegation call suppresses them.
   */
  fallbackModels?: string[];
  /** The agent's system-prompt body: the markdown after the frontmatter. */
  promptBody: string;
  /** The filename of the agent definition (e.g. `worker.md`). */
  filePath: string;
}

/**
 * Scans `agentsDir` for `.md` files with parseable frontmatter.
 *
 * @param agentsDir - Absolute path to the agents directory.
 * @returns A sorted (by name) list of agents, or `[]` on any failure
 *          (unreadable files are skipped, not fatal).
 */
export async function discoverAgents(agentsDir: string): Promise<AgentInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return [];
  }
  const agents: AgentInfo[] = [];
  for (const file of entries.filter((e) => e.endsWith(".md"))) {
    let content: string;
    try {
      content = await readFile(join(agentsDir, file), "utf-8");
    } catch {
      continue; // one unreadable file costs only itself
    }
    const parsed = parseAgentFile(content, file);
    if (parsed) agents.push(parsed);
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Parses one agent definition: YAML-ish frontmatter (name, description,
 * tools, model, fallback_models) plus the markdown body that becomes the
 * child's system prompt.
 *
 * @returns The parsed agent, or `null` when the frontmatter is missing or
 *          has no `name` (such a file is skipped by discovery).
 */
export function parseAgentFile(content: string, fileName: string): AgentInfo | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;

  const raw = match[1];
  const name = extractString(raw, "name");
  if (!name) return null;

  const fallbackModels = extractStringList(raw, "fallback_models");

  return {
    name,
    description: extractString(raw, "description"),
    tools: extractStringList(raw, "tools"),
    model: extractString(raw, "model") || undefined,
    fallbackModels: fallbackModels.length > 0 ? fallbackModels : undefined,
    promptBody: match[2].trim(),
    filePath: fileName,
  };
}

/** Single scalar frontmatter value (`key: value`, first match). */
function extractString(yaml: string, key: string): string {
  const match = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : "";
}

/**
 * List frontmatter value supporting both the inline (`tools: a, b`) and
 * block (`tools:\n  - a`) spellings used in the agent files.
 */
function extractStringList(yaml: string, key: string): string[] {
  const inline = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (inline && !inline[1].startsWith("-")) {
    return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
  }
  const block = yaml.match(new RegExp(`^${key}:\\n((?:\\s+- .+\\n?)+)`, "m"));
  if (block) {
    return block[1].split("\n").map((l) => l.replace(/^\s+-\s*/, "").trim()).filter(Boolean);
  }
  return [];
}
