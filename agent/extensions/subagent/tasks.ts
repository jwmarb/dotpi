/**
 * Task registry.
 *
 * A **Task** is one `subagent` tool call and everything it spawns, addressed by
 * a **Task ID**. Tasks run in the background: they survive a failed LLM turn, an
 * aborted tool call, and an idle prompt — but not the death of the pi process
 * (docs/adr/0001-tasks-die-with-orchestrator.md).
 *
 * The registry owns Task lifecycle and lets callers await terminal state. It
 * knows nothing about the tool interface or rendering.
 */

import { randomBytes } from "node:crypto";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentScope } from "./agents.js";
import { extractResult } from "./results.js";

/** Maximum number of Tasks that may be active at once. */
export const MAX_ACTIVE_TASKS = 6;

/** How a Task's Runs relate to each other. */
export type TaskMode = "single" | "parallel" | "chain";

/** Lifecycle state of a Task. */
export type TaskState = "running" | "completed" | "failed" | "canceled";

/** Token usage and cost accumulated across all turns of a single Run. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Create a zeroed usage record. */
export function emptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

/** One model tried for a Run, and how it went. */
export interface ModelAttempt {
	/** Model id, or undefined when the agent declared no explicit model. */
	model?: string;
	/** Why this attempt was abandoned. Absent on the attempt that succeeded. */
	error?: string;
}

/** Result of a single Run — one child pi process against one prompt. */
export interface RunResult {
	agent: string;
	/**
	 * Stable identity for this Run within its Task, e.g. `sub-a3f1-1`.
	 *
	 * A Run had no identity before session files existed: the Task ID addressed
	 * the whole delegation and runs were positional. A Run now owns a session
	 * file and a Mirror Pane (docs/adr/0019, docs/adr/0020), both of which need a
	 * name that survives being handed to another process. This is deliberately
	 * *not* a Task ID: it never addresses a delegation, only one child process.
	 */
	runId: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	/** -1 while the Run is still in flight. */
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	/**
	 * Every model tried for this Run, in order, with why each non-final attempt
	 * was abandoned. Only populated when at least one fallback was used, so an
	 * agent without fallbacks reports exactly as before.
	 */
	modelAttempts?: ModelAttempt[];
	stopReason?: string;
	errorMessage?: string;
	/** Ordinal position within a chain, if any. */
	step?: number;
	/**
	 * Whether this Run shares its Task with siblings.
	 *
	 * Drives labelling only: a lone Run names its Task, while siblings must name
	 * themselves apart. `step` cannot serve here — it is set for chains only.
	 */
	multiRun?: boolean;
	skills?: string[];
	missingSkills?: string[];
	skippedSkills?: string[];
	/** Absolute path of this Run's session file, once known. */
	sessionFile?: string;
	/** Mirror Pane displaying this Run, if one was created (Fallback path only). */
	mirrorPaneId?: string;
	/**
	 * Run Pane *hosting* this Run, when it is a **Native Run** (docs/adr/0044).
	 *
	 * The inverse of `mirrorPaneId` in the way that matters: a Mirror Pane is a
	 * viewport whose closure means "stopped watching", whereas this pane is the
	 * process's home and closing it ends the Run. Both are never set at once —
	 * which of the two is populated is how a reader tells a Native Run from a
	 * Fallback Run after the fact.
	 */
	runPaneId?: string;
	/**
	 * Pane a **Native Run**'s **Run Pane** should be split from: its Task's Tab.
	 *
	 * Carried on the Run rather than passed down the call chain because the Run is
	 * already threaded through every layer between the Task and the spawn site,
	 * and one Tab per Task means the target is a property of where the Run belongs
	 * — not of how it is executed.
	 */
	paneTarget?: string;
	/**
	 * Whether the user closed this Run's **Run Pane** before it finished.
	 *
	 * A distinct outcome rather than a flavour of failure: a Run waved away is not
	 * a Run that went wrong (docs/adr/0044). It still *fails* its Task — no Result
	 * was produced, so a chain must not continue — but it reports the true cause.
	 */
	dismissed?: boolean;
	/**
	 * Why this Run fell back to the piped **Fallback path** despite herdr being up.
	 *
	 * Set only on the silent-downgrade case, which is otherwise invisible: the Run
	 * still succeeds, just without a **Run Pane**, and without this the user would
	 * have no way to tell a deliberate fallback from a broken plugin link.
	 */
	nativeFallbackReason?: string;
	/** Note attached when the Run violated the <result> write-up contract. */
	resultWarning?: string;
}

