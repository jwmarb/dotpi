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
  delegationRoster,
  LINEAGE_ENV,
  parseLineage,
  type AgentInfo,
  type DelegationRoster,
} from './lib/agents.js';
import { agentsDir, skillsDir } from './lib/layout.js';
import { personaOverride } from './lib/persona.js';
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
 * Name of the tool registered by the `kanban` extension. It is registered for the
 * orchestrator only — the factory returns as soon as `PI_SUBAGENT_RUN_ID` is set —
 * so this flag is naturally false in a child and needs no `isSubagent` conjunct of
 * its own. Nothing from `kanban/lib.ts` is imported here: the *capability* reaches this
 * module through `promptInputs` as a boolean, and a top-level extension taking a
 * dependency on a sibling's internals is the coupling that gate avoids — pi-tui resolves
 * at the repo root and `lib/runtime.test.ts` imports `../kanban/lib.js`, so the bar is
 * architectural, not technical. Only one cap is restated, by hand, as a numeral in the
 * prose below: the per-call title cap (`MAX_ADD_PER_CALL`, "up to 20 titles per call").
 * The 200-card cap is never printed — the tool's refusal names it — so it has no copy
 * to drift. Change `MAX_ADD_PER_CALL` and you change the prose here in the same commit:
 * nothing at test time can catch that drift.
 */
const KANBAN_TOOL = 'kanban';

/**
 * A model ref in the fleet is written `provider/model|effort`, so it contains a pipe. Raw, it
 * closes a cell early and a 5-column table renders 6 fields — and the Tools column is what
 * `delegationSection` tells the model to read when picking an implementer, so a mangled row
 * hides an agent's real tools from the one rule that depends on them. Module scope: the tool
 * table uses it too, and a `const` below that template is in its TDZ when the template runs.
 * GFM renders `\|` in a cell as a literal `|`.
 */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

/**
 * The roster's implementation agent. Named in the prompt only when the roster this
 * session may actually spawn has it — a roster is not a capability.
 */
