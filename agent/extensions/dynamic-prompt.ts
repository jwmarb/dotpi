/**
 * Dynamic orchestrator system prompt extension.
 *
 * Discovers agents, tools, skills, and context files at runtime, then
 * injects a tailored system prompt into the orchestrator before each session.
 * This ensures the agent always knows what resources are available without
 * stale hardcoded inventories.
 *
 * @module dynamic-prompt
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { getAgentDir } from '@mariozechner/pi-coding-agent';

// ---------------------------------------------------------------------------
// Agent discovery: parse YAML frontmatter from agent .md files
// ---------------------------------------------------------------------------

/**
 * Metadata for a discovered subagent parsed from a .md file's YAML frontmatter.
 */
interface AgentInfo {
  /** Agent name (from frontmatter `name` field). */
  name: string;
  /** Human-readable description of the agent's role. */
  description: string;
  /** Allowed tools, or undefined if the agent can use all tools. */
  tools?: string[];
  /** Preferred LLM model, or undefined to use the default. */
  model?: string;
  /** Fallback models if the preferred model is unavailable. */
  fallbackModels?: string[];
  /** The filename of the agent definition (e.g. `code-reviewer.md`). */
  filePath: string;
}

/**
 * Scans a directory for `.md` files and parses their YAML frontmatter
 * to build an inventory of available subagents.
 *
 * @param agentsDir - Absolute path to the agents directory.
 * @returns A sorted array of agent metadata, or an empty array on failure.
 */
async function discoverAgents(agentsDir: string): Promise<AgentInfo[]> {
  try {
    const entries = await readdir(agentsDir);
    const mdFiles = entries.filter((e) => e.endsWith('.md'));
    const agents: AgentInfo[] = [];

    for (const file of mdFiles) {
      const filePath = join(agentsDir, file);
      const content = await readFile(filePath, 'utf-8');
      const parsed = parseFrontmatter(content, file);
      // Skip files with missing or invalid frontmatter
      if (parsed) agents.push(parsed);
    }

    return agents.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error: unknown) {
    // Agents dir missing or unreadable — degrade gracefully with empty inventory.
    // Log silently to avoid noisy output during normal operation.
    return [];
  }
}

/**
 * Parses YAML frontmatter from an agent definition file.
 *
 * @param content - Full file content (including frontmatter delimiters).
 * @param fileName - The source filename (used as `filePath` in the result).
 * @returns Parsed agent metadata, or `null` if frontmatter is missing or invalid.
 */
function parseFrontmatter(content: string, fileName: string): AgentInfo | null {
  // Extract YAML frontmatter between --- delimiters
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const raw = frontmatterMatch[1];
  const name = extractString(raw, 'name');
  const description = extractString(raw, 'description');

  // `name` is the only required field
  if (!name) return null;

  const tools = extractStringList(raw, 'tools');
  const model = extractString(raw, 'model');
  const fallbackModels = extractStringList(raw, 'fallbackModels');

  return { name, description, tools, model, fallbackModels, filePath: fileName };
}

/**
 * Extracts a single string value from YAML frontmatter by key.
 *
 * @param yaml - The raw frontmatter text.
 * @param key - The YAML key to look for.
 * @returns The trimmed value, or an empty string if not found.
 */
