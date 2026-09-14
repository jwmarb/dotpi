/**
 * Load credentials from `agent/.env` into `process.env`.
 *
 * pi has no dotenv support of its own — it is not a dependency and nothing in
 * the bundle reads a `.env` file — so this module exists to keep live
 * credentials out of source. See docs/adr/0042.
 *
 * This is deliberately the ONE loader shared by every consumer rather than a
 * copy per extension: two parsers of the same file drift, and drift is exactly
 * how the fork bomb of docs/adr/0037 bypassed an interlock that already
 * existed. Same reasoning as subagent/rundir.ts in docs/adr/0039.
 *
 * The parser is deliberately minimal — `KEY=VALUE`, `#` comments, optional
 * surrounding quotes. Multiline values, escape sequences and interpolation
 * inside the .env are all omitted on purpose: each one is another way for a
 * credential to end up subtly different from what is visible in the file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Name of the env file, relative to the agent directory. */
export const ENV_FILENAME = ".env";

/**
 * Parse `.env` text into key/value pairs.
 *
 * Recognises `KEY=VALUE` one per line, ignores blank lines and `#` comments,
 * tolerates a leading `export `, and strips ONE layer of matching single or
 * double quotes. A line with no `=`, or with an empty key, is skipped rather
 * than throwing: a malformed line must not cost you every other credential in
 * the file.
 *
 * Values are NOT interpolated — a `$VAR` inside a value stays literal, because
 * an API key is an opaque string and expanding it could silently corrupt one.
 *
 * @param text Raw file contents.
 * @returns Parsed pairs in file order; later duplicates win.
 */
export function parseEnv(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		// `export FOO=bar` is common in files that double as shell snippets.
		const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;

		const eq = body.indexOf("=");
		if (eq <= 0) continue; // no '=' at all, or an empty key

		const key = body.slice(0, eq).trim();
		if (!key) continue;

		let value = body.slice(eq + 1).trim();

		// Strip one layer of matching quotes. Unquoted values may not contain a
		// trailing comment, because '#' is legal inside a secret and guessing
		// wrong would truncate a key.
		const quote = value[0];
		if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
			value = value.slice(1, -1);
		}

		out.set(key, value);
	}
	return out;
}

/**
 * Resolve the agent directory without importing pi.
 *
 * The MCP extension resolves its config through pi's `getAgentDir()`, but this
 * module is imported by extension top-level code and must not depend on pi's
 * export surface, so it mirrors the same resolution order by hand.
 *
 * The variable name is `PI_CODING_AGENT_DIR`, verified empirically rather than
 * assumed: pi builds it as `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`, and an
 * earlier guess of `PI_AGENT_DIR` was silently ignored — setting it changed
 * nothing, so the override would have looked supported while doing nothing.
 * pi also expands a leading `~`, which is mirrored here.
 *
 * Deliberately NOT the current working directory: this repo is a config
 * directory that pi is launched from OTHER projects, so cwd is not the repo
 * (docs/adr/0042).
 */
function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override) {
		const expanded = override.startsWith("~") ? path.join(os.homedir(), override.slice(1)) : override;
		return path.resolve(expanded);
	}
	return path.join(os.homedir(), ".pi", "agent");
}

/** Absolute path of the env file this module loads. */
export function envFilePath(): string {
	return path.join(agentDir(), ENV_FILENAME);
}

/** Outcome of a load, for callers that want to report what happened. */
export interface LoadResult {
	/** Absolute path consulted. */
	file: string;
	/** Whether the file existed and was readable. */
	found: boolean;
	/** Keys copied into process.env (absent ones only). */
	applied: string[];
	/** Keys present in the file but already set in the real environment. */
	skipped: string[];
}

let cached: LoadResult | null = null;

/**
 * Load `agent/.env` into `process.env`, filling only variables that are not
 * already set.
 *
 * **The real environment wins.** This keeps `LITELLM_API_KEY=other pi` working
 * as a one-off override, and it is load-bearing for spawned children: oracle
 * reviews and rework workers inherit `...process.env` from the orchestrator
 * (docs/adr/0039), so a child must never have an inherited value replaced by a
 * file it did not choose.
 *
 * Never throws. A missing or unreadable file is a normal outcome reported in
 * the result — the loud failure belongs at the point a specific credential is
 * needed, where the variable can be named, not here.
 *
 * Idempotent: the first call does the work and later calls return the same
 * result, so several extensions can each call it at load without re-reading.
 *
 * @param opts.force Re-read even if already loaded (tests).
 */
export function loadDotenv(opts: { force?: boolean } = {}): LoadResult {
	if (cached && !opts.force) return cached;

	const file = envFilePath();
	const result: LoadResult = { file, found: false, applied: [], skipped: [] };

	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
		result.found = true;
	} catch {
		// Absent or unreadable: nothing to apply. Callers report the shortfall.
		cached = result;
		return result;
	}

	for (const [key, value] of parseEnv(text)) {
		if (process.env[key] !== undefined) {
			result.skipped.push(key);
			continue;
		}
		process.env[key] = value;
		result.applied.push(key);
	}

	cached = result;
	return result;
}

/**
 * Read a required credential, or throw an error that says exactly how to fix it.
 *
 * Deliberately has no default and no fallback to a literal: a fallback would
 * mean the secret stays in source, which is the entire thing docs/adr/0042
 * removes. The message names both the variable and the file because the failure
 * it replaces — a bare 401 from the gateway — looks like a network fault.
 *
 * @param name Variable to read, e.g. `LITELLM_API_KEY`.
 * @param purpose Short phrase naming what needs it, for the error message.
 * @throws When the variable is unset or empty.
 */
export function requireEnv(name: string, purpose: string): string {
	loadDotenv();
	const value = process.env[name];
	if (value !== undefined && value !== "") return value;

	const file = envFilePath();
	const exists = fs.existsSync(file);
	const hint = exists
		? `Add a line to ${file}:\n    ${name}=<your key>`
		: `Create ${file} with:\n    ${name}=<your key>\n  (copy ${path.join(path.dirname(file), ".env.example")} as a starting point)`;

	throw new Error(`${name} is not set, so ${purpose} cannot be configured.\n  ${hint}`);
}

/** Reset the cached load. Tests only. */
export function resetDotenvForTests(): void {
	cached = null;
}
