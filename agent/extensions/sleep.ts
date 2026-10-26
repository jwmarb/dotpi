/**
 * sleep extension — lets the agent pause for a bounded delay, then carry on.
 *
 * Registers a `sleep` tool: the model calls it with a required timeout in
 * seconds (0 < timeout <= 3600). The tool waits that long (abortably) and
 * then returns an ordinary result, so the agent loop makes another model call
 * and the agent resumes exactly where it left off — the point is "wait for
 * the background job, then check on it", not "stop working".
 *
 * It deliberately does NOT return `terminate: true`. It once did, and that
 * ended the run the moment the timer fired: the model never saw the result,
 * and whatever it was waiting on stayed unfinished until a human typed
 * "continue". Ending a turn needs no tool — the model just stops calling them.
 *
 * Early wake: while sleeping it polls `ctx.hasPendingMessages()`, and returns
 * as soon as a steering/follow-up message (a subagent briefing, a user
 * message) is queued, so that message is not held hostage by the timer.
 * The wake is edge-triggered: it fires only when the queue goes from empty to
 * non-empty during the sleep. A message already queued at the start (typically
 * a follow-up, which pi delivers only once the model stops calling tools) would
 * otherwise wake every later sleep within one poll, so a "sleep, check, sleep"
 * loop would spin at one model call per WAKE_POLL_MS.
 *
 * Cancellation is not successful completion: an aborted wait settles
 * promptly with `isError: true`, so a cancelled turn is never reported as a
 * finished sleep.
 *
 * Install location: ~/.pi/agent/extensions/sleep.ts
 * (auto-discovered; hot-reload with /reload)
 */