const WORKER_AGENT = 'worker';

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
    // A persona switch owns the active set: the persona extension declares it and
    // hard-blocks everything outside it, so the additive refresh below is skipped
    // — running it would widen pi's set beyond the switch's declaration, and the
    // switch's own `tool_call` block would then refuse every widened tool.
    if (activated.length > 0 && !personaOverride()) await refreshActiveTools();
    return undefined;
  });

  /**
   * Re-offers any tool whose owning skill just became active.
   *
   * Additive only: it unions the currently-active tools with the ungated ones, so
   * it can never withdraw a tool another extension is relying on. Guarded because
   * `getActiveTools`/`setActiveTools` live on the `pi` API object, not on an
   * event's `ctx` — older hosts may not have them, and a missing one must not
   * throw inside an event handler. It is also skipped under a persona switch —
   * the persona extension owns the active set there, and an additive refresh would
   * widen it beyond the switch's declaration (which the switch's block then
   * refuses); the call site guards on `personaOverride()`.
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
    // `prompt` exists only on user-triggered runs (1.2.0's `BeforeAgentStartEvent`
    // is a user/custom discriminated union); a custom-triggered turn has none to scan.
    activation.notePrompt(event.messageType === 'user' ? event.prompt : '');

    // A persona switch takes over the prompt: the switched profile's own
    // prompt extension builds it, so this one yields, leaving the run to the
    // switched builder. With no override `personaOverride()` is undefined and
    // the path below is byte-identical to the pre-switch code.
    if (personaOverride()) return undefined;

    // Everything that touches disk or env is loaded here; promptInputs is pure.
    // The roster carries agents shipped by ACTIVE skills only, so an unrelated
    // session is never advertised journal or research agents.
    const library = skillsDir();
    const owners = await loadSkillToolOwners(library);
    const lineage = parseLineage(process.env[LINEAGE_ENV]);
    const roster = await delegationRoster({
      agentsDir: agentsDir(),
      skillsDir: library,
      lineage,
      activeSkills: activation.list(),
    });

    const inputs = promptInputs({
      systemPromptOptions: opts,
      lineage,
      roster,
      owners,
      isActive: (d) => activation.has(d),
      skillsLibrary: library,
    });

    // --- Apply the gate to this run ---
    // selectedTools is mutable here and is what the model is offered for this run.
    // There is no unregisterTool, and setActiveTools is absent from this event's
    // `ctx` (it lives on the `pi` object — see refreshActiveTools above). Assigned
    // under the same condition gating always ran under, so a session with no
    // skill-owned tools leaves pi's array untouched.
    if (owners.size > 0 && Array.isArray(opts.selectedTools)) {
      opts.selectedTools = inputs.selectedTools;
    }

    const orchestratorPrompt = buildOrchestratorPrompt(inputs.buildOptions);

    // Replace the default prompt entirely with the orchestrator prompt
    return { systemPrompt: orchestratorPrompt };
  });
}

// ---------------------------------------------------------------------------
// Prompt input assembly
// ---------------------------------------------------------------------------

/** Inputs to {@link promptInputs}: everything the handler has already loaded. */
export interface PromptInputsOptions {
  /**
   * The event's `systemPromptOptions` — only the fields read here, so pi's
   * normalized options satisfy it and a test can pass a minimal literal.
   */
  systemPromptOptions: {
    selectedTools?: readonly string[];
    toolSnippets?: Readonly<Record<string, string>>;
    promptGuidelines?: readonly string[];
    skills?: ReadonlyArray<{ name: string; description: string; filePath: string }>;
    contextFiles?: ReadonlyArray<{ path: string }>;
    customPrompt?: string;
    appendSystemPrompt?: string;
    cwd: string;
  };
  /** This process's ancestry, oldest first; empty for the human's orchestrator. */
  lineage: readonly string[];
  /** The delegation roster; only `.spawnable` is advertised. */
  roster: DelegationRoster;
  /** Tool name → the skill directory that must be active for it to be offered. */
  owners: ReadonlyMap<string, string>;
  /** Whether a skill directory is active this session. */
  isActive: (skillDir: string) => boolean;
  /** Absolute path to this repo's skills library. */
  skillsLibrary: string;
}

/** What {@link promptInputs} assembles. */
export interface PromptInputsResult {
  /** The offered tools after skill gating — a new array, input order kept. */
  selectedTools: string[];
  /** Exactly the parameter object {@link buildOrchestratorPrompt} takes. */
  buildOptions: Parameters<typeof buildOrchestratorPrompt>[0];
}

/**
 * Assembles the orchestrator prompt's inputs from what the handler loaded:
 * gates skill-owned tools, builds the tool/skill/context inventories, and
 * derives the capability flags. Pure and synchronous — no disk, no env, and
 * the input `selectedTools` is never mutated (the handler assigns the result).
 */
