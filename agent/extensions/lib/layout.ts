/**
 * Where this repo's files live.
 *
 * Six modules used to answer "where is the agent directory" four different
 * ways, and two of them imported `getAgentDir` from *different packages at
 * different versions*. Nothing was broken by that — both resolutions agreed —
 * but "the agent directory" is one fact, and a fact with four implementations
 * drifts the moment one of them is corrected.
 *
 * So this module is the one place that knows how to *resolve* the agent
 * directory, plus the named paths more than one caller wants. Callers ask for the
 * thing they want (`agentsDir()`, `envFile()`) rather than joining a path onto a
 * directory they resolved themselves.
 *
 * It deliberately does **not** collect every path in the repo. A segment with one
 * owner belongs to that owner: `subagent-herdr/rundir.ts` owns `subagent-runs/`
 * (it spans the parent/child process seam and takes its root as a *parameter* so
 * it is testable against a temp dir), and `ralph-loop/image.ts` owns `docker/`
 * and `verify-images/`. An accessor here for any of those would be a second
 * answer to a question that already has one — which is the drift this module
 * exists to prevent, not an instance of preventing it.
 *
 * ## Why the resolution is hand-rolled rather than pi's `getAgentDir()`
 *
 * `lib/dotenv.ts` is imported by extension *top-level* code, and pi's
 * `getAgentDir()` throws when its environment is unset — so an extension that
 * resolved paths through pi's export surface at import time could take pi's
 * startup down with it. `dotenv.ts` documented that constraint and duplicated
 * the resolution to satisfy it; the constraint belongs here instead, which is
 * what makes this module the owner rather than a fifth copy.
 *
 * The resolution mirrors pi's own, verified against both installed packages
 * (0.70.5 and 0.75.4 agree): `PI_CODING_AGENT_DIR` with `~` expansion, else
 * `~/.pi/agent`.
 *
 * @module lib/layout
 */

import os from "node:os";
import path from "node:path";

/** The env var pi reads to relocate its agent directory. */
export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/**
 * Expand a leading `~` to the user's home directory.
 *
 * Only a bare `~` or a `~/`-prefixed path: `~user` is a shell convention pi does
 * not implement, and treating it as a home-relative path would resolve it to the
 * wrong place rather than failing.
 */
function expandTilde(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/**
 * pi's agent directory — the root of everything this repo configures.
 *
 * Never throws: an unset environment falls back to `~/.pi/agent`, because a
 * module imported by extension top-level code cannot be a startup hazard.
 */
export function agentDir(): string {
	const override = process.env[ENV_AGENT_DIR];
	if (override) return expandTilde(override);
	return path.join(os.homedir(), ".pi", "agent");
}

/** Subagent definitions (`<name>.md`, Markdown + YAML frontmatter). */
export function agentsDir(): string {
	return path.join(agentDir(), "agents");
}

/** The skills library, one directory per skill. */
export function skillsDir(): string {
	return path.join(agentDir(), "skills");
}

// `runsDir()` used to live here and had no production caller: every use resolved
// to `subagent-herdr/rundir.ts`'s same-named function, which takes the agent dir
// as a parameter. Two modules hardcoding "subagent-runs" is the drift this file
// exists to prevent, so the copy without callers is the one that goes.

/** The only file holding live credentials (gitignored). */
export function envFile(): string {
	return path.join(agentDir(), ".env");
}

/** The committed template for {@link envFile}. */
export function envExampleFile(): string {
	return path.join(agentDir(), ".env.example");
}

/** pi's own configuration: default model, provider, installed packages. */
export function settingsFile(): string {
	return path.join(agentDir(), "settings.json");
}

// `mcpConfigFile()` was removed too: nothing but its own test ever called it.
// `agent/mcp.json` is read by pi's built-in MCP extension, not by this repo.

/**
 * The repo root: the working tree that contains the agent directory.
 *
 * Only meaningful when the agent directory is a checkout of this repo (the
 * normal case — `~/.pi` is a clone, `~/.pi/agent` the configured tree). Used to
 * find repo-level things like `.githooks`.
 */
export function repoRoot(): string {
	return path.dirname(agentDir());
}
