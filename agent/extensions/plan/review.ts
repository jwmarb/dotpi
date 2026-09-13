/**
 * Autonomous review dispatch: spawning an oracle review and applying its
 * **Verdict** (docs/adr/0032).
 *
 * This module deliberately holds no plan-file logic. It spawns a review, reads
 * a Verdict out of the transcript, and hands the outcome back to the caller,
 * which owns the plan mutation. Keeping the two apart is what lets the whole
 * dispatch path be tested without a plan file, and what stops a review process
 * from becoming a second writer of plan state.
 *
 * The plan extension spawns the review itself rather than asking the
 * orchestrator to, so autonomy does not stop when the orchestrator stops. The
 * cost, recorded in ADR 0032: these reviews are outside the subagent Task
 * registry, so they are invisible to /runs, `subagent_tasks`, Board progress,
 * Mirror Panes and Reminders.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Environment flag marking a pi process as *being* an autonomous review.
 *
 * A review child loads this same plan extension, so without an interlock it
 * would groom items and dispatch reviews of its own — unbounded recursion at
 * roughly ten minutes per oracle run. Any process carrying this flag refuses to
 * dispatch (see {@link dispatchSuppressed}).
 */
export const REVIEW_ENV_FLAG = "PI_PLAN_IN_REVIEW";

/**
 * How long a single review may run before it is abandoned as wedged.
 *
 * Above pi's own worst-case retry ladder (~10.6 min with `maxRetries` 10 capped
 * at 128s) with room for a genuinely long review: the oracle reviews in this
 * repo's history have run 24 turns over ten minutes. A review that outlives this
 * is treated as a dead review, not a Verdict.
 *
 * Raising `retry.maxRetries` or `retry.maxDelayMs` means raising this too, or
 * long-retrying reviews get killed as wedged — the same coupling ADR 0033
 * records for the subagent stall timer.
 */
export const REVIEW_TIMEOUT_MS = 25 * 60 * 1000;

/** Grace between SIGTERM and SIGKILL when abandoning a review. */
const KILL_GRACE_MS = 2000;

/**
 * Hard ceiling on reviews running at once, per process.
 *
 * A backstop, not a scheduler. The recursion interlock and the pi-resolution
 * check should each already make runaway spawning impossible; this exists
 * because they were *also* believed sufficient before a fork bomb took 31GB of
 * the user's RAM. A cap turns any future fault of that class into a handful of
 * wasted processes instead of an unbounded one.
 */
const MAX_CONCURRENT_REVIEWS = 3;

/** Reviews currently in flight in this process. */
let activeReviews = 0;

/**
 * Sentinel written into a review child's `PI_PLAN_KEY`.
 *
 * It must be a non-empty string. An empty string is falsy, and the plan
 * extension branches on `!process.env.PI_PLAN_KEY` to decide whether it is a
 * main session — so `""` made every review child believe it *was* the main
 * session, restoring and re-injecting the plan and spawning a Board.
 */
export const REVIEW_PLAN_KEY = "__review__";


/**
 * Whether this process must not dispatch reviews.
 *
 * True inside a review child (the recursion interlock). Exported so the caller
 * can explain itself rather than silently doing nothing.
 */
export function dispatchSuppressed(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env[REVIEW_ENV_FLAG] === "1";
}

/** Outcome of a dispatched review, before any plan mutation. */
export interface ReviewOutcome {
	/** Raw transcript, kept whole so a dead review can be diagnosed. */
	output: string;
	/** Why no Verdict was reached, or null when one was. */
	deadReason: string | null;
	/** Exit code, or null when the process was killed. */
	exitCode: number | null;
}

/**
 * Determine how to re-invoke `pi`.
 *
 * Mirrors the subagent extension's resolution rather than importing it: the two
 * extensions are deliberately independent, and this is the one piece of
 * knowledge they must share (docs/adr/0032).
 *
 * **This function caused a fork bomb and is now deliberately paranoid.** The
 * subagent version re-invokes `process.argv[1]`, which is sound *there* because
 * that extension only ever runs inside pi, so argv[1] **is** pi. This module can
 * also be imported by a test harness or any other script — and then argv[1] is
 * that script, so "spawn pi" silently became "re-execute myself", each copy
 * spawning another at roughly four per second until the machine's RAM was gone.
 *
 * So the current script is only reused when it actually looks like pi. When it
 * does not, the bare `pi` on PATH is used, and when even that cannot be found
 * the caller is told rather than a guess being executed.
 *
 * @returns The invocation, or null when no pi could be identified.
 */
export function getPiInvocation(
	args: string[],
): { command: string; args: string[] } | null {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	// The script must be recognisably pi itself, not merely present on disk.
	const looksLikePi =
		!!currentScript && /(^|\/)(pi|pi\.[cm]?[jt]s)$/.test(currentScript);
	if (
		currentScript &&
		!isBunVirtualScript &&
		looksLikePi &&
		fs.existsSync(currentScript)
	) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	// A non-generic execPath means the binary IS pi (a compiled single-file build).
	if (!isGenericRuntime) return { command: process.execPath, args };
	// Generic runtime and no pi-looking script: fall back to pi on PATH, but only
	// if it is actually there. Spawning a command that does not exist would be
	// harmless; spawning the wrong one is what burned the machine.
	const onPath = findPiOnPath();
	return onPath ? { command: onPath, args } : null;
}

