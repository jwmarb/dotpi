/**
 * The layout of a run directory, and the shapes of the files inside it.
 *
 * A delegated run is a directory under `<agentDir>/subagent-runs/<runId>/`
 * holding everything two processes need to agree on:
 *
 * ```
 * subagent-runs/sub-a3f1/
 *   meta.json                     the parent's registry record
 *   system-prompt.md              the child's composed system prompt
 *   reports.jsonl                 child → orchestrator messages, appended
 *   <timestamp>_sub-a3f1.jsonl    the child's session transcript (pi mints it)
 *   <timestamp>_sub-a3f1.jsonl.exit   the completion sidecar
 * ```
 *
 * ## Why this is its own module
 *
 * The contract spans a process seam: the parent (`index.ts`, `lib.ts`) reads
 * what the child (`child-done.ts`) writes. The child is launched with pi's `-e`
 * and imports nothing from the parent, so both halves used to hand-write the
 * same paths and the same JSON shapes — the `.exit` suffix was spelled in two
 * files, `"reports.jsonl"` in two more, and the report record was built in one
 * place and re-validated field-by-field in another. Nothing linked them, so
 * nothing would have caught them drifting apart.
 *
 * pi's extension loader resolves a `-e` module's imports through jiti with
 * `tryNative: false`, so a child extension can import its siblings exactly like
 * the parent does. That makes one shared module possible, and a writer and a
 * reader that cannot disagree is worth more than either half's independence.
 *
 * ## What is deliberately not here
 *
 * The async reads and the bulky writes. This module answers "where does it live
 * and what shape is it", and it owns the *small synchronous* reads whose trust
 * rule is part of that shape — `hasExitSidecar`, `readExitSidecarAt`,
 * `readRunRecordFromDisk` and the `listRunCandidates` built from them — because
 * both halves of the handshake, and the child process that imports nothing else
 * from the parent, have to ask the same question of disk. What stays out is the
 * bulk I/O: `readReports` and `extractRunResult` live in `lib.ts` where the
 * parent's async I/O is, and `appendReport`/`writeSidecar` stay in
 * `child-done.ts` where the child's crash-path-sensitive writes are. Paths and
 * shapes, and the one reader of each small file that decides them, are the part
 * both sides must agree on.
 *
 * @module subagent-herdr/rundir
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Directory holding every run's session, sidecar and metadata (gitignored).
 *
 * Takes the agent directory rather than resolving it (`lib/layout.ts` is what
 * resolves it): a path function that accepts its root is testable against a
 * temp directory, and the child already receives its run directory as env, so
 * neither side needs this module to go looking.
 *
 * @param agentDir - pi's agent directory.
 */
export function runsDir(agentDir: string): string {
	return join(agentDir, "subagent-runs");
}

/**
 * One run's directory.
 *
 * Derived from the run id rather than stored: the path is always the same
 * function of the id, and a persisted copy is state that can contradict where
 * the file was actually found (after a moved agent dir, a renamed home, a
 * record copied between machines).
 *
 * @param agentDir - pi's agent directory.
 * @param runId - The run id, e.g. `sub-a3f1`.
 */
export function runDir(agentDir: string, runId: string): string {
	return join(runsDir(agentDir), runId);
}

/**
 * The kanban card id shape (`k3`): `k` plus a positive integer, no leading
 * zero. The canonical mint is `CARD_ID_PATTERN` in `kanban/lib.ts`; this copy
 * lives here because the shape is part of the run record and the seam, and
 * siblings must not import each other. `lib.test.ts` compares the two over a
 * table (k1, k20, k0, K1, k, k999, x1), so a drift in either mint fails the
 * suite.
 */
export const CARD_ID_PATTERN = /^k([1-9][0-9]*)$/;

/** The parent's registry record for a run. */
export function metaPath(runDirPath: string): string {
	return join(runDirPath, "meta.json");
}

/** The child's composed system prompt, passed to pi by path, not by value. */
export function systemPromptPath(runDirPath: string): string {
	return join(runDirPath, "system-prompt.md");
}

/** The child's report log, appended by the child's report tool. */
export function reportsPath(runDirPath: string): string {
	return join(runDirPath, "reports.jsonl");
}

/**
 * The completion sidecar for a session file.
 *
 * Deliberately derived from the session file rather than the run directory: the
 * child knows its session path (pi mints the timestamp prefix) and the parent
 * discovers it by globbing for `*_<runId>.jsonl`, so the sidecar has to hang off
 * whatever that file turned out to be called.
 *
 * @param sessionFile - The child's session transcript path.
 */
export function exitPath(sessionFile: string): string {
	return `${sessionFile}.exit`;
}

/**
 * Does this directory entry look like the session file for `runId`?
 *
 * pi names a session `<timestamp>_<sessionId>.jsonl`, so ownership by run id is
 * unambiguous and a resumed session cannot be mistaken for a different run.
 *
 * @param fileName - A bare file name from the run directory.
 * @param runId - The run id to match.
 */
export function isSessionFileFor(fileName: string, runId: string): boolean {
	return fileName.endsWith(`_${runId}.jsonl`);
}

/**
 * Has the child written its completion sidecar? Synchronous and never throws.
 *
 * One listing of the run directory: a session file for `runId` whose
 * {@link exitPath} sibling is in the same listing. Every filesystem error is
 * "no", because a sidecar nobody can read proves nothing. Shared by the
 * parent's run lifecycle and the kanban board, so "the sidecar is on disk" is
 * decided in one place.
 *
 * @param runDirPath - The run's directory.
 * @param runId - The run id whose session file to look for.
 */
