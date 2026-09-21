/**
 * Thin CLI wrapper around the herdr 0.9.0 CLI (herdr 0.9.0, verified).
 *
 * Every herdr CLI command prints a single JSON document on stdout — a
 * `{"id", "result"}` reply on success, a `{"id", "error": {"code", ...}}`
 * reply on a clean failure. This module shells out, parses that one document,
 * and never throws: every entry point resolves a structured value, because a
 * display/management surface must not be able to take down the session that
 * hosts it.
 *
 * Measured behaviours this module relies on (verified against herdr 0.9.0):
 *
 * 1. `tab create --workspace <ws> --cwd <path> --label <t> --no-focus`
 *    returns `result.root_pane.pane_id` (the tab's fresh shell pane) and
 *    `result.tab.tab_id`. Preferred: each child gets its own tab in the
 *    orchestrator's workspace, leaving the orchestrator tab's layout intact.
 *    Always take IDs from responses, never predict them.
 * 2. `agent start <name> --kind pi --pane <id> [-- argv...]` launches `pi`
 *    in a pane that is at its interactive shell prompt and resolves only once
 *    herdr's pi detection reports the agent interactive-ready. Extra
 *    `pi` arguments ride after `--`.
 * 3. `agent prompt <pane> <text>` submits one prompt to the agent; it is
 *    rejected with `agent_blocked` when the agent is already blocked.
 * 5. `agent wait <pane> --until done` resolves as soon as herdr reports the
 *    agent `done` — for pi that is "the turn finished", which also covers a
 *    child that exits (after exit the pane persists with status `done` and
 *    its scrollback stays readable). `agent read` therefore remains usable
 *    after a run ends.
 *
 * `agent read` is the one oddity: it prints raw terminal text, not a JSON
 * document, so `readAgent` passes stdout through un-parsed.
 *
 * @module subagent-herdr/herdr
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** Patience for a single CLI round-trip. */
const HERDR_TIMEOUT_MS = 30_000;

/** Extra patience layered on top of a caller-supplied herdr-side timeout. */
const EXEC_SLACK_MS = 15_000;

export interface HerdrCall {
  /** False when the CLI failed, timed out, or answered with an error payload. */
  ok: boolean;
  /** The parsed stdout document, when it was a JSON object. */
  data: Record<string, unknown> | null;
  /** The `code` of a `{"error": {...}}` payload, or the spawn/exit failure. */
  error: string | null;
  /** Raw stderr, when any. */
  stderr: string;
}

/**
 * Runs `herdr <args...>` and parses its single JSON document. Never throws.
 *
 * @param args - CLI arguments, no shell involved (tasks are long and full of
 *        quotes; a shell in the middle is a quoting accident waiting to happen).
 * @param timeoutMs - Kill the CLI process after this long (default 30 s).
 */
export async function herdr(args: string[], timeoutMs = HERDR_TIMEOUT_MS): Promise<HerdrCall> {
  let stdout: string;
  let stderr: string;
  try {
    const out = await pexecFile("herdr", args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf-8",
    });
    stdout = out.stdout;
    stderr = out.stderr;
  } catch (e) {
    const ex = e as { code?: number | string; message?: string; stderr?: string; stdout?: string };
    return {
      ok: false,
      data: null,
      error: ex.code ? `herdr exited ${ex.code}` : ex.message ?? String(e),
      stderr: ex.stderr ?? "",
    };
  }

  let data: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === "object" && parsed !== null) data = parsed as Record<string, unknown>;
  } catch {
    // Not a JSON document (e.g. `agent read`'s raw text): `data` stays null
    // and callers that need the raw text use readAgent.
  }

  const err = data && typeof data.error === "object" && data.error !== null ? (data.error as Record<string, unknown>) : null;
  return {
    ok: err === null,
    data,
    error: err ? String(err.code ?? err.message ?? "herdr_error") : null,
    stderr,
  };
}

