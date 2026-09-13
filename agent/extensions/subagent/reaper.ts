/**
 * Reaping and archiving of Run session files.
 *
 * Runs stopped being ephemeral when they gained real session files so herdr's
 * sidebar could open them (docs/adr/0019). Nothing deleted them, so the
 * directory grew without bound — a single oracle consultation measured 296 KB.
 *
 * The lifecycle is: **live** (plain JSONL, readable by herdr and the Mirror
 * Pane) → **archived** (zstd-compressed, ~4x smaller, cold storage) → **gone**.
 * Compression *is* archiving; a Mirror Pane that needs to open an archived Run
 * thaws it back to plain JSONL first (`thawRun`).
 *
 * @module reaper
 */

import { readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { zstdCompress, zstdDecompress } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(zstdCompress);
const decompress = promisify(zstdDecompress);

/** Suffix marking an archived session. */
export const ARCHIVE_SUFFIX = ".zst";

/**
 * Retention policy.
 *
 * Chosen from measurement rather than taste: zstd gave 4.0x in ~1ms on a real
 * 302 KB session, so archiving is cheap enough to do eagerly, while deletion is
 * deliberately distant because an archived run costs little and a deleted one
 * is gone.
 */
export interface ReapPolicy {
	/** Archive (compress) sessions whose last write is older than this. */
	archiveAfterMs: number;
	/** Delete archived sessions older than this. */
	deleteAfterMs: number;
	/** Never touch a session written more recently than this. */
	freshnessGuardMs: number;
}

export const DEFAULT_POLICY: ReapPolicy = {
	archiveAfterMs: 24 * 60 * 60 * 1000, // 1 day
	deleteAfterMs: 90 * 24 * 60 * 60 * 1000, // 90 days
	// A Run writes its session continuously. Anything touched in the last few
	// minutes is presumed live even if its runId is not in the in-flight set —
	// another pi process may own it.
	freshnessGuardMs: 5 * 60 * 1000,
};

/** What a reap pass did, for logging and tests. */
export interface ReapReport {
	archived: string[];
	deleted: string[];
	skipped: number;
	bytesSaved: number;
}

/**
 * Root directory holding one subdirectory per Run.
 *
 * @param agentDir - The pi agent directory (`getAgentDir()`).
 */
export function sessionsRoot(agentDir: string): string {
	return path.join(agentDir, "subagent-sessions");
}

/**
 * Find the session file inside a Run's directory, live or archived.
 *
 * @returns Path and whether it is archived, or null if the directory is empty.
 */
async function runSessionFile(
	runDir: string,
): Promise<{ file: string; archived: boolean } | null> {
	let names: string[];
	try {
		names = await readdir(runDir);
	} catch {
		return null;
	}
	// Prefer a live file: if both exist (a thaw that was interrupted), the plain
	// one is authoritative and the archive is a leftover.
	const live = names.find((n) => n.endsWith(".jsonl"));
	if (live) return { file: path.join(runDir, live), archived: false };
	const archived = names.find((n) => n.endsWith(`.jsonl${ARCHIVE_SUFFIX}`));
	return archived
		? { file: path.join(runDir, archived), archived: true }
		: null;
}

/**
 * Compress one Run's session in place, replacing the plain file.
 *
 * Writes the archive fully before unlinking the original, so an interruption
 * leaves the readable file intact rather than losing the transcript.
 *
 * @returns Bytes saved, or 0 if nothing was archived.
 */
async function archiveRun(file: string): Promise<number> {
	const raw = await readFile(file);
	const packed = await compress(raw);
	const target = `${file}${ARCHIVE_SUFFIX}`;
	await writeFile(target, packed);
	await unlink(file);
	return Math.max(0, raw.length - packed.length);
}

/**
 * Restore an archived Run to plain JSONL so it can be read.
 *
 * Called when a Mirror Pane needs to display an archived Run: compressed
 * sessions are cold storage, and both herdr's sidebar and the viewer expect
 * plain JSONL. The archive is removed once the plain file is written, so a Run
 * is never both live and archived for longer than one write.
 *
 * @param runDir - Directory of the Run to thaw.
 * @returns Path of the readable session file, or null if there is nothing there.
 */
export async function thawRun(runDir: string): Promise<string | null> {
	const found = await runSessionFile(runDir);
	if (!found) return null;
	if (!found.archived) return found.file;

	const packed = await readFile(found.file);
	const raw = await decompress(packed);
	const target = found.file.slice(0, -ARCHIVE_SUFFIX.length);
	await writeFile(target, raw);
	await unlink(found.file);
	return target;
}

/**
 * Archive and delete Run sessions according to policy.
 *
 * Never throws: reaping is housekeeping, and a failure to tidy must not affect
 * the session that triggered it. Individual failures are skipped so one
 * unreadable directory cannot stop the pass.
 *
 * @param agentDir - The pi agent directory.
 * @param inFlight - runIds currently executing; never touched.
 * @param policy - Retention thresholds.
 */
export async function reapSessions(
	agentDir: string,
	inFlight: ReadonlySet<string>,
	policy: ReapPolicy = DEFAULT_POLICY,
): Promise<ReapReport> {
	const report: ReapReport = {
		archived: [],
		deleted: [],
		skipped: 0,
		bytesSaved: 0,
	};
	const root = sessionsRoot(agentDir);

	let runIds: string[];
	try {
		runIds = await readdir(root);
	} catch {
		return report; // Nothing has ever run.
	}

	const now = Date.now();

	for (const runId of runIds) {
		// A Run still writing its session is untouchable.
		if (inFlight.has(runId)) {
			report.skipped++;
			continue;
		}

		const runDir = path.join(root, runId);
		try {
			const found = await runSessionFile(runDir);
			if (!found) {
				// An empty directory is a Run that never wrote anything; only remove
				// it once it is old enough to not be a race with a starting child.
				const info = await stat(runDir);
				if (now - info.mtimeMs > policy.freshnessGuardMs) {
					await rm(runDir, { recursive: true, force: true });
					report.deleted.push(runId);
				} else {
					report.skipped++;
				}
				continue;
			}

			const info = await stat(found.file);
			const age = now - info.mtimeMs;

			// Recently written: presume live regardless of the in-flight set, since
			// another pi process may own this Run.
			if (age < policy.freshnessGuardMs) {
				report.skipped++;
				continue;
			}

			if (found.archived) {
				if (age > policy.deleteAfterMs) {
					await rm(runDir, { recursive: true, force: true });
					report.deleted.push(runId);
				} else {
					report.skipped++;
				}
				continue;
			}

			if (age > policy.archiveAfterMs) {
				report.bytesSaved += await archiveRun(found.file);
				report.archived.push(runId);
			} else {
				report.skipped++;
			}
		} catch {
			// Unreadable or vanished mid-pass: leave it for the next run.
			report.skipped++;
		}
	}

	return report;
}