export function hasExitSidecar(runDirPath: string, runId: string): boolean {
	try {
		const names = readdirSync(runDirPath);
		return names.some((n) => isSessionFileFor(n, runId) && names.includes(exitPath(n)));
	} catch {
		return false;
	}
}

/**
 * The one transcript-selection rule, as a pure function over a directory
 * listing: the `.exit`-settled transcript wins, else the newest (ISO-prefixed
 * names sort chronologically). `findSessionFile` and the lifecycle's
 * `evidenceStamp` (a sync reader) share it so a resumed dir fingerprints and
 * answers from the same file; {@link readExitSidecarAt} selects through it so
 * a resumed dir with two sidecars stamps `finishedAt` from the newest settled
 * completion, not from whichever file the directory enumeration surfaced
 * first. The rule lives here because a name rule *is* the layout contract.
 */
export function pickSessionName(names: readonly string[], runId: string): string | undefined {
	const own = names.filter((n) => isSessionFileFor(n, runId));
	if (own.length === 0) return undefined;
	own.sort();
	const settled = own.filter((n) => names.includes(exitPath(n)));
	return settled.length > 0 ? settled[settled.length - 1] : own[own.length - 1];
}

/**
 * When did the child write its completion sidecar? `undefined` when there is
 * none, it cannot be read, or its `at` is not a finite number.
 *
 * Same name rule as {@link hasExitSidecar} (one listing, the sidecar must sit
 * beside a session file for this run id), and the same "a sidecar nobody can
 * read proves nothing" answer for every filesystem or parse error. Where
 * {@link hasExitSidecar} answers *whether*, this answers *when*, which is what
 * a settlement needs to stamp `finishedAt` with the real completion time
 * rather than the time somebody got round to noticing.
 *
 * The session is selected through {@link pickSessionName} — the one
 * transcript-selection rule `findSessionFile` and `evidenceStamp` share — so
 * a resumed dir with two settled transcripts answers from the newest
 * completion, and a newer transcript with *no* sidecar (a post-completion
 * resume) does not shadow the settled one. Selection is by name, before any
 * parse: an *unparseable* sidecar on the selected transcript proves nothing
 * and yields `undefined`, never an older sibling's `at` — a stale completion
 * time is worse than none.
 *
 * @param runDirPath - The run's directory.
 * @param runId - The run id whose session file to look for.
 */
export function readExitSidecarAt(runDirPath: string, runId: string): number | undefined {
	try {
		const names = readdirSync(runDirPath);
		const name = pickSessionName(names, runId);
		if (name === undefined) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(join(runDirPath, exitPath(name)), "utf-8"));
		} catch {
			return undefined;
		}
		const at = (parsed as { at?: unknown } | null | undefined)?.at;
		return typeof at === "number" && Number.isFinite(at) ? at : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Every way a run can stand, as recorded in `meta.json` — the ONE list
 * `RunStatus`, {@link isRunStatus} and the kanban board's reader derive from.
 */
export const RUN_STATUSES = ["running", "done", "failed", "cancelled"] as const;

/** How a run ended (or that it has not), as recorded in `meta.json`. */
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Is `v` one of {@link RUN_STATUSES}? */
export function isRunStatus(v: unknown): v is RunStatus {
	return (RUN_STATUSES as readonly unknown[]).includes(v);
}
/**
 * Can this *record* still produce a `.exit` sidecar — the ONE terminal rule the
 * pending-spawn predicate applies by default, and the mirror of the
 * lifecycle's own legality rule (`run-lifecycle.ts`):
 *
 * - `done` / `cancelled` — the run ended; no sidecar is coming.
 * - `failed` **with** `failedAttempts` — the launch failed before the process
 *   started (no composer, no prompt, nothing left to answer), so a sidecar
 *   can never be coming.
 * - `failed` **without** `failedAttempts` — terminal only **after**
 *   `REVIVAL_WINDOW_MS` has elapsed since it settled (`finishedAt`): that is
 *   the state the lifecycle keeps recoverable (`failed → done` legal exactly
 *   while `failedAttempts === undefined` and the window has not run out), a
 *   pane kept alive as evidence, a composer that may still finish the run.
 *   Measured on the recorded corpus, 12 such records settled `failed` and went
 *   on to write a sidecar, so a rule that released a bare `failed`
 *   *unconditionally* was wrong. The rule now releases them only once the
 *   window has run: while it runs the record keeps holding, and past it the
 *   state is closed in every sense the lifecycle recognises, so it releases.
 *
 * A record, not a status: the question is "can a sidecar still be coming
 * from this run", and only the record answers it — a `failed` status alone
 * cannot.
 *
 * `now` is the caller's clock; the revival-window clause is the only reason a
 * `finishedAt` is consulted. A bare `failed` with a `finishedAt` that is
 * missing or not a finite number is treated as **still recoverable** (pending):
 * a record too broken to say when it closed keeps holding rather than
 * releasing on an untrusted timestamp.
 * A missing or unrecognised `status` is NOT terminal: a broken record keeps
 * holding its parent rather than silently releasing it.
 */
export function isTerminalRecord(rec: RunRecord, now: number): boolean {
	if (rec.status === "done" || rec.status === "cancelled") return true;
	if (rec.status === "failed") {
		// A failed launch attempt means the process never started, so no sidecar
		// is ever coming: terminal now, regardless of the revival window.
		if (rec.failedAttempts !== undefined) return true;
		// A bare `failed` is the lifecycle's recoverable state. It stays pending
		// until REVIVAL_WINDOW_MS has passed since it settled (`finishedAt`);
		// past that the state is closed and releases its waiting parent. A
		// missing or non-finite `finishedAt` fails closed to pending: a record
		// too broken to say when it closed keeps holding.
		const finishedAt = rec.finishedAt;
		if (typeof finishedAt !== "number" || !Number.isFinite(finishedAt))
			return false;
		return now - finishedAt >= REVIVAL_WINDOW_MS;
	}
	return false;
}

