/**
 * In-session profile switching: `/agent <profile>`.
 *
 * A running session is retargeted to another profile under the repo root — its
 * prompt, its tool set, its MCP servers, its fleet and its skills — without
 * leaving the process. The switch is recorded in the session
 * (`pi.appendEntry("persona-switch", …)`) so a resume restores it, and the
 * live state lives in `lib/persona.ts`'s `globalThis` key so every module in
 * the process (the layout accessors, the child-spawn env, the prompt
 * builders) sees one switch.
 *
 * The pure decision logic — profile discovery, name resolution, MCP config
 * parsing, tool-set computation, widening, entry validation, the prompt
 * block — is in `lib.ts`. This module is the session wiring: the load-time
 * MCP registration, the command, the restore, the hard tool block, and the
 * prompt takeover.
 *
 * ## Why the prompt takeover is a yield, not a load order
 *
 * `before_agent_start` handlers run in load order and each returned
 * `systemPrompt` sets `forceSystemPrompt`, so the last one wins. Both prompt
 * extensions therefore check `personaOverride()` and stand down when a switch
 * is active; this extension is then the single builder for the run. There is
 * no load-order dependency in either state — exactly one handler returns a
 * systemPrompt — so a `zz-` filename prefix is not needed (and not used).
 *
 * @module persona
 */
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  McpServerConfig,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";

type OrchestratorModule = typeof import("../dynamic-prompt.js");
type QuantModule = typeof import("../../../quant-trader/extensions/quant-prompt.js");
import { LINEAGE_ENV, delegationRoster, frontmatterOf, parseLineage } from "../lib/agents.js";
import { agentDir, profileDir, repoRoot, skillsDir, agentsDir } from "../lib/layout.js";
import { personaDenies, personaOverride, setPersonaOverride } from "../lib/persona.js";
import { SkillActivation, loadSkillToolOwners } from "../lib/skill-activation.js";
import { categoryFromPath, findSkills } from "../lib/skill-tree.js";
import {
  computeTargetTools,
  deniedToolsFor,
  discoverProfiles,
  installedPackageNames,
  isWidening,
  latestPersonaEntry,
  mcpServerOf,
  missingInProcess,
  personaBlock,
  readPersonaMcp,
  readPersonaMcpSync,
  resolveProfileArg,
  type PersonaEntry,
  type ProfileInfo,
} from "./lib.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The MCP servers this extension registered, name → JSON config. The load-time
 * registration fills it; every switch re-diffs the target's `persona-mcp.json`
 * against it, unregistering what the target lacks and registering what it adds.
 * Only servers in this map are swappable — `mcp.json` servers stay with the
 * process, exactly as before the switch existed.
 */
const registered = new Map<string, string>();

/** The home snapshot, taken at the first switch away from home. */
let homeState: {
  tools: string[];
  model?: { provider: string; id: string };
  thinking?: string;
} | undefined;

/** The applied switch: what the session runs as now, for the takeover and the reports. */
let applied: {
  profile: ProfileInfo;
  homeName: string;
  at: Date;
  active: Set<string>;
  mcpServers: Set<string>;
  dropped: string[];
  missing: string[];
} | undefined;

/** The run's tool list as this extension last saw it, for the probe. */
let probeSelectedTools: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The process's own profile directory, resolved: the home target. */
function homeDirReal(): string {
  try {
    return realpathSync(agentDir());
  } catch {
    return agentDir();
  }
}

function homeName(): string {
  return basename(homeDirReal());
}

function isHome(profile: ProfileInfo): boolean {
  return profile.dir === homeDirReal();
}
/**
 * Whether a recorded home snapshot matches the session's live home active set —
 * the binding a confirmed widening was made under. Order-insensitive (a Set
 * equality); `undefined` (no snapshot recorded) never matches, so a pre-binding
 * or hand-edited entry falls back to the live gate, which re-asks.
 */
