/**
 * Auto-Update Extension for pi
 *
 * Checks for updates to @earendil-works/pi-coding-agent on session start.
 * If a newer version is available, notifies the user and provides a /update
 * command to install and restart.
 *
 * Update check runs at most once every 4 hours.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { originalEntry, runningCompiled } from "../lib/runtime.js";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
/** Pi-Bolt's npm package: its version is the one to compare when pi is compiled. */
const PIBOLT_PACKAGE_NAME = "pi-bolt";

/** The npm package whose releases update the running pi. */
function updatePackage(): string {
	return runningCompiled() ? PIBOLT_PACKAGE_NAME : PACKAGE_NAME;
}

/**
 * The command that installs the update. Pi-Bolt updates itself (`pi-bolt
 * update`: signature-checked, keeps the JIT/variant chosen, rollback-able); a
 * bun-global `bun update` would not touch the compiled executable at all.
 */
export function updateCommand(compiled: boolean = runningCompiled()): { bin: string; args: string[]; display: string } {
	if (compiled) return { bin: process.execPath, args: ["update", "--self", "--no-approve"], display: "pi-bolt update" };
	return { bin: "bun", args: ["update", "--global", PACKAGE_NAME], display: "pi update" };
}

/** `pi-bolt --version` prints `1.4.0 (Pi-Bolt 1.0.2, linux-x64, JIT off)`. Exported for tests. */
export function parsePiBoltVersion(stdout: string): string | null {
	return /Pi-Bolt (\d+\.\d+\.\d+[^\s,)]*)/.exec(stdout)?.[1] ?? null;
}
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours between checks


