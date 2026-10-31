/**
 * Quant-research persona system prompt extension.
 *
 * The quant-trader profile deliberately does not load `dynamic-prompt.ts` — that
 * extension replaces the whole system prompt with the *orchestrator* prompt in
 * every top-level session, and a research desk is not a code orchestrator. This
 * extension is the quant analogue: on `before_agent_start` it drops `write`/`edit`
 * from the run's tool set (pi has no top-level `tools:` config, so
 * `selectedTools` is the only gate), discovers the profile's own agents and the
 * runtime skill catalogue, and emits a prompt with the quant persona, the fleet
 * roster, the skill catalogue, and the asynchronous delegation protocol.
 *
 * A child's own body is preserved the same way `dynamic-prompt.ts` preserves it:
 * the child is launched with `--append-system-prompt`, which pi folds into
 * `systemPromptOptions.appendSystemPrompt`, and this prompt carries that field
 * through verbatim.
 *
 * @module quant-prompt
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  delegationRoster,
  LINEAGE_ENV,
  parseLineage,
  type AgentInfo,
} from './lib/agents.js';
import { agentsDir, skillsDir } from './lib/layout.js';
import { personaOverride } from './lib/persona.js';
import { SkillActivation } from './lib/skill-activation.js';
import { groupByCategory } from './lib/skill-categories.js';
import { categoryFromPath } from './lib/skill-tree.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The tools a quant session must not offer, top-level or child. pi has no
 * top-level `tools:` config, so the enforcement is `selectedTools` filtering in
 * the `before_agent_start` handler, in the same place the prompt is built. A
 * child is launched with a `--tools` allowlist, and this strips these tools from
 * that allowlist too — a stronger guarantee than the child's own body, which
 * constrains by instruction while this constrains by absence.
 */
// Every tool that mutates a file, not just the two named ones: code_rewrite
// writes when dry_run=false, and undo_last_edit rewrites the file it reverts.
export const QUANT_REMOVED_TOOLS = new Set(['write', 'edit', 'code_rewrite', 'undo_last_edit']);

/**
 * The spawn tool registered by `subagent-herdr`. The roster is gated on it: a
 * roster discovered on disk is not a capability unless the tool that spawns those
 * agents is actually offered this run.
 */
const SUBAGENT_TOOL = 'subagent';

/**
 * A model ref in the fleet is written `provider/model|effort`, so it contains a
 * pipe. Raw, it closes a table cell early and the Model column mangles — and the
 * Tools column is what the delegation rule reads when picking an agent. GFM
 * renders `\|` in a cell as a literal `|`.
 */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

// ---------------------------------------------------------------------------
// Skill catalogue rendering
// ---------------------------------------------------------------------------

/**
 * Renders the skill catalogue as category headings with one line per skill: name,
 * path when it is not implied, and description. Mirrors `dynamic-prompt.ts`'s
 * renderer so the quant prompt and the orchestrator prompt read the same way.
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
        // The path is printed only when neither the library prose nor a declared
        // root already implies it.
        const where = inLibrary(s) || (root && shared.has(root)) ? '' : ` (\`${s.filePath}\`)`;
        // An empty description would leave a dangling dash — say it is missing.
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
 * Assembles the quant-research system prompt from the discovered inventories.
 *
 * Exported as the **one** seam for this module: a test can assert on the prompt
 * the model actually receives rather than on its private section builders, and
 * section *ordering* is part of what a test should be able to pin. Pure: every
 * input arrives in `opts`, the only ambient read is the clock (see `now`).
 */
