/**
 * Shared herdr integration for pi extensions.
 *
 * One place that owns "how this machine's pi talks to herdr" (docs/adr/0016,
 * docs/adr/0019). The subagent and plan extensions import this; neither speaks
 * to the `herdr` CLI directly, so the HERDR_ENV gate, ID parsing, and pane
 * lifecycle rules exist exactly once.
 *
 * This file is NOT the herdr-managed integration. `herdr-agent-state.ts` is
 * stamped "managed by herdr" and is overwritten on reinstall; this module lives
 * beside it deliberately and must never be merged into it.
 *
 * Everything here degrades to a silent no-op outside a herdr TUI pane, so pi
 * behaves identically in a plain terminal, over SSH, in `--mode json`, and in
 * subagent children (which do not inherit a pane identity).
 *
 * DO NOT rename this file to `index.ts`. pi's extension discovery treats
 * `extensions/<dir>/index.ts` as an extension entry point and requires it to
 * default-export a factory function; this is a plain library with only named
 * exports, so being discovered means a hard load failure at startup:
 *
 *   Extension does not export a valid factory function: .../herdr/index.ts
 *
 * Naming it `client.ts` keeps it invisible to discovery (which does not recurse
 * into subdirectories beyond an index/package.json entry) while leaving it
 * importable by the plan and subagent extensions.
 */

import { execFile } from "node:child_process";

/** How long any single herdr CLI call may take before we give up on it. */
const HERDR_TIMEOUT_MS = 5000;

/** Lifecycle states herdr understands for a reported agent. */
export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";

/** Identity herdr injects into every pane it manages. */
export type HerdrContext = {
	workspaceId: string;
	tabId: string;
	paneId: string;
};

/**
 * Resolve this process's herdr identity.
 *
 * @returns The pane context, or null when not running under herdr.
 */
export function herdrContext(): HerdrContext | null {
	if (process.env.HERDR_ENV !== "1") return null;
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	const tabId = process.env.HERDR_TAB_ID;
	const paneId = process.env.HERDR_PANE_ID;
	if (!workspaceId || !tabId || !paneId) return null;
	return { workspaceId, tabId, paneId };
}

/** Whether herdr integration is available at all. */
export function herdrAvailable(): boolean {
	return herdrContext() !== null;
}

/**
 * Run one `herdr` CLI command and parse its JSON reply.
 *
 * Never throws and never rejects: a missing binary, a dead socket, or a
 * malformed reply all resolve to null. A display surface must not be able to
 * take down the work it is displaying.
 *
 * @param args - Arguments after the `herdr` binary name.
 * @returns The parsed `result` object, or null on any failure.
 */
export async function herdrCall(
	args: string[],
): Promise<Record<string, unknown> | null> {
	if (!herdrAvailable()) return null;

	return new Promise((resolve) => {
		execFile(
			"herdr",
			args,
			{ timeout: HERDR_TIMEOUT_MS, encoding: "utf8" },
			(err, stdout) => {
				if (err) return resolve(null);
				// Some commands (report-agent, rename) succeed with no output at all.
				// Exit 0 is the success signal; an empty reply is not a failure, so
				// report it as an empty result rather than null.
				if (!stdout.trim()) return resolve({});
				try {
					const parsed = JSON.parse(stdout) as Record<string, unknown>;
					const result = parsed.result;
					resolve(
						typeof result === "object" && result !== null
							? (result as Record<string, unknown>)
							: null,
					);
				} catch {
					resolve(null);
				}
			},
		);
	});
}

/**
 * Read a nested string out of a herdr JSON reply.
 *
 * IDs must be taken from responses rather than predicted (herdr's own
 * guidance), and the shapes are nested, so this keeps the callers readable.
 */
function pick(
	obj: Record<string, unknown> | null,
	path: string[],
): string | undefined {
	let cur: unknown = obj;
	for (const key of path) {
		if (typeof cur !== "object" || cur === null) return undefined;
		cur = (cur as Record<string, unknown>)[key];
	}
	return typeof cur === "string" ? cur : undefined;
}