export default function (pi: ExtensionAPI) {
	// Check for updates on session start (shares one memoised check with
	// startup-fetch.ts, so a cold start runs `npm view` once).
	pi.on("session_start", async (_event, ctx) => {
		const result = await getUpdateStatus(pi);
		if (result.status !== "available") return;
		ctx.ui.setStatus("auto-update", `⬆ ${result.latestVersion} available`);
	});

	// Command to perform the update
	pi.registerCommand("update", {
		description: "Update pi to the latest version and restart",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.setStatus("auto-update", "Checking for updates...");

				const status = await getUpdateStatus(pi, true);
				if (status.status === "error") {
					// Distinct from "up to date": an unreachable registry is not a
					// clean bill of health.
					ctx.ui.notify("Could not check for pi updates (npm view or version lookup failed).", "error");
					ctx.ui.setStatus("auto-update", undefined);
					return;
				}
				if (status.status === "current") {
					ctx.ui.notify("pi is already up to date!", "info");
					ctx.ui.setStatus("auto-update", undefined);
					return;
				}

				const { currentVersion, latestVersion } = status;

				const confirmed = await ctx.ui.confirm(
					"Update pi",
					`Update from ${currentVersion} to ${latestVersion}?\n\nThis will run \`${updateCommand().display}\` and restart pi.`,
				);

				if (!confirmed) {
					ctx.ui.setStatus("auto-update", undefined);
					return;
				}

				ctx.ui.setStatus("auto-update", `Updating to ${latestVersion}...`);
				ctx.ui.notify("Updating pi... this may take a moment.", "info");

				const update = updateCommand();
				const result = await pi.exec(update.bin, update.args, { timeout: 120000 });

				if (result.code !== 0) {
					ctx.ui.notify(
						`Update failed (exit ${result.code}): ${result.stderr || result.stdout}`,
						"error",
					);
					ctx.ui.setStatus("auto-update", "Update failed");
					return;
				}

				ctx.ui.notify(
					`Updated to ${latestVersion}! Shutting down — please restart pi.`,
					"info",
				);
				ctx.ui.setStatus("auto-update", undefined);

				// Give the user a moment to read the notification
				await new Promise((resolve) => setTimeout(resolve, 1500));

				// Shutdown so the new binary takes effect on next launch
				ctx.shutdown();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Update error: ${msg}`, "error");
				ctx.ui.setStatus("auto-update", "Update error");
			}
		},
	});

	// Tool for the LLM to check/trigger updates
	pi.registerTool({
		name: "pi_update",
		label: "Pi Update",
		description:
			"Check for pi updates and optionally install them. Use when the user asks about updating pi or checking for new versions.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("check"),
				Type.Literal("install"),
			]),
		}),
		async execute(_toolCallId, params) {
			if (params.action === "check") {
				const status = await getUpdateStatus(pi, true);
				const text =
					status.status === "error"
						? "Could not check for pi updates."
						: status.status === "current"
							? "pi is up to date."
							: `Update available: ${status.currentVersion} → ${status.latestVersion}. Use /update command to install.`;
				return { content: [{ type: "text" as const, text }], details: {} };
			}

			// For install, queue the /update command
			pi.sendUserMessage("/update", { deliverAs: "followUp" });
			return {
				content: [
					{
						type: "text" as const,
						text: "Queued /update command. The user will be prompted to confirm the update.",
					},
				],
				details: {},
			};
		},
	});
}

/**
 * The version of pi that is actually running.
 *
 * Resolved from the `pi` on PATH, not from a guessed `node_modules` location.
 * This used to read `$HOME/node_modules/<pkg>/package.json`, which on this
 * machine holds a *different, older* copy than the binary being run: it
 * reported 0.75.4 while pi was 0.85.1, so every check compared the latest
 * release against a version the user was not running and offered an update
 * they already had.
 *
 * Under script pi `process.execPath` is the bun runtime, not pi, so the package is located by
 * resolving the `pi` symlink on PATH back to its own `package.json`.
 */
async function getCurrentVersion(pi: ExtensionAPI): Promise<string | null> {
	if (runningCompiled()) {
		// No package.json on disk: the executable reports its own version.
		try {
			const r = await pi.exec(process.execPath, ["--version"], { timeout: 5000 });
			return r.code === 0 ? parsePiBoltVersion(r.stdout) : null;
		} catch {
			return null;
		}
	}
	try {
		// process.argv[1] is the `pi` entry script being run. Resolving the
		// symlink lands inside the package that is actually executing, whatever
		// its install layout (bun global, npm, a checkout). `import.meta.resolve`
		// does not work here: jiti aliases the package for extensions, so it
		// throws "Cannot find module" inside a running pi.
		let dir = dirname(realpathSync(originalEntry() ?? ""));
		for (let i = 0; i < 5; i++) {
			const candidate = join(dir, "package.json");
			if (existsSync(candidate)) {
				const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
				if (pkg.name === PACKAGE_NAME) return pkg.version ?? null;
			}
			dir = dirname(dir);
		}
		return null;
	} catch {
		return null;
	}
}

export type UpdateStatus =
	| { status: "current"; currentVersion: string }
	| { status: "available"; currentVersion: string; latestVersion: string }
	| { status: "error" };

// On globalThis, not module scope: the extension loader re-imports modules on
// /reload (moduleCache: false), which would otherwise reset the memo.
const MEMO_KEY = Symbol.for("dotpi.auto-update.status");
type Memo = { at: number; promise: Promise<UpdateStatus> };
const memoStore = globalThis as unknown as Record<symbol, Memo | undefined>;

/**
 * Memoised, three-way update check: it tells "could not check" apart from
 * "up to date" — both the session-start status and the forced `/update` and
 * `pi_update` paths share it. Results are reused for CHECK_INTERVAL_MS
 * (errors are not cached); pass `force` to re-check, as both user-facing
 * paths do — a manual update request deserves a fresh answer.
 */
export function getUpdateStatus(pi: ExtensionAPI, force = false): Promise<UpdateStatus> {
	const memo = memoStore[MEMO_KEY];
	if (!force && memo && Date.now() - memo.at < CHECK_INTERVAL_MS) return memo.promise;
	const promise = computeUpdateStatus(pi).then((r) => {
		if (r.status === "error" && memoStore[MEMO_KEY]?.promise === promise) memoStore[MEMO_KEY] = undefined;
		return r;
	});
	memoStore[MEMO_KEY] = { at: Date.now(), promise };
	return promise;
}

async function computeUpdateStatus(pi: ExtensionAPI): Promise<UpdateStatus> {
	try {
		const currentVersion = await getCurrentVersion(pi);
		if (!currentVersion) return { status: "error" };
		const r = await pi.exec("npm", ["view", updatePackage(), "version"], { timeout: 15000 });
		return planUpdateCheck({ current: currentVersion, latestStdout: r.stdout, code: r.code });
	} catch {
		return { status: "error" };
	}
}

/**
 * The tri-state update decision, pure: what every caller asks after its
 * `npm view` — the memoised `computeUpdateStatus` and the forced `/update`
 * and `pi_update` checks alike. `latestStdout` is the registry's raw output
 * and `code` its exit status; an unparseable version is an error, never a
 * silent "up to date".
 */
export function planUpdateCheck(input: {
	current: string | null;
	latestStdout: string;
	code: number;
}): UpdateStatus {
	const latest = input.latestStdout.trim();
	if (!input.current || input.code !== 0 || !latest) return { status: "error" };
	const cmp = compareSemver(latest, input.current);
	if (Number.isNaN(cmp)) return { status: "error" };
	if (cmp > 0) return { status: "available", currentVersion: input.current, latestVersion: latest };
	return { status: "current", currentVersion: input.current };
}

/**
 * A version as semver §4 allows here: optional `v`, a numeric core, an
 * optional `-prerelease`, and an optional `+build` that carries no ordering.
 * `undefined` for anything else.
 */
function parseVersion(v: string): { core: number[]; pre?: string[] } | undefined {
	const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim().replace(/\+.*$/, ""));
	if (!m) return undefined;
	return {
		core: [Number(m[1]), Number(m[2]), Number(m[3])],
		...(m[4] ? { pre: m[4].split(".") } : {}),
	};
}

/**
 * semver §11 ordering for the prerelease parts: a release outranks its own
 * prerelease; within prereleases, all-digit identifiers compare numerically
 * (and rank below alphanumeric ones), the rest by ASCII, and a shorter
 * identifier list ranks lower.
 */
function comparePrerelease(a: string[] | undefined, b: string[] | undefined): number {
	if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		const x = a[i]!;
		const y = b[i]!;
		if (x === y) continue;
		const xNum = /^\d+$/.test(x);
		if (xNum !== /^\d+$/.test(y)) return xNum ? -1 : 1;
		if (xNum) return Number(x) - Number(y);
		return x < y ? -1 : 1;
	}
	return a.length - b.length;
}

/**
 * `a` against `b`: negative, 0, positive — or `NaN` when either side is not
 * a version, which {@link planUpdateCheck} turns into "error". Exported for
 * tests.
 */
export function compareSemver(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	if (!pa || !pb) return Number.NaN;
	for (let i = 0; i < 3; i++) {
		const diff = pa.core[i]! - pb.core[i]!;
		if (diff !== 0) return diff;
	}
	return comparePrerelease(pa.pre, pb.pre);
}
