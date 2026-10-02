/**
 * Reading `settings.json` from extension top-level code.
 *
 * ## Why this exists rather than `pi.getSettings()`
 *
 * `registerVirtualModel()` is one of the few actions pi *queues* during
 * extension load, so the chain has to be known at load time. But
 * `pi.getSettings()` is a throwing stub until the runner binds its context
 * (`core/extensions/loader.js`: `getSettings: notInitialized`) — calling it at
 * load kills the extension with "Extension runtime not initialized", which is
 * exactly how the first version of this extension failed.
 *
 * So load-time configuration is read from disk here, and anything needed only
 * once a session is running (`retry.maxRetries` for the budget warning) still
 * goes through `pi.getSettings()`, where it is live and authoritative.
 *
 * This is the same shape `lib/dotenv.ts` and `lib/layout.ts` already have: a
 * module that extension top-level code may import must never throw, because a
 * throw there is a startup failure rather than a reported error.
 *
 * ## Merge order
 *
 * pi deep-merges global (`<agentDir>/settings.json`) with project
 * (`<cwd>/.pi/settings.json`), project winning. Only one key is read here, so
 * the merge is "project's value replaces global's if present" rather than a
 * recursive merge — a whole-object override is what a reader of the file would
 * expect of a single key, and partial merging of a chain would produce a chain
 * neither file declares.
 *
 * @module model-fallback/settings
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { settingsFile } from "../lib/layout.js";

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
 * The effective value of one top-level settings key at extension load time.
 *
 * @param key - A top-level key, e.g. `modelFallback`.
 * @param cwd - The session's working directory, for the project settings file.
 * @returns The project value when present, else the global one, else undefined.
 */
export function readSettingsKey(key: string, cwd: string = process.cwd()): unknown {
	const project = readOne(path.join(cwd, ".pi", "settings.json"));
	if (key in project) return project[key];
	const global = readOne(settingsFile());
	return global[key];
}
