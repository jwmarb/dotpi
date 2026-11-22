/**
 * The load-safe read/write seam for `settings.json`.
 *
 * Two extensions needed the same file at different moments: `model-fallback`
 * needs its chain while it is still loading, and `startup-fetch` both reads its
 * panel config per header build and writes it from `/fetch style`. Each had its
 * own reader, and only one of them tolerated a BOM. This module is that seam.
 *
 * ## Why this exists rather than `pi.getSettings()`
 *
 * `registerVirtualModel()` is one of the few actions pi *queues* during
 * extension load, so the chain has to be known at load time. But
 * `pi.getSettings()` is a throwing stub until the runner binds its context
 * (`core/extensions/loader.js`: `getSettings: notInitialized`) — calling it at
 * load kills the extension with "Extension runtime not initialized", which is
 * exactly how the first version of `model-fallback` failed.
 *
 * So load-time configuration is read from disk here, and anything needed only
 * once a session is running (`retry.maxRetries` for the budget warning) still
 * goes through `pi.getSettings()`, where it is live and authoritative.
 *
 * This is the same shape `lib/dotenv.ts` and `lib/layout.ts` already have: a
 * module that extension top-level code may import must never throw, because a
 * throw there is a startup failure rather than a reported error. That is why
 * every function here swallows, why nothing happens at import, and why
 * `scripts/check.sh` section 1 imports this file directly.
 *
 * ## Merge order (the reads)
 *
 * pi deep-merges global (`<agentDir>/settings.json`) with project
 * (`<cwd>/.pi/settings.json`), project winning. Both consumers read one key at a
 * time, so the merge here is `{ ...global, ...project }`: per key, the project's
 * value replaces the global one WHOLE rather than recursively. A whole-object
 * override is what a reader of a single key expects, and partial merging of a
 * chain would produce a chain neither file declares.
 *
 * ## One write rule (the writes)
 *
 * Both writers answer a user command, so they must not be able to cost pi its
 * next start: a half-written `settings.json` is not a reported error but a
 * startup failure — pi's loader is a plain `JSON.parse`, and every load-time
 * reader in this repo would then see "no configuration". So a write goes to
 * `<file>.<pid>.tmp` and `renameSync` moves it into place; on any error the temp
 * file is removed and the caller is told `false`. The file is written as
 * `JSON.stringify(…, null, 2) + "\n"`, matching how the file is kept by hand.
 *
 * Writes target the **global file only**, and `patchSettingsKey` merges into the
 * namespace as read from that file — never into the merged view. Merging the
 * merged view would silently copy a repo's own `startupFetch` fields into the
 * user's global configuration. The accepted consequence of reading global-only:
 * a repo that pins `startupFetch` in its own `.pi/settings.json` shadows global
 * writes there (whole-object replace, as above), so `/fetch style` there has no
 * visible effect until the pin is removed.
 *
 * A write is also the moment a UTF-8 BOM a read tolerated disappears: `stripBom`
 * keeps such a file readable, and the rewrite emits plain JSON.
 *
 * A file that exists but does not parse is **refused** rather than replaced. The
 * reads above report it as no configuration, so rewriting from that empty base
 * would discard a hand-edited file — every other key with it — over one stray
 * comma. A refusal costs a `/fetch style` that does not apply; a rewrite costs the
 * user their settings.
 *
 * @module lib/settings
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { settingsFile } from "./layout.js";

/** Strip a UTF-8 BOM, which pi's own loader also tolerates. */
function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Parse one settings file, returning `{}` for anything unreadable.
 *
 * Absent, unparseable, and non-object contents are all "no configuration":
 * pi reports a broken settings file itself, and a second, louder complaint from
 * an extension would not help the human fix it.
 */
function readOne(file: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(stripBom(readFileSync(file, "utf-8")));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/**
 * The global file's contents as a base for a write, or `undefined` when the file
 * must not be rewritten.
 *
 * A missing file is an empty base — the write creates it. A file that exists but
 * does not hold a JSON object is **refused**: {@link readOne} reports such a file
 * as no configuration, and writing from that empty base would replace the whole
 * hand-edited file — every other key with it — because of one stray comma. A
 * refusal leaves the broken file intact for its owner to fix.
 */
function writeBase(): Record<string, unknown> | undefined {
	const file = settingsFile();
	let text: string;
	try {
		text = stripBom(readFileSync(file, "utf-8"));
	} catch {
		return existsSync(file) ? undefined : {};
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/** Write `data` over the global settings file, atomically. Internal to the two writers. */
function writeGlobal(data: Record<string, unknown>): boolean {
	const file = settingsFile();
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
		renameSync(tmp, file);
		return true;
	} catch {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// A temp file that cannot be removed is litter, not a second failure.
		}
		return false;
	}
}

/**
 * The effective settings at extension load time: `{ ...global, ...project }`.
 *
 * Whole-object replace per key — see the merge order above. An unreadable file
 * contributes nothing rather than throwing.
 *
 * @param cwd - The session's working directory, for the project settings file.
 */
export function readSettings(cwd: string = process.cwd()): Record<string, unknown> {
	return { ...readOne(settingsFile()), ...readOne(path.join(cwd, ".pi", "settings.json")) };
}

/**
 * The effective value of one top-level settings key at extension load time.
 *
 * @param key - A top-level key, e.g. `modelFallback`.
 * @param cwd - The session's working directory, for the project settings file.
 * @returns The project value when present, else the global one, else undefined.
 */
export function readSettingsKey(key: string, cwd: string = process.cwd()): unknown {
	return readSettings(cwd)[key];
}

/**
 * Set one top-level key of the GLOBAL settings file, keeping the other keys.
 *
 * The project file is never written, and its value for `key` — if it has one —
 * keeps shadowing what is written here until it is removed.
 *
 * @returns `false` (nothing written) when the file could not be replaced, or when
 * its existing contents are not a JSON object (a write would discard them).
 */
export function writeSettingsKey(key: string, value: unknown): boolean {
	const base = writeBase();
	if (!base) return false;
	return writeGlobal({ ...base, [key]: value });
}

/**
 * Shallow-merge `patch` into the object at one top-level key of the GLOBAL file.
 *
 * Reads that key from the global file only — never the merged view, which would
 * promote a project's fields into the user's global configuration (see the write
 * rule above). Anything non-object already at the key is replaced.
 *
 * @returns `false` (nothing written) when the file could not be replaced, or when
 * its existing contents are not a JSON object (a write would discard them).
 */
export function patchSettingsKey(key: string, patch: Record<string, unknown>): boolean {
	const settings = writeBase();
	if (!settings) return false;
	const at = settings[key];
	const base = at && typeof at === "object" && !Array.isArray(at) ? (at as Record<string, unknown>) : {};
	return writeGlobal({ ...settings, [key]: { ...base, ...patch } });
}