/**
 * One launch attempt that failed before the run started.
 *
 * Kept on the record so a failed spawn is diagnosable after the fact. At most
 * one entry exists now (one launch attempt), and `model` names the router the
 * attempt ran on, not a head ref.
 */
export interface FailedAttempt {
	/** The model the attempt ran on — the router, since there is no other path. */
	model?: string;
	/** Why it failed, as reported by the launcher. */
	error: string;
}

/**
 * One delegated run, persisted verbatim as `meta.json`.
 *
 * No `runDir`: see {@link runDir} — the path is derived from `runId`, so storing
 * it would be a second source of truth for something already known.
 */
export interface RunRecord {
	runId: string;
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	paneId?: string;
	tabId?: string;
	status: RunStatus;
	startedAt: number;
	finishedAt?: number;
	/**
	 * Legacy: the launch-fallback model, written by the pre-router launch loop
	 * (one attempt per candidate model). Nothing reads it anymore — it is kept
	 * only so old records stay valid — and nothing writes it. Every launch is
	 * on `fallback/auto`, so `model` plus `fallbackChain` is the whole story;
	 * what answered a given request is the child's own transcript, where each
	 * assistant message names its physical model.
	resolvedModel?: string;
	/**
	 * The runtime fallback chain handed to the child, when it has one.
	 *
	 * Recorded so a reader of a finished run can tell a child that *could* hop
	 * from one that could not, which `resolvedModel` alone no longer answers.
	 */
	fallbackChain?: string[];
	/** The failed launch attempt, when there is one — at most one entry now. */
	failedAttempts?: FailedAttempt[];
	/**
	 * The target run id for a programmatically spawned health-check run. Absent
	 * for ordinary runs (the common case); when present it must be a string, and
	 * a health-check record points back at the run it is diagnosing. A present
	 * non-string value is ignored (treated as absent) by {@link hasRunId} and
	 * {@link isRunRecord}; the reading sites guard with `typeof === "string"` checks.
	 */
	healthCheckOf?: string;
	/**
	 * The herdr pane id of the spawning parent process (from its
	 * `HERDR_PANE_ID`), stamped at spawn. The run dir is global across all pi
	 * processes, so this is what lets a process tell its own records apart from
	 * every other session's: only the owning pane's process may *autonomously*
	 * sweep the run (flush sweep, liveness tick, stranded-release scan).
	 * Absent on legacy records (pre-ownership), which are loadable but
	 * unsweepable — they stay globally queryable, they are just never swept.
	 * `runId` remains the only record-fatal validation ({@link hasRunId}): a present non-string
	 * `ownerPane` is accepted and treated as absent at the guarded read sites
	 * (string equality only), so a corrupted value cannot make a run invisible.
	 */
	ownerPane?: string;
	/**
	 * The kanban card id this delegation does, when the parent passed one. The
	 * child is told the id (env `PI_KANBAN_CARD` + the `## Assigned Kanban Card`
	 * block in its system prompt) and must build its todo list from the card;
	 * the board reads the child's todo progress from its session file and shows
	 * it under the run line. Absent for ordinary runs.
	 */
	card?: string;
	/**
	 * The run id of the process that launched this run, stamped at spawn from
	 * that process's own `PI_SUBAGENT_RUN_ID` — process-stamped, never taken
	 * from model output, the same rule as {@link ownerPane} and the ancestry
	 * chain. Present only for a nested delegation (a child's own child); the
	 * orchestrator's runs have no run id to inherit and leave it absent.
	 *
	 * It exists because `ownerPane` names a *pane*, not a run: an orchestrator
	 * session reuses one pane for days of successive delegations, so the pane
	 * relation cannot say which run did the launching. Old records stay valid
	 * without it — {@link launchedBy} falls back to `ownerPane` — and a present
	 * non-string value is treated as absent (the same rule as `ownerPane` at
	 * the guarded read sites), so a planted value cannot claim a parent.
	 */
	parentRunId?: string;
}

// ---------------------------------------------------------------------------
// Pending spawns: is a run still waiting on runs it launched?
// ---------------------------------------------------------------------------

/**
 * How long another run's unfinished spawn may hold this run's completion open.
 *
 * Measured over the recorded nested runs: p90 duration 31 min, max 67 min, so
 * 75 min clears every case the corpus contains. The bound therefore only ever
 * fires on something that will never finish anyway — a spawn whose pane died
 * silently, or a record planted in the world-writable run dir.
 *
 * It bounds the deferral *decision*: on any re-evaluation after it expires,
 * the spawn no longer counts as pending, so it cannot hold its parent. The
 * bound does not itself wake anything, and nothing watches the expired spawn:
 * the release is noticed by whoever next re-evaluates the *waiting* run — its
 * owner's liveness tick (open while that owner holds any `running` record),
 * or the waiting child's own next `agent_end` / `subagent_done`.
 *
 * Most closed states do not reach this bound: the terminal rule
 * ({@link isTerminalRecord}) releases a `done`, `cancelled`, or
 * `failed`-with-`failedAttempts` record immediately, and a bare `failed` once
 * its `REVIVAL_WINDOW_MS` has run (the state is recoverable — and a spawn that
 * keeps holding — only while the lifecycle still allows `failed → done`). The
 * bound is the residual backstop for what neither the sidecar nor that
 * time-bounded rule releases: a `running` record whose pane died silently, or a
 * record broken enough to say nothing.
 */
