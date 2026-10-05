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
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  discoverAgents,
  discoverSkillAgents,
  mergeAgents,
  type AgentInfo,
} from './lib/agents.js';
import { agentsDir, skillsDir } from './lib/layout.js';
import { groupByCategory } from './lib/skill-categories.js';
import { categoryFromPath } from './lib/skill-tree.js';
import {
  SkillActivation,
  gateTools,
  loadSkillToolOwners,
} from './lib/skill-activation.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Name of the tool registered by the `ask-user` extension. When this tool is
 * available, the orchestrator prompt gains an explicit instruction to route
 * every user-facing question through it instead of asking in prose.
 */
const QUESTIONNAIRE_TOOL = 'questionnaire';

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
  // Which skills are live in this session. Sticky, and rebuilt per session —
  // `systemPromptOptions.skills` cannot answer this: it is the catalogue of every
  // discovered skill (40 here) on every turn, not the loaded set.
  const activation = new SkillActivation();

  // Only a genuinely new conversation resets the set. `reload` and `fork` keep the
  // same transcript — a loaded skill's guidance is still in context, so dropping
  // activation there would re-gate a tool mid-task, which is the one failure this
  // is supposed to prevent. `startup` needs no reset (the set is already empty).
  pi.on('session_start', async (event) => {
    if (event.reason === 'new' || event.reason === 'resume') activation.reset();
  });

  // A model-invoked skill arrives as a read_skill/read of a SKILL.md, never in
  // the prompt, so both signals have to be watched.
  //
  // This lands *after* this run's gate has already run, and pi snapshots the tool
  // set once per run (`createContextSnapshot`; it sets no `prepareNextTurn`), so
  // the newly-owned tool cannot appear until the next run. `pi.setActiveTools`
  // rebuilds the tool set for the next one — without it the model reads a SKILL.md
  // telling it to call a tool that stays invisible for the whole rest of the run.
  pi.on('tool_call', async (event) => {
    const activated = activation.noteToolCall(event.toolName, event.input);
    if (activated.length > 0) await refreshActiveTools();
    return undefined;
  });

  /**
   * Re-offers any tool whose owning skill just became active.
   *
   * Additive only: it unions the currently-active tools with the ungated ones, so
   * it can never withdraw a tool another extension is relying on. Guarded because
   * `getActiveTools`/`setActiveTools` live on the `pi` API object, not on an
   * event's `ctx` — older hosts may not have them, and a missing one must not
   * throw inside an event handler.
   */
  async function refreshActiveTools(): Promise<void> {
    if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return;
    try {
      const owners = await loadSkillToolOwners(skillsDir());
      if (owners.size === 0) return;
      const active = new Set(pi.getActiveTools());
      let changed = false;
      for (const [tool, skill] of owners) {
        if (!active.has(tool) && activation.has(skill)) {
          active.add(tool);
          changed = true;
        }
      }
      if (changed) pi.setActiveTools([...active]);
    } catch {
      // A gating refresh is a convenience, never worth failing a tool call over.
    }
  }

  pi.on('before_agent_start', async (event, ctx) => {
    const opts = event.systemPromptOptions;

    // A `/skill:name` invocation is expanded into this turn's prompt as
    // `<skill name=… location=…>`, which is the only place it is observable.
    activation.notePrompt(event.prompt ?? '');

    // --- Gate skill-owned tools on their skill being active ---
    // selectedTools is mutable here and is what the model is offered for this run.
    // There is no unregisterTool, and setActiveTools is absent from this event's
    // `ctx` (it lives on the `pi` object — see refreshActiveTools above).
    const owners = await loadSkillToolOwners(skillsDir());
    if (owners.size > 0 && Array.isArray(opts.selectedTools)) {
      const { kept } = gateTools(opts.selectedTools, owners, (d) => activation.has(d));
      opts.selectedTools = kept;
    }

    // --- Discover agents: global roster + agents shipped by ACTIVE skills ---
    // A skill's agents become delegable once its skill is loaded, so an
    // unrelated session is never advertised journal or research agents.
    const agentInventory = mergeAgents(
      await discoverAgents(agentsDir()),
      await discoverSkillAgents(skillsDir(), activation.list()),
    );

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
    // The category comes from the skill's own path when it has one, so the tree
    // on disk is the source of truth and refiling a skill needs no code edit.
    // `skillsDir()` is this repo's library; a package or project-local skill
    // lies outside it and falls through to the name-keyed map instead.
    const library = skillsDir();
    const skillInventory = (opts.skills ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      pathCategory: categoryFromPath(library, skill.filePath),
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

    // --- Build the orchestrator system prompt ---
    const orchestratorPrompt = buildOrchestratorPrompt({
      agentInventory,
      toolInventory,
      skillInventory,
      contextInventory,
      guidelines,
      hasQuestionnaire,
      customPrompt: opts.customPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      cwd: opts.cwd,
      skillsLibrary: library,
    });

    // Replace the default prompt entirely with the orchestrator prompt
    return { systemPrompt: orchestratorPrompt };
  });
}

