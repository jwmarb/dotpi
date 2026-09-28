// OAuth E2E test: McpOAuthProvider (extracted + transpiled from index.ts)
// against a fake authorization server and a fake OAuth-protected MCP server,
// using the real MCP SDK transport/client.
import fs, { mkdirSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import ts from "typescript";

const TMP = path.join(os.tmpdir(), `mcp-oauth-test-${process.pid}`);
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
process.env.PI_CODING_AGENT_DIR = TMP; // agentDir() reads this at call time

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
	if (cond) { pass++; console.log(`  ok  ${name}`); }
	else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

// --- Fake authorization server -----------------------------------------------
const authRequests = { register: 0, authorize: 0, token: 0 };
const authServer = http.createServer((req, res) => {
	const u = new URL(req.url, "http://127.0.0.1");
	const json = (status, obj) => {
		res.writeHead(status, { "content-type": "application/json" });
		res.end(JSON.stringify(obj));
	};
	if (u.pathname === "/.well-known/oauth-authorization-server") {
		return json(200, {
			issuer: `http://127.0.0.1:${AUTH_PORT}`,
			authorization_endpoint: `http://127.0.0.1:${AUTH_PORT}/authorize`,
			token_endpoint: `http://127.0.0.1:${AUTH_PORT}/token`,
			registration_endpoint: `http://127.0.0.1:${AUTH_PORT}/register`,
			code_challenge_methods_supported: ["S256"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			response_types_supported: ["code"],
			token_endpoint_auth_methods_supported: ["none"],
		});
	}
	if (u.pathname === "/register") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			authRequests.register++;
			const meta = JSON.parse(body);
			check("DCR registers our redirect_uri", Array.isArray(meta.redirect_uris) && meta.redirect_uris[0].startsWith("http://127.0.0.1:"));
			// Real auth servers echo the metadata back in the full client info.
			return json(200, { client_id: "fake-client-id", ...meta });
		});
		return;
	}
	if (u.pathname === "/authorize") {
		authRequests.authorize++;
		const redirectUri = u.searchParams.get("redirect_uri");
		const state = u.searchParams.get("state");
		check("authorize URL carries PKCE challenge", u.searchParams.get("code_challenge") !== null);
		// Simulate the user clicking "Allow": bounce straight back.
		res.writeHead(302, { location: `${redirectUri}?code=FAKECODE123&state=${encodeURIComponent(state)}` });
		res.end();
		return;
	}
	if (u.pathname === "/token") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			authRequests.token++;
			const p = new URLSearchParams(body);
			if (p.get("grant_type") === "authorization_code" && p.get("code") === "FAKECODE123") {
				check("token exchange sends code_verifier", p.get("code_verifier") !== null);
				check("token exchange sends client_id", p.get("client_id") === "fake-client-id");
				return json(200, { access_token: "tok-abc", token_type: "Bearer", expires_in: 3600 });
			}
			return json(400, { error: "unexpected token request", body: Object.fromEntries(p) });
		});
		return;
	}
	json(404, { error: "not found" });
});

// --- Fake OAuth-protected MCP server ------------------------------------------
let lastBearer = null;
const mcpServer = http.createServer((req, res) => {
	const u = new URL(req.url, "http://127.0.0.1");
	const json = (status, obj, headers = {}) => {
		res.writeHead(status, { "content-type": "application/json", ...headers });
		res.end(JSON.stringify(obj));
	};
	if (u.pathname === "/.well-known/oauth-protected-resource") {
		return json(200, {
			resource: `http://127.0.0.1:${MCP_PORT}/mcp`,
			authorization_servers: [`http://127.0.0.1:${AUTH_PORT}`],
			scopes_supported: ["trading"],
		});
	}
	if (u.pathname !== "/mcp") return json(404, { error: "not found" });
	const bearer = req.headers["authorization"]?.replace("Bearer ", "");
	if (!bearer) {
		return json(401, { error: "unauthorized" }, {
			"www-authenticate": `Bearer resource_metadata="http://127.0.0.1:${MCP_PORT}/.well-known/oauth-protected-resource"`,
		});
	}
	lastBearer = bearer;
	if (req.method === "GET") return json(405, { error: "method not allowed" });
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		if (!body) return res.writeHead(202).end();
		const msg = JSON.parse(body);
		if (msg.method === "initialize") {
			json(200, {
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					protocolVersion: msg.params.protocolVersion,
					capabilities: {},
					serverInfo: { name: "fake-mcp", version: "1.0.0" },
				},
			});
		} else if (msg.method === "tools/list") {
			json(200, {
				jsonrpc: "2.0",
				id: msg.id,
				result: {
					tools: [
						{
							name: "fake_tool",
							description: "a fake tool",
							inputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
						},
					],
				},
			});
		} else {
			res.writeHead(202).end();
		}
	});
});

