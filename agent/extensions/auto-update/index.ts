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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours between checks

let lastCheckTime = 0;

export default function (pi: ExtensionAPI) {
	// Check for updates on session start
	pi.on("session_start", async (_event, ctx) => {
		const now = Date.now();
		if (now - lastCheckTime < CHECK_INTERVAL_MS) return;
		lastCheckTime = now;

		try {
			const updateInfo = await checkForUpdate(pi);
			if (!updateInfo) return;

			const { currentVersion, latestVersion } = updateInfo;

			ctx.ui.notify(
				`pi update available: ${currentVersion} → ${latestVersion} (use /update to install)`,
				"info",
			);
			ctx.ui.setStatus(
				"auto-update",
				`⬆ ${latestVersion} available`,
			);
		} catch {
			// Silently ignore update check failures
		}
	});

	// Command to perform the update
	pi.registerCommand("update", {
		description: "Update pi to the latest version and restart",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.setStatus("auto-update", "Checking for updates...");

				const updateInfo = await checkForUpdate(pi);
				if (!updateInfo) {
					ctx.ui.notify("pi is already up to date!", "info");
					ctx.ui.setStatus("auto-update", undefined);
					return;
				}

				const { currentVersion, latestVersion } = updateInfo;

				const confirmed = await ctx.ui.confirm(
					"Update pi",
					`Update from ${currentVersion} to ${latestVersion}?\n\nThis will update the global bun package and restart pi.`,
				);

				if (!confirmed) {
					ctx.ui.setStatus("auto-update", undefined);
					return;
				}

				ctx.ui.setStatus("auto-update", `Updating to ${latestVersion}...`);
				ctx.ui.notify("Updating pi... this may take a moment.", "info");

				const result = await pi.exec(
					"bun",
					["update", "--global", PACKAGE_NAME],
					{ timeout: 120000 },
				);

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
				const updateInfo = await checkForUpdate(pi);
				if (!updateInfo) {
					return {
						content: [
							{
								type: "text" as const,
								text: "pi is up to date.",
							},
						],
						details: {},
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Update available: ${updateInfo.currentVersion} → ${updateInfo.latestVersion}. Use /update command to install.`,
						},
					],
					details: {},
				};
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
 * Get the currently running version by reading package.json from the
 * resolved module path. Extensions are loaded via jiti which can resolve
 * the package, so we find it relative to the known dist/cli.js entry.
 */
function getCurrentVersion(): string | null {
	try {
		// The pi binary is a symlink to .../node_modules/@earendil-works/pi-coding-agent/dist/cli.js
		// We can find the package.json relative to that
		const binPath = join(
			process.env.HOME ?? "~",
			"node_modules",
			PACKAGE_NAME,
			"package.json",
		);
		const pkg = JSON.parse(readFileSync(binPath, "utf-8"));
		return pkg.version ?? null;
	} catch {
		return null;
	}
}

async function checkForUpdate(
	pi: ExtensionAPI,
): Promise<{ currentVersion: string; latestVersion: string } | null> {
	// Get current installed version
	const currentVersion = getCurrentVersion();
	if (!currentVersion) return null;

	// Get latest version from npm registry
	const latestResult = await pi.exec(
		"npm",
		["view", PACKAGE_NAME, "version"],
		{ timeout: 15000 },
	);

	if (latestResult.code !== 0) return null;
	const latestVersion = latestResult.stdout.trim();

	if (!latestVersion) return null;
	if (currentVersion === latestVersion) return null;

	// Compare versions
	if (compareSemver(latestVersion, currentVersion) <= 0) return null;

	return { currentVersion, latestVersion };
}

function compareSemver(a: string, b: string): number {
	const partsA = a.split(".").map(Number);
	const partsB = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
