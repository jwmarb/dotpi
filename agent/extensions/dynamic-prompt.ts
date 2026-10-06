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

/**
 * Name of the tool registered by the `subagent-herdr` extension. The agent
 * sections are gated on it: a roster discovered on disk is not a capability
 * unless the tool that spawns those agents is actually offered this run.
 */
const SUBAGENT_TOOL = 'subagent';

/**
 * The two agents that grade an implementation: `reviewer` reads it, `verifier`
 * runs it. A closed union rather than `string`, so the role table below has to
 * cover every member and a third grader fails to compile at the one place that
 * must be updated — the alternative was an unreachable `??` fallback that only
 * looked like safety.
 */
type Grader = 'reviewer' | 'verifier';

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

    // --- Detect the subagent-herdr extension ---
    // `agentInventory` is read off `agents/*.md` on disk, which says nothing about
    // whether the extension that can *spawn* them loaded. subagent-herdr imports
    // `../model-fallback/lib.js` and typebox, and the documented failure mode when
    // that resolution breaks is a silent load failure — leaving a prompt that
    // mandates delegation while offering no tool to delegate with. Same rule as the
    // questionnaire gate, one level up: an agent roster is only actionable if the
    // tool that spawns it exists.
    const hasSubagent =
      (opts.selectedTools ?? []).includes(SUBAGENT_TOOL) ||
      toolInventory.some((t) => t.name === SUBAGENT_TOOL);

    // --- Build the orchestrator system prompt ---
    const orchestratorPrompt = buildOrchestratorPrompt({
      agentInventory,
      toolInventory,
      skillInventory,
      contextInventory,
      guidelines,
      hasQuestionnaire,
      hasSubagent,
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
 * Renders the skill catalogue as category headings with one line per skill:
 * name, path when it is not implied, and description.
 *
 * The description is here on purpose. An earlier format printed bare names to
 * save the tokens 52 descriptions cost on every request, and the saving was
 * real — but a name is the entire basis on which the model decides what to
 * `read_skill`, and names like `triage` or `wayfinder` do not carry enough to
 * earn that call. The catalogue has to be a routing table, not an index.
 *
 * What that earlier format got right is kept: each *root* is declared once and
 * the names under it are bare, rather than printing 52 absolute paths. The
 * library root is declared by the caller's prose; every other root (the
 * vendored `superpowers` checkout, a project-local `.pi/skills`) gets its own
 * `↳ <root>/<name>/SKILL.md` line here.
 *
 * A skill whose path fits no root at all is printed with its full path inline:
 * unusual, but a name the model cannot resolve is a skill it cannot open, and
 * silence there would be the one failure this format must not have.
 *
 * @param skills - The inventory, each with its description and the category
 * from its path if any.
 * @param library - Absolute path to this repo's skills library.
 */
function renderSkillCategories(
  skills: Array<{
    name: string;
    description: string;
    filePath: string;
    pathCategory?: string;
  }>,
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
      const lines = list.map((s) => {
        const root = rootOf(s);
        // The path is printed only when neither the library prose nor a
        // declared root already implies it.
        const where = inLibrary(s) || (root && shared.has(root)) ? '' : ` (\`${s.filePath}\`)`;
        // An empty description would leave a dangling dash, and a skill the
        // model cannot route to is the failure this section exists to avoid —
        // so say that the description is missing rather than printing nothing.
        const desc = s.description.trim() || '(no description — open it to find out)';
        return `- **${s.name}**${where} — ${desc}`;
      });
      return `**${category}**\n${lines.join('\n')}`;
    })
    .join('\n\n');

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
 * than on its private section builders. Those sections stay private on
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
  /**
   * True when the `subagent-herdr` extension's spawn tool is available. The agent
   * roster is discovered from disk independently, so without this a prompt could
   * order a delegation the session has no tool to perform.
   */
  hasSubagent: boolean;
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
    opts.hasSubagent && opts.agentInventory.length > 0
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

  // --- Grading roster ---
  // Shared by the two sections below, both of which name these agents directly.
  // Gated on them actually being spawnable, like askUserSection is gated on the
  // questionnaire tool: a prompt that orders a delegation to an agent this
  // install does not have is an instruction the model cannot obey.
  // The `subagent` conjunct is what makes a roster actionable: without the spawn
  // tool these sections would order a delegation the session cannot perform.
  const graders = (opts.hasSubagent ? (['reviewer', 'verifier'] as const) : []).filter((g) =>
    opts.agentInventory.some((a) => a.name === g),
  );
  // Every phrase that mentions a grader is derived from this one filtered roster,
  // so a single-grader install cannot end up with a list of one described in the
  // plural. That is a bug both sections below have actually shipped: the prose
  // around the list ("launch them", "those two tasks", "these graders") was
  // hardcoded while the list itself was computed, and the two silently
  // disagreed. Anything number-sensitive therefore branches on `graders.length`
  // — and `ROLE` holds the role *without* the agent's name, so the name is
  // printed exactly once per sentence by the caller that needs it.
  const ROLE: Record<Grader, string> = {
    reviewer: 'reads the implementation for correctness',
    verifier: 'proves it actually runs',
  };
  const plural = graders.length > 1;
  const graderList = graders.map((g) => `\`${g}\``).join(' and ');
  // Singular drops the redundant second mention: the list already named it.
  const graderRoles = plural
    ? graders.map((g) => `\`${g}\` ${ROLE[g]}`).join(', and ')
    : `it ${graders[0] ? ROLE[graders[0]] : ''}`;
  // The verifier's obligation is conditional wherever else it is stated — Quality
  // Pass below and `agents/worker.md` both qualify it on the change being
  // runtime-testable — so the sentence that *introduces* it must not read as
  // absolute, or the model launches a container run for a prose edit. It is its
  // own trailing sentence rather than an inline aside, because inlining it
  // collided with the clause that follows the list in the single-grader case.
  const verifierCaveat = graders.includes('verifier')
    ? ` \`verifier\` applies only when execution can settle the change${
        plural ? '; `reviewer` always applies' : ''
      }.`
    : '';

  // --- Planning delegation section ---
  // The orchestrator's weakest moment is the one where it starts editing from a
  // plan it holds only in its own head: `planner` reads the actual files and
  // returns an ordered, file-specific plan, and improvising that order instead is
  // how a half-finished refactor gets left behind.
  //
  // The grading obligation is stated *here* rather than left to the Quality Pass
  // section alone, because a plan nobody checked against the result is a
  // document and not an engineering step. The one carve-out is the same one
  // Quality Pass already makes — a `worker` ends its own run by handing its diff
  // to these graders, so re-grading it would buy a duplicate pass and nothing
  // else.
  const hasPlanner =
    opts.hasSubagent && opts.agentInventory.some((a) => a.name === 'planner');
  const planningSection = hasPlanner
    ? `
## Plan Before You Implement

For any change beyond a trivial edit, **delegate the plan to \`planner\` before you
touch code.** It reads the real files and returns an ordered, file-specific,
verifiable plan. Designing that order in your head instead is how a change lands
half-finished.

**Delegate to \`planner\` when:**
- The work spans two or more files, or needs three or more steps
- It is a feature, a refactor, or a migration — however small it looks
- You are about to invent an approach you have not written down anywhere

**Go direct when:**
- It is a typo, a one-line fix, a single string or constant
- You are only reading, researching, or explaining — nothing is being changed
- You already have a written, file-specific plan — from the user, or from a skill that produced one

**Name any skip.** If a change clears that bar and you still plan it yourself,
say which and why, in one line. Silently skipping is the failure this section
exists to prevent.
${
  graders.length > 0
    ? `