export function promptInputs(opts: PromptInputsOptions): PromptInputsResult {
  const spo = opts.systemPromptOptions;

  // --- Gate skill-owned tools on their skill being active ---
  const { kept: selectedTools } = gateTools(spo.selectedTools ?? [], opts.owners, opts.isActive);

  // --- Agents ---
  // A skill's agents become delegable once its skill is loaded (the roster was
  // discovered for the active set), and only what THIS process may spawn is
  // advertised: an agent its `subagent` call would refuse (a cycle, or a
  // `callable_by` that does not name it) turns one delegation into a refusal
  // plus a retry. Same rule as the spawn guard, via `delegationRoster`.
  const agentInventory = opts.roster.spawnable;

  // --- Build tool inventory ---
  // Only include tools that have a snippet available; fallback to empty description
  const toolInventory = selectedTools
    .filter((name) => spo.toolSnippets?.[name])
    .map((name) => ({
      name,
      description: spo.toolSnippets?.[name] ?? '',
    }));

  // --- Build skill inventory ---
  // The category comes from the skill's own path when it has one, so the tree
  // on disk is the source of truth and refiling a skill needs no code edit.
  // `skillsLibrary` is this repo's library; a package or project-local skill
  // lies outside it and falls through to the name-keyed map instead.
  const library = opts.skillsLibrary;
  const skillInventory = (spo.skills ?? []).map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    pathCategory: categoryFromPath(library, skill.filePath),
  }));

  // --- Build context file inventory ---
  const contextInventory = (spo.contextFiles ?? []).map((f) => ({
    path: f.path,
  }));

  // --- Filter out empty guideline entries ---
  const guidelines = (spo.promptGuidelines ?? []).filter((g) => g.trim().length > 0);

  // --- Detect the ask-user extension ---
  // ask-user.ts registers a tool named `questionnaire`. If it is loaded we
  // instruct the orchestrator to ask the user through it.
  const hasQuestionnaire =
    selectedTools.includes(QUESTIONNAIRE_TOOL) ||
    toolInventory.some((t) => t.name === QUESTIONNAIRE_TOOL);

  // --- Detect the subagent-herdr extension ---
  // `agentInventory` is read off `agents/*.md` on disk, which says nothing about
  // whether the extension that can *spawn* them loaded. subagent-herdr imports
  // `../model-fallback/lib.js` and typebox, and the documented failure mode when
  // that resolution breaks is a silent load failure — leaving a prompt that
  // mandates delegation while offering no tool to delegate with. Same rule as the
  // questionnaire gate, one level up: an agent roster is only actionable if the
  // tool that spawns it exists. Computed after gating, like the inventory.
  const hasSubagent =
    selectedTools.includes(SUBAGENT_TOOL) ||
    toolInventory.some((t) => t.name === SUBAGENT_TOOL);

  // --- Detect the kanban extension ---
  // The same two signals as the questionnaire and subagent gates: the gated
  // `selectedTools` AND the snippet-filtered inventory. `toolInventory` alone is the
  // weaker signal — it lists only tools pi handed over with a snippet — so the flag
  // is computed HERE, off the gated list, and not as a `toolInventory.some(...)`
  // inside the builder: a builder-side check goes false on a session that really does
  // have the tool, and a field on `buildOptions` is pinned at the call site by
  // `Parameters<typeof buildOrchestratorPrompt>[0]`, which a bare name match is not.
  // The retired `plan` section's gate was a bare name match, and it outlived its tool.
  const hasKanban =
    selectedTools.includes(KANBAN_TOOL) ||
    toolInventory.some((t) => t.name === KANBAN_TOOL);

  return {
    selectedTools,
    buildOptions: {
      agentInventory,
      toolInventory,
      skillInventory,
      contextInventory,
      guidelines,
      hasQuestionnaire,
      hasSubagent,
      hasKanban,
      isSubagent: opts.lineage.length > 0,
      customPrompt: spo.customPrompt,
      appendSystemPrompt: spo.appendSystemPrompt,
      cwd: spo.cwd,
      skillsLibrary: library,
    },
  };
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
  /**
   * True when the `kanban` extension's tool is offered this run. Registered for the
   * orchestrator only, so the tool gate is the whole gate: a child is never offered
   * the tool, hence no `isSubagent` conjunct here.
   */
  hasKanban: boolean;
  /**
   * True when this process is itself a delegated subagent (non-empty
   * lineage). The planning and Quality Pass sections are written for the
   * human's orchestrator; a subagent's own body carries its grading contract
   * (`worker.md`), so they are withheld rather than duplicated in the wrong voice.
   */
  isSubagent?: boolean;
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
${opts.toolInventory.map((t) => `| ${cell(t.name)} | ${cell(t.description)} |`).join('\n')}

**Orchestration rules:**
- Break complex tasks into smaller, verifiable steps
- Use the right tool for each subtask — don't force a single tool to do everything
- Read before you write; verify before you commit
- When a tool call fails, diagnose the error and try a different approach
- Parallelize independent operations where possible
- Always confirm the outcome matches the user's intent before declaring success
`
      : '';

  // The chain note names no agents. It used to be the literal "worker → reviewer", which
  // dangled in a roster that has neither. Deriving the pair from the roster is no better: the
  // arrow reads as a child spawning a child, and whether that is legal is decided by
  // `lineageRejection(name, callableBy, lineage)` in lib/agents.ts. The roster entries do
  // carry `callableBy`, but this builder is handed no lineage — only `isSubagent` — so it
  // cannot evaluate the rule that would refuse the pair (explorer → healthcheck, and every
  // self-chain, are refused for a child). State the capability, not a pair: the roster is
  // already filtered for the process that prints it, so a sequential chain of its entries is
  // something that process can actually do.

  // --- Agent inventory section ---
  const agentSection =
    opts.hasSubagent && opts.agentInventory.length > 0
      ? `
