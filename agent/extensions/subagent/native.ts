/**
 * Launch planning for a **Native Run**: a real interactive `pi` TUI in its own
 * herdr **Run Pane** (docs/adr/0044).
 *
 * This module is pure planning — it builds strings and returns them. It opens no
 * panes, spawns no processes and touches no sockets, so every decision here is
 * unit-testable by calling the functions and reading what comes back. The pane is
 * opened by the caller through `herdr/socket.ts`, and the process is started by
 * herdr itself.
 *
 * ## Why a wrapper script at all
 *
 * herdr's plugin API has no command-override field: an `entrypoint` names a fixed
 * argv declared in the plugin manifest, and the only per-open variation available
 * is the environment. Verified twice over — one entrypoint launched three
 * different processes purely by varying one env var, and a direct-argv entrypoint
 * ran with no shell indirection at all. So per-Run variation *must* ride on env,
 * and the generated wrapper is what that env var points at.
 *
 * The rejected alternative is worth naming, because it looks simpler: split a
 * pane, then type the command into its shell (`herdr pane run`). That races
 * against shell init — direnv and devenv swallow the typed command, reproduced
 * ~100% of the time with a swallow threshold near 0.5–1s *even warm*. A race that
 * loses a Mirror Pane is cosmetic; a race that loses a Run is not.
 *
 * ## Why the wrapper does two things after `pi` exits
 *
 * Both are consequences of measured herdr behaviour, and both would otherwise be
 * discovered as data loss:
 *
 * 1. **It records the exit code.** `pane.exited` carries no exit code — not in
 *    the event, and `plugin log list` stays empty even after a deliberate exit 42.
 *    The `.exitcode` sidecar this writes is the *only* source of a Run's exit
 *    status.
 * 2. **It holds itself open on failure.** herdr destroys the pane the instant the
 *    process exits, for clean and failing exits alike, after which `pane read`
 *    returns `pane_not_found` — so scrollback dies with the process. Measured
 *    here: a dispatcher that exited 64 left a pane that was gone in under a
 *    second, taking its diagnostic with it. "Hold the pane open on failure"
 *    therefore cannot be asked of herdr; the wrapper must not exit. That `read -r`
 *    is not a nicety, it is the only thing standing between a failed Run and the
 *    total loss of its evidence.
 *
 * @module native
 */

import path from "node:path";

/**
 * The herdr plugin and entrypoint that host a Native Run.
 *
 * Must match `herdr-plugin/herdr-plugin.toml`. Declared here as constants because
 * a typo in either would surface as a pane that silently never opens.
 */
export const RUN_PLUGIN_ID = "pi-subagents";
export const RUN_ENTRYPOINT = "run";

/**
 * The env var naming the per-Run wrapper script.
 *
 * Read by `herdr-plugin/dispatch.sh`, which execs whatever path this holds. The
 * one piece of per-Run variation the pane request carries; everything else is
 * baked into the wrapper itself, so the pane request stays a single string and
 * cannot grow a quoting problem.
 */
export const WRAPPER_ENV_VAR = "PI_RUN_WRAPPER";

/**
 * How long a failed Run's pane is held open before it gives up waiting.
 *
 * A failure holds the pane with a `read -r`, which waits for a keypress. This
 * bound exists so an unattended machine does not accumulate panes forever: a
 * failure nobody looked at in an hour is a failure whose pane can go. An hour
 * rather than minutes because the whole point is that the user reads it, and they
 * may not be at the keyboard when it happens.
 */
export const FAILURE_HOLD_SECONDS = 3600;

/**
 * The tools that let a **Native Run** delegate in turn.
 *
 * Named as a constant rather than inlined so the grant is greppable: this is the
 * exact capability ADR 0040 said to guard, and it is safe only while the **Spawn
 * slot** budget is tree-wide. Anyone narrowing that budget back to one process
 * must remove these in the same change.
 */
export const NESTING_TOOLS = ["subagent", "subagent_tasks"] as const;