/**
 * Did a completed Run fail?
 *
 * The single definition of Run failure. It lived as three hand-copied predicates
 * (one in index.ts, two here) which drifted apart: all three tested exit code
 * and stop reason, none tested `errorMessage`, so a child that reported an error
 * and then exited cleanly was reported as a *successful* Run with no output
 * (docs/adr/0033).
 *
 * An `errorMessage` therefore fails the Run on its own, whatever the exit code
 * and stop reason say.
 *
 * A **dismissed** Run fails too, and that is not a contradiction of ADR 0044's
 * insistence that dismissal is not failure: the *outcome* recorded on disk stays
 * `dismissed` so the true cause is never lost, while this predicate answers a
 * narrower question — did the Run produce a Result? A dismissed Run did not, so a
 * chain must not feed its silence to the next step (docs/adr/0044).
 */
export function runFailed(run: RunResult): boolean {
	return (
		run.exitCode !== 0 ||
		run.stopReason === "error" ||
		run.stopReason === "aborted" ||
		run.dismissed === true ||
		typeof run.errorMessage === "string"
	);
}

/** A background Task: one subagent tool call and all of its Runs. */
export interface Task {
	id: string;
	mode: TaskMode;
	state: TaskState;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	/** Agent names involved, in launch order. */
	agentNames: string[];
	runs: RunResult[];
	startedAt: number;
	endedAt?: number;
	/** Aborts every child process belonging to this Task. */
	abort: AbortController;
	/** Set once the Task reaches a terminal state. */
	summary?: string;
	/** True once a Reminder has been delivered for this Task. */
	notified: boolean;
	/**
	 * The herdr Tab hosting this Task's Mirror Panes, when there is one.
	 *
	 * Retained so the Tab can be closed once the Reminder is delivered: the
	 * pane no longer lingers to preserve evidence, because a finished Run is
	 * reopenable from the Run Index instead (docs/adr/0028).
	 */
	tabId?: string;
	/**
	 * The Tab's root pane, which every Run's pane is positioned against.
	 *
	 * On the **Fallback path** run 1 adopts this pane as its Mirror Pane. For a
	 * **Native Run** nothing adopts it — herdr opens each Run Pane by splitting
	 * from it — so it is retained separately from `mirrorPaneId` (docs/adr/0044).
	 */
	tabRootPaneId?: string;
}

/** Snapshot of a Task safe to hand to renderers without exposing internals. */
export interface TaskDetails {
	id: string;
	mode: TaskMode;
	state: TaskState;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	runs: RunSummary[];
}

/** Terminal states — a Task in one of these will never change again. */
export function isTerminal(state: TaskState): boolean {
	return state !== "running";
}

/** Thrown by TaskRegistry.create when the active-Task ceiling is reached. */
export class TooManyTasksError extends Error {
	constructor(readonly activeIds: string[]) {
		super(
			`Too many active background tasks (${activeIds.length}/${MAX_ACTIVE_TASKS}). Wait for or cancel some first via subagent_tasks. Active: ${activeIds.join(", ")}`,
		);
		this.name = "TooManyTasksError";
	}
}

/**
 * Task IDs already used on disk, so a new one cannot land on a retained Run.
 *
 * The registry is memory-only by design (docs/adr/0001), but Run directories
 * survive 90 days — so "unused" has to mean unused *on disk* too, not merely
 * unused by this process. Populated once at session start by `reapSessions`.
 */
let knownDiskTaskIds: ReadonlySet<string> = new Set();

/** Tell the registry which Task IDs already exist on disk. */
export function setKnownDiskTaskIds(ids: Iterable<string>): void {
	knownDiskTaskIds = new Set(ids);
}

/**
 * The in-memory Task registry.
 *
 * Storage is memory-only by design: since Tasks die with the process, disk
 * persistence would buy only `/reload` resilience while adding a retention
 * policy and stale-file handling.
 */