export const DEFER_MAX_MS = 75 * 60 * 1000;
/**
 * How long after it settled a bare `failed` run stays the lifecycle's
 * recoverable state (and therefore a pending spawn that keeps holding its
 * parent): six liveness intervals. A false failure is corrected now, not
 * hours later, and after a restart history is not re-read on every tick.
 *
 * Lives here, not in `run-lifecycle.ts`, because the pending-spawn terminal
 * rule in this contract module needs it and `run-lifecycle.ts` imports from
 * this one — the number is spelled once and re-exported by the lifecycle.
 */
export const REVIVAL_WINDOW_MS = 6 * 60_000;

/**
 * Was `rec` launched by `parent`?
 *
 * `parentRunId` decides whenever the record carries a usable one; the legacy
 * `ownerPane` relation is consulted only for records that predate the field.
 * The stamp *wins* rather than narrowing the pane match: a record stamped with
 * a different parent belongs to that parent even when the pane also matches,
 * which is what keeps a pane reused across sessions from adopting unrelated
 * records.
 *
 * Exported because the pending-spawn predicate and the spawns block a parent
 * renders must agree on exactly one parent relation.
 */
export function launchedBy(rec: RunRecord, parent: { runId: string; paneId?: string }): boolean {
	const parentId = typeof rec.parentRunId === "string" ? rec.parentRunId : undefined;
	if (parentId !== undefined) return parentId === parent.runId;
	const owner = typeof rec.ownerPane === "string" ? rec.ownerPane : undefined;
	return owner !== undefined && parent.paneId !== undefined && owner === parent.paneId;
}

/**
 * The runs `run` launched that have not finished — the ONE pending-spawn rule,
 * applied identically by the child that wants to stop and the parent that
 * would otherwise settle it.
 *
 * **Unfinished means: no `.exit` sidecar, and a status that is not terminal**
 * ({@link isTerminalRecord}: `done`, `cancelled`, `failed` *with*
 * `failedAttempts`, or a bare `failed` once `REVIVAL_WINDOW_MS` has passed
 * since it settled — while that window runs a bare `failed` is the lifecycle's
 * recoverable state, so it keeps holding). The sidecar alone was not enough.
 * Some spawns can never write one — a launch that failed before the process
 * started, a run its parent cancelled — and holding the waiting worker for the
 * whole {@link DEFER_MAX_MS} over those defeated the liveness tick that exists
 * to end the wait. A terminal status is written by the owning process, never
 * by the run, so it is not a child's premature claim of done.
 *
 * `DEFER_MAX_MS` is applied here rather than at each caller, measured from the
 * pending spawn's own `startedAt`: one rule, so the child deferring its own
 * completion and the parent declining to settle it cannot disagree about when
 * the wait has run out. A `startedAt` that is not a finite number is treated as
 * expired — a record too broken to say when it started cannot hold anything
 * open.
 *
 * @param run - The run asking, identified by its run id (or, for a record with
 *   no `parentRunId` stamp, by the pane its children were stamped with).
 * @param candidates - Every record the caller can see, with the directory it
 *   was read from ({@link listRunCandidates} produces this shape).
 * @param now - The caller's clock, so the rule is testable without sleeping.
 * @param hasSidecar - "Is this run finished?" — {@link hasExitSidecar} for every
 *   live caller. Injectable only so a replay can ask the same rule *as of* a past
 *   moment (a sidecar counts once its own `at` is no later than that moment)
 *   without a second copy of the rule drifting from this one.
 *
 * @param isTerminal - "Can this spawn still produce a sidecar?" — {@link
 *   isTerminalRecord} on the record for every live caller. Injectable for the
 *   same historical reason: a replay asks about a past moment, and a record's
 *   `status` TODAY (settled since by the migration or its owner) says nothing
 *   about what it was then. A replay that skipped this would read every settled
 *   child as "not pending" and report the whole late population as early.
 *   The predicate receives the caller's `now` (the same value `pendingSpawnsOf`
 *   is given) so the revival-window clause of {@link isTerminalRecord} is
 *   evaluated at the same instant as the {@link DEFER_MAX_MS} bound.
 */
export function pendingSpawnsOf(
	run: { runId: string; paneId?: string },
	candidates: readonly { rec: RunRecord; dir: string }[],
	now: number,
	hasSidecar: (dir: string, runId: string) => boolean = hasExitSidecar,
	isTerminal: (rec: RunRecord, now: number) => boolean = isTerminalRecord,
): RunRecord[] {
	const pending: RunRecord[] = [];
	for (const { rec, dir } of candidates) {
		// A record that *is* the asking run (legacy pane match on its own
		// stamp) is not its own spawn.
		if (rec.runId === run.runId) continue;
		if (!launchedBy(rec, run)) continue;
		if (hasSidecar(dir, rec.runId)) continue;
		if (isTerminal(rec, now)) continue;
		const startedAt = rec.startedAt;
		if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) continue;
		if (now - startedAt >= DEFER_MAX_MS) continue;
		pending.push(rec);
	}
	return pending;
}

/**
 * Reads and validates one run's `meta.json` from a runs dir.
 *
 * The one reader of that file, shared by the parent's registry, its adoption
 * paths and {@link listRunCandidates}. It lives here because its trust rule *is*
 * part of the layout contract: the id must match `RUN_ID_PATTERN` **before** any
 * path is built (so a model-supplied `../x` cannot reach the filesystem through
 * this API, guard in the reader rather than at the call sites), and the record's
 * own `runId` must equal the caller's — the layout assumes that identity, and a
 * mismatch is a partial dir (a crash mid-spawn), not a run.
 *
 * `hasRunId`, not the strict {@link isRunRecord}: a reader must not drop a
 * record whose `status` is missing or unrecognised (an older or truncated
 * `meta.json`).
 *
 * Synchronous on purpose: the input hook that reaches it is synchronous, and
 * the read is one small file.
 *
 * @param runsDir - The runs directory (the `subagent-runs` dir).
 * @param runId - The run id; must match `RUN_ID_PATTERN`.
 */
