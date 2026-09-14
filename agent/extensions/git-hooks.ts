/**
 * git-hooks — self-arms the tracked pre-commit hook on every startup.
 *
 * The hook that refuses a commit whose extension sources cannot load lives in
 * tracked .githooks/, but core.hooksPath is LOCAL git config: a fresh clone
 * has the hook file and silently does not use it. Silence is the failure this
 * guard exists to stop, so the guard arms itself. pi loads this extension
 * from the same repo the hook protects, so on startup it points the clone at
 * .githooks — no manual step, on every clone, from the first commit.
 *
 * Deliberately conservative:
 *   - it only sets the LOCAL config, and
 *   - only when nothing is set. A clone that deliberately points
 *     core.hooksPath somewhere else gets a loud warning (the bypass is
 *     visible) rather than a clobber.
 *
 * Every failure here is swallowed: this extension must never be the reason pi
 * will not start.
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { envFilePath } from "./lib/dotenv.js";

const HOOKS_PATH = ".githooks";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		try {
			// The config dir is the parent of agent/, which is the repo root
			// for a repo-shaped clone. envFilePath() resolves PI_CODING_AGENT_DIR
			// (or ~/.pi/agent), so this is the clone pi is actually running.
			const repoRoot = path.dirname(path.dirname(envFilePath()));

			const top = await pi.exec("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"]);
			if (top.code !== 0) return; // not a git repo: nothing to arm

			// Effective value: local overrides global, so a deliberately
			// configured clone is detected here, not just an unset one.
			const current = await pi.exec("git", ["-C", repoRoot, "config", "core.hooksPath"]);

			if (current.code === 0 && current.stdout.trim() !== "") {
				const value = current.stdout.trim();
				if (path.resolve(repoRoot, value) !== path.resolve(repoRoot, HOOKS_PATH)) {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`core.hooksPath is "${value}" in this clone, so the tracked pre-commit hook that refuses unloadable extension sources will NOT run on commit here. Restore it with: git config core.hooksPath ${HOOKS_PATH}`,
							"warning",
						);
					}
				}
				return;
			}

			// Unset: arm it, but only if the tracked hook is actually part of
			// this clone (a clone where .githooks was deleted must not be
			// pointed at a directory that does not guard anything).
			const hasHook = await pi.exec("git", ["-C", repoRoot, "ls-files", "--error-unmatch", `${HOOKS_PATH}/pre-commit`]);
			if (hasHook.code !== 0) return;

			const set = await pi.exec("git", ["-C", repoRoot, "config", "--local", "core.hooksPath", HOOKS_PATH]);
			if (set.code !== 0) return; // leave it; do not make noise about it

			if (ctx.hasUI) {
				ctx.ui.notify(
					`Enabled the tracked pre-commit hook (core.hooksPath → ${HOOKS_PATH}). Commits in this clone now refuse extension sources that cannot load.`,
					"info",
				);
			}
		} catch {
			// Startup must not break because of this guard.
		}
	});
}
