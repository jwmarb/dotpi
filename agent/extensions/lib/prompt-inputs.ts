/**
 * The prompt-input derivation shared by every prompt builder in this repo.
 *
 * Three builders exist: `dynamic-prompt.ts` (orchestrator),
 * `quant-trader/extensions/quant-prompt.ts` (quant), and — under an in-session
 * `/agent` switch — whichever of those two the *target* profile owns, called
 * from `persona/index.ts`. Each used to assemble its own inputs, and the switch
 * path assembled them from the *process's* `systemPromptOptions` rather than the
 * target's, so the skills and AGENTS.md it had just derived for the target were
 * thrown away and the prompt re-listed the home profile's. This module is that
 * derivation once, so a caller that has retargeted the inputs cannot quietly
 * ignore them.
 *
 * Pi-free and pure: no disk, no env, no mutation of its inputs. A caller does
 * its own loading (roster, skill owners, activation) and hands the results in.
 *
 * @module lib/prompt-inputs
 */
import { gateTools } from "./skill-activation.js";
import { categoryFromPath } from "./skill-tree.js";

// ---------------------------------------------------------------------------
// Tool-name constants
// ---------------------------------------------------------------------------

/**
 * Name of the tool registered by the `ask-user` extension. When this tool is
 * available, the orchestrator prompt gains an explicit instruction to route
 * every user-facing question through it instead of asking in prose.
 */
export const QUESTIONNAIRE_TOOL = "questionnaire";

/**
 * Name of the tool registered by the `subagent-herdr` extension. The agent
 * sections are gated on it: a roster discovered on disk is not a capability
 * unless the tool that spawns those agents is actually offered this run.
 */
export const SUBAGENT_TOOL = "subagent";

/**
 * Name of the tool registered by the `kanban` extension. It is registered for the
 * orchestrator only — the factory returns as soon as `PI_SUBAGENT_RUN_ID` is set —
 * so this flag is naturally false in a child and needs no `isSubagent` conjunct of
 * its own. Nothing from `kanban/lib.ts` is imported here: the *capability* reaches
 * the builders as a boolean, and a top-level extension taking a dependency on a
 * sibling's internals is the coupling that gate avoids — pi-tui resolves at the
 * repo root and `lib/runtime.test.ts` imports `../kanban/lib.js`, so the bar is
 * architectural, not technical.
 */