function sameTools(recorded: string[] | undefined, live: string[]): boolean {
  if (!recorded) return false;
  if (recorded.length !== live.length) return false;
  const s = new Set(recorded);
  return live.every((t) => s.has(t));
}
/**
 * Whether `name` is an MCP tool of one of the active persona's declared servers.
 * A target's MCP servers are a rule, not a snapshot: this lets a freshly
 * registered server's tools through the hard block and the declaration filter
 * even when they are not in `active` (e.g. the server connected after the switch).
 */
function appliedMcpApplies(state: { mcpServers: Set<string> }, name: string): boolean {
  const server = mcpServerOf(name);
  return server !== undefined && state.mcpServers.has(server);
}

/**
 * The prompt kind this process's own profile declares, by its marker file —
 * the same rule `lib.ts` applies at discovery. Without an active override, the
 * tools the session currently withholds are this profile's own, and the
 * widening check needs them.
 */
function homePromptKind(): ProfileInfo["promptKind"] {
  const ext = join(agentDir(), "extensions");
  if (existsSync(join(ext, "dynamic-prompt.ts"))) return "orchestrator";
  if (existsSync(join(ext, "quant-prompt.ts"))) return "quant";
  return undefined;
}

/** `<dir>/settings.json` fields this extension needs; never throws. */
function readSettings(dir: string): {
  packages: string[];
  declaredPackages: string[];
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
} {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")) as {
      packages?: unknown;
      piBolt?: { packages?: unknown; packagesOverlay?: boolean };
      defaultProvider?: unknown;
      defaultModel?: unknown;
      defaultThinkingLevel?: unknown;
    };
    const base = Array.isArray(raw.packages)
      ? raw.packages
          .map((p) => (typeof p === "string" ? p : (p as { source?: unknown })?.source))
          .filter((s): s is string => typeof s === "string")
      : [];
    let packages = base;
    let declaredPackages = base;
    // piBolt swaps the installed name a declared specifier names (the profile
    // declares `npm:@ff-labs/pi-fff` while the tree carries `opensec-pi-fff`).
    // The tool-set rule matches installed names against declared bases, so the
    // matching set must accept BOTH names: `packages` is the union of the raw
    // declared bases and the overlay additions. `declaredPackages` keeps the
    // replacement semantics (the replaced base gone, the overlay name in its
    // place) for `missingInProcess` reporting, where a name is "missing" iff the
    // process never declared it.
    if (raw.piBolt?.packagesOverlay === true && Array.isArray(raw.piBolt.packages)) {
      const overlay = (raw.piBolt.packages as unknown[]).filter((p): p is string => typeof p === "string");
      const remove = new Set(overlay.filter((p) => p.startsWith("-")).map((p) => p.slice(1)));
      const additions = overlay.filter((p) => !p.startsWith("-"));
      packages = [...new Set([...base, ...additions])];
      declaredPackages = [...new Set([...base.filter((p) => !remove.has(p)), ...additions])];
    }
    return {
      packages,
      declaredPackages,
      defaultProvider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : undefined,
      defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : undefined,
      defaultThinkingLevel: typeof raw.defaultThinkingLevel === "string" ? raw.defaultThinkingLevel : undefined,
    };
  } catch {
    return { packages: [], declaredPackages: [] };
  }
}

/**
 * The realpaths of the entries in a profile's `extensions/` that pi would
 * actually load — the tool-set rule's "inside" targets and the missing-report
 * inputs.
 *
 * Follows pi's discovery (one level deep): top-level `*.ts`/`*.js` files,
 * subdirectories with an `index.ts`/`index.js`, and subdirectories with a
 * `package.json` declaring a `pi.extensions` manifest. Symlinks are followed,
 * so a profile's per-item symlinks resolve to the shared realpaths. Anything
 * else (`test/`, `tsconfig.json`, …) is not an extension and must not appear
 * in a switch report.
 */
