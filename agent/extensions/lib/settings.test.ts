/**
 * Tests for the settings seam (`lib/settings.ts`) — the one load-safe read and
 * write path for `settings.json`.
 *
 * The behaviour worth pinning is the merge rule and the write rule, because the
 * two consumers need opposite things from the same file. Reads are
 * project-over-global with a WHOLE-OBJECT replace per key (what pi's deep merge
 * does not do here, and what a reader of one key expects); writes go to the
 * GLOBAL file only and merge into the namespace they are given, so a repo's own
 * `.pi/settings.json` can never be copied into the user's global config.
 *
 * Every test retargets the agent directory with `ENV_AGENT_DIR` (`layout.ts`
 * reads it at call time, so `settingsFile()` moves) and asserts it moved: the
 * alternative is writing the real `agent/settings.json` from a test.
 *
 * Run from the repo root: `bun test agent/extensions/lib/settings.test.ts`
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENV_AGENT_DIR, settingsFile } from "./layout.js";
import { patchSettingsKey, readSettings, readSettingsKey } from "./settings.js";

/** UTF-8 BOM, which pi's own loader tolerates and this seam must too. */
const BOM = "\uFEFF";

const envBefore = process.env[ENV_AGENT_DIR];
let agent = "";
let cwd = "";

/** The global settings file of the current temp agent directory. */
const globalFile = () => settingsFile();
const globalJson = () => JSON.parse(readFileSync(globalFile(), "utf-8"));
const writeGlobal = (contents: string) => writeFileSync(globalFile(), contents);
const writeProject = (contents: unknown) => {
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), typeof contents === "string" ? contents : JSON.stringify(contents));
};
const projectJson = () => JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf-8"));

beforeEach(() => {
	agent = mkdtempSync(join(tmpdir(), "settings-agent-"));
	cwd = mkdtempSync(join(tmpdir(), "settings-cwd-"));
	process.env[ENV_AGENT_DIR] = agent;
	// Inherited by every test: the seam's global file must be the temp one.
	expect(settingsFile().startsWith(agent)).toBe(true);
});

