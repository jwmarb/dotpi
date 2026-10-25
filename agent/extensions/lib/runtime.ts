import { lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

import { agentDir } from "./layout.js";

/**
 * Which kind of pi binary is running this extension.
 *
 * pi ships two shapes: a script run by node/bun (`process.argv[1]` is the real
 * `cli.js` on disk), and a *compiled* Bun executable — Pi-Bolt
 * (https://github.com/opensec-git/Pi-Bolt) — whose entry lives in Bun's virtual
 * filesystem (`/$bunfs/root/pi`, `B:/~BUN/root/pi` on Windows). In the compiled
 * shape `process.argv[1]` names no file, `process.execPath` *is* pi, and that
 * same executable acts as the plain `bun` CLI only when started with
 * `BUN_BE_BUN=1` (measured on Pi-Bolt 1.0.2).
 */

/** True when `entry` (normally `process.argv[1]`) is a compiled Bun executable's virtual entry. */
export function isCompiledEntry(entry: string | undefined): boolean {
	if (!entry) return false;
	return entry.includes("$bunfs") || entry.includes("~BUN") || entry.includes("%7EBUN");
}

/**
 * Set on globalThis by `pi-bolt-host.ts`, which points `process.argv[1]` at a
 * stand-in file while extensions load. Every extension module is re-imported
 * per load (jiti, no module cache), so a module-level copy would not survive.
 */
export const ORIGINAL_ENTRY_KEY = Symbol.for("dotpi.runtime.originalArgv1");

/** `process.argv[1]` as pi started with it, even while pi-bolt-host has it faked. */
export function originalEntry(): string | undefined {
	const saved = (globalThis as Record<symbol, unknown>)[ORIGINAL_ENTRY_KEY];
	return typeof saved === "string" ? saved : process.argv[1];
}

/** The running pi is a compiled Bun executable (Pi-Bolt). */
export function runningCompiled(argv1: string | undefined = originalEntry()): boolean {
	return isCompiledEntry(argv1);
}

/**
 * Absolute path to the running pi, usable as a command: the executable itself
 * when compiled, else the entry script (which owns pi's extension alias map).
 */
export function piExecutable(
	argv1: string | undefined = originalEntry(),
	execPath: string = process.execPath,
): string {
	if (isCompiledEntry(argv1)) return execPath;
	return argv1 ?? "pi";
}

/** Env that turns a compiled Bun executable into the `bun` CLI. */
export const BE_BUN_ENV = { BUN_BE_BUN: "1" } as const;

/**
 * A directory whose `pi` is a symlink to `target`, for a herdr pane to put first
 * on its PATH.
 *
 * `herdr agent start --kind pi` types a bare `pi` into the pane's shell, and the
 * shell's rc files decide which `pi` that is — normally the node/bun install. A
 * compiled pi launching a subagent wants the child to be *itself*. A PATH set
 * with `--env` at pane creation does not survive (`~/.bashrc` prepends after
 * it), so the caller exports this dir from inside the shell instead. herdr's
 * detection needs the process to be called `pi`: a symlink named `pi` is
 * detected as kind `pi`, the executable at its real path as `pi-bolt`.
 *
 * Lives under the agent dir (`cache/pi-shim`, gitignored), never shared `/tmp`:
 * a dir another user could pre-create would let them choose what every child
 * pane runs. It is still refused unless it is our own private real directory.
 *
 * POSIX only (a Windows symlink needs a privilege); returns undefined there or
 * on any failure, and the caller keeps the default `pi`.
 */
export function piShimDir(target: string = process.execPath, root: string = join(agentDir(), "cache")): string | undefined {
	if (process.platform === "win32") return undefined;
	try {
		const dir = join(root, "pi-shim");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const st = lstatSync(dir);
		const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
		if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) return undefined;
		const link = join(dir, "pi");
		let current: string | undefined;
		try {
			current = readlinkSync(link);
		} catch {
			current = undefined;
		}
		if (current !== target) {
			const tmp = `${link}.${process.pid}`;
			rmSync(tmp, { force: true });
			symlinkSync(target, tmp);
			renameSync(tmp, link);
		}
		return dir;
	} catch {
		return undefined;
	}
}

/** The POSIX shell line that puts `dir` first on PATH and drops the shell's command hash. */
export function prependPathCommand(dir: string): string {
	return `export PATH='${dir.replace(/'/g, `'\\''`)}':"$PATH"; hash -r 2>/dev/null`;
}
