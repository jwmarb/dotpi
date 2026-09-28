/**
 * MCP (Model Context Protocol) extension for pi
 *
 * Connects to MCP servers declared in ~/.pi/agent/mcp.json ("mcpServers" key,
 * the standard Claude-Desktop-style format; a top-level map of servers is also
 * accepted) and registers each server's tools as native pi tools, so the LLM
 * can call them exactly like built-in tools.
 *
 * Supported server transports:
 *   - HTTP (Streamable HTTP / SSE): { "url": "...", "headers": { ... }, "timeout": ms }
 *   - stdio:                       { "command": "...", "args": [...], "env": { ... } }
 *
 * Tools are named  mcp__<server>__<tool>  (sanitized, truncated to 64 chars).
 *
 * Commands:
 *   /mcp status            per-server connection state + tool counts
 *   /mcp list [server]     list registered tools (all, or one server)
 *   /mcp refresh [server]  close + reconnect a server (or all) and re-register
 *
 * Lifecycle:
 *   - The (async) factory connects to all servers in parallel with a timeout,
 *     so a slow/unreachable server cannot block startup beyond that timeout.
 *     Failed servers are reported in the widget and /mcp status; tools for a
 *     failed server are simply not registered until it is refreshed.
 *   - On session_shutdown (quit, /new, /resume, /reload, ...) clients are
 *     closed — stdio servers would otherwise leak child processes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import * as http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadDotenv } from "../lib/dotenv.js";
import { agentDir, envFile, mcpConfigFile } from "../lib/layout.js";
import { fittedWidget } from "../lib/widget.js";

// --- Configuration -----------------------------------------------------------

/** Maximum chars allowed in a tool name (OpenAI-compatible limit). */
const MAX_TOOL_NAME_LEN = 64;
/** Default per-server connect timeout (ms). */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** Default per-call timeout (ms). */
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/** One entry under "mcpServers" in mcp.json. */
interface McpServerConfig {
	url?: string;
	headers?: Record<string, string>;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	/** Per-server connect timeout in ms (optional). */
	timeout?: number;
	/** Use OAuth (authorization code + PKCE) for this HTTP server. */
	auth?: "oauth";
	/** Fixed local port for the OAuth callback (default: any free port). */
	authPort?: number;
	/** Enable/disable this server. */
	disabled?: boolean;
}

type McpConfigFile = Record<string, McpServerConfig>;

/**
 * Locate the MCP config file.
 * Resolution order:
 *   1. $PI_MCP_CONFIG env var (explicit path)
 *   2. <agent dir>/mcp.json  (i.e. ~/.pi/agent/mcp.json)
 *
 * @returns Absolute path, or null if no known location exists.
 */
function resolveConfigPath(): string | null {
	const envPath = process.env.PI_MCP_CONFIG;
	if (envPath) return path.resolve(envPath);
	// One resolution, from lib/layout.ts: it cannot throw, so the second
	// hand-rolled homedir fallback this used to carry is gone.
	const p = mcpConfigFile();
	return fs.existsSync(p) ? p : null;
}

/**
 * Expand `${VAR}` placeholders in every string of a parsed config.
 *
 * pi does no expansion of its own, so this is what lets mcp.json reference a
 * credential by name instead of embedding it — which is what allows the file to
 * be committed at all (docs/adr/0042).
 *
 * An unset variable THROWS rather than expanding to empty or staying literal.
 * A literal `Bearer ${LITELLM_MCP_KEY}` would be sent to the gateway and come
 * back as a 401 that looks like a network or gateway fault; naming the missing
 * variable locally is the difference between a five-second fix and a hunt.
 *
 * Escape a literal dollar-brace with `$${...}` if a value ever needs one.
 *
 * @param value Any parsed JSON value; objects and arrays are walked.
 * @param where Path of the config file, for error messages.
 * @param trail Key path walked so far, so an error can point at the exact field.
 * @throws When a referenced variable is unset or empty.
 */
