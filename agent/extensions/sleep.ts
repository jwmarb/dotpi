/**
 * sleep extension — lets the agent end its own turn after a bounded pause.
 *
 * Registers a `sleep` tool: the model calls it with a required timeout in
 * seconds (0 < timeout <= 3600). The tool waits that long (abortably) and
 * returns `terminate: true`, which tells the agent loop to end the current
 * turn after the tool batch — no further model call until the next input.
 *
 * Cancellation is not successful completion: an aborted wait settles
 * promptly with `isError: true` and no `terminate`, so a cancelled turn is
 * never reported as a finished sleep.
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

export interface SleepDetails {
    timeout: number;
    status: "completed" | "interrupted";
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
        "Pause for a required timeout in seconds (0 < timeout <= 3600), then end the current turn. " +
        "The agent loop will not call the model again until new input arrives. Use it when there is " +
        "nothing else to do this turn and the work is waiting on a bounded real-world delay " +
        "(a background process, a CI run). Do not use it to wait for something that wakes the agent " +
        "on its own (a subagent briefing, a user reply) — end the turn plainly instead, because " +
        "messages that arrive during the sleep only queue until the timer runs out. Call it alone: " +
        "it must be the only tool call in its batch, because the turn ends only when every result " +
        "in the batch terminates.",
    promptSnippet:
        "Sleep for a required timeout (seconds, max 3600), then end the current turn without another model call",
    promptGuidelines: [
        "Use sleep to pause and end the turn when there is nothing to do and the work waits on a bounded real-world delay (background jobs, CI). The timeout is in seconds and is required.",
        "If a subagent briefing or a user reply is expected to wake the agent, end the turn plainly instead of sleeping: messages arriving during the sleep only queue until the timer runs out.",
        "sleep must be the final action of the turn and the only tool call in its assistant response: the turn ends only when every result in the batch terminates, so any sibling tool call keeps the loop running."
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

    async execute(_toolCallId, params, signal) {
        const timeout = validateTimeout(params.timeout);
        const milliseconds = timeout * 1000;

        // Single settlement path: the timer and the abort listener can both
        // fire, and whichever settles first must clean up the other.
        return await new Promise<AgentToolResult<SleepDetails>>((resolve) => {
            const complete = (status: SleepDetails["status"]) => {
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                resolve({
                    content: [
                        {
                            type: "text",
                            text:
                                status === "completed"
                                    ? `Slept ${timeout} seconds. The turn ends unless other tool calls in this batch continue it.`
                                    : `Sleep of ${timeout} seconds was interrupted before it completed. The turn is over.`,
                        },
                    ],
                    details: { timeout, status },
                    ...(status === "completed" ? { terminate: true } : { isError: true }),
                });
            };

            const timer = setTimeout(() => complete("completed"), milliseconds);

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
        if (details?.status !== "completed" && details?.status !== "interrupted") {
            // Covers pi's own error results, which carry details: {} —
            // rendering those as a green success would hide the failure.
            const text = result.content[0];
            return new Text(text?.type === "text" ? text.text : "", 0, 0);
        }
        if (details.status === "interrupted") {
            return new Text(theme.fg("warning", `✗ interrupted — ${details.timeout}s sleep cancelled`), 0, 0);
        }
        return new Text(theme.fg("success", `✓ slept ${details.timeout}s — turn ended`), 0, 0);
    },
});

export default function (pi: ExtensionAPI) {
    pi.registerTool(sleepTool);
}
