/**
 * The indirect-MCP-servers note for a forced system prompt.
 *
 * pi's builtin MCP extension publishes the servers whose tools it did not declare
 * as the `mcp_servers` prompt section, so the model knows those tools exist and
 * that `tool_search` (or codemode) is how to reach them. This repo's prompt
 * builder (`dynamic-prompt.ts`) returns a whole system prompt from
 * `before_agent_start`,
 * which sets `forceSystemPrompt` and suppresses every core-contributed section —
 * so that section never reaches the model, and a deferred server is simply
 * invisible.
 *
 * Carrying core's text over is not available either: `before_agent_start`
 * handlers run in extension registration order (pi's `core/extensions/runner.js`,
 * `emitBeforeAgentStart`), user extensions register before the builtin ones, and
 * the builtin MCP extension writes `sections.mcp_servers` inside *its own*
 * handler. By the time a prompt handler runs, that key has not been written yet.
 *
 * So the note is SYNTHESIZED here, from the same source pi's own
 * `renderServersSection` reads: the config files, before any connection. That is
 * the one honest difference from core's text — it describes what the config
 * *declares*, not what connected. A configured server that fails to authenticate
 * is advertised anyway, and its tools are just absent when the model reaches for
 * them; the alternative (read the live connections) needs an API no extension
 * gets, and would drop a server from the prompt for the length of a token refresh.
 *
 * The pi package is not importable here for the loader that would do this
 * properly: `@earendil-works/pi-coding-agent` exports only `.` and
 * `./rpc-entry`, so `…/extensions/mcp/config.js` (which holds `loadMcpConfig`) is
 * outside its exports map and fails to resolve. Hence the direct `fs` +
 * `JSON.parse` readers below, which understand only the `mcpServers` shape.
 *
 * One documented gap: pi also merges the trusted project layer's `<cwd>/.pi/mcp.json`
 * into its own config — including that file's `exposure` and `enabled` overrides of a
 * server the agent dir's `mcp.json` defines — while these readers see only `mcp.json`.
 * A server the project layer overrides can therefore be
 * missing from the note, or advertised with a reach pi is not using.
 *
 * @module lib/mcp-config
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The entry shape
// ---------------------------------------------------------------------------

/**
 * One configured MCP server, as much of pi's `mcpServers` entry as the note
 * needs: the name, what it is for, and how its tools are exposed.
 */
export interface PromptMcpServer {
  /** The key under `mcpServers` in the config file, not pi's `mcp__<name>` namespace. */
  name: string;
  /**
   * pi's optional `description`. Part of the entry because every real config
   * carries one and a caller mapping a file onto this shape should not have to
   * drop it; not rendered — this note's job is reachability, and the forced
   * prompt has no room for a second capability summary per server.
   */
  description?: string;
  /** pi's `exposure`; absent means the default, `"codemode"`. */
  exposure?: string;
  /** pi's per-tool `exposure` overrides, tool name → exposure. */
  toolExposure?: Record<string, string>;
  /** pi's `enabled` flag; only `false` disables. */
  enabled?: boolean;
}

/** What pi's `exposureOf` treats as the default when a config omits `exposure`. */
const DEFAULT_EXPOSURE = "codemode";

/**
 * pi's `hasIndirectTools`: a server belongs in the note when ANY exposure in its
 * configured union is one of these. `direct` declares every tool and `hidden`
 * removes it, so a server whose union holds only those two is not indirect.
 */
const INDIRECT_EXPOSURES = new Set(["codemode", "deferred"]);

/**
 * pi's `configuredExposures`: the union of the server-level exposure (pi's default
 * when omitted) and every per-tool `toolExposure` pin. pi decides both what it
 * lists and which reaching tool it activates (`codemode` when any exposure is
 * `codemode`, `tool_search` when any is `deferred`) on this union, so the note
 * reads it the same way rather than off the server-level key alone.
 */
function configuredExposures(server: PromptMcpServer): Set<string> {
  return new Set([server.exposure ?? DEFAULT_EXPOSURE, ...Object.values(server.toolExposure ?? {})]);
}

/**
 * pi's server namespace: `mcp__<server>`, with `-` replaced by `_` the way
 * `core/mcp-servers.js`'s `mcpNamespace` does. Mirrored, not imported — see this
 * module's header for why the pi package is unreachable from an extension.
 */
function serverNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, "_")}`;
}

/**
 * The name a server tool is actually declared under: `mcp__<server>__<tool>`
 * (`extensions/mcp/tools.js`), with the same character sanitizing. pi shortens
 * names past its length cap with a hash suffix; a name long enough to hit that
 * cap is not in this repo's configs, so the shortening is not mirrored.
 */
function toolNamespace(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/**
 * The `## MCP Servers` body for the servers whose tools the model is NOT offered
 * — one markdown line per server, no heading (the builder adds it), `''` when
 * there is nothing to say.
 *
 * Indirect is decided on the UNION of a server's exposures — the server-level one
 * plus every per-tool `toolExposure` pin — exactly as pi's `hasIndirectTools`
 * decides it: the server contributes when any exposure in that union is `deferred`
 * or `codemode`. So a server-level `direct` carrying one `deferred` pin IS listed
 * (its deferred tools are reachable only through `tool_search`), while one whose
 * union is only `direct` and `hidden` contributes nothing. pi's rule is an
 * allow-list, and an exposure name pi does not know lists nothing for it either;
 * mirroring that keeps the note aligned with what pi actually makes reachable.
 * One line per *server*, not one per exposure combination, is what keeps the note
 * short enough to be read.
 *
 * Names are pi's, not the config's, because the model acts on them: the server
 * heading uses the namespace prefix, and the `declared directly` clause names the
 * tools as they appear in the tool list.
 *
 * Pure: entries in, text out. Callers pass the servers the config declares; the
 * `enabled: false` filter lives here so a caller cannot forget it.
 */
