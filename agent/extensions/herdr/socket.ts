/**
 * Raw socket client for the herdr server (herdr 0.9.0).
 *
 * Sits alongside client.ts, which shells out to the `herdr` CLI (docs/adr/0016,
 * docs/adr/0019). The CLI can do one-shot calls — split, close, rename, run —
 * but it cannot listen: the subscribe-to-events protocol exists only on the
 * server socket. Anything that must *react* to pane lifecycle (a native Run
 * ending, the user dismissing it — docs/adr/0044) goes through this module,
 * while client.ts keeps owning the CLI calls. The two are complementary; this
 * file neither replaces nor is replaced by client.ts.
 *
 * Protocol (measured against herdr 0.9.0, recorded in docs/adr/0044
 * "Verified mechanism"): JSON-lines over $HERDR_SOCKET_PATH — one JSON object
 * per line. A request is {"id", "method", "params"}; the reply on the same
 * connection is {"id", "result"}. After an "events.subscribe" reply
 * ({"id", "result": {"type": "subscription_started"}}), the same connection
 * becomes a stream of {"event", "data"} lines for as long as it stays open.
 *
 * Three protocol facts are load-bearing, and each would otherwise be
 * rediscovered as a bug:
 *
 * 1. `pane_exited` carries NO exit code — pane_id and workspace_id only.
 *    Herdr auto-closes the pane the moment the process exits, so the
 *    scrollback dies with it; the exit code comes from the wrapper-written
 *    `.exitcode` sidecar, never from herdr.
 *
 * 2. `pane_closed` fires ONLY on an explicit close (the user dismissing the
 *    pane, `herdr pane close`) and NEVER on the exit-triggered auto-close.
 *    That asymmetry is what makes user-dismissal cleanly detectable — but it
 *    also means a watcher gating on `pane_closed` would deadlock on every
 *    normal Run. The normal termination signal is `pane.exited`;
 *    `pane.closed` means *dismissed*.
 *
 * 3. Subscription types are spelled with dots (pane.exited) while the emitted
 *    event names use underscores (pane_exited). Both spellings are accepted
 *    in dispatchEvent.
 *
 * And a fourth that is server-specific rather than schema: a
 * `pane.agent_status_changed` subscription entry is REJECTED without a
 * pane_id ("invalid_request: missing field 'pane_id'") even though the
 * published schema marks only `subscriptions` as required. Schema and server
 * diverge; the server wins. This module therefore only ever subscribes to
 * agent status for panes it was given explicit IDs for.
 *
 * Contract, matching client.ts: everything degrades to a silent no-op when
 * herdr is absent. Nothing here throws or rejects; every entry point resolves
 * null (or { close } only once the subscription is live), and close() on a
 * live subscription never throws.
 *
 * DO NOT rename this file to `index.ts`. pi's extension discovery treats
 * `extensions/<dir>/index.ts` as an extension entry point that must
 * default-export a factory function; this is a plain library with only named
 * exports, so being discovered is a hard load failure at startup ("Extension
 * does not export a valid factory function" — docs/adr/0016). `socket.ts`
 * keeps it invisible to discovery while leaving it importable by the subagent
 * and plan extensions, exactly as client.ts does.
 */

import { existsSync } from "node:fs";
import net from "node:net";

/**
 * How long a single request may take before we give up on it. Identical to
 * client.ts's HERDR_TIMEOUT_MS, so a socket round-trip and a CLI round-trip
 * have the same patience.
 */
const HERDR_SOCKET_TIMEOUT_MS = 5000;

/**
 * Agent lifecycle states herdr reports for a pane's agent (the report states
 * from herdr-agent-state.ts plus `done`, which the agent sidebar uses).
 */
export type HerdrAgentStatus =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "unknown";

/** Where a plugin pane may be placed. */
export type PluginPanePlacement = "overlay" | "popup" | "split" | "tab" | "zoomed";

/** Split direction when the placement targets an existing pane. */
export type SplitDirection = "right" | "down";

