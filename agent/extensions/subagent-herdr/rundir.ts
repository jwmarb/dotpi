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
 * The reads and writes themselves. This module answers "where does it live and
 * what shape is it", not "go and fetch it": `readReports` stays in `lib.ts`
 * where the parent's async I/O lives, and `appendReport`/`writeSidecar` stay in
 * `child-done.ts` where the child's synchronous, crash-path-sensitive writes
 * live. Paths and shapes are the part both sides must agree on.
 *
 * @module subagent-herdr/rundir
 */

import { readdirSync } from "node:fs";
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

/** How a run ended, as recorded in `meta.json`. */
export type RunStatus = "running" | "done" | "failed" | "cancelled";

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
	 * non-string value is ignored (treated as absent) by {@link isRunRecord};
	 * the reading sites guard with `typeof === "string"` checks.
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
	 * `runId` remains the only record-fatal validation: a present non-string
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
}

/**
 * Is this parsed JSON a usable {@link RunRecord}?
 *
 * The registry is rebuilt by reading every `meta.json` on disk, where a record
 * can be truncated (the parent crashed mid-spawn) or predate a field. Only
 * `runId` is load-bearing for keying the registry. A present non-string
 * `healthCheckOf` is ignored (treated as absent) rather than record-fatal:
 * the reading sites in index.ts guard with `typeof rec.healthCheckOf ===
 * "string"` checks, so a corrupted value cannot key a bogus registry entry.
 */
export function isRunRecord(value: unknown): value is RunRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { runId?: unknown }).runId === "string"
	);
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