// ---------------------------------------------------------------------------
// Skill catalogue rendering
// ---------------------------------------------------------------------------

/**
 * Renders the skill catalogue as category headings with bare names.
 *
 * Names only, because that is the whole point of the two-tier format — but a
 * name is only useful if the model can turn it into a file to open. Rather than
 * print 52 absolute paths, each *root* is declared once and the names under it
 * are bare.
 *
 * The library root is declared by the caller's prose. Every other root (the
 * vendored `superpowers` checkout, a project-local `.pi/skills`) gets its own
 * `↳ <root>/<name>/SKILL.md` line here, which is what kept the 15 package
 * skills from costing more in repeated path text than the descriptions they
 * replaced.
 *
 * A skill whose path fits no root at all is printed with its full path inline:
 * unusual, but a name the model cannot resolve is a skill it cannot open, and
 * silence there would be the one failure this format must not have.
 *
 * @param skills - The inventory, each with the category from its path if any.
 * @param library - Absolute path to this repo's skills library.
 */
function renderSkillCategories(
  skills: Array<{ name: string; filePath: string; pathCategory?: string }>,
  library: string,
): string {
  /** The directory a skill's root would be, if it follows `<root>/<name>/SKILL.md`. */
  const rootOf = (s: { name: string; filePath: string }): string | undefined => {
    const suffix = `/${s.name}/SKILL.md`;
    return s.filePath.endsWith(suffix) ? s.filePath.slice(0, -suffix.length) : undefined;
  };

  const inLibrary = (s: { name: string; filePath: string; pathCategory?: string }) =>
    s.pathCategory !== undefined &&
    s.filePath === `${library}/${s.pathCategory}/${s.name}/SKILL.md`;

  // Roots worth declaring: those outside the library that more than one skill
  // shares. A one-off root costs the same either way and reads better inline.
  const counts = new Map<string, number>();
  for (const s of skills) {
    if (inLibrary(s)) continue;
    const root = rootOf(s);
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  const shared = new Set([...counts.entries()].filter(([, n]) => n > 1).map(([r]) => r));

  const body = groupByCategory(skills)
    .map(({ category, skills: list }) => {
      const names = list
        .map((s) => {
          if (inLibrary(s)) return s.name;
          const root = rootOf(s);
          if (root && shared.has(root)) return s.name;
          return `${s.name} (\`${s.filePath}\`)`;
        })
        .join(', ');
      return `**${category}**: ${names}`;
    })
    .join('\n');

  if (shared.size === 0) return body;
  // Sorted so the prompt stays byte-stable run to run.
  const roots = [...shared]
    .sort()
    .map((r) => `↳ also at \`${r}/<name>/SKILL.md\``)
    .join('\n');
  return `${body}\n\n${roots}`;
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

/**
 * Assembles the full orchestrator system prompt from discovered inventories
 * and configuration options.
 *
 * Exported as the **one** seam for this module: callers and tests cross the same
 * interface, so a test asserts on the prompt the model actually receives rather
 * than on nine private section builders. The nine sections stay private on
 * purpose — exporting them would widen the interface without adding leverage,
 * and section *ordering* is part of what a test should be able to pin.
 *
 * Pure: every input arrives in `opts`, the only ambient read is the clock (see
 * `now`). Safe to import from `lib/*.test.ts` — pi auto-loads this file as an
 * extension, but importing it only registers nothing; the default export is what
 * wires the session.
 *
 * @param opts - Inventories and configuration for building the prompt.
 * @returns A formatted markdown string ready to be injected as a system prompt.
 */
export function buildOrchestratorPrompt(opts: {
  agentInventory: AgentInfo[];
  toolInventory: Array<{ name: string; description: string }>;
  /**
   * Every discovered skill. `pathCategory` is set when the skill's location
   * declares its category (a local one); package and project skills leave it
   * undefined and are grouped by name instead.
   */
  skillInventory: Array<{
    name: string;
    description: string;
    filePath: string;
    pathCategory?: string;
  }>;
  contextInventory: Array<{ path: string }>;
  guidelines: string[];
  /** True when the `ask-user` extension's questionnaire tool is available. */
  hasQuestionnaire: boolean;
  customPrompt?: string;
  appendSystemPrompt?: string;
  cwd: string;
  /** Absolute path to this repo's skills library, for the path-rule sentence. */
  skillsLibrary: string;
  /**
   * The clock, for the `Current date:` footer. Injected rather than read so a
   * test can pin the footer without freezing time globally; production omits it
   * and gets `new Date()`.
   */
  now?: Date;
}): string {
  const now = opts.now ?? new Date();
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
Delegation runs in the background and returns a task id, not a result: you end
your turn and the subagent wakes you when it has something to say.

| Agent | Description | Model | Tools | From |
|-------|-------------|-------|-------|------|
${opts.agentInventory.map((a) => `| ${a.name} | ${a.description} | ${a.model ?? 'default'} | ${(a.tools?.length ?? 0) > 0 ? a.tools!.join(', ') : 'all'} | ${a.skill ? `skill: ${a.skill}` : 'global'} |`).join('\n')}

**Agent usage notes:**
- Each agent has a focused role — pick the right one for the task
- Agents run in isolated context windows (don't pollute main conversation)
- Delegate with the \`subagent\` tool, naming the agent and its task
- You can chain agents (e.g., worker → reviewer) for complex workflows

**Delegation is asynchronous, and you must end your turn to collect it.**
\`subagent\` starts a background *task* and returns a task id (e.g. \`sub-a3f1\`) —
not the result. There is deliberately **no blocking wait**: the way you wait for
a subagent is to *finish your turn*.

The loop works like this:

1. Delegate (you can launch several at once — they run concurrently).
2. Do any remaining work that does not depend on their answers.
3. **End your turn.** Say what you delegated and stop. Do not poll, do not spin,
   do not ask the user to wait.
4. When a subagent reports something or finishes, a message arrives
   automatically and you are woken with it. Its answer is in that message.
5. Continue from there — collect the rest, or act on what you were told.

- A subagent can message you **while it is still working** (a blocker, a
  question, a finding). You can only see that because you ended your turn, so
  ending it promptly is what makes mid-run collaboration possible at all.
- Reply to a running subagent with \`subagent_tasks\` \`action: "message"\` — that
  is how you unblock one that asked you something.
- Use \`action: "result"\` to re-read a finished task, \`"status"\` for a quick
  is-it-still-running check, \`"list"\` to see all tasks, and \`"cancel"\` to stop
  one.
- Never treat a task id as an answer, and never claim a delegated task is done
  until you have actually seen its result.
- If every remaining step depends on a subagent, ending your turn *is* the
  correct and complete action. An idle turn is not a failure — it is how you
  hand control back until the subagent has something to say.
`
      : '';

  // --- Quality pass section ---
  // Gated on the grading agents actually being spawnable, like askUserSection is
  // gated on the questionnaire tool: a prompt that orders a delegation to an
  // agent this install does not have is an instruction the model cannot obey.
  //
  // The orchestrator is the one agent with no parent to grade it. A `worker`
  // ends its run by handing the diff to `reviewer`/`verifier`, so work routed
  // through delegation is graded by construction — but the orchestrator edits
  // files directly too, and that path had no gate at all. This closes it, so
  // "who checks the implementation" has the same answer either way.
  const graders = ['reviewer', 'verifier'].filter((g) =>
    opts.agentInventory.some((a) => a.name === g),
  );
  const qualityPassSection =
    graders.length > 0
      ? `
## Quality Pass

When **you** implemented something yourself — edited files, wrote a feature, fixed
a bug — you are the worst available judge of it. A \`worker\` you delegate to ends
its run by having its diff graded by an agent that did not write it. Hold yourself
to the same standard: finish your own implementation work the same way.

Before you tell the user an implementation is done, delegate a quality pass:

\`\`\`
${graders.map((g) => `subagent(agent: "${g}", task: "${g === 'verifier' ? '<goal + absolute project path + the command that checks it>' : '<goal + the exact files you touched, as absolute paths>'}")`).join('\n')}
\`\`\`

Ask for exactly this: **a full and thorough quality pass over the implementation
for any remaining bugs, issues, or quality-of-life improvements.**

**When it applies:** you changed code, config, or anything executable, and the
change is more than a typo or a one-line string. It does **not** apply to work you
only read, planned, or researched, nor to a change a subagent already had graded —
do not re-grade a \`worker\`'s diff it has itself passed through these agents.

**How to delegate it well:**
- Write the task self-contained: the child cannot see this conversation. Name the
  goal, the absolute paths, and the command that checks it.
- **List the files explicitly rather than saying \`git diff\`** — an uncommitted new
  file is untracked, and a diff alone will not show it.
- Launch the graders in one turn so they run concurrently, then end your turn.
${graders.includes('verifier') ? `- \`verifier\` expects a container image tag that already exists. Check
  \`docker image ls 'ralph-verify/*'\` and pass a fitting tag, or say plainly that
  none was prebuilt — an honest INCONCLUSIVE beats a verdict from a container that
  was missing the toolchain. Skip it for changes execution cannot settle (docs,
  naming, prose) or when Docker is unavailable.
` : ''}
**Then act on what comes back.** Fix every Critical and every in-scope Warning,
re-run the project's own checks, and take the small local Suggestions. Report
findings you deliberately did not act on, with the severity the grader gave them,
rather than quietly dropping them. A quality pass you did not act on is a quality
pass you wasted — and a \`FAIL\` means the work is not done, whatever your own
earlier command reported.

Tell the user what the pass found and what you changed in response. If you judge a
change too trivial to grade, say that you skipped it and why; do not skip silently.
`
      : '';

  // --- Skill inventory section ---
  // Two-tier by design: categories and names here, descriptions on demand.
  //
  // The full table cost ~4.2k tokens of every request (52 skills × a paragraph
  // each) to describe skills that a given session overwhelmingly does not use.
  // What the model actually needs up front is enough to decide *what to open*,
  // and the grouped name is that. The description is one `read_skill` away, and
  // it is the authoritative copy rather than a summary of itself.
  //
  // This is a real trade, not a free win: a name is a weaker routing signal than
  // a sentence. It is paid for by the names themselves — the opaque ones were
  // renamed to verb phrases — and by stating the path rule so the model can
  // open any skill without being handed 52 absolute paths.
  const skillSection =
    opts.skillInventory.length > 0
      ? `
## Available Skills

Skills are specialized knowledge modules, grouped by domain. Only names are
listed — to use one, read its \`SKILL.md\` with \`read_skill\` first, or let the
human invoke it with \`/skill:name\`.

Most live at \`${opts.skillsLibrary}/<category>/<name>/SKILL.md\`; the ones that do
not carry their path inline below.

${renderSkillCategories(opts.skillInventory, opts.skillsLibrary)}

**Orchestration rules:**
- A name is a hint, not a contract: open the skill before acting on it
- Prefer reading a plausible skill over guessing at what it contains
- Skills are advisory — you decide when they apply
- If a skill's guidance conflicts with the task, use your judgment
- A skill may own tools that appear only once it is loaded
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

${askUserSection}${toolSection}${agentSection}${qualityPassSection}${skillSection}${contextSection}${guidelinesSection}${customSection}${appendSection}${footer}`;
}