/** Reads a nested string out of a herdr reply; ids come from responses, never predictions. */
function pick(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * Identifies the workspace containing the calling pane (the orchestrator's),
 * or null when herdr is absent/refuses.
 */
async function currentWorkspaceId(): Promise<string | null> {
  const r = await herdr(["pane", "current"]);
  if (!r.ok || !r.data) return null;
  return pick(r.data, ["result", "pane", "workspace_id"]) ?? null;
}

/**
 * Splits the current pane (the orchestrator's) and returns the new pane's
 * identity, or null when herdr is absent/refuses.
 *
 * @param env - Extra env for the launched pane process (herdr injects it into
 *        the shell; the pi child inherits it). How the child learns its run id
 *        and the orchestrator's pane id.
 */
export async function splitPane(cwd: string, env?: Record<string, string>): Promise<{ paneId: string; tabId: string } | null> {
  const args = ["pane", "split", "--current", "--direction", "right", "--cwd", cwd];
  for (const [key, value] of Object.entries(env ?? {})) args.push("--env", `${key}=${value}`);
  const r = await herdr(args);
  if (!r.ok || !r.data) return null;
  const paneId = pick(r.data, ["result", "pane", "pane_id"]);
  const tabId = pick(r.data, ["result", "pane", "tab_id"]);
  return paneId && tabId ? { paneId, tabId } : null;
}

/**
 * Spawns a child pane as a **separate tab in the orchestrator's workspace**
 * (one fresh shell pane per tab) and returns the pane/tab identity, or null
 * when herdr is absent/refuses. Falls back to splitting the current pane
 * when the workspace is unknown or `tab create` is unavailable (older herdr).
 * Closing the tab's only pane closes the tab, so the existing `closePane`
 * cleanup path is unchanged.
 *
 * @param label - Tab/pane label for herdr's sidebar (e.g. `librarian sub-1234`).
 * @param env - Extra env for the launched process (herdr injects it into the
 *        shell; the pi child inherits it). How the child learns its run id
 *        and the orchestrator's pane id.
 */
export async function createChildPane(
  cwd: string,
  label: string,
  env?: Record<string, string>,
): Promise<{ paneId: string; tabId: string } | null> {
  const workspaceId = await currentWorkspaceId();
  if (workspaceId) {
    const args = ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"];
    for (const [key, value] of Object.entries(env ?? {})) args.push("--env", `${key}=${value}`);
    const r = await herdr(args);
    if (r.ok && r.data) {
      const paneId = pick(r.data, ["result", "root_pane", "pane_id"]);
      const tabId = pick(r.data, ["result", "tab", "tab_id"]);
      if (paneId && tabId) return { paneId, tabId };
    }
    // `tab create` missing (pre-0.9 herdr) or a changed reply shape: fall
    // back to the legacy split of the current pane.
  }
  return splitPane(cwd, env);
}

/** Cosmetic: labels the pane in herdr's sidebar. Never a failure path. */
export async function renamePane(paneId: string, label: string): Promise<boolean> {
  const r = await herdr(["pane", "rename", paneId, label]);
  return r.ok;
}

/**
 * Starts `pi` in an existing pane with the given argv (everything after
 * herdr's `--`). Resolves true only when herdr's pi detection reports the
 * agent interactive-ready.
 */
export async function startAgent(name: string, paneId: string, argv: string[], timeoutMs = 60_000): Promise<boolean> {
  const args = ["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", String(timeoutMs)];
  if (argv.length > 0) args.push("--", ...argv);
  const r = await herdr(args, timeoutMs + EXEC_SLACK_MS);
  return r.ok;
}

/**
 * Patience for the post-prompt "turn started" observation window. herdr
 * itself reports `agent_prompt_stalled` after 5 s; we give it a bit more so a
 * slow first model hop is not mistaken for a lost keypress.
 */
const PROMPT_START_TIMEOUT_MS = 15_000;

/**
 * Submits the task prompt and waits for the turn to start (agent `working`).
 *
 * The plain form (no `--wait`) only proves herdr typed the text; it does not
 * prove the TUI accepted it. Measured race: with a slow TUI startup the Enter
 * that submits the prompt can be lost, leaving the task text sitting in the
 * editor and the run idle forever. `--wait --until working` makes herdr
 * itself detect that (it answers `agent_prompt_stalled`), so the caller can
 * recover with a re-sent Enter instead of discovering it at wait-time.
 *
 * @returns ok=true when the turn is running; on failure, `error` carries the
 *          herdr error code (e.g. `agent_prompt_stalled`, `timeout`).
 */
export async function promptAgent(
  paneId: string,
  text: string,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await herdr(
    ["agent", "prompt", paneId, text, "--wait", "--until", "working", "--timeout", String(PROMPT_START_TIMEOUT_MS)],
    PROMPT_START_TIMEOUT_MS + EXEC_SLACK_MS,
  );
  return { ok: r.ok, error: r.error };
}

/**
 * Fires a prompt at a pane without waiting for any state change — the shape
 * for *mid-run* messages to a subagent (a child that is already working
 * queues the input; `--wait --until working` would be a no-op or a stall).
 */
export async function sendPrompt(paneId: string, text: string): Promise<{ ok: boolean; error: string | null }> {
  const r = await herdr(["agent", "prompt", paneId, text]);
  return { ok: r.ok, error: r.error };
}

/** Sends literal key presses to a pane (e.g. a recovery Enter). */
export async function sendKeys(paneId: string, ...keys: string[]): Promise<boolean> {
  const r = await herdr(["agent", "send-keys", paneId, ...keys]);
  return r.ok;
}

/** True once the agent reaches `working`; false on timeout or missing pane. */
export async function waitAgentWorking(paneId: string, timeoutMs: number): Promise<boolean> {
  const r = await herdr(
    ["agent", "wait", paneId, "--until", "working", "--timeout", String(timeoutMs)],
    timeoutMs + EXEC_SLACK_MS,
  );
  if (!r.ok || !r.data) return false;
  return pick(r.data, ["result", "agent", "agent_status"]) === "working";
}

/**
 * Blocks until herdr reports the agent `done` (pi: the turn finished, or the
 * process exited). False on timeout, missing pane, or CLI failure.
 */
export async function waitAgent(paneId: string, timeoutMs: number): Promise<boolean> {
  const r = await herdr(
    ["agent", "wait", paneId, "--until", "done", "--timeout", String(timeoutMs)],
    timeoutMs + EXEC_SLACK_MS,
  );
  if (!r.ok || !r.data) return false;
  return pick(r.data, ["result", "agent", "agent_status"]) === "done";
}

/** The agent states herdr reports for a pane. */
export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";

/**
 * One-shot state probe. Resolves null when the pane is gone (herdr answers
 * with an error) so callers can distinguish "running" from "gone".
 */
export async function getAgent(paneId: string): Promise<{ status: AgentState; name: string | undefined } | null> {
  const r = await herdr(["agent", "get", paneId]);
  if (!r.ok || !r.data) return null;
  const agent = (r.data.result as { agent?: { agent_status?: string; name?: string } } | undefined)?.agent;
  if (!agent) return null;
  const status = agent.agent_status ?? "unknown";
  return {
    status: (["idle", "working", "blocked", "done", "unknown"] as const).includes(status as AgentState)
      ? (status as AgentState)
      : "unknown",
    name: agent.name,
  };
}

/**
 * Raw terminal text from a pane (works after the process exited — herdr keeps
 * the pane until it is closed). Null when herdr refuses.
 */
export async function readAgent(paneId: string, lines = 40): Promise<string | null> {
  let stdout: string;
  try {
    const out = await pexecFile("herdr", ["agent", "read", paneId, "--lines", String(lines), "--format", "text"], {
      timeout: HERDR_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf-8",
    });
    stdout = out.stdout;
  } catch {
    return null;
  }
  return stdout.trim() ? stdout : null;
}

/** Closes a pane (killing its process). Idempotent enough: a second close just fails cleanly. */
export async function closePane(paneId: string): Promise<boolean> {
  const r = await herdr(["pane", "close", paneId]);
  return r.ok;
}
