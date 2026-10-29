/**
 * Tests for the cross-process file-lease store.
 *
 * The behaviour worth pinning is the failure rule: a missing or unwritable
 * directory degrades to unlimited (`ok: true`, `file: undefined`) rather than
 * throwing, and stale-by-age leases are swept out of the count.
 */

import { chmodSync, existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	LEASE_DIR_ENV,
	LEASE_TTL_MS,
	acquireLease,
	leaseDir,
	releaseAll,
	releaseLease,
	resolveLeaseDir,
	snapshotLeases,
	sweepDir,
} from "./concurrency.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "model-fallback-leases-"));
}

/** Run `fn` with the env override set, restoring it afterwards. */
function withLeaseDirEnv(value: string | undefined, fn: () => void): void {
	const original = process.env[LEASE_DIR_ENV];
	if (value === undefined) delete process.env[LEASE_DIR_ENV];
	else process.env[LEASE_DIR_ENV] = value;
	try {
		fn();
	} finally {
		if (original === undefined) delete process.env[LEASE_DIR_ENV];
		else process.env[LEASE_DIR_ENV] = original;
	}
}

describe("concurrency lease store", () => {
	test("acquire under the cap succeeds and counts", () => {
		const dir = tempDir();
		const lease = acquireLease(dir, "a/1", 2);
		expect(lease.ok).toBe(true);
		if (!lease.ok) return;
		expect(lease.lease.ref).toBe("a/1");
		expect(lease.lease.key).toBe("a/1");
		expect(lease.lease.file?.startsWith(dir)).toBe(true);
		expect(existsSync(lease.lease.file!)).toBe(true);
		expect(snapshotLeases(dir, ["a/1"])).toEqual({ "a/1": 1 });
	});

	test("at the cap, acquire reports ok:false with the in-use count", () => {
		const dir = tempDir();
		const first = acquireLease(dir, "a/1", 1);
		expect(first.ok).toBe(true);
		const second = acquireLease(dir, "a/1", 1);
		expect(second).toEqual({ ok: false, inUse: 1 });
		// The rejected attempt left no file behind.
		expect(readdirSync(dir).filter((n) => n.endsWith(".lease")).length).toBe(1);
	});

	test("two acquires are two files, and the count is two", () => {
		const dir = tempDir();
		const a = acquireLease(dir, "a/1", 2);
		const b = acquireLease(dir, "a/1", 2);
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.lease.file).not.toBe(b.lease.file);
		expect(snapshotLeases(dir, ["a/1"])).toEqual({ "a/1": 2 });
	});

	test("release decrements the count", () => {
		const dir = tempDir();
		const a = acquireLease(dir, "a/1", 2);
		const b = acquireLease(dir, "a/1", 2);
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		releaseLease(dir, a.lease);
		expect(snapshotLeases(dir, ["a/1"])).toEqual({ "a/1": 1 });
		releaseAll(dir, [b.lease]);
		expect(snapshotLeases(dir, ["a/1"])).toEqual({ "a/1": 0 });
		// Releasing twice is a no-op, not a throw.
		releaseLease(dir, a.lease);
	});

	test("a stale lease (mtime = now − TTL − 1) is excluded and unlinked", () => {
		const dir = tempDir();
		const lease = acquireLease(dir, "a/1", 1);
		expect(lease.ok).toBe(true);
		if (!lease.ok) return;
		const now = Date.now();
		utimesSync(lease.lease.file!, new Date(now - LEASE_TTL_MS - 1), new Date(now - LEASE_TTL_MS - 1));
		expect(snapshotLeases(dir, ["a/1"])).toEqual({ "a/1": 0 });
		expect(existsSync(lease.lease.file!)).toBe(false);
		// The slot is free again.
		expect(acquireLease(dir, "a/1", 1).ok).toBe(true);
	});

	test("a future-mtime lease is kept", () => {
		const dir = tempDir();
		const lease = acquireLease(dir, "a/1", 1);
		expect(lease.ok).toBe(true);
		if (!lease.ok) return;
		const future = new Date(Date.now() + 60_000);
		utimesSync(lease.lease.file!, future, future);
		expect(snapshotLeases(dir, ["a/1"])).toEqual({ "a/1": 1 });
	});

	test("snapshotLeases counts two refs in one call", () => {
		const dir = tempDir();
		expect(acquireLease(dir, "a/1", 5).ok).toBe(true);
		expect(acquireLease(dir, "a/1", 5).ok).toBe(true);
		expect(acquireLease(dir, "b/2", 5).ok).toBe(true);
		expect(snapshotLeases(dir, ["a/1", "b/2"])).toEqual({ "a/1": 2, "b/2": 1 });
		// A ref with no leases counts as zero, not absent.
		expect(snapshotLeases(dir, ["c/3"])).toEqual({ "c/3": 0 });
	});

	test("an absent directory degrades to unlimited, all zeros, no throw", () => {
		// A parent that is a file makes `mkdirSync(recursive)` throw, so the
		// store cannot create its directory and must degrade to unlimited.
		const root = tempDir();
		const blocker = join(root, "blocker");
		writeFileSync(blocker, "not a directory", "utf-8");
		const dir = join(blocker, "leases");
		const result = acquireLease(dir, "a/1", 1);
		expect(result).toEqual({ ok: true, lease: { key: "a/1", ref: "a/1" } });
		expect(snapshotLeases(dir, ["a/1"])).toEqual({ "a/1": 0 });
		// Releasing a file-less lease is a no-op.
		if (result.ok) releaseLease(dir, result.lease);
		expect(sweepDir(dir)).toBe(0);
	});

	test("an unwritable directory degrades to unlimited", () => {
		const dir = tempDir();
		chmodSync(dir, 0o555);
		try {
			const result = acquireLease(dir, "a/1", 1);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.lease.file).toBeUndefined();
			expect(snapshotLeases(dir, ["a/1"])).toEqual({ "a/1": 0 });
		} finally {
			chmodSync(dir, 0o755);
		}
	});

	test("a reference with slashes round-trips to one file key", () => {
		const dir = tempDir();
		const ref = "qwen/qwen3.8-flash-next";
		const lease = acquireLease(dir, ref, 2);
		expect(lease.ok).toBe(true);
		if (!lease.ok) return;
		const names = readdirSync(dir);
		expect(names).toHaveLength(1);
		expect(names[0]!.startsWith(`${encodeURIComponent(ref)}__`)).toBe(true);
		expect(names[0]!.endsWith(".lease")).toBe(true);
		expect(snapshotLeases(dir, [ref])).toEqual({ [ref.toLowerCase()]: 1 });
	});

	test("a reference containing __ round-trips to one file key", () => {
		const dir = tempDir();
		const ref = "litellm/gpt-4__staging";
		const lease = acquireLease(dir, ref, 2);
		expect(lease.ok).toBe(true);
		if (!lease.ok) return;
		const names = readdirSync(dir);
		expect(names).toHaveLength(1);
		// The encoded key contains no `_`, so the first `__` is the separator.
		expect(names[0]!.startsWith(`${encodeURIComponent(ref).replace(/_/g, "%5F")}__`)).toBe(true);
		expect(snapshotLeases(dir, [ref])).toEqual({ "litellm/gpt-4__staging": 1 });
	});

	test("a reference containing a bare _ round-trips to one file key", () => {
		const dir = tempDir();
		const ref = "a_b/c_d";
		const lease = acquireLease(dir, ref, 2);
		expect(lease.ok).toBe(true);
		if (!lease.ok) return;
		const names = readdirSync(dir);
		expect(names).toHaveLength(1);
		expect(snapshotLeases(dir, [ref])).toEqual({ "a_b/c_d": 1 });
	});

	test("a Nextcloud conflicted-copy lease name is not counted", () => {
		const dir = tempDir();
		const real = acquireLease(dir, "a/1", 3);
		expect(real.ok).toBe(true);
		// Sync-replication produces `<name> (conflicted copy <host>).lease` —
		// the tail after the last `__` carries spaces and parens, so the name
		// shape rejects it. The `.lease`-moved-to-the-end variant does not end
		// in `.lease` at all.
		writeFileSync(join(dir, "a%2F1__1-2-3 (conflicted copy host).lease"), "{}", "utf-8");
		writeFileSync(join(dir, "a%2F1__1-2-3.lease (conflicted copy host)"), "{}", "utf-8");
		expect(snapshotLeases(dir, ["a/1"])).toEqual({ "a/1": 1 });
	});

	test("sweepDir leaves foreign files alone, even aged ones", () => {
		const dir = tempDir();
		const stale = acquireLease(dir, "a/1", 3);
		expect(stale.ok).toBe(true);
		if (!stale.ok) return;
		const notes = join(dir, "notes.txt");
		const stray = join(dir, "foo");
		writeFileSync(notes, "not a lease", "utf-8");
		writeFileSync(stray, "not a lease", "utf-8");
		const past = new Date(Date.now() - LEASE_TTL_MS - 1);
		utimesSync(stale.lease.file!, past, past);
		utimesSync(notes, past, past);
		utimesSync(stray, past, past);
		expect(sweepDir(dir)).toBe(1);
		expect(existsSync(stale.lease.file!)).toBe(false);
		expect(existsSync(notes)).toBe(true);
		expect(existsSync(stray)).toBe(true);
	});

	test("snapshotLeases counts a fresh lease written by a different pid-shaped name", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "a%2F1__424242-1a-abcdef.lease"), "{}", "utf-8");
		expect(snapshotLeases(dir, ["a/1"])).toEqual({ "a/1": 1 });
	});

	test("acquire at a pre-filled cap reports ok:false and leaves the dir count unchanged", () => {
		const dir = tempDir();
		const limit = 2;
		for (let i = 0; i < limit; i++) {
			writeFileSync(join(dir, `a%2F1__${1000 + i}-${(i + 1).toString(16)}-abcdef.lease`), "{}", "utf-8");
		}
		const before = readdirSync(dir).length;
		const result = acquireLease(dir, "a/1", limit);
		expect(result).toEqual({ ok: false, inUse: limit });
		// The rejected attempt left no file behind.
		expect(readdirSync(dir).length).toBe(before);
	});

	test("sweepDir drops only the stale leases and reports how many", () => {
		const dir = tempDir();
		const live = acquireLease(dir, "a/1", 3);
		const stale = acquireLease(dir, "b/2", 3);
		expect(live.ok && stale.ok).toBe(true);
		if (!live.ok || !stale.ok) return;
		utimesSync(stale.lease.file!, new Date(Date.now() - LEASE_TTL_MS - 1), new Date(Date.now() - LEASE_TTL_MS - 1));
		expect(sweepDir(dir)).toBe(1);
		expect(existsSync(stale.lease.file!)).toBe(false);
		expect(existsSync(live.lease.file!)).toBe(true);
	});

	test("leaseDir() defaults under the agent dir and honours the env override", () => {
		withLeaseDirEnv(undefined, () => {
			expect(leaseDir("/some/agent/dir")).toBe(join("/some/agent/dir", "cache", "model-fallback-leases"));
		});
		withLeaseDirEnv("/custom/lease/dir", () => {
			// The override wins, even over an explicit root.
			expect(leaseDir("/some/agent/dir")).toBe("/custom/lease/dir");
			expect(leaseDir()).toBe("/custom/lease/dir");
			expect(resolveLeaseDir()).toBe("/custom/lease/dir");
		});
	});
});
