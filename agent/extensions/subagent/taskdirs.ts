/**
 * Task→Run directory resolution for the Run Index (docs/adr/0028).
 *
 * Reopening is addressed by **Task ID** and must find every Run directory
 * belonging to that Task on disk. The matching is kept pure — no I/O, no
 * herdr — so it can be unit-tested by running this module directly, and the
 * resolver in index.ts stays the single place where dirs meet panes.
 *
 * @module taskdirs
 */

/**
 * Return the Run directory names belonging to `taskId`, sorted by ordinal.
 *
 * A directory matches when it is exactly `taskId` (a Run with no ordinal),
 * or `taskId` followed by `-<digits>` (that digit run as the ordinal). The
 * `-<digits>` boundary is enforced so that `sub-6748` never picks up
 * `sub-67480-1` (docs/adr/0028).
 *
 * @param names - Directory names found under `subagent-sessions/`.
 * @param taskId - The Task ID being resolved (e.g. `sub-6748`).
 * @returns Matching directory names, ordinal-ordered (bare ID first).
 */
export function matchTaskRunDirs(names: string[], taskId: string): string[] {
	const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`^${escaped}(?:-(\\d+))?$`);
	const matched: { name: string; ordinal: number }[] = [];
	for (const name of names) {
		const m = re.exec(name);
		if (m) matched.push({ name, ordinal: m[1] ? Number(m[1]) : 0 });
	}
	matched.sort((a, b) => a.ordinal - b.ordinal || a.name.localeCompare(b.name));
	return matched.map((m) => m.name);
}
