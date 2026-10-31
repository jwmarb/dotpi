/**
 * Linked-run status for the kanban board — the one filesystem reader of
 * `subagent-runs/<runId>/meta.json` this extension has, plus a bounded tail
 * read of the run's session JSONL for the child's live todo counts.
 *
 * The *shape* belongs to `subagent-herdr/rundir.ts` (`metaPath`, the strict
 * `isRunRecord` over `RUN_STATUSES`, plus `hasExitSidecar` for the completion sidecar);
 * this module only reads, through those, so the record grammar is still spelled
 * once. Both the extension (settle guard, `show`) and the board process import
 * it, which is why it is separate from the pure `lib.ts`.
 *
 * Status is advisory: it never moves a card. A record still saying `running`
 * after its child wrote the `.exit` sidecar (the parent reconciles lazily) is
 * reported `done`, because the sidecar is what the parent itself classifies by.
 */

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

import {
	hasExitSidecar,
	isRunRecord,
	isSessionFileFor,
	metaPath,
	runDir,
	EVIDENCE_TAIL_BYTES,
} from "../subagent-herdr/rundir.js";
import { counts, parseTodoState } from "../lib/todo.js";
import { RUN_ID_PATTERN, type RunInfo, type RunInfos, type RunTodoCounts } from "./lib.js";

/**
 * The ladder of tail windows `readRunTodos` walks on a miss: the common case
 * is a recent `todo` op near the end of the transcript, so the first pass is
 * small; a miss expands the window before "no list" is concluded, to the cap.
 *
 * The top rung is the shared `EVIDENCE_TAIL_BYTES` — the cap the wake
 * path's evidence read passes — so the two readers bound at the same 4 MB
 * and cannot drift.
 *
 * The bounds are measured, not assumed, 2026-10-30 over the 546 session
 * transcripts (`2026*.jsonl`) in 554 recorded run dirs — a `reports.jsonl`
 * sidecar is not a transcript, so a `*.jsonl` glob inflates that count.
 * The quantity the cap gates is the gap from EOF to
 * the newest snapshot's line start — not the transcript's size: a
 * transcript can be big and its list fresh. Measured, each labelled by
 * quantity: max transcript 7.90 MB (file size, not the gating quantity),
 * p90 transcript ~1.0 MB, max gap from EOF to a snapshot's line start
 * 2.67 MiB (~2.7 MB), p90 gap 0.38 MB, largest single line 985 KiB (the same
 * 1,008,398 B figure the reach bound is derived from). 80 transcripts carry a
 * `todo` snapshot, 19 sit >32 KB from EOF, and the 4 MB cap covers all 80
 * (7 transcripts sit past the cap in size, every one
 * carrying a `.exit` sidecar). A miss with the window already at the cap
 * is evidence the transcript really has no list. A first pass that misses
 * is evidence the window was too small, not that the child never built a
 * list.
 */
const TODO_TAIL_STEPS = [32 * 1024, 512 * 1024, EVIDENCE_TAIL_BYTES];

/**
 * One run's todo progress, read off its session file: the newest `todo` tool
 * result's snapshot, walked backwards.
 *
 * The session is untrusted, append-only JSONL written by a process that may
 * die mid-line, so:
 * - a line that does not parse is skipped — the torn final line is dropped
 *   by the caller before this runs;
 * - a `todo` result whose `details.state` `parseTodoState` refuses does not
 *   win the scan: the scan keeps looking for an older, well-formed one;
 * - an `isError` result is just as good as a successful one: a refused op's
 *   `details` carries the unchanged previous state, which is the state.
 *
 * @param lines - The session's lines, oldest first.
 */