async function extRealpaths(dir: string): Promise<string[]> {
  const extDir = join(dir, "extensions");
  let entries: string[];
  try {
    entries = await readdir(extDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const p = join(extDir, name);
    let st;
    try {
      st = await stat(p);
    } catch {
      // a broken entry is not an extension this target offers
      continue;
    }
    if (st.isFile()) {
      if (name.endsWith(".ts") || name.endsWith(".js")) out.push(await realpath(p));
      continue;
    }
    if (st.isDirectory()) {
      if (
        (await fileExists(join(p, "index.ts"))) ||
        (await fileExists(join(p, "index.js"))) ||
        (await hasPiManifest(join(p, "package.json")))
      ) {
        out.push(await realpath(p));
      }
    }
  }
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function hasPiManifest(p: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(p, "utf-8")) as { pi?: { extensions?: unknown } };
    return Array.isArray(raw.pi?.extensions) && raw.pi.extensions.length > 0;
  } catch {
    return false;
  }
}

/** The server names in `<dir>/mcp.json` — the shared set a target keeps. */
function mcpNamesOf(dir: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf-8")) as { mcpServers?: unknown };
    if (!raw.mcpServers || typeof raw.mcpServers !== "object" || Array.isArray(raw.mcpServers)) return [];
    return Object.keys(raw.mcpServers);
  } catch {
    return [];
  }
}

/**
 * Re-diff `registered` against the target's servers: unregister what the target
 * lacks (or redefined), register what it adds. A name this extension did not
 * register is never touched — `mcp.json` servers stay with the process.
 */