export class TaskRegistry {
	private readonly tasks = new Map<string, Task>();
	/** Promise resolvers waiting on specific Tasks reaching terminal state. */
	private readonly waiters = new Set<{
		ids: Set<string>;
		resolve: () => void;
	}>();
	/** Callbacks fired when a Task reaches a terminal state. */
	private readonly completionListeners = new Set<(task: Task) => void>();

	/**
	 * Generate an unused Task ID.
	 *
	 * Random, not sequential, so a wrong ID is an obvious miss rather than a
	 * plausible hit on somebody else's Task.
	 *
	 * Four bytes, not two. Two gave a 65,536-value space checked only against the
	 * in-memory registry — which dies with the process, while Run directories live
	 * 90 days — so a new Task could reuse a retained Run's directory and bind a
	 * viewer to another Run's transcript. Measured against retained Runs, the
	 * chance of *some* collision was 26% at 200 and 85% at 500; four bytes make
	 * that 0.0005% and 0.003% while staying short enough to type in `/run`
	 * (docs/adr/0036).
	 */
	private mintId(): string {
		for (let attempt = 0; attempt < 100; attempt++) {
			const id = `sub-${randomBytes(4).toString("hex")}`;
			if (!this.tasks.has(id) && !knownDiskTaskIds.has(id)) return id;
		}
		// Vanishingly unlikely; widen the space rather than loop forever.
		return `sub-${randomBytes(8).toString("hex")}`;
	}

	/**
	 * Register a new Task in the running state.
	 *
	 * @throws When the active-Task ceiling is already reached. The check lives
	 * here, not at the call site, because a caller that checks and then awaits
	 * (e.g. a confirmation dialog) can be overtaken by a concurrent tool call.
	 */
	create(params: {
		mode: TaskMode;
		agentScope: AgentScope;
		projectAgentsDir: string | null;
		agentNames: string[];
		runs: RunResult[];
	}): Task {
		const active = this.active();
		if (active.length >= MAX_ACTIVE_TASKS)
			throw new TooManyTasksError(active.map((t) => t.id));

		const task: Task = {
			id: this.mintId(),
			mode: params.mode,
			state: "running",
			agentScope: params.agentScope,
			projectAgentsDir: params.projectAgentsDir,
			agentNames: params.agentNames,
			runs: params.runs,
			startedAt: Date.now(),
			abort: new AbortController(),
			notified: false,
		};
		this.tasks.set(task.id, task);
		return task;
	}

	get(id: string): Task | undefined {
		return this.tasks.get(id);
	}

	all(): Task[] {
		return Array.from(this.tasks.values());
	}

	active(): Task[] {
		return this.all().filter((t) => !isTerminal(t.state));
	}

	/** Tasks that finished but whose Reminder has not yet been delivered. */
	pendingNotification(): Task[] {
		return this.all().filter((t) => isTerminal(t.state) && !t.notified);
	}

	/** Move a Task to a terminal state and wake anything waiting on it. */
	finish(id: string, state: Exclude<TaskState, "running">, summary: string): void {
		const task = this.tasks.get(id);
		if (!task || isTerminal(task.state)) return;
		task.state = state;
		task.summary = summary;
		task.endedAt = Date.now();

		for (const listener of this.completionListeners) {
			try {
				listener(task);
			} catch {
				// A broken listener must not strand the Task or its waiters.
			}
		}
		this.wakeWaiters(id);
	}

	/** Request cancellation. The Task's own runner marks it canceled. */
	cancel(id: string): boolean {
		const task = this.tasks.get(id);
		if (!task || isTerminal(task.state)) return false;
		task.abort.abort();
		return true;
	}

	/** Cancel every active Task. Returns the IDs that were cancelled. */
	cancelAll(): string[] {
		const ids: string[] = [];
		for (const task of this.active()) {
			task.abort.abort();
			ids.push(task.id);
		}
		return ids;
	}

	onCompletion(listener: (task: Task) => void): () => void {
		this.completionListeners.add(listener);
		return () => this.completionListeners.delete(listener);
	}

