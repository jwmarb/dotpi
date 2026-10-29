/**
 * Cross-process file-lease store for the router's per-model concurrency caps.
 *
 * ## Why files
 *
 * The caps are **global across every pi process** — the parent session,
 * subagent-herdr children, ralph-loop gate children — and none of those
 * processes share memory. A lease is one file per in-flight request in a
 * directory they all resolve to the same place: `agent/cache/
 * model-fallback-leases` (or the {@link LEASE_DIR_ENV} override, which exists
 * because this repo is a Nextcloud-synced tree and the agent dir is not
 * guaranteed to be a plain local directory). Counting the files for a model
 * is the count of in-flight requests for that model, machine-wide.
 *
 * ## Why age-only expiry
 *
 * A lease is stale once its mtime is older than {@link LEASE_TTL_MS} (15
 * min). Liveness is checked by age, **not** by pid: the tree is replicated
 * across hosts, where pids are meaningless, and an mtime is the one fact
 * that survives the sync. A crashed process therefore costs at most one
 * stale lease per model per 15 minutes — the cap degrades, it does not
 * wedge.
 *
 * ## The failure rule
 *
 * The store degrades to **unlimited** on any filesystem trouble: a missing
 * or unwritable directory, a failed create. {@link acquireLease} then
 * returns `{ ok: true, lease: { …, file: undefined } }`, which
 * {@link releaseLease} treats as a no-op. Nothing in this module throws: a
 * concurrency cap is a scheduling detail, and a cap that kills the request
 * it is scheduling is not a cap.
 *
 * `node:fs` + `node:path` only — no pi import — and the module
 * top level neither throws nor touches the disk: the directory is resolved
 * and touched only inside the functions.
 *
 * @module model-fallback/concurrency
 */

import { mkdirSync, openSync, closeSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "../lib/layout.js";
import { concurrencyKeyFor } from "./lib.js";

/** How long a lease file is trusted before it is swept as stale. */
export const LEASE_TTL_MS = 900_000;

/**
 * Override for the lease directory. Wins over the default under
 * `agentDir()`: on a Nextcloud-synced tree the agent dir may not be a plain
 * local directory, and a local override is the documented mitigation.
 */
export const LEASE_DIR_ENV = "PI_MODEL_FALLBACK_LEASE_DIR";

/** One in-flight request the router reserved a slot for. */
export interface Lease {
	/** The model, keyed by {@link concurrencyKeyFor}. */
	key: string;
	/** The lease file's path; `undefined` when the store is unavailable. */
	file?: string;
	/** The reference as written, kept for display. */
	ref: string;
}

/** Test seams for the store's clock and its TTL. */
export interface LeaseOptions {
	ttlMs?: number;
	now?: () => number;
}

export type AcquireResult = { ok: true; lease: Lease } | { ok: false; inUse: number };

/**
 * The lease directory.
 *
 * The {@link LEASE_DIR_ENV} override wins over the computed default, which
 * is `cache/model-fallback-leases` under `root` (the agent dir). The
 * directory is created on first use, never at load.
 */
export function leaseDir(root: string = agentDir()): string {
	const override = process.env[LEASE_DIR_ENV];
	if (override) return override;
	return join(root, "cache", "model-fallback-leases");
}

/** The directory this process's leases live in. */
export function resolveLeaseDir(): string {
	return leaseDir();
}

/**
 * Encode a lease key so the encoded form contains no `_` at all.
 *
 * `encodeURIComponent` leaves `_` alone, and `_` is the store's separator
 * character: a ref containing `__` would decode early at its own underscore
 * pair (`name.indexOf("__")`) and its leases would count under the wrong key
 * — zero, in fact, so the model never caps. Encoding `_` as `%5F` keeps the
 * first `__` in a name unambiguously the separator, and
 * `decodeURIComponent` round-trips it.
 */
function encodeLeaseKey(key: string): string {
	return encodeURIComponent(key).replace(/_/g, "%5F");
}

let seq = 0;

/**
 * A fresh, collision-free lease file name for `key`.
 *
 * `pid` plus a per-process sequence plus randomness: two processes creating
 * leases for the same model in the same millisecond must not write the same
 * file, because `wx` would make one of them lose its slot silently.
 */
export function newLeaseName(key: string): string {
	seq = (seq + 1) % 0xffff;
	const rand = Math.random().toString(36).slice(2, 8);
	return `${encodeLeaseKey(key)}__${process.pid}-${seq.toString(16)}-${rand}.lease`;
}

/**
 * The one name shape this module writes: `<encoded-key>__<pid>-<seq>-<rand>.lease`.
 *
 * Only the tail is checked: pid is decimal, seq is 1–4 hex, rand is 1–8
 * alphanumerics — no spaces, no parens, so a Nextcloud `name (conflicted
 * copy host)` copy of a lease file cannot pass. The split is on the *last*
 * `__`, and the encoded key itself never contains one (see
 * {@link encodeLeaseKey}). `snapshotLeases` and `sweepDir` both use this,
 * so a foreign file in the shared directory is neither counted as a live
 * lease nor swept as stale.
 */
function isLeaseName(name: string): boolean {
	return /__\d+-[0-9a-f]{1,4}-[A-Za-z0-9]{1,8}\.lease$/.test(name);
}

function fileStale(file: string, ttl: number, now: number): boolean | undefined {
	try {
		const st = statSync(file);
		if (now - st.mtimeMs > ttl) return true;
		return false;
	} catch {
		return undefined; // gone between readdir and stat
	}
}

function dropStale(file: string): void {
	try {
		unlinkSync(file);
	} catch {
		// Already gone — a concurrent sweep took it first.
	}
}

/**
 * Count in-flight leases for `refs`, one `readdir` + one `stat` per file.
 *
 * Stale-by-age leases are unlinked and excluded. The result has a key for
 * every requested ref, zero when none of its leases are live, so the caller
 * can index it without a `?? 0`. A missing or unreadable directory yields
 * all zeros rather than a throw.
 */
export function snapshotLeases(dir: string, refs: readonly string[], opts?: LeaseOptions): Record<string, number> {
	const ttl = opts?.ttlMs ?? LEASE_TTL_MS;
	const now = opts?.now ? opts.now() : Date.now();
	const out: Record<string, number> = {};
	for (const ref of refs) out[concurrencyKeyFor(ref)] = 0;

	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}

	for (const name of names) {
		if (!isLeaseName(name)) continue; // not one of ours
		const sep = name.lastIndexOf("__");
		let key: string;
		try {
			key = decodeURIComponent(name.slice(0, sep));
		} catch {
			continue; // a hand-made file with a bad escape sequence
		}
		const slot = out[key];
		if (slot === undefined) continue; // not a requested ref
		const file = join(dir, name);
		const stale = fileStale(file, ttl, now);
		if (stale === true) {
			dropStale(file);
			continue;
		}
		if (stale === undefined) continue;
		out[key] = slot + 1;
	}
	return out;
}