export function readRunRecordFromDisk(runsDir: string, runId: string): RunRecord | undefined {
	if (!RUN_ID_PATTERN.test(runId)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(metaPath(join(runsDir, runId)), "utf-8"));
	} catch {
		return undefined;
	}
	return hasRunId(parsed) && parsed.runId === runId ? parsed : undefined;
}

/**
 * Every record readable under `bases`, each with the directory it was found in.
 *
 * The candidate set {@link pendingSpawnsOf} and the spawns block are evaluated
 * over. This process's in-memory registry is *not* enough: the runs dir is
 * global to every pi process, a nested child's record may have been written by
 * a process that has since exited, and a profile switch moves the dir — so
 * "does this run have unfinished spawns?" is a question about disk, asked of
 * {@link runDirBases}-shaped bases by whoever holds them.
 *
 * Hostile by assumption: every field of a returned record came out of a
 * world-writable directory, which is why the predicates guard each one
 * (`launchedBy`'s `typeof` checks, {@link pendingSpawnsOf}'s finite
 * `startedAt`) and why the block renderer prints only what matches a pattern.
 *
 * Deduped by run id with the first base winning — the same rule
 * `findRunRecordInAnyBase` applies — so a record present in both this process's
 * dir and a switched profile's dir is counted once.
 */
export function listRunCandidates(bases: readonly string[]): { rec: RunRecord; dir: string }[] {
	const out: { rec: RunRecord; dir: string }[] = [];
	const seen = new Set<string>();
	for (const base of bases) {
		let names: string[];
		try {
			names = readdirSync(base);
		} catch {
			continue; // No such runs dir: nothing to enumerate.
		}
		for (const name of names) {
			if (!RUN_ID_PATTERN.test(name) || seen.has(name)) continue;
			const rec = readRunRecordFromDisk(base, name);
			if (!rec) continue;
			seen.add(name);
			out.push({ rec, dir: join(base, name) });
		}
	}
	return out;
}

/**
 * The bases a process enumerates run records from, in the one order every
 * caller has to agree on: this process's own runs dir, then the switched
 * profile's dir when an in-session profile switch retargeted children there.
 *
 * {@link listRunCandidates} dedupes with the first base winning, so an order two
 * callers disagree about is a record one caller sees and the other does not — and
 * that is exactly the split that would make a delegating worker look finished to
 * its parent while looking waiting to itself. The parent calls this with its own
 * agent dir; a child calls it with the dir it would spawn into. Same function,
 * same answer, by construction.
 */
export function runDirBasesOf(ownRunsDir: string, switchedRunsDir: string): string[] {
	return ownRunsDir === switchedRunsDir ? [ownRunsDir] : [ownRunsDir, switchedRunsDir];
}

/**
 * An `agent` name reduced to what a name is allowed to look like.
 *
 * Every field of a {@link RunRecord} came out of a world-writable directory, and
 * this one is model-supplied at spawn. It is about to be printed into another
 * model's context (the spawns block, the child's own refusal), so anything
 * outside the id shape prints as `"?"`: the text still says how many runs are
 * pending and which ids they are, which is all it exists to say. A run *id* needs
 * no such guard — {@link listRunCandidates} only returns names that already match
 * `RUN_ID_PATTERN`.
 */
export function printableAgent(agent: unknown): string {
	return typeof agent === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(agent) ? agent : "?";
}

/**
 * Does this parsed JSON carry a usable `runId`? The load and adoption guard.
 *
 * The registry is rebuilt by reading every `meta.json` on disk, where a record
 * can be truncated (the parent crashed mid-spawn) or predate a field. Only
 * `runId` is load-bearing for keying the registry, so a record with a missing
 * or unrecognised `status` still loads. A present non-string
 * `healthCheckOf` is ignored (treated as absent) rather than record-fatal:
 * the reading sites in index.ts guard with `typeof rec.healthCheckOf ===
 * "string"` checks, so a corrupted value cannot key a bogus registry entry.
 */
export function hasRunId(value: unknown): value is RunRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { runId?: unknown }).runId === "string"
	);
}

/**
 * Is this parsed JSON a {@link RunRecord} whose `status` is one of
 * {@link RUN_STATUSES}? The strict reader guard: a reader that renders the
 * status (the kanban board) must not trust an unrecognised one. Loading and
 * adoption use {@link hasRunId}, which does not look at `status`.
 */
export function isRunRecord(value: unknown): value is RunRecord {
	return hasRunId(value) && isRunStatus((value as { status?: unknown }).status);
}

/** One child → orchestrator message, one JSON object per line of the log. */
export interface ChildReport {
	/** When it was written (ms), for ordering. */
	at: number;
	message: string;
}

/**
 * Serialise one report as a line for {@link reportsPath}.
 *
 * The trailing newline is part of the format, not the caller's business: the log
 * is append-only from a process that may die mid-write, and the reader drops a
 * partial final line.
 */
export function formatReportLine(message: string, at: number = Date.now()): string {
	return `${JSON.stringify({ at, message } satisfies ChildReport)}\n`;
}