**A \`planner\` plan carries a grading obligation.** Whenever you call
\`planner\`, the implementation that follows it gets graded by ${graderList} before
you report it done — ${graderRoles}.${verifierCaveat} ${
  plural
    ? `Launch them
in one turn so they run concurrently, then end your turn. See **Quality Pass**
below for how to write those two tasks.`
    : `Launch it, then end your turn. See **Quality Pass**
below for how to write that task.`
}

The pairing is the point: a plan nobody checked against the result is a document,
not an engineering step. The single exception is the one Quality Pass already
names — a \`worker\` has passed its own diff through ${plural ? 'these graders' : 'this grader'}, so do not
re-grade it. Grade what **you** implemented.
`
    : ''
}`
    : '';

  // --- Quality pass section ---
  // The orchestrator is the one agent with no parent to grade it. A `worker`
  // ends its run by handing the diff to `reviewer`/`verifier`, so work routed
  // through delegation is graded by construction — but the orchestrator edits
  // files directly too, and that path had no gate at all. This closes it, so
  // "who checks the implementation" has the same answer either way. The planning
  // section above makes the same obligation explicit for plan-driven work.
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
do not re-grade a \`worker\`'s diff it has itself passed through ${plural ? 'these agents' : 'this agent'}.

**How to delegate it well:**
- Write the task self-contained: the child cannot see this conversation. Name the
  goal, the absolute paths, and the command that checks it.
- **List the files explicitly rather than saying \`git diff\`** — an uncommitted new
  file is untracked, and a diff alone will not show it.
- ${plural ? 'Launch the graders in one turn so they run concurrently, then end your turn.' : 'Launch it, then end your turn.'}
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
  // Descriptions, and the instruction to reach for them first. Both are
  // deliberate reversals of an earlier design, so the reasoning matters.
  //
  // This section used to be two-tier — category headings with bare names — and
  // framed skills as purely advisory ("you decide when they apply"). That cost
  // ~4.2k tokens less per request, and what it bought was a model that mostly
  // did not open them: a bare name is a weak routing signal, and "advisory" is
  // a licence to skip. The result is the expensive failure, because every skill
  // in that library exists for a reason — improvising that work went badly at
  // least once already.
  //
  // So the trade is now the other way round: pay the tokens to make skill
  // selection a decision the model can actually make, and state that consulting
  // the catalogue is the opening move rather than a fallback. It stops short of
  // a hard mandate — a skip is allowed, but it has to be *named*, which is what
  // makes a wrong default visible in the transcript instead of silent.
  //
  // Not a free win either way: a prompt that pushes skills can over-apply one to
  // a task it does not fit, which is why the last rules keep the file (not the
  // name) authoritative and keep the task above the skill in a real conflict.
  const skillSection =
    opts.skillInventory.length > 0
      ? `