export type OpenPluginPaneOptions = {
  pluginId: string;
  entrypoint: string;
  env?: Record<string, string>;
  cwd?: string;
  placement?: PluginPanePlacement;
  targetPaneId?: string;
  direction?: SplitDirection;
  /** Whether herdr should focus the new pane. Defaults to false on the server. */
  focus?: boolean;
  workspaceId?: string;
};

export type SubscribePaneEventsOptions = {
  /**
   * Panes to subscribe to `pane.agent_status_changed` for. The server rejects
   * that subscription type without a pane_id (schema/server divergence, see
   * the file header), so omitting it — or passing no IDs — subscribes only to
   * the global pane.exited and pane.closed events, which is the right default
   * for a watcher that only cares about Runs ending.
   */
  paneIds?: string[];
  /**
   * Fires when a pane's process exits. This is the NORMAL termination signal
   * for a Run — herdr auto-closes the pane on exit and reports only pane_id +
   * workspace_id (no exit code; the wrapper's sidecar carries that).
   */
  onExited?(paneId: string): void;
  /**
   * Fires ONLY on an explicit close — the user dismissing the pane, or
   * `herdr pane close`. It does NOT fire on the exit-triggered auto-close, so
   * this callback is the dismissal detector. A watcher that waited on
   * onClosed instead of onExited would deadlock on every normal Run.
   */
  onClosed?(paneId: string): void;
  /** Fires for each pane in paneIds, with the reported state (a HerdrAgentStatus). */
  onAgentStatus?(paneId: string, status: string): void;
};

/**
 * Handle for a live subscription. close() stops event delivery and tears the
 * connection down; it is idempotent and never throws.
 */
export type PaneEventSubscription = {
  close(): void;
};