/**
 * Parse one line of {@link reportsPath}, or `undefined` if it is not a report.
 *
 * Tolerates the partial final line of a log being appended to as it is read, and
 * defaults a missing `at` to 0 so an old or truncated record still orders.
 */
export function parseReportLine(line: string): ChildReport | undefined {
	if (!line.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as { message?: unknown }).message !== "string"
	) {
		return undefined;
	}
	const rec = parsed as { at?: unknown; message: string };
	return {
		at: typeof rec.at === "number" ? rec.at : 0,
		message: rec.message,
	};
}

/** The completion sidecar's contents. */
export interface ExitSidecar {
	type: "done";
	at: number;
}

/**
 * Serialise the completion sidecar.
 *
 * The sidecar says *when* a run finished, never what it concluded: the child's
 * transcript already carries the answer, and duplicating it here would put a
 * size limit on something that is already on disk in full.
 */
export function formatExitSidecar(at: number = Date.now()): string {
	return JSON.stringify({ type: "done", at } satisfies ExitSidecar);
}

// ---------------------------------------------------------------------------
// The wake notice: child → orchestrator, carried as a prompt
// ---------------------------------------------------------------------------

/**
 * What a child is telling its orchestrator.
 *
 * - `report` — a mid-run message; the child keeps working.
 * - `done` — the child finished and is shutting down.
 * - `stalled` — a one-shot phase-overrun signal (a stream, or one tool call,
 *   that has gone quiet past its threshold). It is *not* a direct orchestrator
 *   briefing: the parent consumes it and spawns a health check, and that health
 *   check is what actually briefs the orchestrator.
 */
export type NoticeKind = "report" | "done" | "stalled";

/**
 * The reroute annotation of a notice whose parent pane was gone: the original
 * parent it was addressed to, and the ancestor that received it. Present only
 * on a notice the child's delivery walker re-routed (`child-done.ts`).
 */
export interface NoticeReroute {
	/** The original parent's agent name. */
	parentAgent: string;
	/** The original parent's run id. */
	parentRunId: string;
	/**
	 * The surviving ancestor that received the notice, human-readable:
	 * `orchestrator` for the root, or `agent runId`.
	 */
	deliveredTo: string;
}

/** A parsed wake notice. */
export interface Notice {
	runId: string;
	agent: string;
	kind: NoticeKind;
	/** The message body; empty for a bare `done`. */
	text: string;
	/** Set when the notice was re-routed to a surviving ancestor. */
	reroute?: NoticeReroute;
}

/**
 * Serialise a notice for `herdr agent prompt`.
 *
 * This is the *only* way a child reaches a sleeping orchestrator, so the
 * grammar is spelled here rather than at either end: the child formats a
 * notice, and the parent's input hook re-parses it out of its own TUI input.
 * A writer and a reader that cannot disagree is the whole point of this module.
 *
 * The prefix is what lets the orchestrator tell a child's message apart from a
 * human's — the parent swallows anything matching this shape, so a shape that
 * drifted would surface as the orchestrator eating the user's typing.
 */
export function formatNotice(
	runId: string,
	agent: string,
	kind: NoticeKind,
	message = "",
	reroute?: NoticeReroute,
): string {
	const head = `[subagent ${runId} (${agent}) ${kind}]`;
	if (!reroute) return message ? `${head} ${message}` : head;
	const marker = rerouteMarker(reroute);
	return message ? `${head} ${marker} ${message}` : `${head} ${marker}`;
}

/**
 * The reroute marker {@link formatNotice} prepends to the body.
 *
 * Spelled here — not inside `formatNotice` — because the receiver can have to
 * reconstitute it: a marker the receiver decides to treat as ordinary text (a
 * direct delivery whose body happens to carry the marker shape) must come back
 * out of the briefing byte-for-byte the way the child's model typed it, and a
 * second spelling of the marker in the receiver is the drift this module
 * exists to prevent.
 */
export function rerouteMarker(r: NoticeReroute): string {
	return (
		`[rerouted: addressed to parent ${r.parentAgent} ${r.parentRunId}, ` +
		`which has finished; delivered to ancestor ${r.deliveredTo}]`
	);
}

/**
 * The shape {@link formatNotice} produces.
 *
 * Deliberately strict on both ids (`sub-` + four hex, and herdr's agent-name
 * rule): the parent *swallows* every input that matches, so a loose pattern
 * would silently eat a human's message that happened to start with a bracket.
 */
const NOTICE_RE =
	/^\[subagent (sub-[0-9a-f]{4}) \(([a-z][a-z0-9_-]{0,31})\) (report|done|stalled)\][ \t]?([\s\S]*)$/;

/**
 * The reroute marker {@link formatNotice} prepends to the body.
 *
 * Applied only to the body of a notice that already matched {@link NOTICE_RE} —
 * the marker alone is not a notice, and widening `NOTICE_RE` to carry it is
 * the anti-pattern this split exists to avoid (a marker in a human's message
 * must not make the input hook swallow the input).
 */
const REROUTE_RE =
	/^\[rerouted: addressed to parent ([a-z][a-z0-9_-]{0,31}) (sub-[0-9a-f]{4}), which has finished; delivered to ancestor (orchestrator|[a-z][a-z0-9_-]{0,31} sub-[0-9a-f]{4})\][ \t]?([\s\S]*)$/;

/**
 * Parse one wake notice, or `undefined` when the text is not one.
 *
 * `undefined` is the safe answer: the caller passes the input through to the
 * agent untouched, so a human typing something bracket-shaped is never lost.
 *
 * @param text - Raw input text as it arrived in the orchestrator's session.
 */