/**
 * Create a tab, returning the tab ID and its root pane.
 *
 * Used for the one-tab-per-Task topology: a Task's Runs share a tab so a
 * parallel fan-out stays visually atomic.
 *
 * @param label - Tab label, normally the Task ID.
 */
export async function createTab(
	label: string,
): Promise<{ tabId: string; paneId: string } | null> {
	const ctx = herdrContext();
	if (!ctx) return null;

	const result = await herdrCall([
		"tab",
		"create",
		"--workspace",
		ctx.workspaceId,
		"--label",
		label,
		"--no-focus",
	]);
	const tabId = pick(result, ["tab", "tab_id"]);
	const paneId = pick(result, ["root_pane", "pane_id"]);
	if (!tabId || !paneId) return null;
	return { tabId, paneId };
}

/**
 * Split a pane and return the new pane's ID.
 *
 * Defaults to the geometry rule herdr documents: wide panes split right, narrow
 * or tall panes split down. Focus stays with the caller.
 *
 * @param target - Pane to split; defaults to this process's own pane.
 * @param direction - Split direction.
 * @param cwd - Working directory for the new pane.
 */
export async function splitPane(options: {
	target?: string;
	direction: "right" | "down";
	cwd?: string;
}): Promise<string | null> {
	const ctx = herdrContext();
	if (!ctx) return null;

	const args = [
		"pane",
		"split",
		"--pane",
		options.target ?? ctx.paneId,
		"--direction",
		options.direction,
		"--no-focus",
	];
	if (options.cwd) args.push("--cwd", options.cwd);

	const result = await herdrCall(args);
	return pick(result, ["pane", "pane_id"]) ?? null;
}

/** Rename a pane so the sidebar shows something meaningful. */
export async function renamePane(
	paneId: string,
	title: string,
): Promise<boolean> {
	return (await herdrCall(["pane", "rename", paneId, title])) !== null;
}

/**
 * Rename a tab so the tab bar shows something meaningful.
 *
 * A tab created by `createTab` is labelled at creation, but a tab herdr made for
 * a session it launched carries only its ordinal (`1`, `2`, …), so a session
 * that wants a name has to set one itself.
 */
export async function renameTab(
	tabId: string,
	title: string,
): Promise<boolean> {
	return (await herdrCall(["tab", "rename", tabId, title])) !== null;
}

/** Run a command in a pane. Sends the text and Enter atomically. */
export async function runInPane(
	paneId: string,
	command: string,
): Promise<boolean> {
	return (await herdrCall(["pane", "run", paneId, command])) !== null;
}

/** Send key presses to a pane. Used to interrupt a process we started. */
export async function sendPaneKeys(
	paneId: string,
	keys: string,
): Promise<boolean> {
	return (await herdrCall(["pane", "send-keys", paneId, keys])) !== null;
}

/**
 * Find a pane in this workspace by the label we gave it.
 *
 * Lets a restarted or imported session adopt a surface an earlier session
 * created, instead of assuming it owns the only one or stacking a duplicate.
 * Matches on `label` — the name set by `pane rename` — not on `terminal_title`,
 * which is whatever the shell happens to be advertising.
 *
 * @returns The pane ID, or null when no pane carries that label.
 */
export async function findPaneByLabel(label: string): Promise<string | null> {
	const ctx = herdrContext();
	if (!ctx) return null;

	const result = await herdrCall([
		"pane",
		"list",
		"--workspace",
		ctx.workspaceId,
	]);
	const panes = result?.panes;
	if (!Array.isArray(panes)) return null;

	for (const pane of panes) {
		if (typeof pane !== "object" || pane === null) continue;
		const entry = pane as Record<string, unknown>;
		if (entry.label === label && typeof entry.pane_id === "string")
			return entry.pane_id;
	}
	return null;
}

/**
 * Close a pane we created.
 *
 * Only ever called on panes this module created (docs/adr/0016): herdr's rule
 * is that you do not close panes you did not create.
 */
export async function closePane(paneId: string): Promise<boolean> {
	return (await herdrCall(["pane", "close", paneId])) !== null;
}