## Available Agents

Specialized subagents you can delegate tasks to via the \`subagent\` tool.
Delegation runs in the background and returns a task id, not a result: you end
your turn and the subagent wakes you when it has something to say.

The Model column is markdown-escaped, so a \`\\|\` inside a cell is one \`|\`: a ref printed as
\`provider/model\\|low\` is passed to a \`model:\` override as \`provider/model|low\` \u2014 drop the backslash.

| Agent | Description | Model | Tools | From |
|-------|-------------|-------|-------|------|
${opts.agentInventory.map((a) => `| ${cell(a.name)} | ${cell(a.description)} | ${cell(a.model ?? 'default')} | ${cell((a.tools?.length ?? 0) > 0 ? a.tools!.join(', ') : 'all')} | ${cell(a.skill ? `skill: ${a.skill}` : 'global')} |`).join('\n')}

**Agent usage notes:**
- Each agent has a focused role — pick the right one for the task
- Agents run in isolated context windows (don't pollute main conversation)
- Delegate with the \`subagent\` tool, naming the agent and its task
- You can chain agents: the report a child brings back is the next child's task — launch it in the turn you read the report

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

  // --- Delegation gates ---
  // Delegation is a capability, not a roster: `agentInventory` is read off disk, so
  // every phrase that names an agent is gated on that agent being one this session
  // may spawn. `canDelegate` mirrors the gate `agentSection` gave its own table (spawn
  // tool + non-empty roster) plus `!isSubagent`, so this module can never point at an
  // `## Available Agents` table it did not print, and never hands a child a section
  // written for its parent — the planning and Quality Pass sections withhold on the
  // same conjunct.
  const canDelegate =
    opts.hasSubagent && !opts.isSubagent && opts.agentInventory.length > 0;
  const hasWorker =
    opts.hasSubagent &&
    !opts.isSubagent &&
    opts.agentInventory.some((a) => a.name === WORKER_AGENT);
  // A roster with no `worker` gets the same push with no hardcoded name, so the
  // section cannot dangle an agent this install does not have. The fallback carries
  // the *joint* test — role and capability — because it is also printed in the Execute
  // step, 190 lines above the delegation section's own qualifier: a role-only test
  // there denotes `planner` ("Writes no code") in the real fleet minus `worker`, and a
  // capability-only test denotes `spiker` (a throwaway sandbox).
  const implName = hasWorker
    ? `\`${WORKER_AGENT}\``
    : 'the roster agent whose role fits the step and whose Tools column shows write and edit (or all)';
  // Rows that can edit files: an explicit write+edit pair, or an unrestricted
  // (`tools: []`) agent, which the table prints as "all". Counted, not described,
  // so the sentence stays true of whatever roster this install has.
  const writerRows = opts.agentInventory.filter(
    (a) =>
      (a.tools?.length ?? 0) === 0 || (a.tools!.includes('write') && a.tools!.includes('edit')),
  ).length;
  const rowsWord = (n: number) => (n === 1 ? 'row' : 'rows');
  const writerCount = `${writerRows} of ${opts.agentInventory.length} ${rowsWord(opts.agentInventory.length)} ${writerRows === 1 ? 'shows' : 'show'} write and edit (or all)`;

  // --- Kanban board section ---
  // The board is the plan of record the user can watch. `kanban/lib.ts`'s `nudgeFor()`
  // states the accounting rule at end-of-turn, so the dispositions and the prohibition
  // below are lifted from that text on purpose: the rule a model reads up front must
  // not drift from the guard that holds its turn, and nothing here may phrase that
  // rule as a way to get past the guard.
  const boardLinkLine = canDelegate
    ? "- `link` a card to the run id `subagent` returned the moment you delegate it, so the board shows that run's live status.\n"
    : '';
  const boardAccounted = canDelegate
    ? ', or linked to a run that is still running'
    : '';
  const boardSection = opts.hasKanban
    ? `
## Kanban Board

Run the work on the board. The user watches it beside this conversation, and a step
that is not on it is a step nobody can see you do.

**Open it before you start.** For work of two or more steps, call \`kanban\` \`add\`
(up to 20 titles per call) with one card per step, in the order you intend to do them;
\`show\` first, so you extend the board instead of duplicating it. One card per step: not
one per file, and not one card for "the rest".
Skip the board for a single step, or for trivial work — a board for a one-line fix is
noise the user has to look at.

**Keep it true as you go.**
- \`move\` to \`in_progress\` when you start a card. Several cards may be \`in_progress\` at once.
${boardLinkLine}- \`move\` to \`review\` with the note naming what you ran; to \`done\` only once it is
  genuinely verified, with that evidence in the note.
- \`move\` to \`blocked\` with a note saying what it waits on (including the user).
- \`drop\` a card that turns out not to be needed; \`clear_done\` to clear finished work off
  the board before you add the next batch.

**Account for every card before you end the turn:** each one is \`done\`, \`blocked\` with
a note, dropped${boardAccounted}. \`review\` is not one of them: the guard keeps counting a
card there while nothing else is waiting. The board's guard holds the turn open while a card is
unaccounted for; answer it by doing the work, or by moving the card to the column that
is true. Never move a card to silence the guard.

Do not restate the board in your replies — the user sees it. Re-read it with \`show\`
(for example after compaction). The user edits it with \`/kanban\`; follow their changes.
`
    : '';

  // --- Grading roster ---
  // Shared by the three sections below (planning, delegation, quality pass), each of which
  // names these agents directly.
  // Gated on them actually being spawnable, like askUserSection is gated on the
  // questionnaire tool: a prompt that orders a delegation to an agent this
  // install does not have is an instruction the model cannot obey.
  // The `subagent` conjunct is what makes a roster actionable: without the spawn
  // tool these sections would order a delegation the session cannot perform.
  const graders = (opts.hasSubagent && !opts.isSubagent ? (['reviewer', 'verifier'] as const) : []).filter((g) =>
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

  // Additive clause on the Execute step, so the header states the board and
  // delegation rules in the same sentence the rest of the prompt points at. Every
  // branch keeps the sentence grammatical, and the no-capability branch is
  // byte-identical to what shipped: `canDelegate` is false in a roster-less install,
  // so no agent name is ever printed there.
  const executeClause =
    opts.hasKanban && canDelegate
      ? ` with each step tracked on the \`${KANBAN_TOOL}\` board, delegating implementation to ${implName} (see **Kanban Board** and **Delegate the Implementation**)`
      : opts.hasKanban
        ? ` with each step tracked on the \`${KANBAN_TOOL}\` board (see **Kanban Board**)`
        : canDelegate
          ? `, delegating implementation to ${implName} (see **Delegate the Implementation**)`
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
  //
  // The exemption names `worker`, so it is gated on `worker`: a roster without it has no
  // self-grading child, and `delegationSection` tells that install the opposite ("No
  // child's diff comes graded in this install"). Granting the exemption there is a
  // licence to skip the only pass that exists, citing an agent the roster lacks — the
  // identical bug one level down, which AGENTS.md records as this module's habit.
  // Quality Pass gates its three `worker` branches for the same reason.
  const hasPlanner =
    opts.hasSubagent && !opts.isSubagent && opts.agentInventory.some((a) => a.name === 'planner');
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
not an engineering step.${hasWorker
  ? `

The single exception is the one Quality Pass already names: a \`worker\` has passed its own diff through ${plural ? 'these graders' : 'this grader'}, so do not re-grade it.`
  : ''} Grade what **you** implemented.
`
    : ''
}${
  opts.hasKanban
    ? `
**Put the plan on the board.** \`planner\` returns an ordered list of steps; make that
list the board. Call \`kanban\` \`add\` with one card per step, in the plan's order,
before you touch code, then work the board. A plan that lives only in this transcript
is a conversation, not a plan of record.
`
    : ''
}`
    : '';

  // --- Delegation-first section ---
  // The orchestrator's second weakest moment: it takes a plan it did not write and
  // executes the whole thing inline, so the implementation is graded by nobody and the
  // user watches a wall of edits from the agent meant to coordinate. A `worker` ends
  // its own run graded, so pushing work to the child also pushes it behind a gate.
  // Gate: a roster this session can delegate to. The agent name is gated one level
  // finer (`implName`), and every grader phrase — the Quality Pass pointer included —
  // is gated on `graders`, because that section is emitted on exactly that condition
  // and a pointer to a section that was never printed is the dangling reference this
  // module keeps having to fix.
  // The child's self-grade is derived, never hardcoded, for two reasons this module has
  // already been burned by: `verifier` is conditional in `agents/worker.md` (as it is in
  // Quality Pass below), and in an install with no spawnable grader *no* child is graded
  // at all. Stating the pass as unconditional is how the orchestrator comes to believe a
  // docs change was verified and declines the one pass still owed — so each phrase below
  // prints only the pass that exists.
  // Singular states the condition without naming the agent twice: the list already
  // named it, and `verifierCaveat` is a separate sentence for exactly this reason.
  const verifierParen = !graders.includes('verifier')
    ? ''
    : plural
      ? ' (the `verifier` only when execution can settle the change)'
      : ' (only when execution can settle the change)';
  const childSelfGrade = graders.length > 0 ? `graded by ${graderList}${verifierParen}` : '';
  const childReports = childSelfGrade
    ? `has its own diff ${childSelfGrade} before it reports`
    : 'reports what it ran — the check on it is yours';
  const implSentence = hasWorker
    ? `When a plan has implementation steps, delegate them to \`${WORKER_AGENT}\`: it edits the files, runs the project's checks, and ${childReports}.`
    : `When a plan has implementation steps, delegate them to ${implName} — both conditions, read off the Available Agents table: ${writerCount}, and a row that can write but whose role is a throwaway spike is not an implementer either. If no row does both, this install has no implementer: the editing is yours, and so is the pass on it.`;
  const qualityPassPointer =
    graders.length > 0
      ? ` See **Quality Pass** below for how to write ${plural ? 'those tasks' : 'that task'}.`
      : '';
  // The exemption from ordering a grader pass is an instruction to obey only where a
  // graded child pass exists. `worker` is the only roster agent whose body ends its run
  // with one, and with no grader spawnable there is no pass to decline — so the
  // paragraph is gated on both, and the inverse is stated out loud rather than left
  // out: an ungraded child's work must not read as work that was checked.
  const gradingParagraph =
    graders.length > 0 && hasWorker
      ? `**Grading follows the work, not the doer.** A child that implements ends its own run
by having its diff ${childSelfGrade} — do not order that pass again. Read the child's
report of that pass: anything it says it skipped is yours. What is yours is what no child
graded: the work you implemented yourself, and the glue you edited while integrating what
came back.${qualityPassPointer}`
      : `**The pass on what comes back is yours.** ${
        graders.length > 0
          ? `No agent in this roster ends its own run with a grading pass, so no child's diff arrives checked.${qualityPassPointer}`
          : `No child's diff comes graded in this install: nothing here grades it, so run the project's own checks on what comes back, and fix what they report before you report the work done.`
      }`;
  // Delegating a step with nothing to implement buys a grading pass over an empty diff —
  // where such a pass exists, and where a child's run is the thing that comes graded. So
  // the tail is three-way: a self-grading implementer (a launch is spent for nothing); a
  // roster with graders but no self-grading implementer (the section above says no child
  // arrives checked, so the launch is one the orchestrator must order itself — saying "a
  // graded implementer run" there contradicts it); and no graders at all, where the cost
  // is only the turn of waiting.
  const emptyDiffBullet =
    graders.length > 0 && hasWorker
      ? '- A step changes no files — a build, a test run, an inspection, a report. A graded implementer run over an empty diff buys a grader launch and a turn of waiting for nothing'
      : graders.length > 0
        ? '- A step changes no files — a build, a test run, an inspection, a report. Run it yourself: no child here comes back with its diff graded, so an empty one buys you a grader launch to order and a turn of waiting for nothing'
        : '- A step changes no files — a build, a test run, an inspection, a report. Run it yourself: a child run with nothing to implement buys a turn of waiting for nothing';

  // The skip rule presumes the delegation it skips. In a roster where no row can write, the
  // opener makes self-editing the outcome, so every implementation step would be a "named skip"
  // and "the implementer" would name a role the section just said may not exist. State the rule
  // that fits the roster.
  const skipLine = hasWorker
    ? '**Name any skip.** If a step clears the delegate bar above and you implement it yourself, say which and why, in one line.'
    : '**Say who is doing it.** If no row fits the role and shows write and edit, the editing is yours: say so in one line, and run the pass on it yourself.';

  const delegationSection = canDelegate
    ? `