export function parseNotice(text: string): Notice | undefined {
	const m = NOTICE_RE.exec(text.trim());
	if (!m) return undefined;
	const reroute = REROUTE_RE.exec(m[4]);
	if (reroute) {
		return {
			runId: m[1],
			agent: m[2],
			kind: m[3] as NoticeKind,
			text: reroute[4].trim(),
			reroute: {
				parentAgent: reroute[1],
				parentRunId: reroute[2],
				deliveredTo: reroute[3],
			},
		};
	}
	return { runId: m[1], agent: m[2], kind: m[3] as NoticeKind, text: m[4].trim() };
}

// ---------------------------------------------------------------------------
// The ancestry chain: what a parent stamps into its child
// ---------------------------------------------------------------------------

/**
 * The env var carrying the delegation ancestry: each ancestor process's pane,
 * run id, and agent, nearest first, `pane|runId|agent` per entry, entries
 * joined by `;`.
 *
 * Stamped by processes, never read from model output — the same rule as
 * `PI_SUBAGENT_LINEAGE` (`../lib/agents.ts`): the parent writes it, the child
 * reads it one process later, so nothing a model says can forge its own
 * ancestry.
 *
 * The delimiters: `;` separates entries because a pane id carries `:` (and an
 * agent name may carry `-`/`_`), and `|` separates fields because none of the
 * three fields may contain it. `PI_SUBAGENT_LINEAGE` owns `,` in
 * `../lib/agents.ts` (`parseLineage`), so the two chains cannot be conflated
 * by a reader that splits on the wrong byte.
 *
 * This lives in `rundir.ts` — not in `../lib/agents.ts` beside the lineage —
 * because both halves of *this* module read it (the parent stamps it via
 * `lib.ts`, the child walks it in `child-done.ts`), and `dynamic-prompt.ts`
 * does not need it.
 */
export const ANCESTRY_ENV = "PI_SUBAGENT_ANCESTRY";

/** The parsed chain's bound: the delivery route has at most this many hops plus the parent. */
export const MAX_ANCESTRY = 8;

/** The run-id shape shared with the notice grammar (`sub-` + four hex). */
export const RUN_ID_PATTERN = /^sub-[0-9a-f]{4}$/;

/** One link in the ancestry chain, nearest ancestor first. */
export interface AncestorEntry {
	/** The ancestor process's herdr pane id. */
	pane: string;
	/** Its run id; `""` for the human's orchestrator (which has no run). */
	runId: string;
	/** Its agent name; `""` for the human's orchestrator. */
	agent: string;
}

/** Serialise an ancestry chain for {@link ANCESTRY_ENV}. */
export function formatAncestry(entries: readonly AncestorEntry[]): string {
	return entries.map((e) => `${e.pane}|${e.runId}|${e.agent}`).join(";");
}

/**
 * Parse an {@link ANCESTRY_ENV} value, dropping malformed entries and
 * truncating to {@link MAX_ANCESTRY}.
 *
 * An entry is well-formed when its pane matches herdr's pane-id alphabet and
 * its runId/agent pair is either both empty (the human's orchestrator) or a
 * valid run id plus a valid agent name. Anything else is dropped rather than
 * fatal: a chain that cannot be read is no chain, and the child then behaves
 * exactly as one whose parent stamped nothing.
 */
export function parseAncestry(raw: string | undefined): AncestorEntry[] {
	if (!raw) return [];
	const out: AncestorEntry[] = [];
	for (const entry of raw.split(";")) {
		if (!entry) continue;
		const [pane, runId, agent] = entry.split("|");
		if (pane === undefined || !/^[A-Za-z0-9:._-]+$/.test(pane)) continue;
		const r = runId ?? "";
		const a = agent ?? "";
		if (r === "" && a === "") {
			out.push({ pane, runId: "", agent: "" });
		} else if (RUN_ID_PATTERN.test(r) && /^[a-z][a-z0-9_-]{0,31}$/.test(a)) {
			out.push({ pane, runId: r, agent: a });
		}
	}
	return out.slice(0, MAX_ANCESTRY);
}

/** The human-facing name of a chain entry: `orchestrator`, or `agent runId`. */
export function ancestorLabel(e: AncestorEntry): string {
	return e.runId === "" ? "orchestrator" : `${e.agent} ${e.runId}`;
}

// ---------------------------------------------------------------------------
// The answer contract: what counts as a finished subagent's answer
// ---------------------------------------------------------------------------

/**
 * Does this agent's own system prompt put its answer under a `<result>`
 * contract?
 *
 * Every agent in `agent/agents/` ends its prompt with "Only what is inside
 * `<result>` reaches the orchestrator", but an agent shipped by a skill
 * (`skills/*​/agents/*.md`) need not, and a future one need not either. So the
 * requirement is *read off the prompt the child was actually launched with*
 * rather than hardcoded here or declared twice in frontmatter: an agent that
 * never mentions the tag is held to the weaker rule, and one that does is held
 * to its own stated contract.
 *
 * @param systemPrompt - The child's composed prompt (`systemPromptPath`), or
 *   `undefined` when it cannot be read.
 */
export function requiresResultBlock(systemPrompt: string | undefined): boolean {
	return !!systemPrompt && systemPrompt.includes("<result>");
}

/**
 * One content part of an assistant message, as little as these rules need.
 *
 * Deliberately structural rather than imported from pi: this module is the
 * parent/child seam and the child reads its own live session while the parent
 * reads JSONL off disk, so the shape has to be described once, here, for both.
 */
export interface VisiblePart {
	type?: string;
	text?: string;
}