afterEach(() => {
	if (envBefore === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = envBefore;
	rmSync(agent, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

describe("readSettings / readSettingsKey", () => {
	test("a BOM'd global file parses", () => {
		writeGlobal(BOM + JSON.stringify({ a: 1, startupFetch: { style: "half" } }));
		expect(readSettings(cwd)).toEqual({ a: 1, startupFetch: { style: "half" } });
		expect(readSettingsKey("a", cwd)).toBe(1);
	});

	test("project wins per key, whole-object replace; an omitted key survives", () => {
		writeGlobal(JSON.stringify({ k: { a: 1, b: 2 }, other: { keep: 1 } }));
		writeProject({ k: { a: 9 } });
		// The project's `k` replaces the global `k` wholesale — `k.b` is gone, not
		// deep-merged back in — while `other`, which the project never names, stands.
		expect(readSettings(cwd)).toEqual({ k: { a: 9 }, other: { keep: 1 } });
		expect(readSettingsKey("k", cwd)).toEqual({ a: 9 });
		expect(readSettingsKey("other", cwd)).toEqual({ keep: 1 });
	});

	test("a project-only or global-only file still reads", () => {
		writeProject({ k: { only: "project" } });
		expect(readSettings(cwd)).toEqual({ k: { only: "project" } });
		rmSync(join(cwd, ".pi", "settings.json"), { force: true });
		writeGlobal(JSON.stringify({ k: { only: "global" } }));
		expect(readSettings(cwd)).toEqual({ k: { only: "global" } });
		expect(readSettingsKey("nope", cwd)).toBeUndefined();
	});

	test("absent, unparseable, array and string contents are all \"no configuration\"", () => {
		// Nothing here may throw: a throw at extension import is a dead pi.
		for (const contents of ["{ not json", "[1,2]", '"just a string"', "42", ""]) {
			writeGlobal(contents);
			expect(() => readSettings(cwd)).not.toThrow();
			expect(readSettings(cwd)).toEqual({});
			expect(readSettingsKey("k", cwd)).toBeUndefined();
		}
		// Absent files (neither file exists) are the same case.
		rmSync(globalFile(), { force: true });
		expect(readSettings(cwd)).toEqual({});
		expect(readSettingsKey("k", cwd)).toBeUndefined();
		// A broken project file does not veto a good global one.
		writeGlobal(JSON.stringify({ k: "from global" }));
		writeProject("{ broken");
		expect(readSettingsKey("k", cwd)).toBe("from global");
	});

	test("readSettingsKey defaults to the real cwd", () => {
		// Only that it is callable and reports nothing about a key no settings file
		// declares, so a consumer's `readSettingsKey("startupFetch")` cannot pick up
		// a stray key from the developer's own configuration.
		expect(readSettingsKey("definitelyNotASettingsKey9e1c")).toBeUndefined();
	});
});

describe("patchSettingsKey", () => {
	test("shallow-merges into the existing global namespace", () => {
		writeGlobal(JSON.stringify({ other: 1, startupFetch: { mode: "cycle", height: 20 } }));
		expect(patchSettingsKey("startupFetch", { style: "quad" })).toBe(true);
		expect(globalJson()).toEqual({ other: 1, startupFetch: { mode: "cycle", height: 20, style: "quad" } });
		expect(readdirSync(agent)).toEqual(["settings.json"]);
	});

	test("creates the namespace when the key is absent", () => {
		writeGlobal(JSON.stringify({ other: 1 }));
		expect(patchSettingsKey("startupFetch", { mode: "quad" })).toBe(true);
		expect(globalJson()).toEqual({ other: 1, startupFetch: { mode: "quad" } });
	});

	test("a non-object already at the key is replaced, not spread", () => {
		writeGlobal(JSON.stringify({ startupFetch: "nonsense" }));
		expect(patchSettingsKey("startupFetch", { mode: "quad" })).toBe(true);
		expect(globalJson()).toEqual({ startupFetch: { mode: "quad" } });
	});

	test("does not copy project fields into the global namespace", () => {
		writeGlobal(JSON.stringify({ startupFetch: { mode: "cycle" } }));
		writeProject({ startupFetch: { style: "braille", image: "duck.png" } });
		expect(patchSettingsKey("startupFetch", { style: "quad" })).toBe(true);
		const written = globalJson();
		expect(written).toEqual({ startupFetch: { mode: "cycle", style: "quad" } });
		expect(written.startupFetch.image).toBeUndefined();
		expect(projectJson()).toEqual({ startupFetch: { style: "braille", image: "duck.png" } });
	});

	test("the merged view is never the write target: a project pin stays local", () => {
		// The consequence of reading global-only: a repo that pins the namespace in
		// its own `.pi/settings.json` shadows this write in that repo (whole-object
		// replace), and copying the merged view would instead have leaked the
		// project's fields into the user's global config.
		writeProject({ startupFetch: { style: "braille" } });
		expect(patchSettingsKey("startupFetch", { style: "quad" })).toBe(true);
		expect(globalJson()).toEqual({ startupFetch: { style: "quad" } });
		expect(readSettingsKey("startupFetch", cwd)).toEqual({ style: "braille" });
	});
	test("a BOM the read tolerated is dropped by the write", () => {
		writeGlobal(BOM + JSON.stringify({ other: 1 }));
		expect(patchSettingsKey("startupFetch", { style: "quad" })).toBe(true);
		expect(readFileSync(globalFile(), "utf-8").startsWith(BOM)).toBe(false);
		expect(globalJson()).toEqual({ other: 1, startupFetch: { style: "quad" } });
	});

	test("an existing file that does not parse is refused, not overwritten", () => {
		// `readOne` reports a broken file as no configuration; rewriting from that
		// empty base would discard every other key over one stray comma. So a writer
		// refuses, and the broken file is left for its owner to fix.
		writeGlobal("{ broken");
		expect(patchSettingsKey("startupFetch", { style: "quad" })).toBe(false);
		expect(readFileSync(settingsFile(), "utf-8")).toBe("{ broken");
	});
	test("a missing file is an empty base, so the first write creates it", () => {
		rmSync(settingsFile(), { force: true });
		expect(existsSync(globalFile())).toBe(false);
		expect(patchSettingsKey("startupFetch", { style: "quad" })).toBe(true);
		expect(globalJson()).toEqual({ startupFetch: { style: "quad" } });
	});
	test("a file holding a non-object is refused too", () => {
		// An array or a scalar is the same hazard: no keys survive a rewrite from {}.
		writeGlobal("[1,2]");
		expect(patchSettingsKey("startupFetch", { style: "quad" })).toBe(false);
		expect(readFileSync(settingsFile(), "utf-8")).toBe("[1,2]");
	});
});
