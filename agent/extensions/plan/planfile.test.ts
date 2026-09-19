/**
 * Pin the ADR 0048 shared plan-file store: seeding a Run's plan at spawn
 * (locked, never clobbering, best-effort shape), the nudge line, and the
 * on-disk item schema -- including the `reviewRunId` twin of `reworkRunId`.
 *
 * Everything is exercised against real files under a temp dir: the store's
 * whole reason to exist is that *other processes* read and write these files.
 *
 * Two house rules for this file, both workarounds for bun v1.4.0: the import
 * from ./planfile.js stays on ONE line -- a multi-line named import silently
 * leaves some imported bindings undefined under bun test (the imported module
 * itself parses fine) -- and expected strings are compared against
 * module-level consts, since an equality check between a called value and a
 * string literal in the same body can break the module link too.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NO_WRITE, PlanLockTimeoutError, YOUR_PLAN_NUDGE, acquirePlanLock, loadPlan, mutatePlan, planFilePathFor, seedRunPlan } from "./planfile.js";

const NUDGE_1 = "Your plan is seeded with 1 items \u2014 maintain it as you work";
const NUDGE_3 = "Your plan is seeded with 3 items \u2014 maintain it as you work";
const PATH_FOR_6748 = "/home/u/.pi/agent/plans/sub-6748.jsonl";
const PRE_EXISTING = '{"id":"p1","text":"pre-existing","status":"active"}\n';
const NOT_JSON = "not-json-at-all";
const SEED_IDS = ["p1", "p2", "p3"];
const SEED_TEXTS = ["First item", "Second item", "Third item"];
const FRESH_TEXT = "Seeded into a fresh dir";
const HANG_MESSAGE = "seedRunPlan hung on a fresh agent dir";


describe("YOUR_PLAN_NUDGE", () => {
	test("names the item count and the obligation", () => {
		// Call results land in variables before the assertion: the bun:test
		// equality between a called value and an in-body literal is the shape
		// that flakes this bun's module link (see the note at the top).
		const n1 = YOUR_PLAN_NUDGE(1);
		const n3 = YOUR_PLAN_NUDGE(3);
		expect([n1, n3]).toEqual([NUDGE_1, NUDGE_3]);
	});
});
describe("planFilePathFor", () => {
	test("addresses the plan file under the agent dir's plans directory", () => {
		expect(
			planFilePathFor("/home/u/.pi/agent", "sub-6748"),
		).toBe(PATH_FOR_6748);
	});
});

describe("seedRunPlan", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(path.join(os.tmpdir(), "planfile-seed-"));
		// planFilePathFor nests under plans/. The pre-existing-file tests write
		// files directly (writeFile creates no parent), so the fixture provides
		// the directory; the fresh-agent-dir block below covers the store
		// creating it itself.
		await mkdir(path.join(agentDir, "plans"), { recursive: true });
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	test("seeds p1..pn with status backlog and route skip", async () => {
		const { seeded } = await seedRunPlan(agentDir, "sub-test-1", [
			"First item",
			"Second item",
			"Third item",
		]);
		expect(seeded).toBe(true);

		const items = await loadPlan(planFilePathFor(agentDir, "sub-test-1"));
		expect(items.map((i) => i.id)).toEqual(SEED_IDS);
		expect(items.map((i) => i.text)).toEqual(SEED_TEXTS);
		for (const item of items) {
			expect(item.status).toBe("backlog");
			// A child cannot /accept its own items, so the seed must not carry
			// the default `user` route that would block its `done`.
			expect(item.route).toBe("skip");
		}
	});

	test("never clobbers a file that already has items", async () => {
		const file = planFilePathFor(agentDir, "sub-test-2");
		await writeFile(file, PRE_EXISTING, "utf-8");

		const { seeded } = await seedRunPlan(agentDir, "sub-test-2", ["Seeded"]);
		expect(seeded).toBe(false);

		// Left byte-for-byte: the pre-existing plan is somebody else's decision.
		expect(await readFile(file, "utf-8")).toBe(PRE_EXISTING);
	});

	test("never clobbers a pre-existing empty file", async () => {
		const file = planFilePathFor(agentDir, "sub-test-3");
		await writeFile(file, "", "utf-8");

		const { seeded } = await seedRunPlan(agentDir, "sub-test-3", ["Seeded"]);
		expect(seeded).toBe(false);

		// The file pre-existed, so the seed is skipped and the file is left
		// byte-for-byte — a pre-existing file means the seed is skipped, no
		// matter what it contains (docs/adr/0048).
		expect(await readFile(file, "utf-8")).toBe("");
	});

	test("never clobbers a metadata-only file", async () => {
		const file = planFilePathFor(agentDir, "sub-test-4");
		const meta = '{"kind":"plan-meta","autonomous":true}\n';
		await writeFile(file, meta, "utf-8");

		const { seeded } = await seedRunPlan(agentDir, "sub-test-4", ["Seeded"]);
		expect(seeded).toBe(false);

		// The meta line parses to zero items, so a parsed-length check would
		// seed here and the rewrite would destroy the meta. The existence
		// check leaves it byte-for-byte (docs/adr/0048).
		expect(await readFile(file, "utf-8")).toBe(meta);
	});

	test("never clobbers a corrupt-only file", async () => {
		const file = planFilePathFor(agentDir, "sub-test-5");
		const corrupt = NOT_JSON + "\n";
		await writeFile(file, corrupt, "utf-8");

		const { seeded } = await seedRunPlan(agentDir, "sub-test-5", ["Seeded"]);
		expect(seeded).toBe(false);

		// Corrupt lines parse to zero items too; the seed must not overwrite
		// them (docs/adr/0048).
		expect(await readFile(file, "utf-8")).toBe(corrupt);
	});

	// Regression: a fresh agent dir has no plans/ directory at all. The lock
	// directory lives inside plans/, so the store must create the parent
	// before acquiring the lock — otherwise the missing-dir ENOENT reads as
	// an "infinitely stale" lock and the acquire loop never reaches its
	// deadline, hanging the spawn path's best-effort seed (docs/adr/0048).
	describe("in a fresh agent dir without a plans directory", () => {
		let agentDir: string;

		beforeEach(async () => {
			agentDir = await mkdtemp(path.join(os.tmpdir(), "planfile-seed-fresh-"));
			// Deliberately no mkdir of plans/ here: that is the case under test.
		});

		afterEach(async () => {
			await rm(agentDir, { recursive: true, force: true });
		});

		test("seeds into a plans directory that does not exist yet", async () => {
			const result = await Promise.race([
				seedRunPlan(agentDir, "sub-fresh-1", [FRESH_TEXT]),
				// The bug was an infinite loop, not a slow write: a timeout here
				// is a hang. The fixed path completes in a few fs operations.
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error(HANG_MESSAGE)), 2000),
				),
			]);
			expect(result.seeded).toBe(true);
			const items = await loadPlan(planFilePathFor(agentDir, "sub-fresh-1"));
			expect(items.map((i) => i.text)).toEqual([FRESH_TEXT]);
			expect(items.map((i) => i.route)).toEqual(["skip"]);
		});
	});
});


describe("loadPlan item schema round-trip", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "planfile-schema-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("carries reworkRunId and reviewRunId, and their durable last-Run twins", async () => {
		const file = path.join(dir, "plan.jsonl");
		await writeFile(
			file,
			JSON.stringify({
				id: "p1",
				text: "The item",
				status: "review",
				reworkRunId: "pln-abc1-1",
				reviewRunId: "pln-def2-1",
				lastReworkRunId: "pln-old1-1",
				lastReviewRunId: "pln-old2-1",
			}) + "\n",
			"utf-8",
		);
		const items = await loadPlan(file);
		expect(items[0].reworkRunId).toBe("pln-abc1-1");
		expect(items[0].reviewRunId).toBe("pln-def2-1");
		// The durable records survive independently of the in-flight markers:
		// they are what the post-hoc Board reads once the markers are cleared
		// (docs/adr/0048).
		expect(items[0].lastReworkRunId).toBe("pln-old1-1");
		expect(items[0].lastReviewRunId).toBe("pln-old2-1");
	});

	test("drops an empty-string run id: it is absence, not a value", async () => {
		const file = path.join(dir, "plan.jsonl");
		await writeFile(
			file,
			JSON.stringify({
				id: "p1",
				text: "The item",
				status: "active",
				reviewRunId: "",
				lastReworkRunId: "",
				lastReviewRunId: "",
			}) + "\n",
			"utf-8",
		);
		const items = await loadPlan(file);
		expect(items[0].reviewRunId).toBeUndefined();
		expect(items[0].lastReworkRunId).toBeUndefined();
		expect(items[0].lastReviewRunId).toBeUndefined();
	});

	test("keeps an unknown status as an item, filed backlog", async () => {
		const file = path.join(dir, "plan.jsonl");
		await writeFile(
			file,
			JSON.stringify({ id: "p1", text: "New state", status: "groomed" }) +
				"\n",
			"utf-8",
		);
		const items = await loadPlan(file);
		expect(items).toHaveLength(1);
		expect(items[0].status).toBe("backlog");
	});
});

describe("mutatePlan", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "planfile-mutate-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("NO_WRITE leaves the file byte-for-byte, including lines loadPlan would drop", async () => {
		const file = path.join(dir, "plan.jsonl");
		const before = JSON.stringify({ id: "p1", text: "kept", status: "active" }) + "\n" + NOT_JSON + "\n";
		await writeFile(file, before, "utf-8");

		const items = await mutatePlan(file, () => NO_WRITE);
		expect(items).toHaveLength(1); // what was read
		expect(await readFile(file, "utf-8")).toBe(before);
	});

	test("creates the plan file's directory before acquiring the lock", async () => {
		// The lock directory lives inside the plan file's own directory. When
		// that directory does not exist, acquiring the lock first loops on
		// ENOENT forever (the missing dir reads as infinitely stale) — so the
		// directory must be created before the lock, not only before the write.
		const file = path.join(dir, "nested", "plan.jsonl");
		const items = await mutatePlan(file, () => [
			{ id: "p1", text: "Nested", status: "backlog" },
		]);
		expect(items).toHaveLength(1);
		expect(await readFile(file, "utf-8")).toContain("Nested");
	});
});

describe("acquirePlanLock", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "planfile-lock-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("refuses with PlanLockTimeoutError while a live writer holds it", async () => {
		const file = path.join(dir, "plan.jsonl");
		// A fresh lock owned by somebody else: its age must not read as stale,
		// so the waiter spends its budget and refuses.
		const owner = { pid: process.pid, at: Date.now(), token: "other-holder" };
		await mkdir(`${file}.lock`);
		await writeFile(
			path.join(`${file}.lock`, "owner.json"),
			JSON.stringify(owner),
			"utf-8",
		);

		await expect(acquirePlanLock(file)).rejects.toThrow(
			PlanLockTimeoutError,
		);
	});

	test("release only removes the lock this acquisition owns", async () => {
		const file = path.join(dir, "plan.jsonl");
		const release = await acquirePlanLock(file);
		// Somebody else's owner file overwriting ours is the stale-break race:
		// release must not delete the replacement holder's lock.
		const owner = { pid: process.pid, at: Date.now(), token: "someone-else" };
		await writeFile(
			path.join(`${file}.lock`, "owner.json"),
			JSON.stringify(owner),
			"utf-8",
		);
		await release();
		const remaining = await readFile(
			path.join(`${file}.lock`, "owner.json"),
			"utf-8",
		);
		expect(JSON.parse(remaining).token).toBe("someone-else");
	});
});