function swapMcp(pi: ExtensionAPI, target: Record<string, unknown>): void {
  for (const [name, json] of [...registered]) {
    const cfg = target[name];
    if (cfg === undefined || JSON.stringify(cfg) !== json) {
      try {
        pi.unregisterMcpServer(name);
      } catch (e) {
        console.error(`persona: failed to unregister MCP server "${name}": ${(e as Error).message}`);
      }
      registered.delete(name);
    }
  }
  for (const [name, cfg] of Object.entries(target)) {
    if (registered.has(name)) continue;
    try {
      pi.registerMcpServer(name, cfg as McpServerConfig);
      registered.set(name, JSON.stringify(cfg));
    } catch (e) {
      console.error(`persona: failed to register MCP server "${name}": ${(e as Error).message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

/**
 * Apply a profile switch in place.
 *
 * Computes the target tool set from the home session's active set, asks about
 * a widening, swaps the MCP servers, sets the override, declares the tools,
 * adopts the target's model and thinking, records the entry, and reports.
 * A switch back to home is the same path with the home target: the set comes
 * back unchanged, the override clears, and home's MCP servers come back.
 *
 * `resumedConfirmed` names a restore of a session entry whose widening the
 * user already confirmed: the gate is skipped, because a resume (including a
 * no-UI `--resume`) cannot ask again. A fresh `/agent` command passes nothing
 * and still gates.
 */
async function applyPersona(
  pi: ExtensionAPI,
  target: ProfileInfo,
  ctx: ExtensionContext,
  resumedConfirmed?: boolean,
): Promise<void> {
  const home = isHome(target);

  // A target that cannot say which prompt builder to run cannot be switched to.
  if (!home && !target.promptKind) {
    const msg = `Cannot switch to ${target.name}: it has no prompt extension (dynamic-prompt.ts or quant-prompt.ts).`;
    console.error(msg);
    ctx.ui.notify(msg, "error");
    return;
  }

  // 1. The target tool set, computed from the home session's active set.
  const currentOverride = personaOverride();
  if (!home && !currentOverride) {
    homeState = {
      tools: pi.getActiveTools(),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
      thinking: ctx.thinkingLevel,
    };
  }
  const homeActive = homeState?.tools ?? pi.getActiveTools();
  const tools = pi.getAllTools().map((t) => ({
    name: t.name,
    sourcePath: t.sourceInfo.path,
    source: t.sourceInfo.source,
    origin: t.sourceInfo.origin,
  }));
  const [targetExtRealpaths, processExtRealpaths, targetMcp] = await Promise.all([
    extRealpaths(target.dir),
    extRealpaths(agentDir()),
    readPersonaMcp(target.dir),
  ]);
  const targetSettings = readSettings(target.dir);
  const targetInstalled = installedPackageNames(target.dir);
  const denied = home ? new Set<string>() : deniedToolsFor(target.promptKind);
  const { active, dropped } = computeTargetTools({
    homeActive,
    tools,
    targetExtRealpaths,
    targetPackages: targetSettings.packages,
    targetNpmNames: targetInstalled.npmNames,
    targetGitPaths: targetInstalled.gitPaths,
    targetMcpServers: Object.keys(targetMcp),
    sharedMcpServers: mcpNamesOf(agentDir()),
    denied,
  });
  const activeSet = new Set(active);
  const missing = missingInProcess(
    targetExtRealpaths,
    processExtRealpaths,
    targetSettings.declaredPackages,
    readSettings(agentDir()).declaredPackages,
  );

  // 2. Widening: the target re-enables tools the session currently refuses.
  // "Current effective" is the active set minus what is withheld right now —
  // the live override's deny list, or, with no switch, this profile's own.
  const currentDenied = currentOverride?.deniedTools ?? deniedToolsFor(homePromptKind());
  const currentEffective = pi.getActiveTools().filter((t) => !currentDenied.has(t));
  // A home restore re-enables whatever the process's own profile declares —
  // that is restoration, not widening, and it never asks.
  const gained = home ? [] : isWidening(currentEffective, active);
  let confirmed = true;
  if (gained.length > 0 && !resumedConfirmed) {
    if (!ctx.hasUI) {
      const msg = `Switch to ${target.name} refused: it would re-enable ${gained.join(", ")}, and this session has no UI to confirm a widening.`;
      console.error(msg);
      ctx.ui.notify(msg, "error");
      return;
    }
    confirmed = await ctx.ui.confirm("Widen tools?", `Switching to ${target.name} re-enables: ${gained.join(", ")}`);
    if (!confirmed) {
      ctx.ui.notify(`Switch to ${target.name} cancelled: it would re-enable ${gained.join(", ")}.`, "warning");
      return;
    }
  }

  // 3. The MCP swap: only servers this extension registered are swappable.
  swapMcp(pi, targetMcp);
  // The target's MCP servers are a rule, not a snapshot: a server the home
  // session never registered cannot enter `active` by iterating `homeActive`, so
  // union the target-declared servers' live tools in here. The same server-name
  // predicate is OR'd into the hard block and the declaration filter below, so a
  // freshly registered server is usable rather than attached with zero tools.
  for (const server of Object.keys(targetMcp)) {
    for (const t of pi.getAllTools()) {
      if (mcpServerOf(t.name) === server) activeSet.add(t.name);
    }
  }

  // 4. The switch state.
  if (home) {
    setPersonaOverride(undefined);
    applied = undefined;
  } else {
    setPersonaOverride({ name: target.name, dir: target.dir, deniedTools: denied });
    applied = { profile: target, homeName: homeName(), at: new Date(), active: activeSet, mcpServers: new Set(Object.keys(targetMcp)), dropped, missing };
  }

  // 5. The declared tool set for the next run.
  if (typeof pi.setActiveTools === "function") {
    pi.setActiveTools([...activeSet]);
  }

  // 6. The target's thinking level and model, from its settings.json.
  if (targetSettings.defaultThinkingLevel) {
    try {
      pi.setThinkingLevel(targetSettings.defaultThinkingLevel as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
    } catch (e) {
      ctx.ui.notify(`Thinking level ${targetSettings.defaultThinkingLevel} not applied: ${(e as Error).message}`, "warning");
    }
  }
  if (targetSettings.defaultProvider && targetSettings.defaultModel) {
    // Guarded so a `setModel` throw cannot escape and leave the session switched
    // with no entry and no report: the entry write (step 7) and the report (step
    // 8) must always run after the switch state is applied.
    try {
      const current = ctx.model;
      if (
        !current ||
        current.provider !== targetSettings.defaultProvider ||
        current.id !== targetSettings.defaultModel
      ) {
        const model = ctx.modelRegistry.find(targetSettings.defaultProvider, targetSettings.defaultModel);
        if (model) {
          const ok = await pi.setModel(model);
          if (!ok) {
            ctx.ui.notify(
              `Model ${targetSettings.defaultProvider}/${targetSettings.defaultModel} has no configured auth; keeping the current model.`,
              "warning",
            );
          }
        } else {
          ctx.ui.notify(
            `Model ${targetSettings.defaultProvider}/${targetSettings.defaultModel} is not in the registry; keeping the current model.`,
            "warning",
          );
        }
      }
    } catch (e) {
      ctx.ui.notify(`Model not applied: ${(e as Error).message}`, "warning");
    }
  }

  // 7. Record the switch in the session, so a resume restores it.
  const at = new Date();
  const entry: PersonaEntry = {
    profile: target.name,
    dir: target.dir,
    at: at.toISOString(),
    widened: gained.length > 0,
    confirmed: gained.length > 0 && confirmed,
    dropped,
    missing,
  };
  if (homeState) {
    entry.homeTools = homeState.tools;
    entry.homeModel = homeState.model;
    entry.homeThinking = homeState.thinking;
  }
  try {
    pi.appendEntry("persona-switch", entry);
  } catch (e) {
    ctx.ui.notify(`Switch applied but not recorded in the session: ${(e as Error).message}`, "warning");
  }

  // 8. Report.
  const report: string[] = [];
  report.push(home ? `Switched back to ${target.name} (home).` : `Switched to ${target.name}.`);
  if (dropped.length > 0) report.push(`Dropped: ${dropped.join(", ")}.`);
  if (missing.length > 0) {
    report.push(`Not loaded in this process (only available via \`pi-p ${target.name}\`): ${missing.join(", ")}.`);
  }
  report.push("Fallback chain unchanged: model-fallback reads it at load.");
  report.push("Gained tools appear on the next run.");
  ctx.ui.notify(report.join(" "));
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Registers the profile's own MCP servers at load, then (in a top-level
 * process) the `/agent` command and the session wiring.
 *
 * A child (`PI_SUBAGENT_RUN_ID` set) gets only the load-time registration:
 * its profile environment is what its parent chose, it is never re-persona'd,
 * and it carries no command.
 *
 * @param pi - The pi extension API.
 */
export default function (pi: ExtensionAPI) {
  // The profile's own servers, registered at load so a session starts with
  // them — the registration code of what `mcp.json` used to do for github.
  // In a child this is the target profile's file (the child's
  // `PI_CODING_AGENT_DIR` is the target's), so child behaviour matches today's.
  registerProfileMcp(pi, profileDir());

  if (process.env.PI_SUBAGENT_RUN_ID) return;

  const activation = new SkillActivation();

  // A skill is only in the roster once it is loaded; the switched library's
  // skills are re-activated from this process's own prompt and tool signals.
  pi.on("session_start", async (event) => {
    if (event.reason === "new" || event.reason === "resume") activation.reset();
  });

  pi.on("session_start", async (event, ctx) => {
    const entry = latestPersonaEntry(ctx.sessionManager.getEntries());

    // A recorded switch to another profile: restore it.
    if (entry && entry.dir !== homeDirReal()) {
      if (!existsSync(join(entry.dir, "settings.json"))) {
        const msg = `Persona ${entry.profile}: ${entry.dir} no longer has a settings.json; staying on ${homeName()}.`;
        console.error(msg);
        ctx.ui.notify(msg, "warning");
        setPersonaOverride(undefined);
        applied = undefined;
        return;
      }
      const target = (await discoverProfiles(repoRoot())).find((p) => p.dir === entry.dir);
      if (!target) {
        const msg = `Persona ${entry.profile}: no profile resolves to ${entry.dir}; staying on ${homeName()}.`;
        console.error(msg);
        ctx.ui.notify(msg, "warning");
        setPersonaOverride(undefined);
        applied = undefined;
        return;
      }
      // Honour the recorded confirmation only if it was a confirmed widening made
      // under the same home the session is on now. A home whose effective set has
      // since changed (or a pre-binding / hand-edited entry) falls back to the live
      // gate, which re-asks. Trust boundary: a session file is a local, user-owned,
      // gitignored artifact, so hand-editing `confirmed` is the user consenting to
      // themselves — and no `PI_SUBAGENT_RUN_ID` child can append an entry (this
      // path returns first), so a child never restores a switch.
      const honoured =
        entry.widened && entry.confirmed && sameTools(entry.homeTools, pi.getActiveTools());
      await applyPersona(pi, target, ctx, honoured);
      return;
    }

    // Test-only: apply a switch at startup, before the first prompt. A widening
    // is refused here — a headless startup has no UI to confirm one.
    if (!entry && event.reason === "startup" && process.env.PI_AGENT_PERSONA) {
      const resolved = resolveProfileArg(process.env.PI_AGENT_PERSONA, await discoverProfiles(repoRoot()), homeDirReal());
      if (!resolved.ok) {
        const msg = `PI_AGENT_PERSONA: ${resolved.error}`;
        console.error(msg);
        ctx.ui.notify(msg, "error");
        return;
      }
      await applyPersona(pi, resolved.profile, ctx);
      return;
    }

    // A switch is live from an earlier session, and this one carries no entry:
    // clear back to home, so the new session is the process's own profile.
    if (!entry && personaOverride() && event.reason === "new") {
      setPersonaOverride(undefined);
      applied = undefined;
      if (typeof pi.setActiveTools === "function" && homeState) {
        pi.setActiveTools(homeState.tools);
      }
      swapMcp(pi, readPersonaMcpSync(profileDir()));
    }
  });

  // The hard block: a switch's denied tools, and every tool outside its active
  // set, are refused at the call, not just withheld from the declaration — the
  // declaration filter hides tools from the model, but `ctx.executeTool()` can
  // reach one regardless. `activation` also feeds the roster.
  pi.on("tool_call", async (event) => {
    activation.noteToolCall(event.toolName, event.input);
    const override = personaOverride();
    if (
      override &&
      (override.deniedTools.has(event.toolName) ||
        (applied && !applied.active.has(event.toolName) && !appliedMcpApplies(applied, event.toolName)))
    ) {
      return { block: true, reason: `Tool not available in persona ${override.name}` };
    }
    return undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const opts = event.systemPromptOptions;
    activation.notePrompt(event.messageType === "user" ? event.prompt : "");

    const override = personaOverride();
    if (!override) {
      // No switch: this profile's own prompt extension builds the prompt, and
      // this one records the run's tool list for the probe.
      probeSelectedTools = [...(opts.selectedTools ?? [])];
      return undefined;
    }

    // A switch is active: this extension is the single builder for the run.
    // (The other prompt extensions stand down on the same `personaOverride()`
    // check — exactly one handler returns a systemPrompt, in load order and
    // out of it alike.)
    const state = applied;
    if (!state) {
      // An override set out-of-band (a test, a future caller) has no applied
      // state to build from: withhold nothing, build the home prompt.
      probeSelectedTools = [...(opts.selectedTools ?? [])];
      return undefined;
    }

    // The prompt builder loads from the target profile's own extensions dir —
    // never from this file's relatives, which under the profile's directory
    // symlink (quant-trader/extensions/persona) resolve into the wrong tree.
    const extDir = join(state.profile.dir, "extensions");
    const quantModule =
      state.profile.promptKind === "quant"
        ? ((await import(join(extDir, "quant-prompt.js"))) as unknown) as QuantModule
        : undefined;
    const orchestratorModule =
      quantModule === undefined
        ? ((await import(join(extDir, "dynamic-prompt.js"))) as unknown) as OrchestratorModule
        : undefined;

    // --- The run's tool set: the switch's active set, minus its denied ---
    // selectedTools is mutable here and is what the model is offered for this
    // run; there is no unregisterTool, so this is the enforcement on top of
    // `setActiveTools` and the `tool_call` block.
    opts.selectedTools = opts.selectedTools.filter(
      (t) => (state.active.has(t) || appliedMcpApplies(state, t)) && !override.deniedTools.has(t),
    );
    probeSelectedTools = [...opts.selectedTools];

    // --- What the switched profile's prompt needs ---
    const library = skillsDir();
    const lineage = parseLineage(process.env[LINEAGE_ENV]);
    const roster = await delegationRoster({
      agentsDir: agentsDir(),
      skillsDir: library,
      lineage,
      activeSkills: activation.list(),
    });

    // The skill inventory: the skills pi's own list places under the switched
    // library, plus what that library holds that the list does not cover (pi
    // discovers against the process's directory, not the switched one).
    const realLibrary = await realpath(library).catch(() => library);
    const covered = new Set<string>();
    const inventory: Array<{
      name: string;
      description: string;
      filePath: string;
      pathCategory?: string;
    }> = [];
    for (const skill of opts.skills ?? []) {
      const real = await realpath(skill.filePath).catch(() => skill.filePath);
      if (real === realLibrary || real.startsWith(realLibrary + "/")) {
        covered.add(real);
        inventory.push({
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          pathCategory: categoryFromPath(library, skill.filePath),
        });
      }
    }
    for (const located of await findSkills(library)) {
      if (covered.has(located.path)) continue;
      let description = "";
      try {
        const fm = frontmatterOf(await readFile(located.path, "utf-8"));
        if (fm) {
          const line = fm.split(/\r?\n/).find((l) => l.startsWith("description:"));
          description = line ? line.slice(line.indexOf(":") + 1).trim() : "";
        }
      } catch {
        // unreadable: no description
      }
      inventory.push({ name: located.dir, description, filePath: located.path, pathCategory: located.category });
    }

    // The context: the home AGENTS.md entry is replaced by the target's, when
    // the target has one; everything else (project context) is untouched.
    const homeAgentsMd = join(homeDirReal(), "AGENTS.md");
    const targetAgentsMd = join(state.profile.dir, "AGENTS.md");
    const contextInventory = (opts.contextFiles ?? [])
      .map((f) => {
        if (f.path !== homeAgentsMd) return { path: f.path };
        if (existsSync(targetAgentsMd)) return { path: targetAgentsMd };
        return undefined;
      })
      .filter((f): f is { path: string } => f !== undefined);

    const guidelines = (opts.promptGuidelines ?? []).filter((g) => g.trim().length > 0);
    const selectedTools = opts.selectedTools ?? [];

    let builtPrompt: string;
    if (quantModule) {
      builtPrompt = quantModule.buildQuantPrompt({
        agentInventory: roster.spawnable,
        skillInventory: inventory,
        contextInventory,
        guidelines,
        hasSubagent: selectedTools.includes("subagent"),
        isSubagent: lineage.length > 0,
        customPrompt: opts.customPrompt,
        appendSystemPrompt: opts.appendSystemPrompt,
        cwd: opts.cwd,
        skillsLibrary: library,
      });
    } else {
      const owners = await loadSkillToolOwners(library);
      const inputs = orchestratorModule!.promptInputs({
        systemPromptOptions: opts,
        lineage,
        roster,
        owners,
        isActive: (d) => activation.has(d),
        skillsLibrary: library,
      });
      if (owners.size > 0 && Array.isArray(opts.selectedTools)) {
        opts.selectedTools = inputs.selectedTools;
        probeSelectedTools = [...opts.selectedTools];
      }
      builtPrompt = orchestratorModule!.buildOrchestratorPrompt(inputs.buildOptions);
    }

    return {
      systemPrompt:
        personaBlock({
          name: state.profile.name,
          homeName: state.homeName,
          at: state.at,
          dropped: state.dropped,
          missing: state.missing,
        }) + builtPrompt,
    };
  });

  // The probe (A8): `PI_PERSONA_PROBE_FILE` makes a run write its observed
  // state as JSON. Written at `agent_start` — after every `before_agent_start`
  // handler has run — so `promptHead` is the prompt the provider actually sees,
  // in both the override and no-override branches.
  pi.on("agent_start", async (_event, ctx) => {
    const file = process.env.PI_PERSONA_PROBE_FILE;
    if (!file) return;
    try {
      let promptHead = "";
      try {
        promptHead = ctx.getSystemPrompt().slice(0, 2000);
      } catch {
        // the prompt is not available yet; the rest of the probe still stands
      }
      const toolSources: Record<string, { path: string; source: string; origin: string }> = {};
      for (const t of pi.getAllTools()) {
        toolSources[t.name] = { path: t.sourceInfo.path, source: t.sourceInfo.source, origin: t.sourceInfo.origin };
      }
      writeFileSync(
        file,
        JSON.stringify(
          {
            persona: personaOverride()?.name ?? null,
            selectedTools: probeSelectedTools,
            activeTools: pi.getActiveTools(),
            toolSources,
            promptHead,
          },
          null,
          2,
        ),
      );
    } catch {
      // a probe is a diagnostic; it must never take a run down
    }
  });

  pi.registerCommand("agent", {
    description: "Switch this session to another profile in place: /agent, /agent quant, /agent -",
    getArgumentCompletions: async (prefix) => {
      const profiles = await discoverProfiles(repoRoot());
      const names = profiles.flatMap((p) => [p.name, ...p.aliases]);
      return [...names, "-"]
        .filter((n) => n.startsWith(prefix))
        .map((n) => ({
          value: n,
          label: n,
          description: n === "-" ? "switch back to this process's profile" : "switch to this profile",
        }));
    },
    handler: async (args, ctx) => {
      const arg = args.trim();
      const profiles = await discoverProfiles(repoRoot());

      if (arg.length === 0) {
        const active = personaOverride();
        const lines = profiles.map((p) => {
          const marker = active?.dir === p.dir ? "●" : " ";
          const homeTag = isHome(p) ? " (home)" : "";
          const aliasTag = p.aliases.length > 0 ? ` [aliases: ${p.aliases.join(", ")}]` : "";
          return `${marker} ${p.name}${homeTag}${aliasTag}`;
        });
        let extra = "";
        if (applied) {
          if (applied.dropped.length > 0) extra += ` Dropped: ${applied.dropped.join(", ")}.`;
          if (applied.missing.length > 0) extra += ` Not loaded in this process: ${applied.missing.join(", ")}.`;
        }
        ctx.ui.notify(`Profiles${extra}\n${lines.join("\n")}`);
        return;
      }

      const resolved = resolveProfileArg(arg, profiles, homeDirReal());
      if (!resolved.ok) {
        ctx.ui.notify(resolved.error, "error");
        return;
      }
      await applyPersona(pi, resolved.profile, ctx);
    },
  });
}

/**
 * Part A: register the profile's own MCP servers from `<dir>/persona-mcp.json`.
 * Runs in every process (top-level and child) so a session starts with its
 * profile's servers, exactly as an `mcp.json` entry would.
 */
function registerProfileMcp(pi: ExtensionAPI, dir: string): void {
  let servers: Record<string, unknown>;
  try {
    servers = readPersonaMcpSync(dir);
  } catch (e) {
    console.error(`persona: ${(e as Error).message}`);
    return;
  }
  for (const [name, config] of Object.entries(servers)) {
    try {
      pi.registerMcpServer(name, config as McpServerConfig);
      registered.set(name, JSON.stringify(config));
    } catch (e) {
      console.error(`persona: failed to register MCP server "${name}": ${(e as Error).message}`);
    }
  }
}
