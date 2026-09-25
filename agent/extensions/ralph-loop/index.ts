/**
 * Ralph loop — session wiring. Registers `/ralph-loop`, `/ulw-loop`, and
 * `/loop-stop`.
 *
 * The loop is a state machine driven by pi's `agent_settled` event, which is
 * the one event that fires only after auto-retry and auto-compaction have
 * settled — i.e. the agent has genuinely stopped rather than paused. On each
 * settle the loop either detects completion and stops, or injects a
 * continuation prompt and lets the agent go again.
 *
 * Constraints discovered by reading pi's own sources rather than guessing:
 *
 *  1. `agent_settled` is emitted from inside `_runAgentPrompt`'s `finally`
 *     block (`core/agent-session.js`), and `prompt()` throws when the agent is
 *     still streaming. So a continuation is dispatched from `setTimeout(0)`,
 *     after the stack unwinds — never inline in the handler.
 *  2. `ctx.sessionManager` is a `ReadonlySessionManager`, which does NOT expose
 *     `getLastAssistantText()` (that lives on the full session/RPC surface).
 *     The final assistant text is therefore captured from `message_end`.
 *  3. `tool_execution_end` carries no `args`, only `result` — file paths are
 *     collected from `tool_execution_start`.
 *
 * Aborts stop the loop. If the user hits escape, the assistant message lands
 * with `stopReason: "aborted"`; continuing would be the extension fighting the
 * human, which is the one thing an auto-continuation must never do.
 *
 * Only one loop runs per session; starting a second replaces the first.
 *
 * @see lib.ts for the pure logic (parsing, completion/stall detection, prompts)
 */
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_ITERATIONS,
	STALL_LIMIT,
	type LoopState,
	type StopReason,
	completionTag,
	detectCompletion,
	fingerprint,
	isProgress,
	parseArgs,
	renderContinuation,
	renderOpening,
	statusLine,
	stopMessage,
	DEFAULT_MAX_VERIFICATIONS,
	renderRejection,
	type VerificationResult,
} from "./lib.js";
import { type Baseline, captureBaseline, runGate } from "./gate.js";
import { ensureImage } from "./image.js";
import { runRuntimeGate } from "./runtime-gate.js";

/** Footer status key. */
const STATUS_KEY = "ralph-loop";

/**
 * Tools whose use counts as "changed something on disk".
 *
 * Deliberately matches the tools this install actually registers — pi core
 * (`write`, `edit`) plus pi-better-edit (`edit`, `undo_last_edit`). Inventing
 * names like `multi_edit` or `apply_patch` would be dead weight that silently
 * never matches, which is worse than a short list.
 */
const WRITE_TOOLS = new Set(["write", "edit", "undo_last_edit"]);

/**
 * Shell commands that write. `bash` is the main way work reaches disk for many
 * agents (heredocs, `sed -i`, `git commit`, `mv`), and counting it as read-only
 * would throw away the strongest progress signal and cause false stalls. Only a
 * writing *shape* counts, so `grep`/`ls`/`cat` probing stays read-only.
 */
const WRITING_SHELL = /(^|[|;&]\s*)(tee|touch|mkdir|mv|cp|rm|install|patch|git\s+(commit|apply|checkout|mv|rm|add)|npm|bun|pnpm|yarn|cargo|make)\b|>>?\s*\S|sed\s+(-\w*i|--in-place)|python3?\s+-c/;

/**
 * How long to wait for a dispatched continuation to actually start a turn
 * before declaring the loop dead. Generous: the send only has to *begin*, and a
 * busy machine should not trip this.
 */
const DISPATCH_TIMEOUT_MS = 30_000;

/**
 * The agent definition the gate runs as. Its model and tool allowlist are read
 * from `agent/agents/oracle.md`, so the gate stays in sync with the fleet
 * definition instead of hard-coding a model here.
 */
const GATE_AGENT = "oracle";

/**
 * Fallback model if the agent definition cannot be read. Matches oracle.md's
 * declared model so behaviour does not silently change.
 */
const GATE_FALLBACK_MODEL = "openai/gpt-5.6-sol";

/** Provider that serves the gate model (see `agent/extensions/litellm.ts`). */
const GATE_PROVIDER = "litellm";

/** Tool argument keys that carry a file path, in preference order. */
const PATH_KEYS = ["path", "file", "file_path", "filePath"] as const;

