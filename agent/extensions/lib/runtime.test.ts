import { describe, expect, test } from "bun:test";
import { mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePiBoltVersion, updateCommand } from "../auto-update/index.js";
import { paneCommand } from "../kanban/lib.js";
import { chmodSync, mkdirSync } from "node:fs";
import { isCompiledEntry, piExecutable, piShimDir, prependPathCommand, runningCompiled } from "./runtime.js";

describe("runtime: compiled (Pi-Bolt) vs script pi", () => {
	test("isCompiledEntry recognises Bun's virtual entry on every platform", () => {
		expect(isCompiledEntry("/$bunfs/root/pi")).toBe(true);
		expect(isCompiledEntry("B:/~BUN/root/pi.exe")).toBe(true);
		expect(isCompiledEntry("file:///B:/%7EBUN/root/pi")).toBe(true);
		expect(isCompiledEntry("/home/u/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")).toBe(false);
		expect(isCompiledEntry(undefined)).toBe(false);
	});
	test("piExecutable: the executable when compiled, the entry script otherwise", () => {
		expect(piExecutable("/$bunfs/root/pi", "/opt/pi-bolt/pi")).toBe("/opt/pi-bolt/pi");
		expect(piExecutable("/x/cli.js", "/usr/bin/bun")).toBe("/x/cli.js");
	});
	test("piShimDir links `pi` to the target, idempotently and retargetably", () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "shim-test-"));
		try {
			const dir = piShimDir("/opt/a/pi", root)!;
			expect(readlinkSync(join(dir, "pi"))).toBe("/opt/a/pi");
			expect(piShimDir("/opt/a/pi", root)).toBe(dir);
			piShimDir("/opt/b/pi", root);
			expect(readlinkSync(join(dir, "pi"))).toBe("/opt/b/pi");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	test("prependPathCommand quotes the dir", () => {
		expect(prependPathCommand("/t/it's")).toBe(`export PATH='/t/it'\\''s':"$PATH"; hash -r 2>/dev/null`);
	});
	test("paneCommand carries env for the program only", () => {
		expect(paneCommand(["/p/pi", "b.ts"], "linux", { BUN_BE_BUN: "1" })).toBe("exec env BUN_BE_BUN=1 /p/pi b.ts");
		expect(paneCommand(["C:\\p\\pi.exe", "b.ts"], "win32", { BUN_BE_BUN: "1" })).toBe(
			"$env:BUN_BE_BUN = '1'; & 'C:\\p\\pi.exe' 'b.ts'; exit $LASTEXITCODE",
		);
		expect(paneCommand(["/b/bun", "x"], "linux")).toBe("exec /b/bun x");
	});
	test("parsePiBoltVersion reads Pi-Bolt's own version, not Pi's", () => {
		expect(parsePiBoltVersion("1.4.0 (Pi-Bolt 1.0.2, linux-x64, JIT off)\n")).toBe("1.0.2");
		expect(parsePiBoltVersion("1.4.0\n")).toBeNull();
	});
	test("updateCommand: bun's global update for script pi, Pi-Bolt's own self-update when compiled", () => {
		expect(updateCommand(false).bin).toBe("bun");
		const c = updateCommand(true);
		expect(c.bin).toBe(process.execPath);
		expect(c.args).toEqual(["update", "--self", "--no-approve"]);
		expect(c.display).toBe("pi-bolt update");
	});
	test("runningCompiled takes the entry to test", () => {
		expect(runningCompiled("/$bunfs/root/pi")).toBe(true);
		expect(runningCompiled("/x/cli.js")).toBe(false);
	});
	test("piShimDir refuses a shim dir others can write", () => {
		if (process.platform === "win32") return;
		const root = mkdtempSync(join(tmpdir(), "shim-test-"));
		try {
			mkdirSync(join(root, "pi-shim"));
			chmodSync(join(root, "pi-shim"), 0o777);
			expect(piShimDir("/opt/a/pi", root)).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("runtime: sees through pi-bolt-host's stand-in argv[1]", () => {
	test("the recorded original entry wins over a faked argv[1]", async () => {
		const { ORIGINAL_ENTRY_KEY, originalEntry, runningCompiled } = await import("./runtime.js");
		const g = globalThis as Record<symbol, unknown>;
		const saved = process.argv[1];
		try {
			g[ORIGINAL_ENTRY_KEY] = "/$bunfs/root/pi";
			process.argv[1] = "/home/u/.pi/agent/cache/pi-bolt-host/dist/cli.js";
			expect(originalEntry()).toBe("/$bunfs/root/pi");
			expect(runningCompiled()).toBe(true);
		} finally {
			delete g[ORIGINAL_ENTRY_KEY];
			process.argv[1] = saved;
		}
		expect(runningCompiled()).toBe(false);
	});
});
