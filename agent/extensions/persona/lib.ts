/**
 * Pure logic for the persona switch: profile discovery, name resolution,
 * per-profile MCP config, tool-set computation, widening, and session-entry
 * parsing.
 *
 * No pi import, no session state: every function takes its inputs as
 * parameters, so the whole switch decision is testable against temp dirs,
 * and the file loads identically in an orchestrator process and (through the
 * `quant-trader/extensions/persona` symlink) in a quant process. The
 * session wiring that calls these lives in `index.ts`.
 *
 * @module persona/lib
 */
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

import { QUANT_REMOVED_TOOLS } from "../../../quant-trader/extensions/quant-prompt.js";

// ---------------------------------------------------------------------------
// Profile discovery
// ---------------------------------------------------------------------------

/**
 * One profile the repo root offers: the directory (resolved), the name the
 * user addresses it by, every alias, and the prompt kind its `extensions/`
 * marker file selects.
 */
export interface ProfileInfo {
  /** The canonical name: the non-symlink entry under the repo root. */
  name: string;
  /** Symlink entries that resolve to this profile's directory. */
  aliases: string[];
  /** The profile directory, resolved to its realpath. */
  dir: string;
  /**
   * The prompt builder the profile's own prompt extension selects:
   * `dynamic-prompt.ts` → orchestrator, `quant-prompt.ts` → quant, neither →
   * `undefined` (the switch refuses such a profile).
   */
  promptKind: "orchestrator" | "quant" | undefined;
}

/** Top-level entries that are never profiles. */
const EXCLUDED_ENTRIES = new Set(["node_modules", "docs", "scripts"]);

/**
 * The prompt kind a profile's `extensions/` directory declares, by its marker
 * file. A profile with neither marker is `undefined` — the switch refuses it,
 * because it cannot say which prompt builder to run.
 */
async function promptKindOf(entryPath: string): Promise<ProfileInfo["promptKind"]> {
  try {
    const files = await readdir(join(entryPath, "extensions"));
    if (files.includes("dynamic-prompt.ts")) return "orchestrator";
    if (files.includes("quant-prompt.ts")) return "quant";
    return undefined;
  } catch {
    return undefined; // no extensions dir: nothing to select
  }
}

/**
 * The profiles a repo root offers.
 *
 * A profile is a top-level entry (directory, or symlink to one) that carries
 * a `settings.json`. Entries starting with `.`, plus `node_modules`, `docs`
 * and `scripts`, are excluded. Entries are deduplicated by `realpath`: the
 * non-symlink entry becomes the canonical name and symlinks become aliases.
 *
 * Never throws: an unreadable root is "no profiles", because this runs on the
 * `/agent` command path, where a throw would be a dead-end the user cannot
 * act on.
 */
export async function discoverProfiles(root: string): Promise<ProfileInfo[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }

  interface Candidate {
    name: string;
    isLink: boolean;
  }
  const byReal = new Map<string, { candidates: Candidate[]; dir: string; promptKind: ProfileInfo["promptKind"] }>();

  for (const name of names) {
    if (name.startsWith(".") || EXCLUDED_ENTRIES.has(name)) continue;
    const entryPath = join(root, name);
    let st;
    try {
      st = await lstat(entryPath);
    } catch {
      continue;
    }
    const isLink = st.isSymbolicLink();
    if (isLink) {
      // `stat` follows: a broken symlink is not a profile.
      try {
        st = await stat(entryPath);
      } catch {
        continue;
      }
    }
    if (!st.isDirectory()) continue;
    try {
      await stat(join(entryPath, "settings.json"));
    } catch {
      continue; // a profile is a directory with a settings.json, nothing else
    }
    let real: string;
    try {
      real = await realpath(entryPath);
    } catch {
      continue;
    }
    const known = byReal.get(real);
    if (known) {
      known.candidates.push({ name, isLink });
    } else {
      byReal.set(real, { candidates: [{ name, isLink }], dir: real, promptKind: await promptKindOf(entryPath) });
    }
  }

  const out: ProfileInfo[] = [];
  for (const { candidates, dir, promptKind } of byReal.values()) {
    const nonLink = candidates.filter((c) => !c.isLink);
    // The non-symlink entry is the canonical name; if only symlinks exist,
    // the first one seen is the name.
    const name = (nonLink[0] ?? candidates[0]!).name;
    const aliases = candidates.filter((c) => c.name !== name).map((c) => c.name).sort();
    out.push({ name, aliases, dir, promptKind });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a `/agent` argument to a profile.
 *
 * `-`, `default` and `home` name the process's real profile (`homeDir`, its
 * realpath) — the same target the switch clears back to. An exact name or
 * alias resolves directly; otherwise a unique prefix is accepted (`quant` →
 * `quant-trader`), an ambiguous prefix is an error that lists the candidates,
 * and a name nothing matches is an error.
 */