import { defineTool, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const MAX_TIMEOUT_SECONDS = 3600;

/** How often the wait checks for a queued message to wake on. */
export const WAKE_POLL_MS = 500;

export interface SleepDetails {
    timeout: number;
    status: "completed" | "woken" | "interrupted";
    /** Seconds actually slept (rounded to 0.1s). */
    elapsed: number;
    /** Set when a message was already queued as the sleep began (it cannot wake it). */
    pendingAtStart?: true;
}

/** The slice of the tool context sleep uses; absent outside a session. */
interface WakeSource {
    hasPendingMessages?: () => boolean;
}

// ---------------------------------------------------------------------------
// Pure logic (tested from lib/sleep.test.ts)
// ---------------------------------------------------------------------------

/**
 * Validate a model-supplied timeout. Throws for non-number, non-finite,
 * non-positive, and over-limit values; returns valid fractional values
 * unchanged.
 */
export function validateTimeout(timeout: unknown): number {
    if (typeof timeout !== "number" || !Number.isFinite(timeout)) {
        throw new Error(`timeout must be a finite number of seconds, got ${String(timeout)}`);
    }
    if (timeout <= 0) {
        throw new Error(`timeout must be greater than 0 seconds, got ${timeout}`);
    }
    if (timeout > MAX_TIMEOUT_SECONDS) {
        throw new Error(`timeout must be at most ${MAX_TIMEOUT_SECONDS} seconds, got ${timeout}`);
    }
    return timeout;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const sleepTool = defineTool({
    name: "sleep",
    label: "Sleep",
    description:
        "Pause for a required timeout in seconds (0 < timeout <= 3600), then continue working: the " +
        "result comes back to you like any other tool result and the turn goes on. Use it to wait on " +
        "a bounded real-world delay (a background process, a CI run, a deploy) before checking on it. " +
        "It wakes early if a message (a subagent briefing, a user message) is queued while sleeping. " +
        "Do not use it to end your turn — to wait for a subagent or the user, just end the turn plainly.",
    promptSnippet:
        "Pause for a required timeout (seconds, max 3600), then resume the turn; wakes early on a queued message",
    promptGuidelines: [
        "Use sleep to wait on a bounded real-world delay (background jobs, CI, deploys) and then continue: after it returns, check on whatever you were waiting for. The timeout is in seconds and is required.",
        "sleep does not end the turn. If the only thing left is waiting for a subagent briefing or a user reply, end the turn plainly instead of sleeping.",
        "If sleep reports it woke early, a new message has arrived and appears before your next response: read it and act on it before deciding whether to wait again.",
        "If sleep reports a message was already queued when it started, that message is delivered only once you stop calling tools: wrap up and end the turn rather than sleeping in a loop."
    ],
    parameters: Type.Object({
        timeout: Type.Number({
            description: "How long to sleep, in seconds. Required. 0 < timeout <= 3600.",
            exclusiveMinimum: 0,
            maximum: MAX_TIMEOUT_SECONDS,
        }),
    }),
    // Sequential pacing, not a shared-state guard: the batch must not race
    // ahead of the timer while it runs.
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const timeout = validateTimeout(params.timeout);
        const milliseconds = timeout * 1000;
        // Narrowed to the one method used, so tests can pass a bare stub.
        const wakeSource = ctx as WakeSource | undefined;
        const hasPending = () => {
            try {
                return wakeSource?.hasPendingMessages?.() === true;
            } catch {
                // A stale context (e.g. after /reload) must not break the wait.
                return false;
            }
        };
        const start = Date.now();
        // Edge-triggered wake: remember what was already queued so a message
        // that pre-dates this sleep cannot wake it (see the header comment).
        const pendingAtStart = hasPending();
        let lastPending = pendingAtStart;

        // Single settlement path: the timer, the wake poll and the abort
        // listener can all fire; whichever settles first cleans up the rest.
        return await new Promise<AgentToolResult<SleepDetails>>((resolve) => {
            const complete = (status: SleepDetails["status"]) => {
                clearTimeout(timer);
                clearInterval(poll);
                signal?.removeEventListener("abort", onAbort);
                const elapsed = Math.round((Date.now() - start) / 100) / 10;
                const base =
                    status === "completed"
                        ? `Slept ${timeout} seconds. Continue with what you were waiting on.`
                        : status === "woken"
                          ? `Woke after ${elapsed} of ${timeout} seconds because a new message arrived. ` +
                            `It appears before your next response; read it before deciding whether to wait again.`
                          : `Sleep of ${timeout} seconds was interrupted after ${elapsed} seconds.`;
                const text =
                    pendingAtStart && status !== "interrupted"
                        ? `${base} Note: a message was already queued when this sleep started; it is delivered ` +
                          `only once you stop calling tools, so wrap up and end the turn rather than sleeping again.`
                        : base;
                resolve({
                    content: [{ type: "text", text }],
                    details: { timeout, status, elapsed, ...(pendingAtStart ? { pendingAtStart: true as const } : {}) },
                    ...(status === "interrupted" ? { isError: true } : {}),
                });
            };

            const timer = setTimeout(() => complete("completed"), milliseconds);
            const poll = setInterval(() => {
                const now = hasPending();
                if (now && !lastPending) complete("woken");
                lastPending = now;
            }, WAKE_POLL_MS);

            const onAbort = () => complete("interrupted");

            if (signal?.aborted) {
                complete("interrupted");
                return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    },

    renderCall(args, theme) {
        const argsText = typeof args.timeout === "number" ? `${args.timeout}s` : "…";
        const text = theme.fg("toolTitle", theme.bold("sleep ")) + theme.fg("muted", argsText);
        return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
        const details = result.details as SleepDetails | undefined;
        const status = details?.status;
        if (status !== "completed" && status !== "woken" && status !== "interrupted") {
            // Covers pi's own error results, which carry details: {} —
            // rendering those as a green success would hide the failure.
            const text = result.content[0];
            return new Text(text?.type === "text" ? text.text : "", 0, 0);
        }
        if (status === "interrupted") {
            return new Text(theme.fg("warning", `✗ interrupted — ${details!.timeout}s sleep cancelled`), 0, 0);
        }
        if (status === "woken") {
            return new Text(
                theme.fg("success", `✓ woke early after ${details!.elapsed}s of ${details!.timeout}s — new message arrived`),
                0,
                0,
            );
        }
        return new Text(theme.fg("success", `✓ slept ${details!.timeout}s — resuming`), 0, 0);
    },
});

export default function (pi: ExtensionAPI) {
    pi.registerTool(sleepTool);
}