/** Shell-quote one argument for safe interpolation into the wrapper. */
function sq(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Inputs for planning one Native Run's launch. */
export interface NativeLaunchOptions {
	/** The Run's id, which is also its session id. */
	runId: string;
	/** The Run's own session directory, `<agentDir>/subagent-sessions/<runId>`. */
	sessionDir: string;
	/** Working directory for the child. */
	cwd: string;
	/**
	 * How to invoke `pi`, as a full argv prefix rather than a single path.
	 *
	 * Must be a prefix, not a binary: pi may be running as a *script* under a
	 * generic runtime, in which case invoking it takes two words —
	 * `/path/to/node /path/to/pi/cli.js`. Passing only the executable sent pi's
	 * flags to bare `node`, which rejected `--session-dir` and exited 9. Prefer
	 * `getPiInvocation([])`, which resolves all three cases (script under a
	 * runtime, a real pi executable, or a bare `pi` on PATH).
	 */
	piCommand: string[];
	/** Absolute path to the child-side done extension, loaded with `-e`. */
	doneExtensionPath: string;
	/** Tool allowlist for the child; already includes the done tool. */
	tools: string[];
	/** Model override, e.g. `openai/gpt-5.6-sol` or with a `:thinking` suffix. */
	model?: string;
	/** Absolute path to the composed system prompt, passed by file not by value. */
	systemPromptPath?: string;
	/** The task text delivered as the child's opening prompt. */
	task: string;
	/** Plan key the child's plan tool should address (docs/adr/0012). */
	planKey: string;
}

/** A planned launch: what to write, and what to ask herdr for. */
export interface NativeLaunchPlan {
	/** Where the wrapper script must be written before the pane is opened. */
	wrapperPath: string;
	/** The wrapper's contents. */
	wrapperSource: string;
	/** Env for the pane request. */
	paneEnv: Record<string, string>;
	/** The `pi` argv the wrapper will exec, exposed for tests and diagnostics. */
	piArgv: string[];
}

/**
 * Build the tool allowlist for a Native Run's child.
 *
 * The done tool is *always* appended, even to a tightly restricted agent, because
 * a child that cannot report completion cannot finish: its Run would hang until
 * the stall watchdog fired. So the one tool that ends a Run is never something an
 * agent definition can accidentally omit — which is also why none of the agent
 * files needed editing for ADR 0044.
 *
 * **Nesting.** A **Native Run** may delegate in turn, so `subagent` and
 * `subagent_tasks` are granted here — but *only* to an agent that already has
 * tools it chose. This grant is exactly what ADR 0040 named as the thing to
 * guard: it is safe solely because the **Spawn slot** budget is now tree-wide, so
 * six means six across the whole descent rather than six per process. Verified
 * before this was switched on: a child process saw its parent's five held slots,
 * took the sixth, and was refused the seventh. If that cap ever reverts to a
 * module-level counter, this grant becomes a fork bomb and must be withdrawn with
 * it.
 *
 * The done tool is added to *every* allowlist; these two are added for the same
 * reason but carry the risk, which is why they are named separately here rather
 * than folded silently into the same line.
 *
 * @param agentTools - The agent definition's declared tools, if any.
 * @param doneTool - Name of the completion tool to guarantee.
 * @param allowNesting - Whether this child may delegate. False for an autonomous
 *        review or rework, which must not be able to route around ADR 0037's
 *        interlock via a different spawner. False does not merely withhold the
 *        grant: a nesting tool the agent itself declared is *removed* from the
 *        result, so the boundary holds no matter what an agent file says.
 * @returns The allowlist, deduplicated, or null when the agent declares no tools
 *          (meaning "every tool", which already includes the done tool).
 */
export function buildSubagentToolAllowlist(
	agentTools: string[] | undefined,
	doneTool: string,
	allowNesting = true,
): string[] | null {
	if (!agentTools || agentTools.length === 0) return null;
	const seen = new Set(agentTools);
	seen.add(doneTool);
	// Nesting: safe only because the Spawn slot budget is tree-wide (docs/adr/0044).
	// Withheld from an autonomous child — a review or rework — because ADR 0037's
	// interlock stops such a child dispatching *reviews*, and handing it `subagent`
	// would route straight around that guard into a different spawner. A reviewer
	// also has no business delegating: its verdict is supposed to be its own
	// reading of the work.
	if (allowNesting) {
		for (const tool of NESTING_TOOLS) seen.add(tool);
	} else {
		// Removed, not merely not added: an agent file may itself declare a nesting
		// tool, and an autonomous child must never hold one — the boundary cannot
		// depend on what any definition happens to say (docs/adr/0037).
		for (const tool of NESTING_TOOLS) seen.delete(tool);
	}
	return [...seen];
}

/**
 * Build the bash wrapper herdr's dispatcher will exec.
 *
 * Uses `cd` rather than a flag because `pi` has no `--cwd`; the process's working
 * directory is the only way to place it. `exec` is deliberately *not* used for
 * `pi`, because the wrapper must outlive it to record the exit code and hold the
 * pane on failure.
 *
 * @param opts - The planned launch.
 * @param piArgv - Arguments to `pi`, already ordered with the prompt last.
 * @returns A complete bash script.
 */
export function buildWrapperScript(
	opts: NativeLaunchOptions,
	piArgv: string[],
): string {
	const exitcodePath = path.join(opts.sessionDir, `${opts.runId}.exitcode`);
	return [
		"#!/usr/bin/env bash",
		"# Generated per Run by agent/extensions/subagent/native.ts (docs/adr/0044).",
		"# Not intended to be edited or reused: it is written, exec'd once, and left",
		"# beside the Run's session as a record of how that Run was launched.",
		"",
		// Ctrl+Z would suspend the TUI with no parent shell to foreground it from,
		// wedging the pane in a way the user cannot recover.
		"trap '' TSTP",
		"",
		`cd ${sq(opts.cwd)} || exit 70`,
		"",
		`export PI_PLAN_KEY=${sq(opts.planKey)}`,
		`export PI_SUBAGENT_RUN_ID=${sq(opts.runId)}`,
		`export PI_SUBAGENT_SESSION_DIR=${sq(opts.sessionDir)}`,
		"",
		[...opts.piCommand.map(sq), ...piArgv.map(sq)].join(" "),
		"code=$?",
		"",
		"# The only record of the exit status: pane.exited carries no code, and",
		"# herdr's plugin command log stays empty for plugin panes (docs/adr/0044).",
		`printf '%s\\n' "$code" > ${sq(exitcodePath)} 2>/dev/null || true`,
		"",
		"# herdr destroys the pane the moment this script exits, so a failure that",
		"# returns here leaves no readable trace. Stay alive instead: the pane, and",
		"# therefore the error on screen, survives until the user dismisses it.",
		'if [ "$code" -ne 0 ]; then',
		'  printf "\\n[subagent run failed with exit %s — press Enter to close this pane]\\n" "$code"',
		`  read -r -t ${FAILURE_HOLD_SECONDS} _ || true`,
		"fi",
		"",
		'exit "$code"',
		"",
	].join("\n");
}

/**
 * Plan one Native Run's launch.
 *
 * The prompt is passed as a positional argument and therefore goes **last**,
 * after every flag. `--session-dir` plus `--session-id` are used rather than
 * `--session <path>` so the child mints the session file itself under a directory
 * we chose, which is what lets the run directory stay a published contract
 * (docs/adr/0039) without the parent having to predict a filename that does not
 * exist yet (docs/adr/0036).
 *
 * Note what is absent: no `--mode json`, no `-p`. Those are what make a child a
 * piped **Fallback Run**; a Native Run must be a TUI, which `pi` enters only when
 * stdin and stdout are both TTYs — true inside a herdr pane, and impossible for a
 * child spawned on pipes.
 *
 * @param opts - The Run to launch.
 * @returns The wrapper to write and the pane env to request.
 */
export function buildLaunchPlan(opts: NativeLaunchOptions): NativeLaunchPlan {
	const piArgv: string[] = [
		"-e",
		opts.doneExtensionPath,
		"--session-dir",
		opts.sessionDir,
		"--session-id",
		opts.runId,
	];
	if (opts.model) piArgv.push("--model", opts.model);
	if (opts.tools.length > 0) piArgv.push("--tools", opts.tools.join(","));
	if (opts.systemPromptPath)
		piArgv.push("--append-system-prompt", opts.systemPromptPath);
	// Positional prompt, last: everything after this is treated as the message.
	piArgv.push(opts.task);

	const wrapperPath = path.join(opts.sessionDir, "run-wrapper.sh");
	return {
		wrapperPath,
		wrapperSource: buildWrapperScript(opts, piArgv),
		paneEnv: { [WRAPPER_ENV_VAR]: wrapperPath },
		piArgv,
	};
}