export function resolveProfileArg(
  arg: string,
  profiles: ProfileInfo[],
  homeDir: string,
): { ok: true; profile: ProfileInfo } | { ok: false; error: string } {
  if (arg === "-" || arg === "default" || arg === "home") {
    const home = profiles.find((p) => p.dir === homeDir);
    // Home is always switchable-to, even if discovery excluded it (e.g. the
    // repo root is not the profile's parent): a minimal entry keeps the
    // switch-back path working.
    return { ok: true, profile: home ?? { name: "agent", aliases: [], dir: homeDir, promptKind: undefined } };
  }

  const exact = profiles.find((p) => p.name === arg || p.aliases.includes(arg));
  if (exact) return { ok: true, profile: exact };

  const prefixed = profiles.filter((p) => p.name.startsWith(arg) || p.aliases.some((a) => a.startsWith(arg)));
  if (prefixed.length === 1) return { ok: true, profile: prefixed[0]! };
  if (prefixed.length > 1) {
    const names = prefixed.flatMap((p) => [p.name, ...p.aliases]).join(", ");
    return { ok: false, error: `Ambiguous profile name "${arg}": ${names}` };
  }
  return { ok: false, error: `Unknown profile "${arg}"` };
}

// ---------------------------------------------------------------------------
// Per-profile MCP config
// ---------------------------------------------------------------------------

/**
 * The target profile's MCP servers, from `<dir>/persona-mcp.json`'s
 * `mcpServers` — the shape pi's MCP runtime fills `${VAR}` references in.
 *
 * A missing file gives `{}`: the target then shares only the process's
 * `mcp.json` servers. Malformed JSON throws with the path in the message,
 * because a config the switch cannot read is a config the user must fix, not
 * one it may silently drop.
 */
export async function readPersonaMcp(dir: string): Promise<Record<string, unknown>> {
  const file = join(dir, "persona-mcp.json");
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch {
    text = "{}"; // missing file: the empty set
  }
  return parsePersonaMcp(text, file);
}

/**
 * The synchronous variant, for load-time registration (extension load happens
 * before any await the registration code may use).
 */
export function readPersonaMcpSync(dir: string): Record<string, unknown> {
  const file = join(dir, "persona-mcp.json");
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return {};
  }
  return parsePersonaMcp(text, file);
}