const ports = await new Promise((resolve) => {
	authServer.listen(0, "127.0.0.1", () => {
		mcpServer.listen(0, "127.0.0.1", () => {
			resolve([authServer.address().port, mcpServer.address().port]);
		});
	});
});
const [AUTH_PORT, MCP_PORT] = ports;

// --- Extract + transpile the OAuth section from index.ts -----------------------
const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const start = src.indexOf("// --- OAuth");
const end = src.indexOf("// --- Extension entry point");
if (start < 0 || end < 0) throw new Error("OAuth section not found in index.ts");
const js = ts.transpileModule(src.slice(start, end), {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;

const layoutSrc = readFileSync(new URL("../lib/layout.ts", import.meta.url), "utf8");
const layoutJs = ts.transpileModule(layoutSrc, {
	compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const agentDir = new Function(
	"os",
	"path",
	layoutJs.replace(/^import[^;]*;\s*$/gm, "").replace(/export /g, "") + "\nreturn agentDir;",
)(os, path);
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");

const nodeFs = fs;
const nodePath = path;
const nodeHttp = http;
const crypto = await import("node:crypto");
const cp = await import("node:child_process");

const factory = new Function(
	"fs", "path", "http", "randomBytes", "spawn", "agentDir",
	`${js}\nreturn McpOAuthProvider;`,
);
const McpOAuthProvider = factory(
	nodeFs,
	nodePath,
	nodeHttp,
	crypto.randomBytes,
	cp.spawn,
	agentDir,
);

// --- The flow ------------------------------------------------------------------
const provider = new McpOAuthProvider("robinhood");
await provider.ready();
check("redirect server bound on 127.0.0.1", /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(provider.redirectUrl));

const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
	authProvider: provider,
});
const client = new Client({ name: "pi-test", version: "1.0.0" });

let firstErr = null;
try {
	await client.connect(transport);
} catch (e) {
	firstErr = e;
}
check("first connect throws UnauthorizedError", firstErr instanceof UnauthorizedError, firstErr ? `${firstErr.constructor.name}: ${firstErr.message}` : "no error");
check("server saw 401 (no bearer yet)", lastBearer === null);

// Simulate the browser redirect (the real user's browser does this).
const cb = await fetch(`${provider.redirectUrl}?code=FAKECODE123&state=${provider.state()}`);
check("callback responds 200", cb.status === 200);

const code = await provider.waitForCode(10_000);
check("waitForCode resolves with the code", code === "FAKECODE123");

await transport.finishAuth(code);
const transportFresh = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
	authProvider: provider,
});
await client.connect(transportFresh);
check("reconnect authenticated with issued token", lastBearer === "tok-abc");

const { tools } = await client.listTools();
check("tools/list works after auth", tools.length === 1 && tools[0].name === "fake_tool");

// --- Persistence ----------------------------------------------------------------
const stateFile = path.join(TMP, "mcp-auth", "robinhood.json");
check("state file written", readFileSync(stateFile, "utf8").length > 0);
const persisted = JSON.parse(readFileSync(stateFile, "utf8"));
check("client info persisted", persisted.clientInformation?.client_id === "fake-client-id");
check("tokens persisted", persisted.tokens?.access_token === "tok-abc");

// --- Second connection reuses persisted tokens (no new browser flow) ------------
authRequests.authorize = 0;
const transport2 = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
	authProvider: provider,
});
const client2 = new Client({ name: "pi-test-2", version: "1.0.0" });
await client2.connect(transport2);
const { tools: tools2 } = await client2.listTools();
check("reconnect from persisted tokens (no redirect)", tools2[0].name === "fake_tool" && authRequests.authorize === 0);

// --- State mismatch is rejected --------------------------------------------------
const bad = await fetch(`${provider.redirectUrl}?code=OTHER&state=wrong-state`);
check("state mismatch rejected", bad.status === 400);

provider.close();
client.close().catch(() => {});
client2.close().catch(() => {});
authServer.close();
mcpServer.close();

console.log(fail === 0 ? `\n${pass}/${pass + fail} passed` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