## Available Skills

Skills are specialized knowledge modules: distilled, already-debugged procedure
for work that has been done badly before. **Consulting this catalogue is the
default opening move, not a fallback.** When one matches the task it beats
anything you will improvise, because it encodes the failures you have not hit yet.

To use a skill, read its \`SKILL.md\` with \`read_skill\`: the line below is a
routing signal, the file is the method. The human can also invoke one with
\`/skill:name\`.

Most live at \`${opts.skillsLibrary}/<category>/<name>/SKILL.md\`; the ones that do
not carry their path inline below.

${renderSkillCategories(opts.skillInventory, opts.skillsLibrary)}

**How to use this catalogue:**
- **Check it before you plan.** For any task beyond a one-line answer, scan for a
  matching skill and open it *before* designing your approach — not after the
  approach fails.
- **Prefer the skill to your own default.** If one matches, follow it.
- **Name any skip.** If a plausible skill exists and you choose not to use it,
  say which one and why, in one line. Silently ignoring the catalogue is the
  failure this section exists to prevent.
- **Composition is normal.** Several skills can apply to one task (plan it, then
  verify it); loading one does not rule out another.
- A name is a hint, not a contract: open the file rather than guessing at what it
  contains, and act on what it says rather than on the summary here.
- If a skill's guidance genuinely conflicts with the task, the task wins — but
  state which skill you set aside and why.
- A skill may own tools that appear only once it is loaded.
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
2. **Plan** — Consult the skills catalogue first, then${hasPlanner ? ` delegate the plan to \`planner\` for anything beyond a trivial edit (see **Plan Before You Implement**) and` : ''} determine the optimal sequence of tool calls and skill invocations
3. **Execute** — Call tools and skills in the correct order, handling errors gracefully
4. **Verify** — Confirm each step's result before proceeding to the next
5. **Adapt** — If something fails, diagnose and try a different approach

## Decision Framework

When given a task:
1. Identify the goal and any constraints
2. Check which tools are available, and scan the skills catalogue for a match — open any plausible skill before designing the plan
3. ${hasPlanner ? `Delegate the plan to \`planner\` for two or more files or three or more steps — and name any skip (see **Plan Before You Implement**)` : 'Design a step-by-step plan'}
4. Execute the plan, verifying each step
5. Report back with results and any issues

## Error Handling

- If a tool call fails, read the error and adjust your approach
- If no skill fits, say so in one line and proceed with tools — but check the catalogue before concluding that
- If you're unsure, read relevant files before making assumptions${opts.hasQuestionnaire ? `\n- If reading the code cannot resolve the uncertainty, ask via the \`${QUESTIONNAIRE_TOOL}\` tool instead of assuming` : ''}
- Communicate your plan to the user for complex or risky operations

${askUserSection}${toolSection}${agentSection}${planningSection}${qualityPassSection}${skillSection}${contextSection}${guidelinesSection}${customSection}${appendSection}${footer}`;
}