export function buildQuantPrompt(opts: {
  agentInventory: AgentInfo[];
  skillInventory: Array<{
    name: string;
    description: string;
    filePath: string;
    pathCategory?: string;
  }>;
  contextInventory: Array<{ path: string }>;
  guidelines: string[];
  /** True when the `subagent-herdr` spawn tool is offered this run. */
  hasSubagent: boolean;
  /**
   * True when this process is itself a delegated subagent (non-empty lineage).
   * The coordinator's charter is written for the top-level session; a child's own
   * body carries its contract, so it is withheld rather than duplicated in the
   * wrong voice.
   */
  isSubagent: boolean;
  customPrompt?: string;
  appendSystemPrompt?: string;
  cwd: string;
  /** Absolute path to this profile's skills library, for the path-rule sentence. */
  skillsLibrary: string;
  /** The clock, for the `Current date:` footer. Injected so a test can pin it. */
  now?: Date;
}): string {
  const now = opts.now ?? new Date();
  // ISO date format for consistent prompt output.
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  // --- Persona (always) ---
  const persona = `
# Quant-Research Agent

You are the quant-research persona. You research markets, backtest ideas against
data, audit the risk in a proposed trade or backtest, and journal durable
observations. You are a research desk, not a codebase: you read markets and data,
you run scripts, and you report findings with the numbers behind them.
`;

  // --- Coordinator's charter (top-level only) ---
  const responsibilities = opts.isSubagent
    ? ''
    : `
## Core Responsibilities

1. **Decompose** — Break a research question into discrete, verifiable steps. If it
   has gaps, state the assumption you made and proceed.
2. **Orient** — Recall the journal first (\`trade_journal\` \`mode:read\` with the
   ticker), then consult the skills catalogue for a matching method.
3. **Delegate** — Route the work to the right agent from the roster below, in the
   right order, and end your turn to let it run.
4. **Verify** — Confirm each step's result — a number, a dated source, an executed
   command — before building on it.
5. **Report** — Report findings with the numbers behind them, dated, with the
   source you ran. A claim without its date and its source is not a finding.
`;

  // --- Roster + asynchronous delegation ---
  const agentSection =
    opts.hasSubagent && opts.agentInventory.length > 0
      ? `
## Available Agents

Specialized subagents you can delegate to via the \`subagent\` tool. Delegation runs
in the background and returns a task id, not a result: you end your turn and the
subagent wakes you when it has something to say.

The Model column is markdown-escaped, so a \`\\|\` inside a cell is one \`|\`: a ref
printed as \`provider/model\\|low\` is passed to a \`model:\` override as
\`provider/model|low\` — drop the backslash.

| Agent | Description | Tools | Model |
|-------|-------------|-------|-------|
${opts.agentInventory.map((a) => `| ${cell(a.name)} | ${cell(a.description)} | ${cell((a.tools?.length ?? 0) > 0 ? a.tools!.join(', ') : 'all')} | ${cell(a.model ?? 'default')} |`).join('\n')}

**Agent usage notes:**
- Each agent has a focused role — pick the right one for the task.
- Agents run in isolated context windows (they see no conversation history).
- Delegate with the \`subagent\` tool, naming the agent and a self-contained task.
- A child may spawn a sibling only by naming it (e.g. \`backtester\` →
  \`risk-check\`); the top-level session is admitted to every agent.

## Asynchronous Delegation

\`subagent\` starts a background *task* and returns a task id (e.g. \`sub-a3f1\`) —
not the result. There is deliberately **no blocking wait**: the way you wait for a
subagent is to *finish your turn*.

The loop:

1. Delegate (you can launch several at once — they run concurrently).
2. Do the remaining work that does not depend on their answers.
3. **End your turn.** Say what you delegated and stop. Do not poll, do not spin.
4. When a subagent reports something or finishes, a message arrives automatically
   and you are woken with it. Its answer is in that message.
5. Continue from there — collect the rest, or act on what you were told.

- A subagent can message you **while it is still working** (a blocker, a finding);
  ending your turn promptly is what makes that visible.
- Reply to a running subagent with \`subagent_tasks\` \`action: "message"\`.
- Use \`action: "result"\` to re-read a finished task, \`"status"\` for a quick
  is-it-still-running check, \`"list"\` to see all tasks, and \`"cancel"\` to stop one.
- Never treat a task id as an answer, and never claim a delegated task is done until
  you have actually seen its result.
- If every remaining step depends on a subagent, ending your turn *is* the correct
  and complete action. An idle turn is not a failure — it is how you hand control
  back until the subagent has something to say.
`
      : '';

  // --- Skill catalogue ---
  const skillSection =
    opts.skillInventory.length > 0
      ? `
## Available Skills

Skills are specialized knowledge modules: distilled, already-debugged procedure for
work that has been done badly before. **Consulting this catalogue is the default
opening move, not a fallback.** When one matches the task it beats anything you will
improvise, because it encodes the failures you have not hit yet.

To use a skill, read its \`SKILL.md\` with \`read_skill\`: the line below is a
routing signal, the file is the method.

Most live at \`${opts.skillsLibrary}/<category>/<name>/SKILL.md\`; the ones that do
not carry their path inline below.

${renderSkillCategories(opts.skillInventory, opts.skillsLibrary)}

**How to use this catalogue:**
- **Check it before you start.** For any task beyond a one-line answer, scan for a
  matching skill and open it *before* designing your approach — not after the
  approach fails.
- **Prefer the skill to your own default.** If one matches, follow it.
- **Name any skip.** If a plausible skill exists and you choose not to use it, say
  which one and why, in one line. Silently ignoring the catalogue is the failure
  this section exists to prevent.
- A name is a hint, not a contract: open the file rather than guessing at what it
  contains, and act on what it says rather than on the summary here.
- If a skill's guidance genuinely conflicts with the task, the task wins — but state
  which skill you set aside and why.
`
      : '';

  // --- Context files ---
  const contextSection =
    opts.contextInventory.length > 0
      ? `
## Project Context

The following context files are available and should inform your decisions:

${opts.contextInventory.map((f) => `- **${f.path}**`).join('\n')}

Use these files to understand project conventions, architecture, and constraints.
`
      : '';

  // --- Guidelines ---
  const guidelinesSection =
    opts.guidelines.length > 0
      ? `
## Guidelines

${opts.guidelines.map((g) => `- ${g}`).join('\n')}
`
      : '';

  const customSection = opts.customPrompt ? `\n${opts.customPrompt}\n` : '';
  const appendSection = opts.appendSystemPrompt ? `\n${opts.appendSystemPrompt}\n` : '';
  const footer = `\nCurrent date: ${date}\nCurrent working directory: ${opts.cwd}`;

  return `${persona}${responsibilities}${agentSection}${skillSection}${contextSection}${guidelinesSection}${customSection}${appendSection}${footer}`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Extension entry point. Hooks into `before_agent_start` to inject a dynamically
 * built quant-research system prompt, and to drop `write`/`edit` from the
 * top-level tool set.
 *
 * @param pi - The pi extension API.
 */
export default function (pi: ExtensionAPI) {
  // Which skills are live in this session, for the roster: a skill-shipped agent
  // (the journal agents under `technical-analysis`) is advertised only once its
  // skill is loaded, so an unrelated session is never told about agents it will not
  // use. Sticky, and rebuilt per session — `systemPromptOptions.skills` is the
  // catalogue of every discovered skill on every turn, not the loaded set.
  const activation = new SkillActivation();

  // Only a genuinely new conversation resets the set. `startup` needs no reset
  // (the set is already empty).
  pi.on('session_start', async (event) => {
    if (event.reason === 'new' || event.reason === 'resume') activation.reset();
  });

  // A model-invoked skill arrives as a read_skill/read of a SKILL.md, never in the
  // prompt, so this signal grows the roster alongside the prompt one.
  pi.on('tool_call', async (event) => {
    activation.noteToolCall(event.toolName, event.input);
    return undefined;
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const opts = event.systemPromptOptions;

    // A `/skill:name` invocation is expanded into this turn's prompt as
    // `<skill name=… location=…>`, which is the only place it is observable.
    // `prompt` exists only on user-triggered runs; a custom-triggered turn has none
    // to scan.
    activation.notePrompt(event.messageType === 'user' ? event.prompt : '');

    // An in-session `/agent <profile>` switch owns the prompt for the run: the
    // persona extension is the single builder in that state, so this handler
    // stands down. There is no load-order dependency — exactly one handler
    // returns a systemPrompt in each state. With no switch active, this line is
    // inert and today's behaviour is unchanged.
    if (personaOverride()) return undefined;

    // --- Drop the file-mutating tools from this run's tool set ---
    // selectedTools is mutable here and is what the model is offered for this run.
    // There is no top-level `tools:` config and no unregisterTool, so this is the
    // enforcement. Applied to a child too: its list arrives already allowlisted by
    // `--tools`, and this strips the mutators from that allowlist as well — a
    // stronger guarantee than the child's body, which constrains by instruction.
    if (Array.isArray(opts.selectedTools)) {
      opts.selectedTools = opts.selectedTools.filter((t) => !QUANT_REMOVED_TOOLS.has(t));
    }

    // Everything that touches disk or env is loaded here; buildQuantPrompt is pure.
    const library = skillsDir();
    const lineage = parseLineage(process.env[LINEAGE_ENV]);
    const roster = await delegationRoster({
      agentsDir: agentsDir(),
      skillsDir: library,
      lineage,
      activeSkills: activation.list(),
    });

    const selectedTools = opts.selectedTools ?? [];
    const hasSubagent = selectedTools.includes(SUBAGENT_TOOL);

    const quantPrompt = buildQuantPrompt({
      agentInventory: roster.spawnable,
      skillInventory: (opts.skills ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        pathCategory: categoryFromPath(library, skill.filePath),
      })),
      contextInventory: (opts.contextFiles ?? []).map((f) => ({ path: f.path })),
      guidelines: (opts.promptGuidelines ?? []).filter((g) => g.trim().length > 0),
      hasSubagent,
      isSubagent: lineage.length > 0,
      customPrompt: opts.customPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      cwd: opts.cwd,
      skillsLibrary: library,
    });

    // Replace the default prompt entirely with the quant prompt.
    return { systemPrompt: quantPrompt };
  });
}