export function synthesizeMcpServersSection(servers: readonly PromptMcpServer[]): string {
  const indirect = servers
    .filter((s) => s.enabled !== false)
    .filter((s) => [...configuredExposures(s)].some((e) => INDIRECT_EXPOSURES.has(e)))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (indirect.length === 0) return "";

  const lines = indirect.map((server) => {
    // pi's own reach label (`renderServersSection`): `codemode` when ANY exposure
    // in the union is `codemode`, `tool_search` otherwise. A server mixing both
    // pins gets the codemode wording because that is what today's pi enables for
    // it — codemode-first is the agreed choice, not an oversight.
    const reach = configuredExposures(server).has("codemode")
      ? "call them from codemode scripts (`searchTools()`)"
      : "load them with `tool_search`";
    // A `direct` override is the exception worth naming: those tools are already
    // in the tool list, so searching for them wastes a turn.
    const declared = Object.entries(server.toolExposure ?? {})
      .filter(([, exposure]) => exposure === "direct")
      .map(([tool]) => `\`${toolNamespace(server.name, tool)}\``);
    const direct = declared.length > 0 ? `; declared directly: ${declared.join(", ")}` : "";
    return `- \`${serverNamespace(server.name)}\` — tools are NOT declared to you; ${reach}${direct}`;
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

/**
 * One `mcp.json` file as entries: a missing, unreadable, or invalid-JSON file
 * yields `[]`, not an error to report here, because pi's own loader surfaces
 * those errors to the user through `/mcp` — which is where a fix belongs.
 */
export function readMcpServersFile(file: string): PromptMcpServer[] {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return []; // missing or unreadable: no servers
  }
  // A leading BOM is valid UTF-8 JSON but `JSON.parse` rejects it, and Windows
  // editors write one; strip it so the note survives a config saved with a BOM.
  text = text.replace(/^\uFEFF/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const servers = (parsed as { mcpServers?: unknown } | undefined)?.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];

  const entries: PromptMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof name !== "string" || typeof raw !== "object" || raw === null) continue;
    const config = raw as Record<string, unknown>;
    const entry: PromptMcpServer = { name };
    if (typeof config.description === "string") entry.description = config.description;
    if (typeof config.exposure === "string") entry.exposure = config.exposure;
    if (typeof config.enabled === "boolean") entry.enabled = config.enabled;
    if (typeof config.toolExposure === "object" && config.toolExposure !== null) {
      const overrides: Record<string, string> = {};
      for (const [tool, exposure] of Object.entries(config.toolExposure as Record<string, unknown>)) {
        if (typeof exposure === "string") overrides[tool] = exposure;
      }
      entry.toolExposure = overrides;
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * The servers a prompt should advertise: the ones the agent dir's `mcp.json`
declares, deduped by registered namespace keeping the first occurrence.
 *
 * `mcpJsonDir` is the agent dir whose `mcp.json` pi loaded — always the
 * *process's* own (`agentDir()`), since no prompt path retargets it. Dedup is
 * kept as a reader invariant even though one JSON object cannot repeat a key:
 * pi's namespace sanitizing (`mcpNamespace`) folds `-` and `_` together, so
 * `my-srv` and `my_srv` clash in the tool list even though both keys are legal
 * in one file.
 *
 * Never throws; a config-reading failure yields `[]`, which yields no section.
 */
export function readPromptMcpServers(mcpJsonDir: string): PromptMcpServer[] {
  try {
    const seen = new Set<string>();
    const servers: PromptMcpServer[] = [];
    for (const entry of readMcpServersFile(join(mcpJsonDir, "mcp.json"))) {
      // A disabled server is not registered, so it must not shadow an enabled
      // server whose name folds onto the same namespace.
      if (entry.enabled === false) continue;
      // First wins, keyed on the namespace pi actually registers the server under:
      // `mcpNamespace` folds `-` into `_`, so `my-srv` and `my_srv` clash in the
      // tool list even though both keys are legal in one JSON object.
      const namespace = serverNamespace(entry.name);
      if (seen.has(namespace)) continue;
      seen.add(namespace);
      servers.push(entry);
    }
    return servers;
  } catch {
    return [];
  }
}

/** {@link readPromptMcpServers} + {@link synthesizeMcpServersSection}: the section body, or `''`. */
export function promptMcpServersSection(mcpJsonDir: string): string {
  try {
    return synthesizeMcpServersSection(readPromptMcpServers(mcpJsonDir));
  } catch {
    return "";
  }
}