function extractString(yaml: string, key: string): string {
  const match = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

/**
 * Extracts a list of strings from YAML frontmatter, supporting both
 * inline (`key: a, b, c`) and block (`key:\n  - a\n  - b`) formats.
 *
 * @param yaml - The raw frontmatter text.
 * @param key - The YAML key to look for.
 * @returns An array of trimmed values, or an empty array if not found.
 */
function extractStringList(yaml: string, key: string): string[] {
  // Inline list: tools: read, grep, find
  const inlineMatch = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  if (inlineMatch && !inlineMatch[1].startsWith('-')) {
    return inlineMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Block list:
  // tools:
  //   - read
  //   - grep
  const blockMatch = yaml.match(new RegExp(`^${key}:\\n((?:\\s+- .+\\n?)+)`, 'm'));
  if (blockMatch) {
    return blockMatch[1]
      .split('\n')
      .map((l) => l.replace(/^\s+-\s*/, '').trim())
      .filter(Boolean);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Name of the tool registered by the `ask-user` extension. When this tool is
 * available, the orchestrator prompt gains an explicit instruction to route
 * every user-facing question through it instead of asking in prose.
 */
const QUESTIONNAIRE_TOOL = 'questionnaire';

/**
 * Name of the tool registered by the `plan` extension. When this tool is
 * available, the orchestrator prompt gains a Planning Discipline section that
 * mandates maintaining a Plan for any work requiring careful execution.
 */
const PLAN_TOOL = 'plan';

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Extension entry point. Hooks into `before_agent_start` to inject
 * a dynamically built orchestrator system prompt.
 *
 * @param pi - The pi extension API.
 */
export default function (pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event, ctx) => {
    const opts = event.systemPromptOptions;

    // --- Discover agents from ~/.pi/agent/agents/ ---
    const agentsDir = join(getAgentDir(), 'agents');
    const agentInventory = await discoverAgents(agentsDir);

    // --- Build tool inventory ---
    // Only include tools that have a snippet available; fallback to empty description
    const toolInventory =
      opts.selectedTools
        ?.filter((name) => opts.toolSnippets?.[name])
        .map((name) => ({
          name,
          description: opts.toolSnippets?.[name] ?? '',
        })) ?? [];

    // --- Build skill inventory ---
    const skillInventory = (opts.skills ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
    }));

    // --- Build context file inventory ---
    const contextInventory = (opts.contextFiles ?? []).map((f) => ({
      path: f.path,
    }));

    // --- Filter out empty guideline entries ---
    const guidelines = (opts.promptGuidelines ?? []).filter((g) => g.trim().length > 0);

    // --- Detect the ask-user extension ---
    // ask-user.ts registers a tool named `questionnaire`. If it is loaded we
    // instruct the orchestrator to ask the user through it.
    const hasQuestionnaire =
      (opts.selectedTools ?? []).includes(QUESTIONNAIRE_TOOL) ||
      toolInventory.some((t) => t.name === QUESTIONNAIRE_TOOL);

    // --- Detect the plan extension ---
    // plan/index.ts registers a tool named `plan`. If it is loaded we inject
    // the Planning Discipline section; without the tool the section would
    // dangle, so it is emitted only then (same pattern as the questionnaire).
    const hasPlanTool =
      (opts.selectedTools ?? []).includes(PLAN_TOOL) ||
      toolInventory.some((t) => t.name === PLAN_TOOL);

    // --- Build the orchestrator system prompt ---
    const orchestratorPrompt = buildOrchestratorPrompt({
      agentInventory,
      toolInventory,
      skillInventory,
      contextInventory,
      guidelines,
      hasQuestionnaire,
      hasPlanTool,
      customPrompt: opts.customPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      cwd: opts.cwd,
    });

    // Replace the default prompt entirely with the orchestrator prompt
    return { systemPrompt: orchestratorPrompt };
  });
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

/**
 * Assembles the full orchestrator system prompt from discovered inventories
 * and configuration options.
 *
 * @param opts - Inventories and configuration for building the prompt.
 * @returns A formatted markdown string ready to be injected as a system prompt.
 */
function buildOrchestratorPrompt(opts: {
  agentInventory: AgentInfo[];
  toolInventory: Array<{ name: string; description: string }>;
  skillInventory: Array<{ name: string; description: string; filePath: string }>;
  contextInventory: Array<{ path: string }>;
  guidelines: string[];
  /** True when the `ask-user` extension's questionnaire tool is available. */
  hasQuestionnaire: boolean;
  /** True when the `plan` extension's plan tool is available. */
  hasPlanTool: boolean;
  customPrompt?: string;
  appendSystemPrompt?: string;
  cwd: string;
}): string {
  const now = new Date();
  // ISO date format for consistent prompt output
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  // --- Tool inventory section ---
  const toolSection =
    opts.toolInventory.length > 0
      ? `
## Available Tools

You are an orchestrator. Your job is to decompose user requests into
sequences of tool calls, coordinate execution, and verify results.

| Tool | Description |
|------|-------------|
${opts.toolInventory.map((t) => `| ${t.name} | ${t.description} |`).join('\n')}

**Orchestration rules:**
- Break complex tasks into smaller, verifiable steps
- Use the right tool for each subtask — don't force a single tool to do everything
- Read before you write; verify before you commit
- When a tool call fails, diagnose the error and try a different approach
- Parallelize independent operations where possible
- Always confirm the outcome matches the user's intent before declaring success
`
      : '';

  // --- Agent inventory section ---
  const agentSection =
    opts.agentInventory.length > 0
      ? `
## Available Agents

Specialized subagents you can delegate tasks to via the \`subagent\` tool.
Delegation runs in the background and returns a task id, not a result.

| Agent | Description | Model | Tools |
|-------|-------------|-------|-------|
${opts.agentInventory.map((a) => `| ${a.name} | ${a.description} | ${a.model ?? 'default'} | ${(a.tools?.length ?? 0) > 0 ? a.tools!.join(', ') : 'all'} |`).join('\n')}

**Agent usage notes:**
- Each agent has a focused role — pick the right one for the task
- Agents run in isolated context windows (don't pollute main conversation)
- Delegate with the \`subagent\` tool, naming the agent and its task
- You can chain agents (e.g., worker → reviewer) for complex workflows

**Delegation is asynchronous.** \`subagent\` starts a background *task* and returns
a task id (e.g. \`sub-a3f1\`) — not the result. The task keeps running even if your
turn ends or errors out, and you are notified automatically when it finishes.

- Need the answer before your next step? Call \`subagent_tasks\` with
  \`action: "wait"\` and the task ids. It blocks until they finish and returns the
  results. Waiting on several ids in one call is one round trip.
- Want to work on something else meanwhile? Launch the task, keep going, and act
  on the completion notification when it arrives.
- Use \`action: "status"\` to check progress, \`"result"\` to re-read a finished
  task, \`"list"\` to see all tasks, and \`"cancel"\` to stop one.
- Never treat a task id as an answer, and never claim a delegated task is done
  until you have actually seen its result.
`
      : '';

  // --- Skill inventory section ---
  const skillSection =
    opts.skillInventory.length > 0
      ? `
## Available Skills

Skills are specialized knowledge modules. Invoke them via \`/skill:name\`
when their expertise matches the current task.

| Skill | Description |
|-------|-------------|
${opts.skillInventory.map((s) => `| ${s.name} | ${s.description} |`).join('\n')}

**Orchestration rules:**
- Read the full skill content (via \`/skill:name\`) before delegating
- Skills are advisory — you decide when they apply
- If a skill's guidance conflicts with the task, use your judgment
`
      : '';

  // --- Context files section ---
  const contextSection =
    opts.contextInventory.length > 0
      ? `
## Project Context

The following context files are available and should inform your decisions:

${opts.contextInventory.map((f) => `- **${f.path}**`).join('\n')}

Use these files to understand project conventions, architecture, and constraints.
`
      : '';

  // --- Guidelines section ---
  const guidelinesSection =
    opts.guidelines.length > 0
      ? `
## Guidelines

${opts.guidelines.map((g) => `- ${g}`).join('\n')}
`
      : '';

  // --- Asking the user section ---
  // Only emitted when the ask-user extension is loaded, so the prompt never
  // references a tool the agent cannot actually call.
  const askUserSection = opts.hasQuestionnaire
    ? `
## Asking the User

When you need something from the user — a clarification, a decision between
viable paths, a preference, or confirmation before a risky action — ask it with
the \`${QUESTIONNAIRE_TOOL}\` tool. Do not pose questions in prose and do not
end a turn hoping the user volunteers the missing information.

**When to call \`${QUESTIONNAIRE_TOOL}\`:**
- The request is ambiguous or underspecified and guessing wrong is costly
- Several reasonable approaches exist and the choice belongs to the user
- You are about to do something destructive or hard to reverse
- A required value is missing (path, name, target branch, environment, ...)

**How to ask well:**
- Batch related questions into one call instead of asking one at a time
- Give each question a stable \`id\` and a short \`label\` for the tab bar
- Offer 2–5 concrete, mutually exclusive options — never a blank prompt
- Leave \`allowOther\` at its default (true) so the user can type an answer
- Ask only what you cannot determine yourself: read the code first

**After asking:**
- Treat the returned answers as binding and proceed without re-asking
- If the user cancels, stop and report what you needed rather than guessing
`
    : '';

  // --- Planning discipline section ---
  // Emitted whenever the plan extension is loaded (it is a global extension,
  // so this is every session — orchestrator and subagents alike, since
  // subagent children load the same user extensions).
  const planSection = opts.hasPlanTool
    ? `
## Planning Discipline

Before you act, keep a **Plan** — the ordered list of what you are doing,
what is left, and what has landed. You maintain it with the \`${PLAN_TOOL}\` tool.

**When a plan is required:**
- Before any work that is a procedure requiring careful execution: multiple
  steps, multiple files, destructive or hard-to-reverse operations,
  unfamiliar code, or delegation to subagents.
- When in doubt, make a plan. A one-item plan is cheap; losing track of work
  costs the task.
- Only a purely conversational reply — no tools, no file changes — needs no plan.

**How to maintain it:**
- Use the \`${PLAN_TOOL}\` tool exclusively (add / status / seed / archive / show) —
  never edit the plan file by hand.
- The plan is session-wide: it accumulates across requests. New work appends
  items; do not discard the running list.
- Keep at most one item active: mark an item active before you start it, and
  review or failed before you move on.
- Groom an item to `ready` when it is specified enough to start, rather than
  jumping `backlog` → `active`. Grooming is where a Review Route is normally
  chosen, and it is the moment to notice an item is vaguer than it looked.
- When you delegate a step, record the returned Task ID on that plan item and
  mark the item done (or failed) when the Task's Result arrives.
- Before delegating, write the child's Starter Plan into the delegation text
  and seed it with \`${PLAN_TOOL}\` op "seed" for the Task ID. The child owns its
  plan file from then on — you will never read it back.
- The plan survives compaction: it is re-injected into your context
  automatically. If it is ever missing from your context, call \`${PLAN_TOOL}\` op
  "show" before continuing.
- When every item is done or failed the plan archives itself; you can also
  call \`${PLAN_TOOL}\` op "archive" explicitly.
`
    : '';

  // --- Custom prompt ---
  const customSection = opts.customPrompt ? `\n${opts.customPrompt}\n` : '';

  // --- Append system prompt ---
  const appendSection = opts.appendSystemPrompt ? `\n${opts.appendSystemPrompt}\n` : '';

  // --- Footer ---
  const footer = `\nCurrent date: ${date}\nCurrent working directory: ${opts.cwd}`;

  return `
# Orchestrator Agent

You are an orchestrator agent inside pi. Your primary role is to plan,
coordinate, and execute multi-step tasks by composing tool calls and
skill invocations in the right order.

## Core Responsibilities

1. **Decompose** — Break complex user requests into discrete, verifiable steps. If a request has gaps or is unclear, ask${opts.hasQuestionnaire ? ` using the \`${QUESTIONNAIRE_TOOL}\` tool` : ''} before planning.
2. **Plan** — Determine the optimal sequence of tool calls and skill invocations
3. **Execute** — Call tools and skills in the correct order, handling errors gracefully
4. **Verify** — Confirm each step's result before proceeding to the next
5. **Adapt** — If something fails, diagnose and try a different approach

## Decision Framework

When given a task:
1. Identify the goal and any constraints
2. Check which tools and skills are available (see sections below)
3. Design a step-by-step plan
4. Execute the plan, verifying each step
5. Report back with results and any issues

## Error Handling

- If a tool call fails, read the error and adjust your approach
- If a skill doesn't apply, skip it and use a different tool
- If you're unsure, read relevant files before making assumptions${opts.hasQuestionnaire ? `\n- If reading the code cannot resolve the uncertainty, ask via the \`${QUESTIONNAIRE_TOOL}\` tool instead of assuming` : ''}
- Communicate your plan to the user for complex or risky operations

${askUserSection}${planSection}${toolSection}${agentSection}${skillSection}${contextSection}${guidelinesSection}${customSection}${appendSection}${footer}`;
}
