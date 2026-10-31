/**
 * Tests for the pure update decision: `compareSemver` ordering (including
 * the prerelease rules the old numeric split silently turned into `NaN`) and
 * `planUpdateCheck`, the tri-state both the session status and the forced
 * `/update` / `pi_update` paths share.
 *
 * `parsePiBoltVersion` and `updateCommand` live in `runtime.test.ts`; not
 * re-tested here.
 */

import { describe, expect, test } from "bun:test";

import { compareSemver, planUpdateCheck } from "../auto-update/index.js";

describe("compareSemver", () => {
	test("compares numeric cores, not strings", () => {
		expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
		expect(compareSemver("1.9.0", "1.10.0")).toBeLessThan(0);
	});

	test("equal versions compare 0", () => {
		expect(compareSemver("1.4.0", "1.4.0")).toBe(0);
	});

	test("a release outranks its own prerelease", () => {
		expect(compareSemver("1.4.0-beta.1", "1.4.0")).toBeLessThan(0);
		expect(compareSemver("1.4.0", "1.4.0-beta.1")).toBeGreaterThan(0);
	});

	test("numeric prerelease identifiers compare numerically", () => {
		expect(compareSemver("1.4.0-beta.10", "1.4.0-beta.2")).toBeGreaterThan(0);
	});

	test("alphanumeric prerelease identifiers compare by ASCII", () => {
		expect(compareSemver("1.4.0-alpha", "1.4.0-beta")).toBeLessThan(0);
	});

	test("build metadata carries no ordering", () => {
		expect(compareSemver("1.4.0+abc", "1.4.0")).toBe(0);
	});

	test("a non-version is NaN, never a silent comparison", () => {
		expect(Number.isNaN(compareSemver("garbage", "1.0.0"))).toBe(true);
	});
});

describe("planUpdateCheck", () => {
	test("a failed npm view is an error", () => {
		expect(planUpdateCheck({ current: "1.4.0", latestStdout: "1.5.0", code: 1 })).toEqual({ status: "error" });
	});

	test("empty registry output is an error", () => {
		expect(planUpdateCheck({ current: "1.4.0", latestStdout: "  \n", code: 0 })).toEqual({ status: "error" });
	});

	test("an unknown current version is an error", () => {
		expect(planUpdateCheck({ current: null, latestStdout: "1.5.0\n", code: 0 })).toEqual({ status: "error" });
	});

	test("an unparseable registry version is an error, not 'up to date'", () => {
		expect(planUpdateCheck({ current: "1.4.0", latestStdout: "not-a-version", code: 0 })).toEqual({
			status: "error",
		});
	});

	test("same version is current", () => {
		expect(planUpdateCheck({ current: "1.4.0", latestStdout: "1.4.0\n", code: 0 })).toEqual({
			status: "current",
			currentVersion: "1.4.0",
		});
	});

	test("a newer registry version is available, trimmed", () => {
		expect(planUpdateCheck({ current: "1.4.0", latestStdout: "1.5.0\n", code: 0 })).toEqual({
			status: "available",
			currentVersion: "1.4.0",
			latestVersion: "1.5.0",
		});
	});

	test("an older registry version is current", () => {
		expect(planUpdateCheck({ current: "1.4.0", latestStdout: "1.3.0", code: 0 })).toEqual({
			status: "current",
			currentVersion: "1.4.0",
		});
	});
});