export function parseRunTodos(lines: readonly string[]): RunTodoCounts | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line || !line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as {
			type?: unknown;
			message?: { role?: unknown; toolName?: unknown; details?: unknown };
		};
		if (e.type !== "message" || e.message?.role !== "toolResult" || e.message?.toolName !== "todo") continue;
		const state = parseTodoState((e.message?.details as { state?: unknown } | undefined)?.state);
		if (!state) continue;
		const c = counts(state);
		return { done: c.done, total: c.total, inProgress: c.inProgress, blocked: c.blocked };
	}
	return undefined;
}

/**
 * The `readRunTodos` results, keyed by the resolved session file path. The
 * board re-reads run info on every projection refresh, widget update and
 * `kanban:run-todos` event — a poll at the board's cadence — so a session
 * file whose `<size>:<mtimeMs>` stamp is unchanged is not re-parsed.
 */
const todoCache = new Map<string, { stamp: string; todos: RunTodoCounts | undefined }>();

/**
 * runId → the session file the last read resolved, so a terminal run's cache
 * entry can be dropped without a second directory listing.
 */
const todoFileOf = new Map<string, string>();

/**
 * Offsets the ladder has proven free of todo snapshots, per transcript, with
 * the `size:mtimeMs` stamp they were proven under. The transcript is
 * append-only, so the next read only scans above the offset — and the offset
 * is a newline boundary (the torn tail is re-read next pass), so the region's
 * first line is complete. A live run with no list therefore costs one
 * appended-region read per growth, not the whole ladder (32 KB + 512 KB +
 * 4 MB read AND parsed, synchronously in pi's main loop) on every append, at
 * any size — including a transcript first read past the cap (board restart
 * mid-run, the 60 s liveness tick); there the ladder's 4 MB tail simply never
 * reaches farther from EOF, the measured tradeoff (max gap from EOF to a
 * snapshot's line start 2.67 MiB (~2.7 MB), over 80 recorded todo snapshots,
 * measured 2026-10-30). The stamp guards the size-equal in-place rewrite (a
 * Nextcloud sync restore): an append always changes the size, so a stamp
 * that moves while the size does not is a replaced file, not a grown one.
 * A size that goes DOWN is likewise a replaced file: the marker is a lie,
 * dropped, and the ladder re-proves from scratch. The memo is cleared when a
 * snapshot IS found (the region stops being evidence) and on cache drop —
 * a snapshot DEEPER than the ladder's 4 MiB tail then lives for one poll
 * per stamp change (an idle transcript keeps serving it from the
 * cache): the ladder cannot re-reach it and the memo re-arms at the
 * tail boundary. Measured max gap from EOF 2.67 MiB (~2.7 MB, 2026-10-30) <
 * unreachable in recorded data; it is the reach cost of a capped tail.
 */
const scannedTo = new Map<string, { off: number; stamp: string }>();


/**
 * One chunked or laddered read's outcome: the newest snapshot found (if any),
 * the byte offset the read PROVED free of snapshots (a newline boundary), and
 * whether the read itself failed — a failed read proves nothing and arms
 * nothing.
 */
export interface TodoRead {
	todos?: RunTodoCounts;
	boundary: number;
	failed: boolean;
}

/** What the scan memo permits next: trust the cache, read the growth, or re-prove. */
export type MemoDecision = { kind: "hit" } | { kind: "scan"; from: number } | { kind: "ladder" };

/**
 * What the scan memo proves about a transcript of `size` bytes stamped `stamp`,
 * given the offset the ladder proved (`memo`) under an earlier stamp. The
 * transcript is append-only, so a memo below EOF still holds; every other
 * mismatch is a file the memo was never proven against:
 * - no memo: nothing is proven — walk the ladder.
 * - `off > size`: the file SHRANK (a sync rewrite) — append-only is broken,
 *   the marker proves nothing; the ladder re-proves from scratch.
 * - `off === size`, same stamp: nothing new above EOF — a hit, read nothing.
 * - `off === size`, new stamp: a same-size IN-PLACE REWRITE (a sync restore).
 *   The memo was proven against bytes that are gone; the ladder re-proves.
 * - `off < size`: scan the appended region from the proven offset — the only
 *   arm that reads, and it reads just the growth.
 */