export const KANBAN_TOOL = "kanban";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One discovered skill. `pathCategory` is optional because pi's own skill list
 * has no such field: a caller that already knows the category (a switched
 * profile's library walk) passes it, and everyone else lets
 * {@link derivePromptInputs} read it off the path.
 */
export interface PromptSkill {
  name: string;
  description: string;
  filePath: string;
  pathCategory?: string;
}

/** Everything the derivation reads. Each caller supplies its own loads. */
export interface DeriveInputsOptions {
  /** The tools offered this run, before skill gating. Never mutated. */
  selectedTools: readonly string[];
  /** Tool name → the snippet pi hands the model for it. */
  toolSnippets?: Readonly<Record<string, string>>;
  /** Caller-supplied guideline lines; blanks are dropped. */
  promptGuidelines?: readonly string[];
  /** The skill catalogue to advertise. */
  skills: readonly PromptSkill[];
  /** Context files (AGENTS.md and friends); only `path` is kept. */
  contextFiles: ReadonlyArray<{ path: string }>;
  /** This process's ancestry, oldest first; empty for the human's orchestrator. */
  lineage: readonly string[];
  /** Tool name → the skill directory that must be active for it to be offered. */
  owners: ReadonlyMap<string, string>;
  /** Whether a skill directory is active this session. */
  isActive: (skillDir: string) => boolean;
  /** Absolute path to the skills library these skills belong to. */
  skillsLibrary: string;
}

/** The derived inventories and capability flags — not the builder-only fields. */
export interface DerivedPromptInputs {
  /** The offered tools after skill gating — a new array, input order kept. */
  selectedTools: string[];
  toolInventory: Array<{ name: string; description: string }>;
  skillInventory: Array<{
    name: string;
    description: string;
    filePath: string;
    pathCategory: string | undefined;
  }>;
  contextInventory: Array<{ path: string }>;
  guidelines: string[];
  hasQuestionnaire: boolean;
  hasSubagent: boolean;
  hasKanban: boolean;
  isSubagent: boolean;
}

/**
 * Assembles a prompt builder's inputs from what the caller loaded: gates
 * skill-owned tools, builds the tool/skill/context inventories, and derives the
 * capability flags. Pure and synchronous — no disk, no env, and the input
 * `selectedTools` is never mutated (the caller assigns the result).
 *
 * The builder-specific fields (`agentInventory`, `customPrompt`,
 * `appendSystemPrompt`, `cwd`, `skillsLibrary`) deliberately are *not* derived
 * here: they are read straight off the caller's own options, so this module has
 * no opinion about a shape its two callers do not share.
 */
export function derivePromptInputs(o: DeriveInputsOptions): DerivedPromptInputs {
  // --- Gate skill-owned tools on their skill being active ---
  const { kept: selectedTools } = gateTools(o.selectedTools, o.owners, o.isActive);

  // --- Build tool inventory ---
  // Only include tools that have a snippet available; fallback to empty description
  const toolInventory = selectedTools
    .filter((name) => o.toolSnippets?.[name])
    .map((name) => ({
      name,
      description: o.toolSnippets?.[name] ?? "",
    }));

  // --- Build skill inventory ---
  // The category comes from the skill's own path when it has one, so the tree
  // on disk is the source of truth and refiling a skill needs no code edit.
  // `skillsLibrary` is the library these skills came from; a package or
  // project-local skill lies outside it and falls through to the name-keyed map
  // instead. A caller that already resolved a category (the switched profile's
  // own library walk) keeps its answer.
  const skillInventory = o.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    pathCategory: skill.pathCategory ?? categoryFromPath(o.skillsLibrary, skill.filePath),
  }));

  // --- Build context file inventory ---
  const contextInventory = o.contextFiles.map((f) => ({
    path: f.path,
  }));

  // --- Filter out empty guideline entries ---
  const guidelines = (o.promptGuidelines ?? []).filter((g) => g.trim().length > 0);

  // --- Detect the ask-user extension ---
  // ask-user.ts registers a tool named `questionnaire`. If it is loaded we
  // instruct the orchestrator to ask the user through it.
  const hasQuestionnaire =
    selectedTools.includes(QUESTIONNAIRE_TOOL) ||
    toolInventory.some((t) => t.name === QUESTIONNAIRE_TOOL);

  // --- Detect the subagent-herdr extension ---
  // The roster the caller pairs with this result is read off `agents/*.md` on
  // disk, which says nothing about whether the extension that can *spawn* them
  // loaded. subagent-herdr imports `../model-fallback/lib.js` and typebox, and
  // the documented failure mode when that resolution breaks is a silent load
  // failure — leaving a prompt that mandates delegation while offering no tool to
  // delegate with. Same rule as the questionnaire gate, one level up: an agent
  // roster is only actionable if the tool that spawns it exists. Computed after
  // gating, like the inventory.
  //
  // The OR is logically equivalent to `selectedTools.includes(SUBAGENT_TOOL)` on
  // its own: `toolInventory` is built by filtering that same gated list, so the
  // second signal can never be true where the first is false. It is kept as the
  // single shared capability signal for all three flags, and
  // `lib/prompt-inputs.test.ts` pins that a snippet alone does not set a flag.
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
    toolInventory,
    skillInventory,
    contextInventory,
    guidelines,
    hasQuestionnaire,
    hasSubagent,
    hasKanban,
    isSubagent: o.lineage.length > 0,
  };
}