/**
 * Unique per-process request IDs. herdr's own integration (see
 * herdr-agent-state.ts) uses `<source>:<ms>:<random>`; the counter keeps IDs
 * distinct even within a single millisecond, which matters when several
 * connections open back to back.
 */
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `pi-socket:${Date.now()}:${requestCounter}:${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The endpoint a raw socket dials. On Windows the server listens on a named
 * pipe (mirroring herdr-agent-state.ts); elsewhere the env var is the literal
 * socket path.
 */
function socketEndpoint(socketPath: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

/**
 * Whether we can talk to the herdr server at all.
 *
 * True only when HERDR_SOCKET_PATH is set AND the socket file exists — the
 * cheapest honest check, matching how client.ts gates on herdrContext().
 * Every entry point below no-ops (resolves null) when this is false, so the
 * module is inert in a plain terminal, over SSH, or with herdr stopped.
 */
export function herdrSocketAvailable(): boolean {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) return false;
  return existsSync(socketEndpoint(socketPath));
}

/**
 * Accumulates socket chunks and yields complete newline-terminated lines.
 *
 * The protocol is JSON-lines: one JSON object per line. Socket reads are
 * frame-partial — a single data event can carry half a line or several whole
 * lines — so we never parse until a `\n` has arrived. This is the same
 * framing herdr-agent-state.ts relies on (it writes full lines and treats the
 * first data event as delivery; the server hands us back full lines).
 */
class LineBuffer {
  private pending = "";

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines: string[] = [];
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) !== -1) {
      lines.push(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
    }
    return lines;
  }
}

/**
 * Read a nested string out of a herdr JSON reply.
 *
 * IDs must be taken from responses rather than predicted (client.ts's rule),
 * and plugin.pane.open nests them three levels deep, so this keeps the caller
 * readable. Mirrors client.ts's pick exactly.
 */
function pick(obj: Record<string, unknown> | null, path: string[]): string | undefined {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : undefined;
}

/**
 * Fire one request on a fresh connection and resolve with the reply's
 * `result` object.
 *
 * Never throws and never rejects: a missing socket, a dead server, a timeout
 * (HERDR_SOCKET_TIMEOUT_MS), and a malformed or id-mismatched reply all
 * resolve to null. A display surface must not be able to take down the work
 * it is displaying (client.ts's rule, applied to the socket).
 *
 * The reply is matched by request id, so stray frames on the connection
 * (the server may send unsolicited ones) are ignored rather than mistaken
 * for the answer.
 */
function request(
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath || !existsSync(socketEndpoint(socketPath))) {
    return Promise.resolve(null);
  }

  const requestId = nextRequestId();
  return new Promise((resolve) => {
    let settled = false;

    const socket = net.createConnection(socketEndpoint(socketPath));
    const timer = setTimeout(() => finish(null), HERDR_SOCKET_TIMEOUT_MS);
    timer.unref?.();

    const finish = (result: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const buffer = new LineBuffer();

    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      for (const line of buffer.push(chunk.toString())) {
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // partial or foreign frame: drop it, never throw
        }
        if (typeof msg !== "object" || msg === null) continue;
        const frame = msg as Record<string, unknown>;
        if (frame.id !== requestId) continue; // stray frame: not our reply
        const result = frame.result;
        finish(
          typeof result === "object" && result !== null
            ? (result as Record<string, unknown>)
            : null,
        );
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
  });
}

/**
 * Open a plugin pane: launch a plugin entrypoint (an argv, no shell — see
 * docs/adr/0044) into a real PTY and resolve with the new pane's identity.
 *
 * Per-Run variation rides on `env` by necessity: herdr's plugin API has no
 * command-override field, so a Run's dispatcher resolves whatever the env
 * points at (docs/adr/0044, finding 4). The launched process also inherits
 * the herdr *server's* environment, not the requesting pane's — pass every
 * variable a Run needs explicitly here.
 *
 * @returns The pane and tab IDs from the reply (never predicted), or null on
 * any failure: herdr absent, timeout, or an unexpected reply shape.
 */
export async function openPluginPane(
  options: OpenPluginPaneOptions,
): Promise<{ paneId: string; tabId: string } | null> {
  const params: Record<string, unknown> = {
    plugin_id: options.pluginId,
    entrypoint: options.entrypoint,
  };
  if (options.env !== undefined) params.env = options.env;
  if (options.cwd !== undefined) params.cwd = options.cwd;
  if (options.placement !== undefined) params.placement = options.placement;
  if (options.targetPaneId !== undefined) params.target_pane_id = options.targetPaneId;
  if (options.direction !== undefined) params.direction = options.direction;
  if (options.focus !== undefined) params.focus = options.focus;
  if (options.workspaceId !== undefined) params.workspace_id = options.workspaceId;

  const result = await request("plugin.pane.open", params);
  const paneId = pick(result, ["plugin_pane", "pane", "pane_id"]);
  const tabId = pick(result, ["plugin_pane", "pane", "tab_id"]);
  if (!paneId || !tabId) return null;
  return { paneId, tabId };
}

/**
 * Deliver one emitted event to the matching callback.
 *
 * Handles both spellings of the event name (dots in subscription types,
 * underscores in emitted names — see the file header). Every event this
 * module cares about is per-pane, so a frame without a pane_id is dropped.
 * Callbacks run in a try/catch: a throwing consumer must not kill the
 * subscription, and the socket must not be able to take down the session.
 */
function dispatchEvent(
  frame: Record<string, unknown>,
  options: SubscribePaneEventsOptions,
): void {
  const data =
    typeof frame.data === "object" && frame.data !== null
      ? (frame.data as Record<string, unknown>)
      : {};

  const name =
    typeof frame.event === "string"
      ? frame.event
      : typeof data.type === "string"
        ? data.type
        : undefined;
  if (!name) return;

  const paneId = typeof data.pane_id === "string" ? data.pane_id : undefined;
  if (!paneId) return;

  const invoke = (fn: (() => void) | undefined) => {
    if (!fn) return;
    try {
      fn();
    } catch {
      // silent by contract
    }
  };

  if (name === "pane_exited" || name === "pane.exited") {
    invoke(() => options.onExited?.(paneId));
  } else if (name === "pane_closed" || name === "pane.closed") {
    invoke(() => options.onClosed?.(paneId));
  } else if (
    name === "pane_agent_status_changed" ||
    name === "pane.agent_status_changed"
  ) {
    // The emitted field name is not recorded in the ADR; the report protocol
    // calls it `state`, so accept the plausible spellings rather than
    // guessing one.
    const status =
      typeof data.status === "string"
        ? data.status
        : typeof data.agent_status === "string"
          ? data.agent_status
          : typeof data.state === "string"
            ? data.state
            : undefined;
    if (status) invoke(() => options.onAgentStatus?.(paneId, status));
  }
}

/**
 * Subscribe to pane lifecycle events on a long-lived connection.
 *
 * Always subscribes to `pane.exited` (the normal Run-termination signal) and
 * `pane.closed` (explicit close only — the dismissal detector, see the file
 * header), plus `pane.agent_status_changed` for each id in paneIds.
 *
 * Resolves with a PaneEventSubscription once the server acks
 * ({"result":{"type":"subscription_started"}}); resolves null if herdr is
 * absent, the connection dies before the ack, the ack times out
 * (HERDR_SOCKET_TIMEOUT_MS), or the server rejects the subscription. After
 * the ack, event lines stream on the same connection and are dispatched to
 * the callbacks until close() or socket death. Partial lines are buffered
 * until their newline, and nothing in this path throws: a dead socket simply
 * stops delivering.
 */
export async function subscribePaneEvents(
  options: SubscribePaneEventsOptions,
): Promise<PaneEventSubscription | null> {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath || !existsSync(socketEndpoint(socketPath))) return null;

  // Dotted spellings — what the server wants in the request. The agent_status
  // entries carry the pane_id the server demands (and its published schema
  // under-specifies), so only request them for panes the caller named.
  const subscriptions: Array<Record<string, string>> = [
    { type: "pane.exited" },
    { type: "pane.closed" },
  ];
  for (const paneId of options.paneIds ?? []) {
    subscriptions.push({ type: "pane.agent_status_changed", pane_id: paneId });
  }

  const requestId = nextRequestId();
  return new Promise((resolve) => {
    let settled = false;
    let closedByUser = false;

    const socket = net.createConnection(socketEndpoint(socketPath));
    const ackTimer = setTimeout(
      () => finish(null, true),
      HERDR_SOCKET_TIMEOUT_MS,
    );
    ackTimer.unref?.();

    const finish = (handle: PaneEventSubscription | null, destroy: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(ackTimer);
      if (destroy) socket.destroy();
      resolve(handle);
    };

    // close() is only reachable through the handle, which the caller gets
    // after the ack — so this never races the resolve.
    const handle: PaneEventSubscription = {
      close() {
        closedByUser = true;
        socket.destroy();
      },
    };

    const buffer = new LineBuffer();

    const onLine = (line: string) => {
      if (!line) return;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // partial or foreign frame: drop it, never throw
      }
      if (typeof msg !== "object" || msg === null) return;
      const frame = msg as Record<string, unknown>;

      // The ack carries our request id AND result.type ===
      // "subscription_started" — that exact shape is the live signal (see the
      // contract above). Anything else with our id — an error reply, an
      // unrelated or malformed result — is a failed subscription.
      if (frame.id === requestId) {
        const result = frame.result;
        if (
          typeof result === "object" &&
          result !== null &&
          (result as Record<string, unknown>).type === "subscription_started"
        ) {
          // Live. Do NOT destroy: the connection now carries the event
          // stream, and dispatch keeps running after the resolve.
          finish(handle, false);
        } else {
          finish(null, true);
        }
        return;
      }

      if (typeof frame.event === "string") {
        dispatchEvent(frame, options);
      }
    };

    socket.on("data", (chunk: Buffer) => {
      if (closedByUser) return;
      for (const line of buffer.push(chunk.toString())) onLine(line);
    });
    // Socket death is not an error condition for a subscription: events stop,
    // and if the ack never arrived we settle to null rather than throw.
    socket.on("error", () => finish(null, true));
    socket.on("close", () => finish(null, false));
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          id: requestId,
          method: "events.subscribe",
          params: { subscriptions },
        })}\n`,
      );
    });
  });
}
