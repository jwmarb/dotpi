/**
 * Register the LiteLLM MCP gateway with pi's built-in MCP extension.
 *
 * This is the whole remnant of the old 925-line `extensions/mcp/` extension:
 * pi 0.99+ ships MCP support (transport, OAuth, tool registration, `/mcp`), so
 * the only thing left to own is the *one* thing the builtin deliberately does
 * not do — read the gateway URL out of `agent/.env`.
 *
 * Why this file has to exist at all: the builtin config loader validates
 * `mcp.json` `url` with `URL.canParse()` *before* any expansion, so a
 * `"url": "${LITELLM_MCP_URL}"` placeholder is rejected as "url must be an
 * http or https URL". Headers *are* expanded (`${VAR}` and `!cmd`), so only the
 * URL is a problem. Inlining it instead would put a gateway URL in git, which
 * `.gitignore` calls out as sensitive alongside the keys.
 *
 * `pi.registerMcpServer()` hands the config to whichever extension connects MCP
 * servers (here: `builtin:mcp`), which then treats it exactly like an
 * `mcp.json` entry — same `mcp__<server>__<tool>` naming, same exposure rules,
 * same `/mcp` manager. A server of the same name in `mcp.json` wins over this
 * registration, so `mcp.json` stays the override point.
 *
 * The key stays a `${LITELLM_MCP_KEY}` placeholder in the header: the builtin
 * expands it at connect time, so the live secret is never read into this
 * process and never lands in a session transcript.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadDotenv } from "./lib/dotenv.js";

/** Server name. `-` becomes `_` in tool names: `mcp__litellm_gateway__<tool>`. */
const SERVER_NAME = "litellm-gateway";

export default async function (pi: ExtensionAPI) {
	// The builtin expands ${VAR} in headers from process.env, not from
	// agent/.env, so the file has to be loaded before it connects. `force` is
	// deliberate: loadDotenv caches, and this must win over a stale cache
	// populated earlier in startup. It only fills vars that are unset, so a
	// real environment variable still takes precedence.
	loadDotenv({ force: true });

	const url = process.env.LITELLM_MCP_URL;
	if (!url) {
		// Not fatal: pi must still start without the gateway, the same way the
		// builtin reports its own config errors without aborting startup.
		console.error(
			`[mcp-gateway] LITELLM_MCP_URL is not set, so "${SERVER_NAME}" was not registered.\n` +
				`  Add it to agent/.env (template: agent/.env.example).`,
		);
		return;
	}

	pi.registerMcpServer(SERVER_NAME, {
		url,
		headers: { "x-litellm-api-key": "Bearer ${LITELLM_MCP_KEY}" },
		description:
			"LiteLLM gateway: context7 library docs and the GitHub API. (Web search/scrape moved to the `firecrawl` CLI — see extensions/firecrawl-cli.ts.)",
		// Default exposure. Tools stay out of the model's declarations and are
		// reached from codemode scripts via searchTools() — which matters here
		// because this one server offers 59 tools.
		exposure: "codemode",
		// Seconds, per request (the old extension's `timeout` was connect-time ms).
		timeout: 60,
	});
}
