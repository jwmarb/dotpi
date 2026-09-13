/**
 * Agent discovery and configuration.
 *
 * Scans user (~/.pi/agent/agents) and project-local (.pi/agents) directories
 * for Markdown files with frontmatter to discover available subagents.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir, parseFrontmatter } from '@mariozechner/pi-coding-agent';

/**
 * Which agent directories to search.
 * - "user" — only the global ~/.pi/agent/agents directory
 * - "project" — only the nearest .pi/agents directory
 * - "both" — merge both, with project agents taking precedence on name conflicts
 */
export type AgentScope = 'user' | 'project' | 'both';

/** Configuration for a discovered agent, parsed from a Markdown file's frontmatter and body. */
export interface AgentConfig {
  /** Unique name of the agent (from frontmatter). */
  name: string;
  /** Human-readable description (from frontmatter). */
  description: string;
  /** Comma-separated list of tool names to enable (from frontmatter, optional). */
  tools?: string[];
  /** AI model to use for this agent (from frontmatter, optional). */
  model?: string;
  /**
   * Models to try, in order, if the primary `model` fails (from frontmatter
   * `fallback_models`, optional). Only consulted after a Run actually fails;
   * a canceled Run never falls back.
   */
  fallbackModels?: string[];
  /** System prompt extracted from the Markdown body. */
  systemPrompt: string;
  /** Origin: "user" for global agents, "project" for repo-local agents. */
  source: 'user' | 'project';
  /** Absolute path to the Markdown file defining this agent. */
  filePath: string;
}

/** Result of agent discovery, including the resolved project agents directory (if any). */
export interface AgentDiscoveryResult {
  /** List of discovered agents (merged and de-duplicated by name). */
  agents: AgentConfig[];
  /** Path to the nearest .pi/agents directory, or null if none exists. */
  projectAgentsDir: string | null;
}

/**
 * Load agent configurations from a directory.
 *
 * Reads all `.md` files in `dir`, parses their frontmatter for `name` and
 * `description`, and treats the remaining body as the system prompt.
 *
 * @param dir - Absolute path to the agents directory.
 * @param source - Origin label ("user" or "project").
 * @returns Array of valid agent configurations.
 */
function loadAgentsFromDir(dir: string, source: 'user' | 'project'): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) {
    return agents;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Parse frontmatter for agent metadata; body becomes the system prompt.
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

    // Skip files missing required fields.
    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    // Parse optional comma-separated tool list.
    const tools = frontmatter.tools
      ?.split(',')
      .map((t: string) => t.trim())
      .filter(Boolean);

    // Parse optional comma-separated fallback model chain. Duplicates and the
    // primary model are dropped: retrying the same model gains nothing.
    const fallbackModels = frontmatter.fallback_models
      ?.split(',')
      .map((m: string) => m.trim())
      .filter(Boolean)
      .filter((m: string, i: number, all: string[]) => all.indexOf(m) === i && m !== frontmatter.model);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      fallbackModels: fallbackModels && fallbackModels.length > 0 ? fallbackModels : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk up the directory tree from `cwd` to find the nearest `.pi/agents` directory.
 *
 * @param cwd - Starting directory.
 * @returns Path to the nearest project agents directory, or null if none found.
 */
function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, '.pi', 'agents');
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * Discover agents based on scope, merging user and project agents as needed.
 *
 * When scope is "both", project agents override user agents with the same name.
 *
 * @param cwd - Current working directory (used to resolve project agents).
 * @param scope - Which agent directories to search.
 * @returns Discovered agents and the resolved project agents directory.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), 'agents');
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents = scope === 'project' ? [] : loadAgentsFromDir(userDir, 'user');
  const projectAgents = scope === 'user' || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, 'project');

  // Merge agents by scope; project agents override user agents on name conflict.
  const agentMap = new Map<string, AgentConfig>();

  if (scope === 'both') {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  } else if (scope === 'user') {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
  } else {
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  }

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/**
 * Format a list of agents into a compact, human-readable string.
 *
 * @param agents - Array of agent configurations.
 * @param maxItems - Maximum number of agents to include in the output string.
 * @returns Formatted text and the count of agents that were not shown.
 */
export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
  if (agents.length === 0) return { text: 'none', remaining: 0 };
  const listed = agents.slice(0, maxItems);
  const remaining = agents.length - listed.length;
  return {
    text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join('; '),
    remaining,
  };
}