function parsePersonaMcp(text: string, file?: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Malformed JSON in ${file ?? "persona-mcp.json"}: ${(e as Error).message}`);
  }
  const servers = (parsed as { mcpServers?: unknown } | undefined)?.mcpServers;
  if (servers === undefined || servers === null) return {};
  if (typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`Malformed mcpServers in ${file ?? "persona-mcp.json"}: expected an object`);
  }
  return servers as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool-set computation
// ---------------------------------------------------------------------------

/**
 * The tools a prompt kind withholds, for the switch's hard `tool_call` block.
 *
 * The quant desk refuses the file-mutating tools (`quant-prompt.ts` owns the
 * list — one parser per format, so the two cannot drift); the orchestrator
 * withholds nothing here, because its own prompt extension applies its own
 * rules.
 */
export function deniedToolsFor(kind: ProfileInfo["promptKind"]): ReadonlySet<string> {
  return kind === "quant" ? QUANT_REMOVED_TOOLS : new Set<string>();
}

/** One of the process's tools, as `computeTargetTools` needs it. */
export interface ProcessToolInfo {
  name: string;
  /** `sourceInfo.path` — a file path, or a synthetic `builtin:` name. */
  sourcePath: string;
  /** `sourceInfo.source`. */
  source: string;
  /** `sourceInfo.origin` — `package` or `top-level`. */
  origin: string;
}

/**
 * The installed package names under a profile: every `name` in an
 * `npm/node_modules` `package.json` (scoped entries included) plus the
 * relative install path of every git package under `<dir>/git`.
 *
 * This is what the tool-set rule matches `ProcessToolInfo.source` against,
 * because pi reports package tools by *installed* name — `npm:opensec-pi-fff@0.11.1` —
 * which is not necessarily the `settings.json` specifier (`npm:@ff-labs/pi-fff`).
 * The set proves installation, not declaration: the tool-set rule intersects it
 * with the target's declared specifiers, because a profile's trees are symlinks
 * into the home cache. An unreadable tree yields an empty set: the rule then
 * falls back to the specifier match alone.
 */
export function installedPackageNames(dir: string): { npmNames: string[]; gitPaths: string[] } {
  const npmNames = new Set<string>();
  const nmDir = join(dir, "npm", "node_modules");
  let entries: string[] = [];
  try {
    entries = readdirSync(nmDir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const p = join(nmDir, name);
    if (name.startsWith("@")) {
      let sub: string[] = [];
      try {
        sub = readdirSync(p);
      } catch {
        sub = [];
      }
      for (const s of sub) collectPackageName(join(p, s), npmNames);
    } else {
      collectPackageName(p, npmNames);
    }
  }
  const gitPaths = new Set<string>();
  walkGitPackages(join(dir, "git"), "", gitPaths);
  return { npmNames: [...npmNames], gitPaths: [...gitPaths] };
}

function collectPackageName(pkgDir: string, out: Set<string>): void {
  try {
    const raw = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as { name?: unknown };
    if (typeof raw.name === "string") out.add(raw.name);
  } catch {
    // not an installed package
  }
}

function walkGitPackages(dir: string, rel: string, out: Set<string>): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const r = rel === "" ? name : `${rel}/${name}`;
    if (existsSync(join(p, "package.json"))) {
      out.add(r);
      continue;
    }
    walkGitPackages(p, r, out);
  }
}

/**
 * The installed-name part of a package tool's `source`: the `npm:`/`git:`
 * scheme and a trailing `@version` are stripped. A scope `@` (index 0) is kept.
 */
export function packageBaseName(source: string): string {
  let s = source;
  const colon = s.indexOf(":");
  if (colon > 0 && colon <= 4) s = s.slice(colon + 1);
  const at = s.lastIndexOf("@");
  if (at > 0 && /^\d/.test(s.slice(at + 1))) s = s.slice(0, at);
  return s;
}

/**
 * The `mcp__<server>__*` server a tool name names, or `undefined` when the name
 * is not an MCP tool. The server is everything between the first two `__` pairs
 * — the same rule `computeTargetTools` applies, factored out so the switch's hard
 * block and declaration filter can test it too (a target's MCP servers are a rule,
 * not a snapshot: see the union in `index.ts`'s `applyPersona`).
 */
export function mcpServerOf(name: string): string | undefined {
  const m = name.match(/^mcp__(.*?)__[\s\S]+$/);
  return m ? m[1] : undefined;
}
/**
 * The target profile's effective tool set, computed from the home session's
 * active set.
 *
 * For each tool in `homeActive`, in order:
 * - `mcp__<server>__*` is kept when `<server>` is in the target's own MCP
 *   servers or in the shared (`mcp.json`) set; a server the target does not
 *   declare is dropped, with every tool under it.
 * - a `builtin:` source is kept — the builtins travel with the process.
 * - a `package` tool is kept when its `source` is one of the target's declared
 *   specifiers — or, when `targetNpmNames`/`targetGitPaths` are given, when it is
 *   installed in the target AND its installed name is declared: an npm package's
 *   base name is the `packageBaseName` of a declared specifier, a git package's
 *   path is a declared `git:` specifier without its prefix. The target's package
 *   trees are per-item symlinks into the home cache, so installed alone is
 *   "installed in home" — the declared intersection is what trims. The installed
 *   match exists because pi reports package tools by installed name, which the
 *   specifier list does not carry.
 * - a top-level extension tool is kept when its `realpath(sourcePath)` is
 *   inside one of the target's extension realpaths (a profile's extensions
 *   dir is per-item symlinks into the process's, so shared extensions
 *   resolve to the same realpath and are kept).
 * - anything in `denied` is dropped, always, no matter its source.
 *
 * The input order is kept: `setActiveTools` takes a set, but the declared
 * list the model sees should not reorder on a switch.
 */
export function computeTargetTools(i: {
  homeActive: string[];
  tools: ProcessToolInfo[];
  targetExtRealpaths: string[];
  targetPackages: string[];
  targetNpmNames?: string[];
  targetGitPaths?: string[];
  targetMcpServers: string[];
  sharedMcpServers: string[];
  denied: ReadonlySet<string>;
}): { active: string[]; dropped: string[] } {
  const byName = new Map(i.tools.map((t) => [t.name, t]));
  const mcpServers = new Set([...i.targetMcpServers, ...i.sharedMcpServers]);
  const packages = new Set(i.targetPackages);
  const npmNames = i.targetNpmNames ? new Set(i.targetNpmNames) : undefined;
  const gitPaths = i.targetGitPaths ? new Set(i.targetGitPaths) : undefined;
  const declaredNpmBases = new Set(i.targetPackages.map((s) => packageBaseName(s)));
  const declaredGitUrls = new Set(i.targetPackages.filter((s) => s.startsWith("git:")).map((s) => s.slice(4)));
  const active: string[] = [];
  const dropped: string[] = [];
  for (const name of i.homeActive) {
    if (i.denied.has(name)) {
      dropped.push(name);
      continue;
    }
    const server = mcpServerOf(name);
    if (server !== undefined) {
      // The server name is everything between the first two `__` pairs.
      if (mcpServers.has(server)) active.push(name);
      else dropped.push(name);
      continue;
    }
    const tool = byName.get(name);
    if (!tool) {
      // No source info: the home session offered it, so it exists. Keep.
      // Safe only because `computeTargetTools` runs BEFORE `swapMcp` unregisters a
      // server's tools (the switch in `index.ts`): a tool with no source fact here
      // is one the live process still carries, so keeping it cannot resurrect a
      // server the target has dropped. Do not reorder the two.
      active.push(name);
      continue;
    }
    if (tool.sourcePath.startsWith("builtin:")) {
      active.push(name);
      continue;
    }
    if (tool.origin === "package") {
      const base = packageBaseName(tool.source);
      const gitUrl = tool.source.startsWith("git:") ? tool.source.slice(4) : undefined;
      const kept =
        packages.has(tool.source) ||
        ((npmNames?.has(base) ?? false) && declaredNpmBases.has(base)) ||
        (gitUrl !== undefined && (gitPaths?.has(gitUrl) ?? false) && declaredGitUrls.has(gitUrl));
      if (kept) active.push(name);
      else dropped.push(name);
      continue;
    }
    if (insideAnyOf(tool.sourcePath, i.targetExtRealpaths)) {
      active.push(name);
    } else {
      dropped.push(name);
    }
  }
  return { active, dropped };
}

/**
 * Whether `path` (resolved to its realpath, when it exists) is `target` or
 * inside it. A path that cannot be resolved is compared as given — the
 * hermetic tests pass fabricated paths, and a missing file is still "inside"
 * its (also fabricated) extension dir.
 */
function insideAnyOf(path: string, targets: string[]): boolean {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // keep the path as given
  }
  return targets.some((t) => real === t || real.startsWith(t.endsWith("/") ? t : t + "/"));
}

/**
 * The target's extensions and packages this process never loaded: the things
 * `/agent` cannot add in place, which the report names and points at
 * `pi-p <profile>` for.
 *
 * The prompt marker files are excluded: the persona extension supplies the
 * prompt, so their absence is not a gap the user should be told about.
 */
export function missingInProcess(
  targetExtRealpaths: string[],
  processExtRealpaths: string[],
  targetPackages: string[],
  processPackages: string[],
): string[] {
  const loaded = new Set(processExtRealpaths);
  const missingExts = targetExtRealpaths.filter(
    (p) => !loaded.has(p) && basename(p) !== "dynamic-prompt.ts" && basename(p) !== "quant-prompt.ts",
  );
  const loadedPackages = new Set(processPackages);
  return [...missingExts, ...targetPackages.filter((p) => !loadedPackages.has(p))];
}

/**
 * The tools a switch gains: the target's active set minus the current
 * effective set. Non-empty is a widening — re-enabling tools the session
 * currently refuses — which the switch confirms with the user before
 * applying.
 */
export function isWidening(currentEffective: string[], targetActive: string[]): string[] {
  const current = new Set(currentEffective);
  return targetActive.filter((t) => !current.has(t));
}

// ---------------------------------------------------------------------------
// Session entries
// ---------------------------------------------------------------------------

/**
 * One `persona-switch` session entry: what a switch applied, so a resume can
 * restore it and the report can say what it did.
 */
export interface PersonaEntry {
  /** The profile's canonical name. */
  profile: string;
  /** The profile's directory, realpath. */
  dir: string;
  /** When the switch was applied (ISO timestamp). */
  at: string;
  /** Whether the switch widened the tool set. */
  widened: boolean;
  /** Whether the user confirmed the widening (always true when not widened). */
  confirmed: boolean;
  /** The tools the switch dropped from the declared set. */
  dropped: string[];
  /** The extensions/packages the process never loaded (report-only). */
  missing: string[];
  /** The home snapshot of the active tools, taken at the first switch away. */
  homeTools?: string[];
  /** The home model, taken at the first switch away. */
  homeModel?: { provider: string; id: string };
  /** The home thinking level, taken at the first switch away. */
  homeThinking?: string;
}

/**
 * The last valid `persona-switch` entry in a session's entry list.
 *
 * Entries are pi's `CustomEntry` shape (`type: "custom"`,
 * `customType: "persona-switch"`, payload in `data`); anything else — other
 * custom types, messages, malformed `data` — is skipped, because a resume
 * must not be refused by an entry it cannot parse.
 */
export function latestPersonaEntry(entries: unknown[]): PersonaEntry | undefined {
  let latest: PersonaEntry | undefined;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (e.type !== "custom" || e.customType !== "persona-switch") continue;
    const data = validatePersonaEntry(e.data);
    if (data) latest = data;
  }
  return latest;
}

/** The one validator: a payload the resume path can rely on, or `undefined`. */
function validatePersonaEntry(data: unknown): PersonaEntry | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.profile !== "string" || typeof d.dir !== "string" || typeof d.at !== "string") return undefined;
  if (typeof d.widened !== "boolean" || typeof d.confirmed !== "boolean") return undefined;
  if (!Array.isArray(d.dropped) || !d.dropped.every((x) => typeof x === "string")) return undefined;
  if (!Array.isArray(d.missing) || !d.missing.every((x) => typeof x === "string")) return undefined;
  if (d.homeTools !== undefined && (!Array.isArray(d.homeTools) || !d.homeTools.every((x) => typeof x === "string")))
    return undefined;
  if (d.homeModel !== undefined) {
    const m = d.homeModel as Record<string, unknown> | undefined;
    if (typeof m?.provider !== "string" || typeof m?.id !== "string") return undefined;
  }
  if (d.homeThinking !== undefined && typeof d.homeThinking !== "string") return undefined;
  return d as unknown as PersonaEntry;
}

// ---------------------------------------------------------------------------
// The prompt block
// ---------------------------------------------------------------------------

/**
 * The `## Active Persona` block prepended to the switched session's prompt.
 *
 * It says what changed, when, and what no longer applies — because the
 * transcript keeps the home profile's AGENTS.md and skill text, and the only
 * way to tell the model those instructions are stale is to say so, up front,
 * in the prompt it actually reads.
 */
export function personaBlock(opts: {
  /** The target profile's canonical name. */
  name: string;
  /** The process's own profile name. */
  homeName: string;
  /** When the switch was applied. */
  at: Date;
  /** The tools the switch dropped. */
  dropped: string[];
  /** The extensions/packages the process never loaded. */
  missing: string[];
}): string {
  const lines = [
    "## Active Persona",
    "",
    `This session was switched in place from \`${opts.homeName}\` to \`${opts.name}\` at ${opts.at.toISOString()}. You are now the \`${opts.name}\` persona. Earlier turns, and any \`AGENTS.md\` or skill text already quoted in this conversation, were produced under \`${opts.homeName}\`. Those instructions no longer apply. The tools declared to you now are the only ones you have.`,
  ];
  if (opts.dropped.length > 0) {
    lines.push(`Dropped: ${opts.dropped.join(", ")}.`);
  }
  if (opts.missing.length > 0) {
    lines.push(`Not loaded in this process (available via \`pi-p <profile>\`): ${opts.missing.join(", ")}.`);
  }
  lines.push("To load a skill not in pi's own list, `read` its absolute `SKILL.md` path.");
  return lines.join("\n");
}
