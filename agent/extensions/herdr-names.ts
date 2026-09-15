/**
 * herdr-names — give this pi session a readable herdr tab and pane label.
 *
 * A pi pane starts with no label at all and its tab shows herdr's ordinal
 * (`1`, `2`, …), so a workspace with several sessions plus the panes the
 * subagent and plan extensions open is a row of interchangeable numbers. The
 * orchestrator — the session a human is actually typing into — is the one that
 * most needs to be findable, and it was the only one nothing named.
 *
 * **A Run is also a pi process**, so this cannot simply name every session it
 * loads into. A delegated Run already gets a tab from `subagent/index.ts`
 * (`explorer (#6748)`) and a pane from `mirrorPaneLabel`, and a plan-spawned
 * review or rework is named by `plan/review.ts`. Relabelling those from inside
 * the child would overwrite the spawner's own naming with `orchestrator`, which
 * is both wrong and the exact opposite of the point. The child markers in the
 * environment are what distinguish them, and they are checked *before* anything
 * is renamed.
 *
 * Every failure is swallowed. Naming a tab is cosmetic, and it must never be
 * the reason pi will not start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { herdrContext, renamePane, renameTab } from "./herdr/client.js";

/** The label an orchestrator session claims. */
const ORCHESTRATOR_LABEL = "orchestrator";

/**
 * Environment markers that mean "this pi is a child Run, not an orchestrator".
 *
 * Each is set by the spawner on the child's pane environment:
 *   - `PI_SUBAGENT_RUN_ID`  — a delegated Run (subagent extension).
 *   - `PI_PLAN_IN_REVIEW`   — an autonomous review (plan extension); it doubles
 *     as the recursion interlock, so it is reliably present.
 *   - `PI_RUN_WRAPPER`      — any Run launched through the herdr plugin's argv
 *     entrypoint, which covers a rework.
 *
 * Checked as a set rather than one flag because these three are set by
 * different code paths, and a Run that grew a fourth launcher should default to
 * being left alone rather than to claiming the orchestrator's name.
 */
const CHILD_RUN_MARKERS = [
	"PI_SUBAGENT_RUN_ID",
	"PI_PLAN_IN_REVIEW",
	"PI_RUN_WRAPPER",
] as const;

/** Whether this process is a child Run rather than a user's own session. */
function isChildRun(): boolean {
	return CHILD_RUN_MARKERS.some((key) => {
		const value = process.env[key];
		return value !== undefined && value !== "";
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, _ctx) => {
		// `startup` and `reload` only. Both mean "this pane may not carry its name":
		// a fresh session has never been named, and a reload is how this extension
		// arrives in a pane that predates it — which is the common case for an
		// existing session, and the one a `startup`-only guard silently missed.
		//
		// `new`, `resume` and `fork` are deliberately excluded. Those swap the
		// session inside a pane that is already named, so relabelling would fight a
		// name the user may have set by hand, and none of them can be the moment
		// this extension first sees the pane.
		if (event.reason !== "startup" && event.reason !== "reload") return;
		try {
			// A Run's tab and pane are named by whoever spawned it, and that naming
			// is better than anything this file could produce — it knows the Task,
			// the agent and the plan item. Leave it alone.
			if (isChildRun()) return;

			// Not under herdr: nothing to name, and no `herdr` binary to call.
			const ctx = herdrContext();
			if (!ctx) return;

			// Tab first, then pane. The tab is what shows in the tab bar and is the
			// thing being asked for; the pane label is what the sidebar and
			// `findPaneByLabel` use. Both are attempted independently so one
			// failing still leaves the other named.
			await renameTab(ctx.tabId, ORCHESTRATOR_LABEL);
			await renamePane(ctx.paneId, ORCHESTRATOR_LABEL);
		} catch {
			// Cosmetic by definition: never break startup over a label.
		}
	});
}