	private wakeWaiters(finishedId: string): void {
		for (const waiter of [...this.waiters]) {
			waiter.ids.delete(finishedId);
			if (waiter.ids.size === 0) {
				this.waiters.delete(waiter);
				waiter.resolve();
			}
		}
	}

	/**
	 * Block until all named Tasks reach a terminal state.
	 *
	 * @param ids - Task IDs to await. Unknown or already-terminal IDs are skipped.
	 * @param timeoutMs - Optional cap; resolves false when it expires first.
	 * @returns True if every Task settled, false on timeout.
	 */
	async waitFor(
		ids: string[],
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<boolean> {
		const pending = new Set(
			ids.filter((id) => {
				const task = this.tasks.get(id);
				return task && !isTerminal(task.state);
			}),
		);
		if (pending.size === 0) return true;

		let settle!: () => void;
		const done = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const waiter = { ids: pending, resolve: settle };
		this.waiters.add(waiter);

		// Racers that let the caller escape without the Tasks having landed.
		const races: Promise<boolean>[] = [done.then(() => false)];
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;

		if (timeoutMs !== undefined)
			races.push(
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(true), timeoutMs);
				}),
			);

		// Without this an unbounded wait is uninterruptible: aborting the turn
		// would leave the tool call parked on a promise nothing resolves.
		if (signal)
			races.push(
				new Promise<boolean>((resolve) => {
					if (signal.aborted) return resolve(true);
					onAbort = () => resolve(true);
					signal.addEventListener("abort", onAbort, { once: true });
				}),
			);

		const gaveUp = await Promise.race(races);

		if (timer) clearTimeout(timer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		// A waiter that gave up must be unregistered or it leaks and later
		// mis-resolves when unrelated Tasks finish.
		this.waiters.delete(waiter);
		return !gaveUp;
	}

	/** Wait for every currently active Task. Used to drain before headless exit. */
	async drain(timeoutMs?: number): Promise<boolean> {
		const ids = this.active().map((t) => t.id);
		if (ids.length === 0) return true;
		return this.waitFor(ids, timeoutMs);
	}

	toDetails(task: Task): TaskDetails {
		return {
			id: task.id,
			mode: task.mode,
			state: task.state,
			agentScope: task.agentScope,
			projectAgentsDir: task.projectAgentsDir,
			runs: task.runs.map(summarizeRun),
		};
	}
}

/**
 * A Run reduced to what a renderer needs, with no Transcript.
 *
 * `details` payloads are persisted to the session file, so embedding full child
 * message streams there would grow it without bound for data only the TUI reads.
 */
export interface RunSummary {
	agent: string;
	step?: number;
	state: "running" | "done" | "failed";
	/** The extracted Result, or the error text when the Run failed. */
	text: string;
	warning?: string;
	turns: number;
	cost: number;
	model?: string;
	/** Present only when a fallback model was used. */
	modelAttempts?: ModelAttempt[];
}

/** Reduce a Run to a transcript-free summary. */
export function summarizeRun(run: RunResult): RunSummary {
	const base = {
		agent: run.agent,
		step: run.step,
		turns: run.usage.turns,
		cost: run.usage.cost,
		model: run.model,
		modelAttempts: run.modelAttempts,
	};

	if (run.exitCode === -1)
		return { ...base, state: "running", text: "" };

	const failed = runFailed(run);

	if (failed)
		return {
			...base,
			state: "failed",
			text:
				run.errorMessage ||
				run.stderr.trim().split("\n").slice(-3).join("\n") ||
				"(no error detail)",
		};

	const extracted = extractResult(run.messages);
	return {
		...base,
		state: "done",
		text: extracted.text,
		// A **Native Run** is not held to the `<result>` contract: ADR 0044 retired it
		// for that path, because the payload is read from the child's transcript
		// instead of scraped out of its prose. Warning here would scold every native
		// Run for obeying its own design, and would train the reader to ignore a
		// warning that still means something on the Fallback path.
		warning: run.runPaneId ? undefined : extracted.warning,
	};
}

