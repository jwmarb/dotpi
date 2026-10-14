/**
 * Projection publishing — the Windows regression.
 *
 * `publish` writes `<runtimeDir>/projection.json.tmp` and renames it over
 * `projection.json`. POSIX `rename` replaces an existing target; on Windows
 * `fs.rename` fails with EPERM while the target exists, so the FIRST publish
 * (an `add`) succeeded and every later one (a `move`/`note`/`rename`/…) failed
 * with "EPERM: operation not permitted, rename '…\Temp\pi-kanban-…\projection.json.tmp'
 * -> '…\projection.json'" — the board pane froze on the first state.
 *
 * The mock below emulates exactly that rename semantics on any platform, so
 * this test is a real regression guard here too: two consecutive `/kanban`
 * ops must both land in the projection file.
 *
 * Run from the repo root: `bun test agent/extensions/kanban/`
 * Note: bun's `mock.module` is process-wide — in the same `bun test` invocation
 * no other suite may call `fs.renameSync`, or run this file in its own invocation.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PANE = "publish-test-pane";
const REAL = await import("node:fs");
// Captured before the mock is installed: `mock.module` rewrites the namespace
// object itself, so `REAL.renameSync` would be the mock (and recurse).
const realRenameSync = REAL.renameSync;

/** `rename` as Windows implements it for `fs.rename`: the target must not exist. */
const winRenameSync = (from: string, to: string): void => {
	if (REAL.existsSync(to)) {
		const err = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`) as NodeJS.ErrnoException;
		err.code = "EPERM";
		throw err;
	}
	realRenameSync(from, to);
};

// Installed before `./index.js` is imported, so the extension links the wrapped
// rename; every other node:fs binding stays the real one.
mock.module("node:fs", () => ({ ...REAL, renameSync: winRenameSync }));

interface BoardRecordLike {
	ownerPaneId: string;
	runtimeDir?: string;
	projectionFile?: string;
	paneId?: string;
	opened: boolean;
	seq: number;
}

describe("projection publish", () => {
	let dir: string;
	let handler: (args: string, ctx: unknown) => Promise<void>;
	let notifications: string[];
	const ctx = {
		sessionManager: { getSessionId: () => "sess-test", getSessionName: () => "test", getLeafId: () => null },
		isIdle: () => true,
		hasUI: true,
		ui: { notify: (msg: string) => notifications.push(msg), setWidget: () => {} },
	} as unknown;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kanban-publish-"));
		notifications = [];
		process.env.HERDR_ENV = "1";
		process.env.HERDR_PANE_ID = PANE;
		delete process.env.PI_SUBAGENT_RUN_ID;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_PANE_ID;
		const boards = (globalThis as Record<symbol, Map<string, BoardRecordLike> | undefined>)[Symbol.for("pi.kanban.boards")];
		boards?.delete(PANE);
	});

	/** Boot the extension, capture the /kanban handler, seed its runtime dir. */
	async function boot(): Promise<void> {
		const seen: { def?: { handler: (args: string, ctx: unknown) => Promise<void> } } = {};
		const api = {
			registerTool: () => {},
			registerCommand: (_name: string, def: unknown) => {
				seen.def = def as typeof seen.def;
			},
			on: () => {},
			appendEntry: () => {},
			sendMessage: () => {},
		} as unknown as ExtensionAPI;
		const mod = await import("./index.js");
		mod.default(api);
		handler = seen.def!.handler;
		const g = globalThis as Record<symbol, Map<string, BoardRecordLike> | undefined>;
		const boards = (g[Symbol.for("pi.kanban.boards")] ??= new Map());
		boards.set(PANE, {
			ownerPaneId: PANE,
			runtimeDir: dir,
			projectionFile: join(dir, "projection.json"),
			opened: false,
			seq: 0,
		});
	}

	const projection = () => JSON.parse(readFileSync(join(dir, "projection.json"), "utf8")) as {
		seq: number;
		state: { cards: { id: string; title: string }[] };
	};

	test("a second publish replaces the projection file (Windows EPERM on rename)", async () => {
		await boot();
		await handler("add first card", ctx);
		const first = projection();
		expect(first.state.cards.map((c) => c.title)).toEqual(["first card"]);
		expect(first.seq).toBe(1);

		// The edit: the target now exists, so the rename throws EPERM like on Windows.
		await handler("add second card", ctx);
		const second = projection();
		expect(second.state.cards.map((c) => c.title)).toEqual(["first card", "second card"]);
		expect(second.seq).toBe(2);
		expect(notifications).toEqual([]); // no "could not be updated" warning
	});

	test("replaceSync installs over an existing target", async () => {
		await boot();
		const { replaceSync } = await import("./index.js");
		const target = join(dir, "t.json");
		const tmp = `${target}.tmp`;
		writeFileSync(target, "old");
		writeFileSync(tmp, "new");
		replaceSync(tmp, target);
		expect(readFileSync(target, "utf8")).toBe("new");
		expect(REAL.existsSync(tmp)).toBe(false);
	});

	test("replaceSync propagates a genuine failure", async () => {
		await boot();
		const { replaceSync } = await import("./index.js");
		const tmp = join(dir, "missing.tmp");
		expect(() => replaceSync(tmp, join(dir, "t.json"))).toThrow(/ENOENT/);
	});
});