export function memoDecision(memo: { off: number; stamp: string } | undefined, size: number, stamp: string): MemoDecision {
	if (!memo) return { kind: "ladder" };
	if (memo.off > size) return { kind: "ladder" };
	if (memo.off === size) return memo.stamp === stamp ? { kind: "hit" } : { kind: "ladder" };
	return { kind: "scan", from: memo.off };
}
function readRunTodos(dir: string, runId: string): RunTodoCounts | undefined {
	try {
		const names = readdirSync(dir).filter((n) => isSessionFileFor(n, runId));
		if (names.length === 0) return undefined;
		// A run dir can hold more than one session file (a resumed session):
		// 3 of 443 recorded dirs do. The names are ISO-timestamp-prefixed, so
		// lexicographic order is chronological order — the newest wins.
		names.sort();
		const file = join(dir, names[names.length - 1]);
		const prev = todoFileOf.get(runId);
		// resumed dir: the older transcript is gone — drop both caches for it
		if (prev && prev !== file) {
			todoCache.delete(prev);
			scannedTo.delete(prev);
		}
		todoFileOf.set(runId, file);
		// ONE `open` and ONE `fstat` for the whole read: every ladder, region,
		// and tail read below runs against this fd, so the size the stamp
		// reports and the bytes the scan reads are the same file. A failed
		// `open` (an unreadable mode) exits through the outer catch and caches
		// nothing — the next poll re-proves.
		const fd = openSync(file, "r");
		try {
			const st = fstatSync(fd);
			const stamp = `${st.size}:${st.mtimeMs}`;
			const hit = todoCache.get(file);
			if (hit && hit.stamp === stamp) return hit.todos;
			const memo = scannedTo.get(file);
			const d = memoDecision(memo, st.size, stamp);
			if (d.kind === "hit") return undefined; // nothing new above EOF
			// A memo the decision rejected (`ladder`) proved nothing about the
			// file this stamp describes; drop it, the ladder re-proves.
			if (memo && d.kind === "ladder") scannedTo.delete(file);
			// The ladder expands its window on a miss before "no list" is
			// concluded (the measured bound is on TODO_TAIL_STEPS); the scan
			// reads only the appended region above the proven offset.
			const r = d.kind === "scan" ? scanRegion(fd, d.from, st.size) : readLadder(fd, st.size);
			// A failed ladder proves NOTHING — arm nothing. A memo armed at 0
			// from "" would rescan the whole file on every future append.
			if (r.failed) return undefined;
			if (r.todos) scannedTo.delete(file); // a found list is not "no list"
			// Arm on every miss, at the newline boundary of the last window
			// read (see the scannedTo and readLadder docstrings).
			else scannedTo.set(file, { off: r.boundary, stamp });
			todoCache.set(file, { stamp, todos: r.todos }); // cache BOTH arms
			return r.todos;
		} finally {
			closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

/**
 * The byte offset of the end of `text`'s last COMPLETE line, relative to a
 * file of `size` bytes that ends with `text`. Counted in BYTES
 * (`Buffer.byteLength`), matching `st.size`. Transcript JSONL is ASCII-escaped
 * JSON, so UTF-8 bytes and UTF-16 units coincide; for the ill-formed case (a
 * raw multibyte char in a tool payload) `Buffer.byteLength` over-counts a lone
 * surrogate, so the offset lands BEFORE the true line start — it moves into
 * bytes already scanned, it never skips new ones. (The forward direction needs
 * an UNDER-count: invalid bytes collapsing to fewer replacement bytes than
 * they occupy. Rare. The region scan's CUTS are byte-aligned, which
 * forecloses drift there; its TAIL is measured over a decoded string, so
 * one invalid subpart in a torn tail under-counts by <=1 byte and the
 * boundary may start <=1 byte into the line it just parsed — no newline
 * is skipped, but the cost is real: a completed line whose first byte is
 * cut off parses as a fragment forever. Reachable only via a malformed
 * subpart (F0 80 80 80 -> one replacement char); JSON.stringify never
 * emits one.)
 */
export function eofBoundary(text: string, size: number): number {
	const cut = text.lastIndexOf("\n");
	if (cut < 0) return Math.max(0, size - Buffer.byteLength(text));
	return size - Buffer.byteLength(text.slice(cut + 1));
}

/**
 * The appended-region scan's chunk size, in bytes — the scan's own measured
 * bound, named here with its own rationale rather than derived from the
 * ladder's top rung: the two justifications are different, and a
 * wake-path-motivated change to the cap must not silently retune the board
 * scan's reach and memory.
 *
 * The chunk sets the scan's reach and peak, independently of the ladder: a
 * pass reads 3 chunks (the carry caps at 2, so a line between one and three
 * chunks is carried whole — carry + chunk + concat, up to 6 chunks, ~24 MiB
 * at the carry cap), so 4 MB chunks give the 12 MiB reach the edge tests
 * pin, and the measured max line (~1.0 MB, 1,008,398 B, 2026-10-30) sits
 * well inside one chunk. A line past three chunks stops the scan at its
 * start (see scanRegion); a line is the atomic unit of the scan between the
 * chunk and the stop — it is never split.
 *
 * It equals the shared `EVIDENCE_TAIL_BYTES` today, so the board scan and
 * the wake path's evidence read stay at the same 4 MB; `lib.test.ts` pins
 * the equality, so the coupling is an explicit tested fact, not an
 * incidental one.
 */
export const REGION_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Scan `[from, size)` front to back for the newest `todo` snapshot, in
 * bounded chunks (a later chunk's snapshot supersedes an earlier one).
 * `boundary` is the newest complete-line offset reached: EOF when the region
 * ends on complete lines, else the start of the trailing partial line.
 *
 * Cuts are at newlines and the carry is raw BYTES, so whole lines decode
 * byte-exactly and the boundary arithmetic is exact. Decoding a chunk that
 * split a character would be lossy, and offset math over a lossy string
 * drifts: the replacement chars' usual OVER-count moves the boundary
 * BACKWARD (safe — re-scans), an UNDER-count (invalid bytes collapsing)
 * moves it FORWARD past a line start, which would skip a snapshot line
 * forever. The cuts are byte-aligned, which forecloses both there (the
 * tail's <=1-byte under-count is bounded and safe — see eofBoundary).
 * Peak memory: ~2x `REGION_CHUNK_BYTES` while lines fit one chunk; at the
 * carry cap, carry + chunk + concat reach 6 chunks (~24 MiB) plus the
 * decoded region (~12 MiB for a 12 MiB ASCII concat — Latin1 strings are
 * one byte per char — ~24 MiB more with split() copies; ~60 MiB
 * transient at the split). The CARRY is capped at 2 chunks: the
 * transcript is untrusted input written by a child, and a
 * longer line stops the scan at its start (bounded re-reads per poll).
 * (The `12 MiB` figures are 3 × `chunkBytes` at the default chunk: the reach
 * and the carry bound are multiples of the parameter, not literals.)
 * Reach splits at 12 MiB - 1 (the 12 MiB window, one byte shy of its own
 * terminating newline): a line of AT MOST 12 MiB - 1 is invisible while
 * torn and FOUND once it closes (sub-0021, 2.25 chunks; sub-0022's
 * thin edge sits at exactly 12 MiB - 1); AT 12 MiB
 * and beyond the newline sits outside the window, the scan can never
 * advance past the line — closed or not — and a snapshot behind it is
 * invisible FOREVER (sub-0020, sub-0022's thick edge). A zero-length read
 * stops the scan at `pos` — the loop cannot spin in a reader's loop.
 */
export function scanRegion(fd: number, from: number, size: number, chunkBytes: number = REGION_CHUNK_BYTES): TodoRead {
	let found: RunTodoCounts | undefined;
	// Invariants (see the docstring for why): `pos` is the file offset of
	// carry[0]; chunks are cut ONLY at newlines, so `pos` is always a line
	// start; the returned boundary is a line start (EOF's next line when the
	// region ends complete, `pos` when it is one partial line).
	let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
	let pos = from; // file offset of carry[0]
	while (pos < size) {
		const want = Math.min(chunkBytes, size - pos - carry.length);
		const chunk = readRangeBytes(fd, pos + carry.length, want);
		if (chunk.length === 0) {
			// A read delivered NOTHING (EMFILE, the file shrank under the scan,
			// want <= 0): the loop's only advance is `pos += nl + 1` below, which
			// needs bytes — an empty read repeats byte-identical state FOREVER,
			// and this runs synchronously in a reader's loop (the board viewer at 1 s;
			// pi on flush/liveness events). Stop at `pos`, the start of the
			// line in flight: the backward, safe bias
			// (same as eofBoundary); the next poll re-proves from here.
			return { todos: found, boundary: pos, failed: false };
		}
		const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
		const end = pos + data.length; // file offset just past data
		if (end >= size) {
			const text = data.toString("utf-8"); // only a torn tail can split a char, at the very end
			const nl = text.lastIndexOf("\n");
			const lines = text.split("\n");
			lines.pop();
			const todos = parseRunTodos(lines);
			// Byte-exact when the tail decodes cleanly (ASCII transcripts); a lone
			// surrogate in a torn tail over-counts, moving the boundary backward —
			// the safe direction (see eofBoundary).
			// nl < 0: the whole region is ONE partial line — the boundary stays at
			// its start (`pos`), so the completed line is re-read whole next pass.
			// `eofBoundary(text, end)` IS the `end - byteLength(text after nl)`
			// arithmetic the boundary needs.
			return { todos: todos ?? found, boundary: nl < 0 ? pos : eofBoundary(text, end), failed: false };
		}
		const nl = data.lastIndexOf(0x0a);
		if (nl >= 0) {
			const head = data.subarray(0, nl + 1).toString("utf-8"); // complete lines, byte-aligned
			found = parseRunTodos(head.split("\n")) ?? found;
			pos += nl + 1;
			carry = data.subarray(nl + 1);
		} else {
			carry = data; // one line longer than a chunk: keep buffering
			if (carry.length > 2 * chunkBytes) {
				// Untrusted input (the child writes this file) must not make
				// pi's main loop buffer a 200 MB line. Stop at the line's
				// start; the per-poll re-read stays bounded at 3 chunks.
				return { todos: found, boundary: pos, failed: false };
			}
		}
	}
	return { todos: found, boundary: pos, failed: false }; // defensive: the caller only enters with from < size
}

/**
 * `len` bytes starting at `offset`, for the appended region of a scan.
 *
 * Never floored: the byte band BELOW a memo offset must stay visible to the
 * scan, so the offset must not be raised to the ladder's 4 MB tail — that
 * floor is what made a snapshot inside the skipped band permanently invisible.
 * The delta is bounded only by the poll cadence; `scanRegion` reads it in
 * byte-aligned chunks so peak memory stays at `REGION_CHUNK_BYTES`.
 */
function readRangeBytes(fd: number, offset: number, len: number): Buffer {
	try {
		const buf = Buffer.alloc(len);
		const n = readSync(fd, buf, 0, len, offset);
		return buf.subarray(0, n);
	} catch {
		return Buffer.alloc(0);
	}
}

/** At most `bytes` from the end of an OPEN file, decoded. Throws with the read. */
function readTailAt(fd: number, size: number, bytes: number): string {
	const len = Math.min(bytes, size);
	const buf = Buffer.alloc(len);
	const bytesRead = readSync(fd, buf, 0, len, size - len);
	return buf.toString("utf-8", 0, bytesRead);
}

/**
 * The ladder of tail windows, walked on an OPEN file (see TODO_TAIL_STEPS for
 * why a miss expands before "no list" is concluded). Each rung reads the tail,
 * pops the torn final line (a write in progress is not evidence — the same
 * rule `extractRunResult` applies), and parses; it stops covered when a window
 * already spanned the whole file (a larger step would re-read byte-identical
 * bytes, and a no-list run walks this on **every** append — the board polls at
 * 1 s, the widget inside pi's main loop).
 *
 * `boundary` is the newline boundary of the last window read: covered files
 * prove everything below it; a past-cap file proves the cap tail, and bytes
 * farther from EOF than that tail are never reached (see the scannedTo
 * docstring). A failed rung throws out of the loop: `failed: true` proves
 * NOTHING — the caller must not arm anything from it.
 */
export function readLadder(fd: number, size: number, steps: readonly number[] = TODO_TAIL_STEPS): TodoRead {
	try {
		let todos: RunTodoCounts | undefined;
		let lastText = "";
		for (const bytes of steps) {
			lastText = readTailAt(fd, size, bytes);
			const lines = lastText.split("\n");
			lines.pop();
			todos = parseRunTodos(lines);
			if (todos) break;
			if (bytes >= size) break; // covered: stop, the memo arms at EOF
		}
		return { todos, boundary: eofBoundary(lastText, size), failed: false };
	} catch {
		return { boundary: 0, failed: true };
	}
}
/** One run's status, `unknown` when its record is absent or unreadable. Never throws. */
export function readRunInfo(agentDir: string, runId: string): RunInfo {
	// The id is joined into a path: anything but the minted shape is refused.
	if (!RUN_ID_PATTERN.test(runId)) return { status: "unknown" };
	const dir = runDir(agentDir, runId);
	// A cache entry must not outlive the run it keys: terminal — meta-terminal,
	// or `running` with an `.exit` sidecar (the most common transition, which
	// used to return before the drop) — the session file is closed and will not
	// grow, so the entry goes now. Same for a swept dir (meta absent/unreadable)
	// and a record that fails validation: the path is deleted, never re-read.
	const dropTodoCache = () => {
		const file = todoFileOf.get(runId);
		if (file) {
			todoCache.delete(file);
			todoFileOf.delete(runId);
			scannedTo.delete(file);
		}
	};
	let record: unknown;
	try {
		record = JSON.parse(readFileSync(metaPath(dir), "utf-8"));
	} catch {
		dropTodoCache();
		return { status: "unknown" };
	}
	// Strict: a record whose status is not one of RUN_STATUSES is `unknown` whole
	// (no agent, no todos) — the board does not render what it cannot classify.
	if (!isRunRecord(record) || record.runId !== runId) {
		dropTodoCache();
		return { status: "unknown" };
	}
	const agent = typeof record.agent === "string" ? record.agent : undefined;
	const status = record.status;
	if (status === "running" && hasExitSidecar(dir, runId)) {
		dropTodoCache();
		return { status: "done", ...(agent ? { agent } : {}) };
	}
	// The board renders progress for live work only: a terminal run's session
	// file is not going to grow, so it is not read.
	if (status !== "running") {
		dropTodoCache();
		return { status, ...(agent ? { agent } : {}) };
	}
	const todos = readRunTodos(dir, runId);
	return { status, ...(agent ? { agent } : {}), ...(todos ? { todos } : {}) };
}

/** Status for each id. Small and synchronous: a board links a handful of runs. */
export function readRunInfos(agentDir: string, runIds: readonly string[]): RunInfos {
	const out: Record<string, RunInfo> = {};
	for (const id of runIds) out[id] = readRunInfo(agentDir, id);
	return out;
}