/** Locate a `pi` executable on PATH, or null. */
function findPiOnPath(): string | null {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, "pi");
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			// Keep looking.
		}
	}
	return null;
}

/**
 * Strip YAML frontmatter from an agent file, returning the body and the model.
 *
 * The plan extension cannot import the subagent extension's agent loader, so it
 * reads the standalone agent file directly. Only the two fields a review needs
 * are extracted; everything else in the frontmatter is ignored rather than
 * half-understood.
 *
 * @param raw - Full contents of the agent markdown file.
 */
export function parseAgentFile(raw: string): {
	body: string;
	model: string | null;
	tools: string[] | null;
} {
	const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
	if (!m) return { body: raw.trim(), model: null, tools: null };
	const fm = m[1];
	const body = raw.slice(m[0].length).trim();
	const modelMatch = /^model:\s*(.+)$/m.exec(fm);
	const toolsMatch = /^tools:\s*(.+)$/m.exec(fm);
	return {
		body,
		model: modelMatch ? modelMatch[1].trim() : null,
		tools: toolsMatch
			? toolsMatch[1]
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: null,
	};
}

/**
 * The instruction appended to oracle's own prompt for an autonomous review.
 *
 * States the Verdict contract in the exact form {@link parseVerdict} accepts.
 * The parser has no prose fallback, so this contract is the only thing standing
 * between a thoughtful review and a dead one.
 */
export function reviewContract(itemText: string, note: string | undefined): string {
	return [
		"## Autonomous review",
		"",
		"You are reviewing one completed Plan Item. Decide whether the work it",
		"describes is actually correct and complete as claimed. Read the code; do",
		"not take the claim on trust.",
		"",
		`**The Item:** ${itemText}`,
		...(note ? ["", `**What the implementer reported:**`, "", note] : []),
		"",
		"### Verdict contract (required)",
		"",
		"End your reply with a verdict as the LAST line, exactly:",
		"",
		"```",
		"VERDICT: pass",
		"```",
		"",
		"Use `pass` if the work is correct and complete, `fail` if it is not, or",
		"`unsure` if you could not establish either way. Nothing may follow that",
		"line — no sign-off, no summary. A missing or malformed verdict is",
		"discarded as a dead review and the work is reviewed again, wasting the",
		"whole run, so put your reasoning ABOVE the line.",
		"",
		"Before the verdict, state your findings plainly: if you fail the Item,",
		"what you write is the only thing a fresh implementer will receive.",
	].join("\n");
}

/**
 * Spawn one oracle review and collect its transcript.
 *
 * Never throws: a failure to spawn, a timeout and a crash all come back as a
 * dead review, because the caller's job is to decide whether to retry, and an
 * exception here would leave a plan Item stuck in `review` with nothing said.
 *
 * @param opts.agentFile - Absolute path to the standalone oracle agent file.
 * @param opts.itemText - The Item under review.
 * @param opts.note - What the implementer reported, if anything.
 * @param opts.cwd - Working directory for the review.
 * @param opts.timeoutMs - Override the abandon deadline (tests use a short one).
 * @param opts.runDir - Where the child should write its session, making the
 *        review observable in `/runs`, on the Board and in a Mirror Pane. Both
 *        this and `runId` must be given, or the review runs unobserved as before.
 * @param opts.runId - The Run ID, which is also the run directory's name.
 * @param opts.spawnFn - Injectable spawn, so the dispatch path is testable
 *        without paying for a real oracle run.
 */