/**
 * Reserve one in-flight slot for `ref` under `limit`.
 *
 * Creates a lease file with `wx` (exclusive), then re-counts: the snapshot
 * that decided there was room and the create are not atomic across
 * processes, so a race can land the count over the cap — in that case the
 * lease is released and the result is `{ ok: false }`. An over-cap result is
 * the caller's business: the cap is soft, and the router rotates.
 *
 * Any filesystem trouble (missing directory that cannot be created,
 * unwritable directory, a lost `wx` race) degrades to
 * `{ ok: true, lease: { file: undefined } }` — unlimited, and a
 * no-op to release.
 */
export function acquireLease(dir: string, ref: string, limit: number, opts?: LeaseOptions): AcquireResult {
	const key = concurrencyKeyFor(ref);
	const ttl = opts?.ttlMs ?? LEASE_TTL_MS;
	const now = opts?.now ? opts.now() : Date.now();

	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		return { ok: true, lease: { key, ref } };
	}

	const before = snapshotLeases(dir, [ref], opts);
	if ((before[key] ?? 0) >= limit) return { ok: false, inUse: before[key] ?? 0 };

	let file: string | undefined;
	let created = false;
	try {
		const name = newLeaseName(key);
		file = join(dir, name);
		const fd = openSync(file, "wx");
		created = true;
		try {
			writeFileSync(fd, JSON.stringify({ ref, pid: process.pid, at: now }), "utf-8");
		} finally {
			closeSync(fd);
		}
	} catch {
		// `openSync` created the file before `writeFileSync` failed: unlink it so it
		// does not count toward the cap until the TTL sweep. Only unlink when we
		// created it — an `EEXIST` from a lost `wx` race means the file is another
		// process's lease, not ours to drop.
		if (created && file) dropStale(file);
		file = undefined;
	}
	if (file === undefined) return { ok: true, lease: { key, ref } };

	// Re-count: we may have lost a race with another process.
	const after = snapshotLeases(dir, [ref], opts);
	const total = after[key] ?? 0;
	if (total > limit) {
		dropStale(file);
		return { ok: false, inUse: total };
	}
	return { ok: true, lease: { key, ref, file } };
}

/**
 * Release one lease. A no-op when the lease has no file (store degraded).
 *
 * `dir` is ignored: the lease already carries the file's full path, and the
 * directory can move under an env override between acquire and release — the
 * stored path is the fact. The parameter stays for symmetry with
 * {@link acquireLease} and {@link releaseAll}.
 */
export function releaseLease(dir: string, lease: Lease): void {
	if (!lease.file) return;
	dropStale(lease.file);
}

/** Release every lease. */
export function releaseAll(dir: string, leases: readonly Lease[]): void {
	for (const lease of leases) releaseLease(dir, lease);
}

/**
 * Drop every stale lease in `dir`, returning how many it dropped.
 *
 * Sweeps every file matching the lease name shape, not just known refs: a
 * lease for a model that no chain names anymore is as dead as one for a
 * chain model. Files the shape does not match are left alone — the
 * directory is shared (an env override can point it at any dir), and this
 * module is not their owner.
 */
export function sweepDir(dir: string, opts?: LeaseOptions): number {
	const ttl = opts?.ttlMs ?? LEASE_TTL_MS;
	const now = opts?.now ? opts.now() : Date.now();
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	let swept = 0;
	for (const name of names) {
		if (!isLeaseName(name)) continue; // not ours to sweep
		const file = join(dir, name);
		const stale = fileStale(file, ttl, now);
		if (stale === true) {
			dropStale(file);
			swept += 1;
		}
	}
	return swept;
}
