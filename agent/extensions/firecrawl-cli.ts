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
 * because pi has to start without the research stack. The shortfall is reported
 * here, once, naming the variable and the file, because the failure it replaces
 * (a 402/401 from the Firecrawl
 * cloud) does not mention either.
 *
 * No API key is set or needed. Any non-default `apiUrl` makes the CLI skip key
 * validation entirely (`validateConfig` returns early when `isCustomApiUrl()`),
 * so a self-hosted endpoint authenticates however the endpoint itself wants:
 * `user:pass@host` userinfo in the URL is turned into an `Authorization: Basic`
 * header, and a plain LAN endpoint needs nothing at all. That is why the secret
 * never has to leave `agent/.env` as a separate key.
 *
 * The file now owns a second thing: the keyless `--sources` gate. `firecrawl
 * search` defaults to the sources `web,alexandria`, and `alexandria` is a
 * cloud-only index a self-hosted endpoint does not serve, so on this setup a bare
 * search fails with an error that blames a missing API key rather than the missing
 * flag. This file registers the `tool_call` handler that refuses such a command
 * before it reaches the shell; the decision itself is the pure
 * `guardFirecrawlSearch` in `lib/firecrawl-search.ts`, tested there, because what
 * it has to get right is parsing shape and that needs a table of commands rather
 * than a pi harness.
 */
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { guardFirecrawlSearch } from "./lib/firecrawl-search.js";
import { loadDotenv } from "./lib/dotenv.js";

/** The one variable `firecrawl-cli` reads for its endpoint. */
const URL_VAR = "FIRECRAWL_API_URL";

/** The variable whose absence makes the CLI's default search sources unsatisfiable. */
const KEY_VAR = "FIRECRAWL_API_KEY";

/** Set once by the guard's fail-open path, so it complains exactly once. */
let warned = false;

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

export default function (pi: ExtensionAPI): void {
	// `force` because loadDotenv caches, and this
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

	// Registered only below the URL check above, which is what makes a machine with
	// no `FIRECRAWL_API_URL` register nothing at all — the no-op is structural here,
	// not a condition inside the handler.
	//
	// The guard never rewrites: it does not assign to `event.input`, because a
	// rewrite that misfires runs a command nobody wrote (pi re-validates nothing
	// after a handler mutates the input), while a refusal costs one round trip and
	// tells the agent what to add.
	pi.on("tool_call", async (event) => {
		// The two tools that hand a command string to a shell. `PowerShellToolInput`
		// is an alias of `BashToolInput` in pi, so one classifier covers both, and
		// without this the guard would quietly never fire on Windows.
		if (!isToolCallEventType("bash", event) && !isToolCallEventType("powershell", event)) return;

		// A `bash`/`powershell` call always carries a string `command` — pi validates
		// tool arguments before this handler runs — so reaching for anything else is
		// a shape change, not a value to judge. Skip it quietly rather than let the
		// property read throw and spend the one warning below on a non-event.
		const command = event.input?.command;
		if (typeof command !== "string") return;

		// pi blocks the tool when a handler throws, so a bug in a convenience gate
		// must not take down every `bash` call. This is why THIS handler fails open:
		// pi's "gate handlers fail closed" rule is about safety gates, and the
		// fallback for a quiet gate is the CLI's own loud error — a worse message,
		// never a wrong action.
		try {
			// Read at call time, so adding a key to `agent/.env` or to the real
			// environment disables the guard without restarting pi.
			const verdict = guardFirecrawlSearch(command, {
				// Truthiness, not `.trim()`: the CLI tests `if (process.env.FIRECRAWL_API_KEY)`
				// (`utils/config.js`), so a whitespace-only value is a key to it and
				// pretending otherwise would refuse a command that was going to run.
				hasApiKey: (process.env[KEY_VAR] ?? "").length > 0,
				hasApiUrl: (process.env[URL_VAR] ?? "").length > 0,
			});
			if (verdict.kind === "block") return { block: true, reason: verdict.reason };
		} catch (error) {
			// Fail open: see the note above. Complained about once per process, so a
			// guard that faults on every call is not mistaken for one that never fires —
			// but the wording says "faulted", not "disabled": the next call still tries.
			if (!warned) {
				warned = true;
				console.error(`[firecrawl-cli] the --sources guard faulted, this call allowed: ${String(error)}`);
			}
		}
		return undefined;
	});
}