export async function runReview(opts: {
	agentFile: string;
	itemText: string;
	note?: string;
	cwd: string;
	timeoutMs?: number;
	runDir?: string;
	runId?: string;
	spawnFn?: typeof spawn;
}): Promise<ReviewOutcome> {
	const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
	const spawnImpl = opts.spawnFn ?? spawn;

	// The interlock is enforced HERE, at the only place that actually spawns, not
	// merely in dispatchReview. A guard the spawner does not itself apply is a
	// guard any new caller can bypass — which is exactly how the fork bomb got
	// out: a harness called runReview directly and never saw dispatchReview's check.
	if (dispatchSuppressed()) {
		return {
			output: "",
			deadReason:
				"refused to spawn: this process is itself an autonomous review, and a review must not review",
			exitCode: null,
		};
	}
	if (activeReviews >= MAX_CONCURRENT_REVIEWS) {
		return {
			output: "",
			deadReason: `refused to spawn: ${activeReviews} reviews are already running (cap ${MAX_CONCURRENT_REVIEWS})`,
			exitCode: null,
		};
	}
	// The slot is claimed HERE, synchronously with the check above and before any
	// await. Incrementing later (at the spawn) left three awaits — readFile,
	// mkdtemp, writeFile — between test and set, so N concurrent callers all
	// passed the check before any of them counted: a caught regression where 12
	// callers produced 12 spawns against a cap of 3.
	activeReviews++;
	/** Release the slot exactly once, however this call ends. */
	let released = false;
	const releaseSlot = () => {
		if (released) return;
		released = true;
		activeReviews = Math.max(0, activeReviews - 1);
	};


	let raw: string;
	try {
		raw = await readFile(opts.agentFile, "utf-8");
	} catch (err) {
		// Outside the try/finally below, so this path must release its own slot.
		releaseSlot();
		return {
			output: "",
			deadReason: `could not read the oracle agent file at ${opts.agentFile}: ${
				(err as Error).message
			}`,
			exitCode: null,
		};
	}
	const agent = parseAgentFile(raw);

	// The prompt goes through a file: it is far past any safe argv length, and a
	// review prompt embeds arbitrary findings text.
	let tmpDir: string | null = null;
	try {
		tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-plan-review-"));
		const promptPath = path.join(tmpDir, "prompt.md");
		await writeFile(
			promptPath,
			[agent.body, reviewContract(opts.itemText, opts.note)].join(
				"\n\n---\n\n",
			),
			"utf-8",
		);

		const args = ["--mode", "text", "-p", "--append-system-prompt", promptPath];
		// Write the transcript where every existing viewer already looks. Without
		// --session-dir the child writes its session nowhere discoverable, which is
		// the entire reason autonomous reviews were invisible: no /runs row, no Board
		// progress, and a Mirror Pane stuck on "waiting for the run to start…".
		// Verified that a --mode text child does write a readable .jsonl here
		// (docs/adr/0039).
		if (opts.runDir && opts.runId) {
			args.push("--session-dir", opts.runDir, "--session-id", opts.runId);
		}
		if (agent.model) args.push("--model", agent.model);
		if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
		args.push("Review the Plan Item described in your system prompt.");

		const invocation = getPiInvocation(args);
		// No identifiable pi: report it instead of executing a guess. Executing the
		// guess is what re-ran the calling script and exhausted the machine.
		if (!invocation) {
			return {
				output: "",
				deadReason:
					"refused to spawn: could not identify the pi executable to run (not the current script, not the runtime, not on PATH)",
				exitCode: null,
			};
		}
		return await new Promise<ReviewOutcome>((resolve) => {
			let output = "";
			let settled = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const child = spawnImpl(invocation.command, invocation.args, {
				cwd: opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					// The interlock: this child must not dispatch reviews of its own.
					[REVIEW_ENV_FLAG]: "1",
					// Not the reviewed plan's key: a review must not load that plan —
					// including its autonomous mode — as its own. It must still be a
					// NON-EMPTY sentinel, because the plan extension treats a falsy
					// PI_PLAN_KEY as "I am the main session" and would then restore the
					// plan, re-inject it and spawn a Board inside every review child.
					PI_PLAN_KEY: REVIEW_PLAN_KEY,
				},
			});

			const finish = (outcome: ReviewOutcome) => {
				if (settled) return;
				settled = true;
				// The slot is released by the `finally` below, which covers every exit
				// including the ones that never reach here (a failed spawn, a throw
				// while writing the prompt) — one release path, not several.
				clearTimeout(timer);
				if (killTimer) clearTimeout(killTimer);
				resolve(outcome);
			};

			const timer = setTimeout(() => {
				// Abandon rather than wait: a wedged review is invisible (it has no
				// Mirror Pane and no Reminder), so the deadline is the only thing that
				// can end it.
				try {
					child.kill("SIGTERM");
				} catch {
					// Already gone.
				}
				killTimer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						// Already gone.
					}
				}, KILL_GRACE_MS);
				finish({
					output,
					deadReason: `the review produced no verdict within ${
						timeoutMs >= 60000
							? `${Math.round(timeoutMs / 60000)} minutes`
							: `${timeoutMs}ms`
					} and was abandoned as wedged`,
					exitCode: null,
				});
			}, timeoutMs);

			child.stdout?.on("data", (d: Buffer) => {
				output += d.toString();
			});
			// stderr is captured into the same transcript: when a review dies, its
			// error text is the only diagnosis available.
			child.stderr?.on("data", (d: Buffer) => {
				output += d.toString();
			});
			child.on("error", (err) => {
				finish({
					output,
					deadReason: `the review could not be started: ${err.message}`,
					exitCode: null,
				});
			});
			child.on("close", (code) => {
				finish({
					output,
					deadReason:
						code === 0
							? null
							: `the review exited with code ${code} before reaching a verdict`,
					exitCode: code,
				});
			});
		});
	} catch (err) {
		return {
			output: "",
			deadReason: `the review could not be prepared: ${(err as Error).message}`,
			exitCode: null,
		};
	} finally {
		// One release path for every outcome: success, dead review, unidentifiable
		// pi, or a throw. A leaked slot would silently shrink the cap toward zero
		// until no review could ever run again — a quiet failure worse than the
		// noisy one it guards against.
		releaseSlot();
		if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}