function expandPlaceholders(value: unknown, where: string, trail: string[] = []): unknown {
	if (typeof value === "string") {
		return value.replace(/\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
			if (match === "$${") return "${"; // escaped
			const v = process.env[name as string];
			if (v === undefined || v === "") {
				const field = trail.length ? trail.join(".") : "(root)";
				throw new Error(
					`${where}: ${field} references \${${name}}, which is not set.\n` +
					`  Set ${name} in the environment or in ${envFile()}.`,
				);
			}
			return v;
		});
	}
	if (Array.isArray(value)) return value.map((v, i) => expandPlaceholders(v, where, [...trail, String(i)]));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = expandPlaceholders(v, where, [...trail, k]);
		return out;
	}
	return value;
}

/**
 * Parse the mcp.json file into a map of server configs.
 * Accepts the standard { "mcpServers": { ... } } shape as well as a
 * top-level { "<name>": { ... } } map.
 *
 * @throws When the file cannot be read or is not valid JSON.
 */
function loadConfig(configPath: string): Map<string, McpServerConfig> {
	let raw: unknown;
try {
		const text = fs.readFileSync(configPath, "utf8");
		try {
			raw = JSON.parse(text);
		} catch (err) {
			throw new Error(`invalid JSON in ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	} catch (err) {
		if (err instanceof SyntaxError) throw err;
		throw new Error(`cannot read ${configPath}: ${err instanceof Error ? err.message : String(err)}`);
	}
	// Fill in credentials from agent/.env before expanding, so a placeholder can
	// resolve from the file as well as from the real environment (docs/adr/0042).
	// Force a fresh read: config load is the one moment a mid-session edit to .env
	// must become visible to a re-imported extension; the shared cache would
	// otherwise keep serving the pre-edit snapshot for this process's life, and a
	// newly referenced ${VAR} would fail to expand on hot reload.
	loadDotenv({ force: true });
	raw = expandPlaceholders(raw, configPath);

	const file = raw as { mcpServers?: McpConfigFile } | McpConfigFile;
	const servers =
		(typeof file === "object" && file !== null && "mcpServers" in (file as object) &&
			typeof (file as { mcpServers?: McpConfigFile }).mcpServers === "object" &&
			(file as { mcpServers: McpConfigFile }).mcpServers !== null)
			? (file as { mcpServers: McpConfigFile }).mcpServers
			: (file as McpConfigFile);
	const out = new Map<string, McpServerConfig>();
	if (servers && typeof servers === "object") {
		for (const [name, cfg] of Object.entries(servers)) {
			if (cfg && typeof cfg === "object" && !cfg.disabled) out.set(name, cfg);
		}
	}
	return out;
}

// --- Connection state --------------------------------------------------------

interface McpServerState {
	name: string;
	config: McpServerConfig;
	/** The connected MCP client (undefined while connecting/failed). */
	client?: unknown; // Client from @modelcontextprotocol/sdk
	/** Live OAuth redirect server, while an OAuth-protected server connects. */
	authProvider?: McpOAuthProvider;
	/** True while waiting for the user to finish browser authorization. */
	authPending?: boolean;
	transportKind: "http" | "stdio";
	toolNames: string[];
	toolDescriptions: Map<string, string>;
	/** The tool's inputSchema (plain JSON Schema) as reported by the server. */
	toolSchemas: Map<string, unknown>;
	status: "connecting" | "connected" | "failed";
	error?: string;
	connectedAt?: number;
}

/** Sanitize a string into a valid tool-name segment. */
function sanitizeSegment(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
}

/**
 * Build the global pi tool name for an MCP tool.
 * Format: mcp__<server>__<tool>, truncated to the 64-char tool name limit.
 */
function buildToolName(server: string, tool: string): string {
	const base = `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool)}`;
	return base.length <= MAX_TOOL_NAME_LEN
		? base
		: base.slice(0, MAX_TOOL_NAME_LEN - 5) + "_____".slice(0, 5);
}

/**
 * Map MCP content blocks to pi content blocks (text/image), falling back to
 * a text placeholder for anything else (resources, audio, ...).
 */
type McpContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function mapMcpContent(content: unknown[]): McpContentBlock[] {
	const out: McpContentBlock[] = [];
	for (const block of content) {
		const b = block as Record<string, unknown>;
		if (b.type === "text" && typeof b.text === "string") {
			out.push({ type: "text", text: b.text });
		} else if (b.type === "image" && typeof b.data === "string") {
			out.push({ type: "image", data: b.data, mimeType: typeof b.mimeType === "string" ? b.mimeType : "application/octet-stream" });
		} else if (b.type === "resource") {
			const r = (b.resource ?? {}) as Record<string, unknown>;
			if (typeof r.text === "string") {
				const mime = typeof r.mimeType === "string" ? ` (${r.mimeType})` : "";
				out.push({ type: "text", text: `[resource${mime}] ${r.text}` });
			} else {
				out.push({ type: "text", text: "[resource content omitted]" });
			}
		} else if (b.type === "audio") {
			out.push({ type: "text", text: "[audio content omitted]" });
		} else {
			try {
				out.push({ type: "text", text: `[unmapped content] ${JSON.stringify(b)}` });
			} catch {
				out.push({ type: "text", text: "[unmapped content]" });
			}
		}
	}
	return out;
}

/**
 * Resolve a local JSON-pointer ($ref "#/...") against the schema root.
 * Handles ~0/~1 escapes; returns undefined for external or dangling refs.
 */
function deref(ref: string, root: Record<string, unknown>): unknown {
	if (!ref.startsWith("#/")) return undefined;
	const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
	let cur: unknown = root;
	for (const p of parts) {
		if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[p];
		else return undefined;
	}
	return cur;
}

/**
 * Inline local $ref pointers so downstream consumers that do not follow
 * references see concrete types. pi-ai's JSON-schema argument coercion walks
 * properties without resolving $ref, so a value nested under a $defs entry
 * would otherwise stay a string and fail the strict Compile validation;
 * several LLM providers are also finicky about $ref inside tool schemas.
 * External refs and cycles (depth cap) are left untouched.
 */
function resolveRefs(node: unknown, root: Record<string, unknown>, depth = 0): unknown {
	if (depth > 16) return node;
	if (Array.isArray(node)) return node.map((n) => resolveRefs(n, root, depth + 1));
	if (!node || typeof node !== "object") return node;
	const s = node as Record<string, unknown>;
	if (typeof s.$ref === "string") {
		const target = deref(s.$ref, root);
		if (target && typeof target === "object") return resolveRefs(target, root, depth + 1);
		return node;
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(s)) out[k] = resolveRefs(v, root, depth + 1);
	return out;
}

/**
 * Turn an MCP tool's inputSchema (plain JSON Schema from listTools()) into the
 * `parameters` schema for registerTool.
 *
 * pi passes a plain JSON Schema through untouched: the provider serializes it
 * into the LLM tool definition, pi-ai validates with typebox Compile, and
 * coerces stringified arguments back to their declared types before execute()
 * runs. That is what keeps numbers/booleans/arrays arriving as their real
 * types instead of strings — with the previous empty-object schema the LLM
 * saw no parameters at all and guessed, usually stringifying everything.
 *
 * Local $ref/$defs are inlined (see resolveRefs); the original schema object
 * is never mutated. Falls back to an open object schema when the server
 * reports none.
 */
function toParametersSchema(raw: unknown, description: string): TSchema {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		const s = raw as Record<string, unknown>;
		let schema = s;
		if (s.$defs || s.definitions) {
			schema = resolveRefs(s, s) as Record<string, unknown>;
		}
		// A tool's arguments are an object; some servers omit `type`.
		if (schema.type === undefined) schema = { ...schema, type: "object" };
		return schema as TSchema;
	}
	return Type.Object({}, { additionalProperties: true, description });
}

// --- OAuth (authorization code + PKCE) ----------------------------------------

/** How long to wait for the user to finish browser authorization (ms). */
const AUTH_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Per-server OAuth state file (registered client, tokens, PKCE verifier,
 * discovery state). Lives outside mcp.json so rotating tokens never dirty the
 * committed config.
 */
function authStateFile(server: string): string {
	return path.join(agentDir(), "mcp-auth", `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function readAuthState(file: string): Record<string, unknown> {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function writeAuthState(file: string, patch: Record<string, unknown>): void {
	const next = { ...readAuthState(file), ...patch };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Best-effort browser launch; the authorization URL is always printed to the
 * console as well, so a headless machine (no xdg-open) can still finish the
 * flow by hand.
 */
function openBrowser(url: string): void {
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	try {
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		// no browser available — the console URL is the fallback
	}
}

/**
 * OAuthClientProvider for one MCP server: authorization code + PKCE with
 * dynamic client registration (RFC 7591), a local 127.0.0.1 redirect server
 * that captures the browser callback, and file-backed state so the user
 * authenticates once and token refreshes survive restarts.
 */
class McpOAuthProvider implements OAuthClientProvider {
	private readonly serverName: string;
	private readonly file: string;
	private readonly _redirectServer: http.Server;
	private _redirectUrl = "";
	private readonly _state: string;
	private _codeResolve: ((code: string) => void) | null = null;
	private _codeReject: ((err: Error) => void) | null = null;
	private _codePromise: Promise<string> | null = null;
	private readonly _ready: Promise<string>;
	private _bufferedCode: string | undefined;

	constructor(serverName: string, port = 0) {
		this.serverName = serverName;
		this.file = authStateFile(serverName);
		this._state = randomBytes(16).toString("hex");
		this._redirectServer = http.createServer((req, res) => this.handleRedirect(req, res));
		// Bind at construction: clientMetadata.redirect_uris must be fixed
		// before dynamic client registration, which happens before the
		// redirect.
		this._ready = new Promise<string>((resolve, reject) => {
			this._redirectServer.once("error", reject);
			this._redirectServer.listen(port, "127.0.0.1", () => {
				const addr = this._redirectServer.address();
				const p = typeof addr === "object" && addr !== null ? addr.port : port;
				this._redirectUrl = `http://127.0.0.1:${p}/callback`;
				resolve(this._redirectUrl);
			});
		});
	}

	/** Resolves with the redirect URL once the callback server is listening. */
	ready(): Promise<string> {
		return this._ready;
	}

	get redirectUrl(): string {
		return this._redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: `pi mcp ${this.serverName}`,
			redirect_uris: [this._redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	state(): string {
		return this._state;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return readAuthState(this.file).clientInformation as OAuthClientInformationMixed | undefined;
	}

	saveClientInformation(info: OAuthClientInformationMixed): void {
		writeAuthState(this.file, { clientInformation: info });
	}

	tokens(): OAuthTokens | undefined {
		return readAuthState(this.file).tokens as OAuthTokens | undefined;
	}

	saveTokens(tokens: OAuthTokens): void {
		writeAuthState(this.file, { tokens });
	}

	async redirectToAuthorization(url: URL): Promise<void> {
		console.log(`[mcp] ${this.serverName}: open this URL to authorize:\n  ${url}`);
		openBrowser(String(url));
	}

	saveCodeVerifier(codeVerifier: string): void {
		writeAuthState(this.file, { codeVerifier });
	}

	async codeVerifier(): Promise<string> {
		return (readAuthState(this.file).codeVerifier as string | undefined) ?? "";
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		const drop =
			scope === "all"
				? ["clientInformation", "tokens", "codeVerifier", "discoveryState"]
				: scope === "client"
					? ["clientInformation"]
					: scope === "tokens"
						? ["tokens"]
						: scope === "verifier"
							? ["codeVerifier"]
							: ["discoveryState"];
		const data = readAuthState(this.file);
		const next: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(data)) if (!drop.includes(k)) next[k] = v;
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		writeAuthState(this.file, { discoveryState: state });
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return readAuthState(this.file).discoveryState as OAuthDiscoveryState | undefined;
	}

	/**
	 * Wait for the browser callback to deliver an authorization code.
	 * Rejects on timeout, state mismatch, a server-side authorization
	 * error, or close().
	 */
	waitForCode(timeoutMs: number = AUTH_WAIT_TIMEOUT_MS): Promise<string> {
		if (this._bufferedCode !== undefined) {
			const c = this._bufferedCode;
			this._bufferedCode = undefined;
			return Promise.resolve(c);
		}
		if (!this._codePromise) {
			this._codePromise = new Promise<string>((resolve, reject) => {
				this._codeResolve = resolve;
				this._codeReject = reject;
			});
		}
		const timeout = new Promise<string>((_, reject) => {
			const t = setTimeout(
				() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for browser authorization`)),
				timeoutMs,
			);
			t.unref();
		});
		return Promise.race([this._codePromise, timeout]);
	}

	/** Stop the callback server; rejects any in-flight code wait. */
	close(): void {
		this._redirectServer.close();
		if (this._codePromise) {
			this._codeReject?.(new Error("OAuth flow cancelled"));
			this._codePromise = null;
			this._codeResolve = null;
			this._codeReject = null;
		}
	}

	private handleRedirect(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method !== "GET" || url.pathname !== "/callback") {
			res.writeHead(404, { "content-type": "text/plain" });
			res.end("not found");
			return;
		}
		const reply = (status: number, title: string, body: string) => {
			res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
			res.end(`<html><body><h1>${title}</h1><p>${body}</p></body></html>`);
		};
		const code = url.searchParams.get("code");
		const err = url.searchParams.get("error");
		const state = url.searchParams.get("state");
		if (state !== null && state !== this._state) {
			reply(400, "State mismatch", "Please retry the authorization.");
			this.settleCode(new Error("OAuth state mismatch (possible CSRF)"));
			return;
		}
		if (err) {
			reply(400, "Authorization failed", err);
			this.settleCode(new Error(`authorization server returned an error: ${err}`));
			return;
		}
		if (!code) {
			reply(400, "Missing code", "The redirect contained no authorization code.");
			this.settleCode(new Error("no authorization code in redirect"));
			return;
		}
		reply(200, "Authenticated", "You can close this tab and return to pi.");
		this.settleCode(null, code);
	}

	private settleCode(err: Error | null, code?: string): void {
		if (err) {
			this._codeReject?.(err);
		} else if (this._codeResolve) {
			this._codeResolve(code as string);
		} else {
			// The callback beat waitForCode() (fast redirect); buffer the code
			// so a later waitForCode() picks it up instead of dropping it.
			this._bufferedCode = code;
		}
		this._codePromise = null;
		this._codeResolve = null;
		this._codeReject = null;
	}
}
// --- Extension entry point ---------------------------------------------------

export default async function (pi: ExtensionAPI) {
	const configPath = resolveConfigPath();
	const servers = new Map<string, McpServerState>();
	const registeredTools = new Map<string, Set<string>>(); // server -> pi tool names
	const WIDGET_KEY = "mcp";

	// Lazily-imported SDK handles (set once by connectServer).
	let sdkClient: typeof import("@modelcontextprotocol/sdk/client/index.js").Client | null = null;
	let httpTransportCtor: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport | null = null;
	let stdioTransportCtor: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport | null = null;

	async function loadSdk() {
		if (sdkClient && httpTransportCtor && stdioTransportCtor) return;
		const [clientMod, httpMod, stdioMod] = await Promise.all([
			import("@modelcontextprotocol/sdk/client/index.js"),
			import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
			import("@modelcontextprotocol/sdk/client/stdio.js"),
		]);
		sdkClient = clientMod.Client;
		httpTransportCtor = httpMod.StreamableHTTPClientTransport;
		stdioTransportCtor = stdioMod.StdioClientTransport;
	}

	/** Update the editor widget with per-server status lines. */
	function updateWidget(ctx?: Parameters<Parameters<typeof pi.on>[1]>[1]) {
		if (!ctx || !ctx.hasUI) return;
		if (servers.size === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const lines: string[] = [];
		const t = ctx.ui.theme;
		for (const s of servers.values()) {
			const icon =
				s.status === "connected" ? t.fg("success", "●") : s.status === "connecting" ? t.fg("warning", "◌") : t.fg("error", "●");
			const detail =
				s.status === "connected"
					? t.fg("dim", ` ${s.toolNames.length} tools`)
					: s.status === "connecting"
						? t.fg("warning", s.authPending ? " awaiting browser auth…" : " connecting…")
						: t.fg("error", ` failed: ${s.error ?? "unknown"}`);
			lines.push(`${icon} mcp: ${t.fg("text", s.name)}${detail}`);
		}
		ctx.ui.setWidget(WIDGET_KEY, (_tui, _theme) => fittedWidget(() => lines));
	}

	/** Register pi tools for one connected server. Safe to re-register after refresh. */
	function registerServerTools(state: McpServerState) {
		const names = registeredTools.get(state.name) ?? new Set<string>();
		for (const mcpTool of state.toolNames) {
			const piName = buildToolName(state.name, mcpTool);
			const desc = state.toolDescriptions.get(mcpTool) ?? "";
			pi.registerTool({
				name: piName,
				label: `${state.name}:${mcpTool}`,
				description: desc || `MCP tool ${mcpTool} from server ${state.name}`,
				promptSnippet: desc ? desc.slice(0, 120) : `MCP tool ${mcpTool} (server ${state.name})`,
				parameters: toParametersSchema(state.toolSchemas.get(mcpTool), desc || "MCP tool input"),
				async execute(_toolCallId, params, signal) {
					const stateNow = servers.get(state.name);
					if (!stateNow || stateNow.status !== "connected" || !stateNow.client) {
						throw new Error(
							`MCP server "${state.name}" is not connected (${stateNow?.error ?? "no connection"}). Use /mcp refresh ${state.name} to retry.`,
						);
					}
					const client = stateNow.client as {
						callTool: (
							params: { name: string; arguments?: unknown },
							_schema?: unknown,
							options?: { signal?: AbortSignal; timeout?: number },
						) => Promise<{ content?: unknown; isError?: boolean }>;
					};
					const result = await client.callTool(
						{ name: mcpTool, arguments: (params as Record<string, unknown>) ?? {} },
						undefined,
						{ signal, timeout: DEFAULT_CALL_TIMEOUT_MS },
					);
					const rawContent = Array.isArray(result.content) ? result.content : [];
					const content = mapMcpContent(rawContent);
					if (result.isError) {
						const errText = content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n") || "MCP tool returned an error";
						throw new Error(errText);
					}
					if (content.length === 0) {
						return { content: [{ type: "text" as const, text: "(MCP tool returned no content)" }], details: { server: state.name, tool: mcpTool } };
					}
					return { content, details: { server: state.name, tool: mcpTool } };
				},
			});
				// De-duplicate defensively (re-registration after refresh).
				names.add(piName);
		}
		registeredTools.set(state.name, names);
	}

	/** Connect one server. Sets state.status; never throws. */
	async function connectServer(state: McpServerState, ctx?: Parameters<Parameters<typeof pi.on>[1]>[1]) {
		try {
			state.status = "connecting";
			updateWidget(ctx);
			await loadSdk();
			if (state.config.url) {
				state.transportKind = "http";
				// Capture the narrowed URL so the transport factory closure sees a string.
				const serverUrl = state.config.url;
				// Close a stale redirect server left by a previous (re)connect.
				try {
					state.authProvider?.close();
				} catch {
					// ignore
				}
				let provider: McpOAuthProvider | undefined;
				if (state.config.auth === "oauth") {
					provider = new McpOAuthProvider(state.name, state.config.authPort);
					await provider.ready();
					state.authProvider = provider;
				}
				const makeTransport = () =>
					new httpTransportCtor!(new URL(serverUrl), {
						requestInit: { headers: state.config.headers ?? {} },
						...(provider ? { authProvider: provider } : {}),
					});
				let transport = makeTransport();
				const client = new sdkClient!({ name: "pi-mcp-extension", version: "1.0.0" });
				try {
					await client.connect(transport);
				} catch (err) {
					if (!provider) throw err;
					const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");
					if (!(err instanceof UnauthorizedError)) throw err;
					// The SDK started the browser flow (discovery, client
					// registration, PKCE, redirect); now we wait for the user.
					state.authPending = true;
					updateWidget(ctx);
					try {
						const code = await provider.waitForCode();
						await transport.finishAuth(code);
						// A transport cannot be started twice — the SDK sample
						// creates a fresh one after the auth flow.
						transport = makeTransport();
						await client.connect(transport);
					} finally {
						state.authPending = false;
					}
				}
				const tools = await client.listTools();
				state.client = client;
				state.toolNames = tools.tools.map((t: { name: string }) => t.name);
				state.toolDescriptions = new Map(tools.tools.map((t: { name: string; description?: string }) => [t.name, t.description ?? ""]));
				state.toolSchemas = new Map(tools.tools.map((t: { name: string; inputSchema?: unknown }) => [t.name, t.inputSchema]));
				state.status = "connected";
				state.connectedAt = Date.now();
				registerServerTools(state);
			} else if (state.config.command) {
				state.transportKind = "stdio";
				const transport = new stdioTransportCtor!({
					command: state.config.command,
					args: state.config.args ?? [],
					env: { ...process.env, ...(state.config.env ?? {}) } as Record<string, string>,
				});
				const client = new sdkClient!({ name: "pi-mcp-extension", version: "1.0.0" });
				await client.connect(transport);
				const tools = await client.listTools();
				state.client = client;
				state.toolNames = tools.tools.map((t: { name: string }) => t.name);
				state.toolDescriptions = new Map(tools.tools.map((t: { name: string; description?: string }) => [t.name, t.description ?? ""]));
				state.toolSchemas = new Map(tools.tools.map((t: { name: string; inputSchema?: unknown }) => [t.name, t.inputSchema]));
				state.status = "connected";
				state.connectedAt = Date.now();
				registerServerTools(state);
			} else {
				throw new Error("no \"url\" or \"command\" in server config");
			}
		} catch (err) {
			state.status = "failed";
			state.error = err instanceof Error ? err.message : String(err);
			// A 401 without an OAuth config is a config gap, not a network fault.
			if (state.transportKind === "http" && !state.config.auth && /401|unauthor/i.test(state.error)) {
				state.error += ` — the server requires authentication. Add "auth": "oauth" to the "${state.name}" entry in mcp.json, then run /mcp refresh ${state.name}.`;
			}
			try {
				await (state.client as { close?: () => Promise<void> } | undefined)?.close?.();
			} catch {
				// ignore
			}
			state.client = undefined;
		} finally {
			if (ctx) updateWidget(ctx);
		}
	}

	/** Close and reconnect one (or all) servers. */
	async function refreshServer(name: string | undefined, ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) {
		const targets = (name ? [servers.get(name)] : [...servers.values()]).filter((s): s is McpServerState => s !== undefined);
		for (const s of targets) {
			try {
				await (s.client as { close?: () => Promise<void> } | undefined)?.close?.();
			} catch {
				// ignore
			}
			s.client = undefined;
			try {
				s.authProvider?.close();
			} catch {
				// ignore
			}
			s.authProvider = undefined;
			s.authPending = false;
			// Re-registration is idempotent for pi (tools refresh in place).
			await connectServer(s, ctx);
		}
	}

	// --- Startup: connect all servers (parallel, bounded) ---

	if (configPath) {
		let configServers: Map<string, McpServerConfig>;
		try {
			configServers = loadConfig(configPath);
		} catch (err) {
			pi.registerCommand("mcp", {
				description: "Show MCP status (config currently fails to parse)",
				handler: async (_args, ctx) => {
					ctx.ui.notify(`MCP config error: ${err instanceof Error ? err.message : String(err)}`, "error");
				},
			});
			return;
		}
		for (const [name, cfg] of configServers) {
			servers.set(name, {
				name,
				config: cfg,
				transportKind: cfg.url ? "http" : "stdio",
				toolNames: [],
				toolDescriptions: new Map(),
				toolSchemas: new Map(),
				status: "connecting",
			});
		}
		if (servers.size > 0) {
			// Connect in parallel with per-server timeouts so a dead server
			// can't hang startup.
			await Promise.all(
				[...servers.values()].map((s) =>
					Promise.race([
						connectServer(s),
						new Promise((resolve) =>
								setTimeout(
									resolve,
									(s.config.timeout ?? DEFAULT_CONNECT_TIMEOUT_MS) + (s.config.auth === "oauth" ? AUTH_WAIT_TIMEOUT_MS : 0) + 1000,
								),
						),
					]),
				),
			);
			const ok = [...servers.values()].filter((s) => s.status === "connected");
			const bad = [...servers.values()].filter((s) => s.status === "failed");
			const totalTools = ok.reduce((n, s) => n + s.toolNames.length, 0);
			if (ok.length > 0) {
				console.log(`[mcp] ${ok.length}/${servers.size} server(s) connected, ${totalTools} tool(s) registered`);
			}
			for (const s of bad) {
				console.warn(`[mcp] server "${s.name}" failed: ${s.error}`);
			}
		}
	}

	// --- UI: widget on session events ---

	pi.on("session_start", async (_event, ctx) => {
		if (servers.size > 0) {
			ctx.ui.notify(
				`MCP: ${[...servers.values()].filter((s) => s.status === "connected").length}/${servers.size} server(s) connected, ${[...servers.values()].reduce((n, s) => n + s.toolNames.length, 0)} tool(s) registered`,
				"info",
			);
			updateWidget(ctx);
		}
	});

	// --- Commands ---

	pi.registerCommand("mcp", {
		description: "MCP server status / list tools / refresh connections (usage: /mcp [status|list [server]|refresh [server]])",
		handler: async (args, ctx) => {
			const [cmd, serverArg] = (args ?? "").split(/\s+/).filter(Boolean);
			if (servers.size === 0) {
				ctx.ui.notify(`No MCP config found${configPath ? ` at ${configPath}` : " (expected ~/.pi/agent/mcp.json)"}`, "warning");
				return;
			}
			if (!cmd || cmd === "status") {
				const lines: string[] = [];
				for (const s of servers.values()) {
					const mark = s.status === "connected" ? "●" : s.status === "connecting" ? "◌" : "●";
					const suffix =
						s.status === "connected"
							? `${s.toolNames.length} tools (${s.transportKind})`
							: s.status === "connecting"
								? "connecting…"
								: `FAILED: ${s.error ?? "unknown"}`;
					lines.push(`${mark} ${s.name}: ${suffix}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} else if (cmd === "list") {
				const states = serverArg ? [...servers.values()].filter((s) => s.name === serverArg) : [...servers.values()];
				if (states.length === 0) {
					ctx.ui.notify(`No MCP server named "${serverArg}"`, "warning");
					return;
				}
				const lines: string[] = [];
				for (const s of states) {
					lines.push(`${s.name}:`);
					if (s.status !== "connected") {
						lines.push(`  (${s.status}${s.error ? `: ${s.error}` : ""})`);
						continue;
					}
					for (const t of s.toolNames) {
						const d = (s.toolDescriptions.get(t) ?? "").slice(0, 100);
						lines.push(`  ${buildToolName(s.name, t)}${d ? `  — ${d}` : ""}`);
					}
				}
				ctx.ui.notify(lines.join("\n"), "info");
			} else if (cmd === "refresh") {
				if (serverArg && !servers.has(serverArg)) {
					ctx.ui.notify(`No MCP server named "${serverArg}"`, "warning");
					return;
				}
				ctx.ui.setStatus(WIDGET_KEY, "refreshing…");
				await refreshServer(serverArg, ctx);
				ctx.ui.setStatus(WIDGET_KEY, undefined);
				ctx.ui.notify(
					serverArg ? `Refreshed ${serverArg}: ${servers.get(serverArg)!.status}` : "Refreshed all MCP servers",
					"info",
				);
			} else {
				ctx.ui.notify("Usage: /mcp [status|list [server]|refresh [server]]", "info");
			}
		},
	});

	// --- Teardown: always close clients (stdio servers spawn child processes) ---

	pi.on("session_shutdown", async () => {
		for (const s of servers.values()) {
			try {
				await (s.client as { close?: () => Promise<void> } | undefined)?.close?.();
			} catch {
				// ignore — best-effort cleanup
			}
			s.client = undefined;
			try {
				s.authProvider?.close();
			} catch {
				// ignore
			}
			s.authProvider = undefined;
		}
	});
}
