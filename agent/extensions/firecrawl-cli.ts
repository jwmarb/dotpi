/**
 * Put `FIRECRAWL_API_URL` into the real process environment so the
 * `firecrawl-cli` binary can see it.
 *
 * Why this exists: the librarian researches with `firecrawl-cli` (`firecrawl
 * scrape|search|map`), which it runs through `bash`. The CLI reads its endpoint
 * from `process.env.FIRECRAWL_API_URL` — it knows nothing about `agent/.env`,
 * which is read by `lib/dotenv.ts` and not by pi itself. A subagent inherits
 * `...process.env` from the orchestrator (docs/adr/0039), so loading the file
 * here is what makes a bare `firecrawl ...` work in every child shell. Without
 * it the CLI silently falls back to `https://api.firecrawl.dev` and fails on a
 * missing API key, which reads like a network fault rather than a config gap.
 *
 * Deliberately NOT `requireEnv`: a missing URL must not take pi's startup down,
 * and the same reasoning as `mcp-gateway.ts` applies — pi has to start without
 * the research stack. The shortfall is reported here, once, naming the variable
 * and the file, because the failure it replaces (a 402/401 from the Firecrawl
 * cloud) does not mention either.
 *
 * No API key is set or needed. Any non-default `apiUrl` makes the CLI skip key
 * validation entirely (`validateConfig` returns early when `isCustomApiUrl()`),
 * so a self-hosted endpoint authenticates however the endpoint itself wants:
 * `user:pass@host` userinfo in the URL is turned into an `Authorization: Basic`
 * header, and a plain LAN endpoint needs nothing at all. That is why the secret
 * never has to leave `agent/.env` as a separate key.
 */
import { loadDotenv } from "./lib/dotenv.js";

/** The one variable `firecrawl-cli` reads for its endpoint. */
const URL_VAR = "FIRECRAWL_API_URL";

/**
 * Noise suppressants, applied only when unset so a real environment still wins.
 *
 * The CLI otherwise hits the npm registry for a version check (cached 20h) and
 * can print a telemetry notice. Both write to a research agent's stdout/stderr,
 * where the agent's whole output is the deliverable — an update banner inside a
 * `<result>` block is indistinguishable from findings.
 */
const QUIET_DEFAULTS: Record<string, string> = {
	FIRECRAWL_NO_UPDATE_CHECK: "1",
	FIRECRAWL_NO_TELEMETRY: "1",
};

export default function () {
	// `force` for the same reason as mcp-gateway.ts: loadDotenv caches, and this
	// must win over a stale cache populated earlier in startup. It only fills
	// vars that are unset, so a real environment variable still takes precedence.
	loadDotenv({ force: true });

	if (!process.env[URL_VAR]) {
		console.error(
			`[firecrawl-cli] ${URL_VAR} is not set, so the librarian's research tools will not work.\n` +
				`  Add it to agent/.env (template: agent/.env.example), e.g.\n` +
				`    ${URL_VAR}=http://firecrawl.lan:3002`,
		);
		return;
	}

	for (const [key, value] of Object.entries(QUIET_DEFAULTS)) {
		process.env[key] ??= value;
	}
}