export default function activate(pi: ExtensionAPI): void {
	/** The active loop, or undefined when no loop is running. */
	let state: LoopState | undefined;

	/** Handle of the queued continuation, so it can be cancelled on stop. */
	let pendingContinuation: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Most recent context, kept so the watchdog (which fires from a bare timer,
	 * outside any event) has a UI to report through.
	 */
	let lastCtx: ExtensionContext | undefined;

	/**
	 * Repository state when the current loop started, so the gate can tell the
	 * loop's own work from changes that were already in the tree.
	 */
	let baseline: Baseline | undefined;

	/**
	 * Every path the loop has been observed touching, across all iterations.
	 *
	 * Separate from the per-iteration `files` buffer, which resets each turn: the
	 * gate wants the whole loop's footprint, not the last turn's. Advisory only —
	 * shell writes are inferred, so this can be incomplete, and the gate prompt
	 * says so.
	 */
	let touchedPaths = new Set<string>();

	/**
	 * Findings from the most recent gate rejection, so resuming past the cap can
	 * re-send them instead of a generic continuation.
	 */
	let lastRejection: string | undefined;

	/** Which gate produced `lastRejection`, so a resend keeps the right framing. */
	let lastRejectionKind: "static" | "runtime" = "static";

	/**
	 * Absolute path of the running `pi` binary.
	 *
	 * `process.argv[1]` is the script pi was launched as, which is exactly the
	 * binary that owns the extension alias map and the litellm provider. Resolving
	 * `pi` off `PATH` instead would risk finding a different install (see the root
	 * AGENTS.md note on the pre-rename `@mariozechner` copy).
	 */
	const piBinaryPath = (): string => process.argv[1] ?? "pi";

	/** Drop any queued continuation. */
	const cancelPendingContinuation = (): void => {
		if (pendingContinuation !== undefined) {
			clearTimeout(pendingContinuation);
			pendingContinuation = undefined;
		}
	};

	/** Tool names seen during the current iteration. */
	let tools: string[] = [];
	/** File paths touched during the current iteration. */
	let files: string[] = [];
	/** Whether the current iteration wrote to disk. */
	let wrote = false;
	/** Text of the most recent assistant message. */
	let lastText: string | undefined;
	/** Stop reason of the most recent assistant message. */
	let lastStop: string | undefined;

	/** Reset per-iteration observation buffers. */
	const resetObservations = (): void => {
		tools = [];
		files = [];
		wrote = false;
		lastText = undefined;
		lastStop = undefined;
	};

	/** Update (or clear) the footer status. */
	const showStatus = (ctx: ExtensionContext): void => {
		ctx.ui.setStatus(STATUS_KEY, state ? statusLine(state) : undefined);
	};

	/**
	 * Stop the loop and report why.
	 *
	 * Marks the state `stopping` before clearing it, so a continuation already
	 * queued on the macrotask queue sees the flag and does nothing.
	 */
	const stop = (ctx: ExtensionContext, reason: StopReason): void => {
		if (!state) return;
		state.stopping = true;
		const message = stopMessage(state, reason);
		state = undefined;
		cancelPendingContinuation();
		resetObservations();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.notify(message, reason === "complete" ? "info" : "warning");
	};

	/**
	 * Send the next continuation on a fresh macrotask.
	 *
	 * The deferral is not cosmetic. `agent_settled` is emitted from inside
	 * `_runAgentPrompt`'s `finally` *after* `_isAgentRunActive` has already been
	 * set false, so `prompt()` would not refuse the call — it would re-enter
	 * `_runAgentPrompt` within the outer run's own `finally`, nesting agent runs
	 * and emitting a nested `agent_settled` per level. Yielding to the macrotask
	 * queue first lets the outer run finish unwinding.
	 *
	 * The send is wrapped: `pi.sendUserMessage` calls `assertActive()`
	 * synchronously, which throws once the extension runtime has been
	 * invalidated (`/reload`, new session, session switch). An uncaught throw
	 * from a timer callback reaches pi's `uncaughtException` handler, which
	 * exits the process — a loop must never be able to kill the session.
	 */
	const dispatchPrompt = (prompt: string): void => {
		if (!state || state.stopping) return;
		const snapshot = state;
		cancelPendingContinuation();
		pendingContinuation = setTimeout(() => {
			pendingContinuation = undefined;
			// Identity check, not just a null check: `startLoop` replaces `state`
			// wholesale, so a timer from the previous loop must not fire into its
			// successor (it would send the old goal and wipe the new buffers).
			if (state !== snapshot || snapshot.stopping) return;
			resetObservations();
			snapshot.dispatchedAt = Date.now();
			try {
				// expandPromptTemplates:false — a goal starting with "/" must never be
				// re-dispatched as a slash command.
				pi.sendUserMessage(prompt, { expandPromptTemplates: false });
			} catch {
				// The runtime went away under us; abandon the loop silently — there is
				// no live UI left to notify through.
				state = undefined;
			}
		}, 0);

		// Watchdog: if the send was rejected, no turn starts and no `agent_settled`
		// ever arrives, so nothing would re-enter the state machine and the footer
		// would advertise a loop that is actually dead. `agent_start` clears
		// `dispatchedAt`; if it is still set well after the send, give up cleanly.
		setTimeout(() => {
			if (state !== snapshot || snapshot.stopping) return;
			if (snapshot.dispatchedAt === undefined) return;
			if (!lastCtx) return;
			stop(lastCtx, "error");
		}, DISPATCH_TIMEOUT_MS);
	};

	/** Send the ordinary "keep going" continuation. */
	const dispatchContinuation = (stalled: boolean): void => {
		if (!state || state.stopping) return;
		dispatchPrompt(renderContinuation(state, stalled));
	};

	// --- Observation: what did this iteration actually do? -------------------

	// Reset on the real turn boundary, not only when the loop itself dispatches.
	// Otherwise a turn the loop skipped (queued user message) or a user-initiated
	// turn leaves stale tools/files behind — they accumulate across turns and
	// inflate apparent progress — and a stale `lastStop`/`lastText` could be read
	// as completion one settle too late.
	pi.on("agent_start", () => {
		if (!state) return;
		// The send landed and a turn is really running — disarm the watchdog.
		state.dispatchedAt = undefined;
		resetObservations();
	});

	pi.on("tool_execution_start", (event) => {
		if (!state) return;
		tools.push(event.toolName);
		if (WRITE_TOOLS.has(event.toolName)) {
			wrote = true;
		}
		const args = event.args as Record<string, unknown> | undefined;
		if (args) {
			for (const key of PATH_KEYS) {
				const value = args[key];
				if (typeof value === "string") {
					files.push(value);
					// Also accumulate across the whole loop, for the gate's evidence.
					touchedPaths.add(value);
					break;
				}
			}
			// A shell command is both a possible write and a distinguishing mark for
			// the fingerprint: two turns running *different* commands are doing
			// different work even when neither touches a file.
			const command = args.command;
			if (typeof command === "string") {
				files.push(`$ ${command}`);
				if (WRITING_SHELL.test(command)) {
					wrote = true;
				}
			}
		}
	});

	// ReadonlySessionManager has no getLastAssistantText(), so the final text and
	// stop reason are captured here as messages finalize.
	pi.on("message_end", (event) => {
		if (!state) return;
		const message = event.message as {
			role?: string;
			content?: unknown;
			stopReason?: string;
		};
		if (message.role !== "assistant") return;

		lastStop = message.stopReason;
		let text = "";
		if (Array.isArray(message.content)) {
			for (const part of message.content) {
				const chunk = part as { type?: string; text?: string };
				if (chunk.type === "text" && typeof chunk.text === "string") {
					text += chunk.text;
				}
			}
		}
		lastText = text;
	});

	// --- The loop edge -------------------------------------------------------

	pi.on("agent_settled", (_event, ctx) => {
		lastCtx = ctx;
		// Two latches, two distinct states: `awaitingDecision` holds while the cap
		// dialog is open, `verifying` while a gate audit runs. A settle arriving
		// during either must not open a second dialog, launch a second audit, or
		// dispatch a continuation underneath one.
		if (!state || state.stopping) return;
		if (state.awaitingDecision || state.verifying) return;

		// The user took over: a queued message is theirs, not ours.
		if (ctx.hasPendingMessages()) return;

		// The user (or an error) ended the turn. Either way, do not re-prompt.
		if (lastStop === "aborted") {
			stop(ctx, "cancelled");
			return;
		}
		if (lastStop === "error") {
			stop(ctx, "error");
			return;
		}

		// 1. Progress accounting runs FIRST, before the completion branch, so that a
		// turn which claims completion is still judged on what it actually did. A
		// turn that only re-emits the tag without fixing anything is a stall.
		const current = fingerprint(tools, files, lastText);
		if (isProgress(current, state.lastFingerprint, wrote)) {
			state.stallCount = 0;
			state.nudged = false;
		} else {
			state.stallCount += 1;
		}
		state.lastFingerprint = current;

		// 2. Completion claimed? Either accept it, or send it to the gate.
		if (detectCompletion(lastText, state.promise)) {
			if (state.verify === "off") {
				stop(ctx, "complete");
				return;
			}
			// The gate has its own budget: audits are expensive, so a loop that keeps
			// re-claiming completion must not buy unlimited frontier-model calls.
			if (state.verifications >= state.maxVerifications) {
				stop(ctx, "verification-limit");
				return;
			}
			void verifyCompletion(ctx, lastText ?? "");
			return;
		}

		// 3. Stalled? Nudge once, then bail.
		if (state.stallCount >= STALL_LIMIT) {
			stop(ctx, "stalled");
			return;
		}
		const shouldNudge = state.stallCount > 0 && !state.nudged;
		if (shouldNudge) {
			state.nudged = true;
		}

		// 4. Cap reached? Ask rather than dying quietly.
		if (state.iteration >= state.maxIterations) {
			void askToContinue(ctx);
			return;
		}

		// 5. Otherwise: go again.
		state.iteration += 1;
		showStatus(ctx);
		dispatchContinuation(shouldNudge);
	});

	/**
	 * Audit a completion claim, then act on the verdict.
	 *
	 * Detached (`void`-called) from the settled handler: the audit is a child
	 * process taking tens of seconds, and `agent_settled` handlers must return
	 * promptly. `pi.exec` is async, so awaiting it here does not block the event
	 * loop — the hazard being managed is state re-entry, not CPU blocking.
	 *
	 * Every exit path clears the `verifying` latch and re-checks that the loop it
	 * started with is still the live one, because anything can happen across an
	 * await: `/loop-stop`, a session switch, or a replacement loop.
	 *
	 * @param ctx Context at the time of the claim.
	 * @param claim The agent's final message — the claim under audit.
	 */
	const verifyCompletion = async (
		ctx: ExtensionContext,
		claim: string,
	): Promise<void> => {
		const snapshot = state;
		if (!snapshot || snapshot.stopping) return;

		snapshot.verifying = true;
		snapshot.verifications += 1;
		const budget = `${snapshot.verifications}/${snapshot.maxVerifications}`;

		/** Act on the decisive verdict. */
		const finish = (decided: VerificationResult, from: "static" | "runtime"): void => {
			// `finally` above has not run yet when this is called from inside `try`,
			// so release the latch here too; both are idempotent.
			snapshot.verifying = false;
			snapshot.verifyPhase = undefined;

			// The loop may have been stopped or replaced while the gate ran. A stale
			// verdict must never stop or steer its successor.
			if (state !== snapshot || snapshot.stopping) return;

			if (decided.verdict === "approve") {
				stop(ctx, "complete");
				return;
			}

			if (decided.verdict === "inconclusive") {
				// Fail-stop, not fail-open and not fail-closed-by-looping. A broken or
				// undecided gate must not be read as approval, and must not feed
				// infrastructure errors back to the agent as code defects.
				if (decided.reason) {
					ctx.ui.notify(
						`${from === "runtime" ? "Runtime check" : "Audit"} inconclusive: ${decided.reason}`,
						"warning",
					);
				}
				stop(ctx, "verification-inconclusive");
				return;
			}

			// Rejected. Remember the findings so a cap-extension can re-send them.
			lastRejection = decided.findings;
			lastRejectionKind = from;

			// The claiming turn has already been through progress accounting, so apply
			// the normal rails before spending another iteration on it.
			if (snapshot.stallCount >= STALL_LIMIT) {
				stop(ctx, "stalled");
				return;
			}
			if (snapshot.verifications >= snapshot.maxVerifications) {
				ctx.ui.notify("The final completion claim was rejected.", "warning");
				stop(ctx, "verification-limit");
				return;
			}
			if (snapshot.iteration >= snapshot.maxIterations) {
				void askToContinue(ctx, "rejected");
				return;
			}

			ctx.ui.notify(
				from === "runtime"
					? "The project's checks failed — sending the output back."
					: "Audit rejected the claim — sending findings back.",
				"warning",
			);
			snapshot.iteration += 1;
			showStatus(ctx);
			dispatchPrompt(renderRejection(snapshot, decided.findings, from));
		};

		const evidence = {
			cwd: ctx.cwd,
			startHead: baseline?.startHead,
			startStatus: baseline?.startStatus ?? "",
			touched: [...touchedPaths],
			claim,
		};

		/** Set the footer phase and re-render. */
		const phase = (label: string | undefined): void => {
			if (state !== snapshot) return;
			snapshot.verifyPhase = label;
			showStatus(ctx);
		};

		/** Which gate produced the decisive verdict, for the rejection framing. */
		let kind: "static" | "runtime" = "static";
		let result: VerificationResult;

		try {
			// --- Static pass: oracle reads the repository -------------------------
			if (snapshot.verify === "static" || snapshot.verify === "both") {
				phase("auditing");
				ctx.ui.notify(`Auditing the completion claim (${budget})…`, "info");
				result = await runGate(pi, {
					state: snapshot,
					evidence,
					piBinary: piBinaryPath(),
					provider: GATE_PROVIDER,
					agent: GATE_AGENT,
					fallbackModel: GATE_FALLBACK_MODEL,
				});
				// Short-circuit: a static rejection is already actionable, so there is
				// no reason to spend a container run proving it twice.
				if (result.verdict !== "approve") {
					return void finish(result, "static");
				}
			}

			// --- Runtime pass: the verifier executes the project's checks ----------
			if (snapshot.verify === "runtime" || snapshot.verify === "both") {
				kind = "runtime";
				phase("preparing image");
				const image = await ensureImage(pi, ctx.cwd, (message) => {
					phase(message);
					ctx.ui.notify(`Runtime check: ${message}…`, "info");
				});
				if (state !== snapshot || snapshot.stopping) return;

				if (!image.ok) {
					// No image means no executable evidence. Inconclusive, not approval:
					// "I could not run it" must never read as "it works".
					return void finish(
						{ verdict: "inconclusive", findings: "", reason: image.reason },
						"runtime",
					);
				}

				// A writable scratch dir for screenshots and reports, so the project
				// mount can stay read-only. Created per audit and left on disk: it is
				// the evidence behind the verdict.
				let artifacts: string;
				try {
					artifacts = await mkdtemp(join(tmpdir(), "ralph-artifacts-"));
					// World-writable: the container runs as this uid, but a project
					// Dockerfile may declare its own USER.
					await chmod(artifacts, 0o777);
				} catch (err) {
					return void finish(
						{
							verdict: "inconclusive",
							findings: "",
							reason: `could not create an artifacts directory (${err instanceof Error ? err.message : String(err)})`,
						},
						"runtime",
					);
				}

				phase(image.web ? "running tests + UI" : "running tests");
				ctx.ui.notify(
					`Running the project's checks${image.web ? " and driving the UI" : ""} in ${image.built ? "a new" : "the cached"} container (${budget})…`,
					"info",
				);
				result = await runRuntimeGate(pi, {
					state: snapshot,
					evidence,
					image: image.image,
					artifacts,
					web: image.web,
					piBinary: piBinaryPath(),
					provider: GATE_PROVIDER,
				});
				return void finish(result, "runtime");
			}

			// Reachable only if verify was flipped off mid-flight; treat as approval
			// of the static pass that already ran.
			return void finish({ verdict: "approve", findings: "" }, kind);
		} catch (err) {
			// The gates are written not to throw; this is belt-and-braces so a
			// surprise cannot leave the latch stuck on.
			return void finish(
				{
					verdict: "inconclusive",
					findings: "",
					reason: err instanceof Error ? err.message : String(err),
				},
				kind,
			);
		} finally {
			snapshot.verifying = false;
			snapshot.verifyPhase = undefined;
		}


	};

	/**
	 * At the cap, offer to extend rather than stopping silently.
	 *
	 * Awaits a dialog, so it re-checks that the loop it started with is still
	 * the live one before acting on the answer.
	 */
	const askToContinue = async (
		ctx: ExtensionContext,
		cause: "no-claim" | "rejected" = "no-claim",
	): Promise<void> => {
		const snapshot = state;
		if (!snapshot) return;

		if (!ctx.hasUI) {
			stop(ctx, "max-iterations");
			return;
		}

		// Latch before awaiting, so further settles are ignored while we ask.
		snapshot.awaitingDecision = true;

		let extend: boolean;
		try {
			extend = await ctx.ui.confirm(
				"Ralph loop — iteration cap reached",
				// The two causes are genuinely different situations, and saying
				// "without <promise>DONE</promise>" when the tag WAS present but the
				// audit rejected it would simply be false.
				(cause === "rejected"
					? `${snapshot.iteration} iterations; the audit rejected the last completion claim.\n\n`
					: `${snapshot.iteration} iterations without ${completionTag(snapshot.promise)}.\n\n`) +
					`Run another ${DEFAULT_MAX_ITERATIONS}?`,
			);
		} finally {
			// Always released, so the flag's lifetime is bounded by this call even if
			// the dialog throws.
			snapshot.awaitingDecision = false;
		}

		// The loop may have been stopped or replaced while the dialog was open.
		if (state !== snapshot || snapshot.stopping) return;

		if (!extend) {
			stop(ctx, "max-iterations");
			return;
		}

		snapshot.maxIterations += DEFAULT_MAX_ITERATIONS;
		snapshot.iteration += 1;
		snapshot.stallCount = 0;
		snapshot.nudged = false;
		showStatus(ctx);
		// After a rejection the useful next prompt is the audit's findings, not a
		// generic "your turn did not end with the tag" (which would be untrue).
		if (cause === "rejected" && lastRejection) {
			dispatchPrompt(renderRejection(snapshot, lastRejection, lastRejectionKind));
			return;
		}
		dispatchContinuation(false);
	};

	// --- Safety: never outlive the thing we are looping on -------------------

	// A new or switched session has its own transcript; a loop carried over from
	// the previous one would be prompting into a context it never saw.
	pi.on("session_start", (_event, ctx) => {
		if (state) stop(ctx, "cancelled");
	});

	// Shutdown reaches THIS closure, whereas a reload's `session_start` arrives on
	// a fresh one — so drop the loop and the queued timer here without touching
	// the UI, which may already be gone.
	pi.on("session_shutdown", () => {
		state = undefined;
		cancelPendingContinuation();
	});

	// --- Commands ------------------------------------------------------------

	/** Shared body of `/ralph-loop` and `/ulw-loop`. */
	const startLoop = async (
		args: string,
		ctx: ExtensionContext,
		ultrawork: boolean,
	): Promise<void> => {
		const options = parseArgs(args, ultrawork);
		const name = ultrawork ? "ulw-loop" : "ralph-loop";

		let task = options.task;
		if (!task) {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`Usage: /${name} <goal> [--max-iterations=N] [--promise=WORD]`,
					"warning",
				);
				return;
			}
			const entered = await ctx.ui.input(
				ultrawork ? "Ultrawork loop — goal" : "Ralph loop — goal",
				"What should the agent work on until it is done?",
			);
			if (!entered?.trim()) return;
			task = entered.trim();
		}

		if (state) {
			ctx.ui.notify(
				"Replacing the loop already running in this session.",
				"warning",
			);
			state.stopping = true;
		}

		state = {
			...options,
			task,
			iteration: 0,
			stallCount: 0,
			lastFingerprint: undefined,
			stopping: false,
			awaitingDecision: false,
			dispatchedAt: undefined,
			nudged: false,
			verifying: false,
			verifyPhase: undefined,
			verifications: 0,
			maxVerifications: DEFAULT_MAX_VERIFICATIONS,
		};
		resetObservations();
		touchedPaths = new Set();
		lastRejection = undefined;
		lastRejectionKind = "static";
		baseline = undefined;
		lastCtx = ctx;
		showStatus(ctx);

		// Snapshot the repo before the agent touches anything, so the gate can tell
		// the loop's work from what was already dirty. Fire-and-forget: the audit is
		// many turns away, and a slow `git status` must not delay the first prompt.
		if (options.verify !== "off") {
			const snapshot = state;
			void captureBaseline(pi, ctx.cwd).then((result) => {
				if (state === snapshot) baseline = result;
			});
		}

		// Sent as a user message so the transcript reads as the user asking for
		// the goal — which they did.
		pi.sendUserMessage(renderOpening(state), { expandPromptTemplates: false });
	};

	pi.registerCommand("ralph-loop", {
		description:
			"Loop the agent on a goal until it emits <promise>DONE</promise> (--verify[=static|runtime|both] gates completion on an independent audit and/or containerised test run)",
		handler: async (args, ctx) => {
			await startLoop(args, ctx, false);
		},
	});

	pi.registerCommand("ulw-loop", {
		description:
			"Ralph loop at maximum intensity (ultrawork mode); --verify[=static|runtime|both] gates completion",
		handler: async (args, ctx) => {
			await startLoop(args, ctx, true);
		},
	});

	pi.registerCommand("loop-stop", {
		description: "Stop the running ralph/ultrawork loop",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("No loop is running.", "info");
				return;
			}
			stop(ctx, "cancelled");
		},
	});
}