/**
 * The visible text of an assistant message: `text` parts only, joined.
 *
 * Lives here, with the predicate that consumes it, because *what text is fed
 * to the rule* is as much of the contract as the rule itself. It was briefly
 * implemented twice — once in `child-done.ts` for the live session, once in
 * `lib.ts` for the transcript — and the two had already diverged on string
 * `content` before they were merged, which is precisely the drift the
 * "one parser per format" convention exists to stop: the child could have
 * passed its gate on a message the parent then read as unanswered.
 *
 * Thinking is excluded, and that exclusion is the point. A report composed
 * inside reasoning is invisible to the orchestrator, however complete it looks
 * in the child's own pane.
 */
export function visibleTextOf(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is VisiblePart =>
				!!part &&
				typeof part === "object" &&
				(part as VisiblePart).type === "text" &&
				typeof (part as VisiblePart).text === "string",
		)
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

/**
 * Does this text carry a complete `<result>` element?
 *
 * The pair is what matters, in order. A model that opened the tag and ran out
 * of output has not delivered a report, and neither has one that wrote the
 * closing tag first — both looked like success to a bare `includes("<result>")`.
 */
export function hasResultBlock(text: string): boolean {
	return /<result>[\s\S]*?<\/result>/.test(text);
}

/**
 * Is this text an answer the orchestrator can actually use?
 *
 * This is the single rule both halves of the handshake apply: the child gates
 * its own completion on it (`child-done.ts`) and the parent decides what to
 * surface with it (`lib.ts`). It lives here, beside the paths and the notice
 * grammar, because it spans the same process seam — and because the two halves
 * disagreeing about what "finished" means is exactly how an answer goes
 * missing. Nine of thirty-seven recorded `explorer` runs ended with the report
 * stranded in a tool argument, in the model's thinking, or nowhere at all,
 * while both ends believed the run had succeeded.
 *
 * Thinking is never passed in: reasoning is not visible to the orchestrator, so
 * a `<result>` composed there is not an answer no matter how complete it is.
 *
 * @param text - Candidate answer text, already extracted from visible content.
 * @param systemPrompt - The child's composed prompt, for {@link requiresResultBlock}.
 */
export function qualifiesAsAnswer(text: string, systemPrompt: string | undefined): boolean {
	if (!text.trim()) return false;
	return requiresResultBlock(systemPrompt) ? hasResultBlock(text) : true;
}

/**
 * Minimum length for a stranded payload to be worth surfacing as a report.
 *
 * Set from the real cases: the three recorded runs that handed their write-up
 * to the tool passed 7.5 KB, 9.2 KB and 17.4 KB, while the filler lines they
 * left as their visible "answer" were 48, 62 and 63 characters. Anything in
 * between is not a judgement this function can make well, so the bar sits far
 * above the filler and far below the reports.
 */
export const SUBSTANTIAL_ANSWER_CHARS = 400;

/**
 * The cap on the transcript tail a completion-evidence read may take.
 *
 * The completion boundary (the `subagent_done` call, or the last assistant
 * message) sits at the end of a finished run's transcript, so a bounded tail
 * is enough to find a clean answer — and the read can sit on a serialized
 * path (the wake path's parent proof, the board's ladder) where a
 * multi-megabyte whole-file read would block every briefing. Two readers
 * bound at the same 4 MB and share this one name so they cannot drift: the
 * wake path's evidence read (`index.ts`) and the kanban board's ladder top
 * rung (`kanban/runs.ts`). Measured 2026-10-30 over the recorded corpus
 * (554 run dirs, 546 session transcripts — `2026*.jsonl`, not the `*.jsonl` glob, which counts the `reports.jsonl` sidecars), each quantity labelled: max transcript
 * 7.90 MB (file size, not the gating quantity), p90 transcript ~1.0 MB,
 * largest single line 985 KiB (1,008,398 B), max gap from EOF to a todo snapshot's line
 * start 2.67 MiB (~2.7 MB) — the gap, not the size, is what the cap gates.
 * Every transcript past the cap carries a `.exit` sidecar and keeps its
 * completion boundary inside the last 4 MB, so the cap is safe today.
 */
export const EVIDENCE_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Is this *salvaged* text worth showing the orchestrator?
 *
 * Deliberately weaker than {@link qualifiesAsAnswer}, and only ever applied
 * after the fact, to text the child already committed somewhere unintended.
 * The distinction matters because the two questions are different:
 *
 * - The **gate** asks "may this run finish?", while the child can still fix it.
 *   There it must be strict, or the contract is not a contract.
 * - **Salvage** asks "is there anything here worth forwarding?", once the run
 *   is over and the alternative is `(no final answer in transcript)`.
 *
 * Measured against the real failures, strictness here would discard every one:
 * all three reports handed to `subagent_done` were truncated mid-document (the
 * model spent its output budget on an argument it should not have been writing)
 * or carried no tags at all, so none has a closing `</result>`. A 17 KB map
 * with a missing tag is still the recon the orchestrator asked for.
 *
 * So: a complete `<result>` always qualifies, and so does any substantial
 * text. A short line never does — that is the filler this whole fix exists to
 * stop being mistaken for an answer.
 *
 * Length is the only extra signal, deliberately. Requiring even an *opening*
 * `<result>` was tried and measured against the real runs: it would have thrown
 * away sub-c459 (7.5 KB) and sub-e987 (9.2 KB), which carried no tags at all.
 * The tag tells you the model remembered the format; it does not tell you
 * whether there is a report, and the report is what the orchestrator needs.
 */
export function qualifiesAsSalvage(text: string, systemPrompt: string | undefined): boolean {
	if (qualifiesAsAnswer(text, systemPrompt)) return true;
	return text.trim().length >= SUBSTANTIAL_ANSWER_CHARS;
}