## Delegate the Implementation

${hasWorker ? 'You coordinate; the child implements.' : 'You coordinate; a child implements where one can.'} ${implSentence} ${
  hasWorker
    ? 'Executing a whole plan inline is work no child graded and no one can see.'
    : 'Executing a whole plan inline when a row does both is work no child graded and no one can see.'}

**Delegate when:**
- A step changes files and the plan already specifies it: the file, the function, what to change, how it will be checked${hasWorker ? '' : ' — and a row does both'}
- Two or more such steps are independent of each other — launch them in one turn, then end your turn
- The step is a sweep over many files you would otherwise do line by line${hasWorker ? '' : ' — and a row does both'}
${hasWorker ? '- The step is a read-heavy investigation → a read-only agent from the table above, if it has one; never the implementer' : '- The step is a read-heavy investigation → a read-only agent from the table above, if it has one; never a row that edits files'}

**Stay direct when:**
- It is a typo, a one-line fix, a single string or constant
- You are only reading, researching, explaining, or answering a question
- You are triaging a delegation that came back wrong — the child is gone; the diagnosis is yours
- It is integration glue: wiring the returned pieces together, and the final assembly you have to hold in your own head
${emptyDiffBullet}

${skipLine}

${gradingParagraph}
`
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
a bug — you are the worst available judge of it.${hasWorker
  ? ` A \`worker\` you delegate to ends its run by having its diff graded by an agent that did
not write it. Hold yourself to that standard: finish your own implementation work the same way.`
  : ` Hold yourself to the standard a grader would apply: finish your own implementation work
as an agent that did not write it would.`}