/** Aggregate cost and turns across a Task's Runs. */
export function aggregateUsage(runs: RunResult[]): {
	cost: number;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
} {
	const total = {
		cost: 0,
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
	for (const r of runs) {
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
	}
	return total;
}

/**
 * One-line note describing fallback usage, or null when no fallback happened.
 *
 * The orchestrator needs to know it did not get the model it asked for: a
 * weaker fallback changes how much the Result should be trusted.
 */
export function formatFallbackNote(run: RunResult): string | null {
	const attempts = run.modelAttempts;
	if (!attempts || attempts.length < 2) return null;
	const failed = attempts.slice(0, -1);
	const final = attempts[attempts.length - 1];
	const tried = failed
		.map((a) => `${a.model ?? "default"} (${a.error ?? "failed"})`)
		.join(", ");
	const outcome = final.error
		? `all fallbacks exhausted, last was ${final.model ?? "default"}`
		: `succeeded on fallback ${final.model ?? "default"}`;
	return `[fallback] primary failed: ${tried}; ${outcome}.`;
}

/**
 * Render a Task's Results for the orchestrator.
 *
 * Deliberately excludes Transcripts and tool calls: the orchestrator needs the
 * answer, not the method (see CONTEXT.md, "Result" vs "Transcript").
 */
export function formatTaskResults(task: Task): string {
	const lines: string[] = [];
	const usage = aggregateUsage(task.runs);
	const costNote = usage.cost > 0 ? ` ($${usage.cost.toFixed(4)})` : "";
	lines.push(`Task ${task.id} [${task.mode}] ${task.state}${costNote}`);

	for (const run of task.runs) {
		const label = run.step ? `step ${run.step}: ${run.agent}` : run.agent;
		lines.push("");

		if (run.exitCode === -1) {
			// Two very different things land here: a chain step that legitimately
			// never started after an earlier step failed (no detail to give), and a
			// Run that threw before spawn (detail exists and is the whole story).
			// Reporting both as a bare "did not run" hides real crashes.
			const why =
				run.errorMessage || run.stderr.trim().split("\n").slice(-3).join("\n");
			lines.push(`── ${label} — did not run`);
			if (why) lines.push(why);
			continue;
		}

		const failed = runFailed(run);

		if (failed) {
			const why =
				run.errorMessage ||
				run.stderr.trim().split("\n").slice(-3).join("\n") ||
				"(no error detail)";
			lines.push(`── ${label} — FAILED (${run.stopReason ?? `exit ${run.exitCode}`})`);
			const failNote = formatFallbackNote(run);
			if (failNote) lines.push(failNote);
			lines.push(why);
			continue;
		}

		const extracted = extractResult(run.messages);
		lines.push(`── ${label}`);
		const note = formatFallbackNote(run);
		if (note) lines.push(note);
		// Suppressed for a Native Run, which is exempt from the `<result>` contract
		// (docs/adr/0044) — see the matching note in `runSummary`.
		if (extracted.warning && !run.runPaneId)
			lines.push(`[warning] ${extracted.warning}`);
		lines.push(extracted.text || "(no output)");
	}

	return lines.join("\n");
}

/** One-line-per-Run status summary: state, turns, cost. No Transcript. */
export function formatTaskStatus(task: Task): string {
	const usage = aggregateUsage(task.runs);
	const elapsed = Math.round(
		((task.endedAt ?? Date.now()) - task.startedAt) / 1000,
	);
	const header =
		`${task.id} [${task.mode}] ${task.state} — ${elapsed}s, ` +
		`${usage.turns} turn${usage.turns === 1 ? "" : "s"}, $${usage.cost.toFixed(4)}`;

	const runLines = task.runs.map((run) => {
		const label = run.step ? `step ${run.step}: ${run.agent}` : run.agent;
		// A not-yet-started Run in a terminal Task never ran; calling it "running"
		// here while formatTaskResults calls it "did not run" would contradict.
		const state =
			run.exitCode === -1
				? isTerminal(task.state)
					? "did not run"
					: "running"
				: run.exitCode === 0 &&
						run.stopReason !== "error" &&
						run.stopReason !== "aborted"
					? "done"
					: `failed (${run.stopReason ?? `exit ${run.exitCode}`})`;
		return `  ${label}: ${state} — ${run.usage.turns} turn${run.usage.turns === 1 ? "" : "s"}, $${run.usage.cost.toFixed(4)}`;
	});

	return [header, ...runLines].join("\n");
}