/** Close a tab we created. */
export async function closeTab(tabId: string): Promise<boolean> {
	return (await herdrCall(["tab", "close", tabId])) !== null;
}

/**
 * Declare a pane to be an agent, with a lifecycle state.
 *
 * This is what puts a Mirror Pane into `herdr agent list` and the agents
 * sidebar (docs/adr/0019). The state is *declared*, not detected from the
 * screen — a JSON-mode child shows no recognisable agent UI, so detection could
 * never classify it. Passing `sessionPath` is what makes the sidebar entry a
 * declared by us because a JSON-mode child has no detectable UI on screen.
 * Passing `sessionPath` only attaches a browsable session when the pane also has
 * a *detected* agent and the official source/agent pair is used — see
 * HERDR_PI_SOURCE and docs/adr/0021.
 *
 * @param paneId - Pane hosting the run.
 * @param label - Agent label shown by herdr (e.g. "pi:explorer").
 * @param state - Lifecycle state to report.
 * @param options.sessionPath - Absolute path of the run's session file.
 * @param options.message - Detail shown alongside a blocked/working state.
 * @param options.seq - Monotonic sequence number; later reports win.
 */
export async function reportAgent(
	paneId: string,
	label: string,
	state: HerdrAgentState,
	options: { sessionPath?: string; message?: string; seq?: number } = {},
): Promise<boolean> {
	const args = [
		"pane",
		"report-agent",
		paneId,
		"--source",
		HERDR_PI_SOURCE,
		"--agent",
		label,
		"--state",
		state,
	];
	if (options.sessionPath) args.push("--agent-session-path", options.sessionPath);
	if (options.message) args.push("--message", options.message);
	if (options.seq !== undefined) args.push("--seq", String(options.seq));

	return (await herdrCall(args)) !== null;
}

/**
 * Announce a pane's agent session identity without changing its state.
 *
 * Reported separately from lifecycle state because a session path can become
 * known after the pane is already reporting `working`.
 */
export async function reportAgentSession(
	paneId: string,
	label: string,
	sessionPath: string,
	seq?: number,
): Promise<boolean> {
	const args = [
		"pane",
		"report-agent-session",
		paneId,
		"--source",
		HERDR_PI_SOURCE,
		"--agent",
		label,
		"--agent-session-path",
		sessionPath,
	];
	if (seq !== undefined) args.push("--seq", String(seq));
	return (await herdrCall(args)) !== null;
}

/**
 * Source and agent label Herdr accepts as authoritative for a pi session.
 *
 * Herdr keeps a whitelist of "official" source/agent pairs and silently
 * discards a session reference reported under any other pair — a custom source
 * like `pi:subagent` produces an agent-list entry with `agent_session: null`.
 * For pi the accepted pair is exactly this one, so a Mirror Pane must claim it
 * verbatim to get a browsable session (docs/adr/0021).
 *
 * Specialist identity (explorer, oracle, ...) is therefore *presentation*: it
 * goes in the pane label and the report message, never in the agent label.
 */
export const HERDR_PI_SOURCE = "herdr:pi";
export const HERDR_PI_AGENT = "pi";

/**
 * Release our claim on a pane's agent identity.
 *
 * Called when a Run ends but its Mirror Pane lingers: the pane should stop
 * claiming to be a live agent without the pane itself disappearing.
 *
 * @param paneId - Pane to release.
 * @param agent - Agent label originally claimed; herdr requires it to match.
 */
export async function releaseAgent(
	paneId: string,
	agent: string = HERDR_PI_AGENT,
): Promise<boolean> {
	return (
		(await herdrCall([
			"pane",
			"release-agent",
			paneId,
			"--source",
			HERDR_PI_SOURCE,
			"--agent",
			agent,
		])) !== null
	);
}

/**
 * Monotonic sequence numbers for agent reports.
 *
 * herdr resolves out-of-order reports by sequence, so every report from this
 * process must be strictly increasing. Seeded from the clock so numbers keep
 * rising across a reload that replaces this module mid-session.
 */
let seq = Date.now() * 1000;

/** Next report sequence number. */
export function nextSeq(): number {
	seq += 1;
	return seq;
}