Before you tell the user an implementation is done, delegate a quality pass:

\`\`\`
${graders.map((g) => `subagent(agent: "${g}", task: "${g === 'verifier' ? '<goal + absolute project path + the command that checks it>' : '<goal + the exact files you touched, as absolute paths>'}")`).join('\n')}
\`\`\`

Ask for exactly this: **a full and thorough quality pass over the implementation
for any remaining bugs, issues, or quality-of-life improvements.**

**When it applies:** you changed code, config, or anything executable, and the
change is more than a typo or a one-line string. It does **not** apply to work you
only read, planned, or researched.${hasWorker
  ? ` Nor does it apply to a change a child already had graded: do not re-grade a
\`worker\`'s diff it has itself passed through ${plural ? 'these agents' : 'this agent'}.`
  : ''}
It applies to glue **you edited yourself** while integrating what the children returned —
no child graded that glue. Confirming the whole does what the goal asked is the project's
own checks, not a second grader launch over ${hasWorker ? 'a diff a child already had graded' : 'work you have already checked yourself'}.

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
3. **Execute** — Call tools and skills in the correct order${executeClause}, handling errors gracefully
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

${askUserSection}${toolSection}${agentSection}${boardSection}${planningSection}${delegationSection}${qualityPassSection}${skillSection}${contextSection}${guidelinesSection}${customSection}${appendSection}${footer}`;
}
