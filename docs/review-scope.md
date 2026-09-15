# Review scope from git history

Hot-spot analysis for scoping a code review. Generated 2026-09-15 at `27e3bb1`.

## Method

- **History window:** the entire history — all 32 commits, root `9189388`
  ("Initial commit") through HEAD `27e3bb1`.
- **Hotspot metric (post-introduction churn):** for each file in HEAD, find its
  introducing commit (oldest `--diff-filter=A` for that path), then count, over
  all *later* commits: commits touching the file and changed lines
  (numstat additions + deletions). The commit that introduced the file is
  excluded, so file size at introduction never looks like churn.
- **Introduction churn is accounted separately,** not silently excluded: the
  table at the end lists every file introduced after the root commit with its
  size at introduction.
- Reproduce:

  ```sh
  git ls-tree -r --name-only HEAD | while read -r f; do
    intro=$(git log --diff-filter=A --format='%H' -- "$f" | tail -1)
    git rev-list --count "${intro}..HEAD" -- "$f"
    git log --format= --numstat "${intro}..HEAD" -- "$f" | awk '{a+=$1;d+=$2} END{print a+d}'
  done
  ```

Note: excluding only the root commit (and counting per-file introductions as
churn) ranks one-shot introduction commits — e.g. `subagent/watcher.ts`
(402 lines in `e90f305`) — at the top. That is size, not change; this document
uses post-introduction churn for ranking and lists introductions separately.

## Hotspots, ranked by post-introduction churn

| # | File | Commits | Lines |
|---|------|---------|-------|
| 1 | `agent/extensions/plan/index.ts` | 11 | 963 |
| 2 | `agent/extensions/subagent/index.ts` | 5 | 707 |
| 3 | `agent/extensions/plan/review.ts` | 5 | 443 |
| 4 | `agent/extensions/subagent/spawnlimit.ts` | 1 | 266 |
| 5 | `agent/extensions/plan/rework-report.test.ts` | 2 | 188 |
| 6 | `agent/extensions/thinking-indicator.ts` | 1 | 112 |
| 7 | `PATCHES.md` (docs) | 4 | 100 |
| 8 | `CONTEXT.md` (docs) | 10 | 98 |
| 9 | `scripts/check.sh` | 2 | 97 |
| 10 | `agent/extensions/plan/review-route.test.ts` | 1 | 91 |
| 11 | `agent/extensions/subagent/runindex.ts` | 3 | 66 |
| 12 | `agent/extensions/subagent/tasks.ts` | 1 | 64 |
| 13 | `agent/extensions/mcp/index.ts` | 1 | 58 |
| 14 | `agent/extensions/herdr-names.ts` | 2 | 55 |
| 15 | `agent/extensions/plan/board.ts` | 2 | 51 |

Below that (1–50 lines post-introduction): `scripts/patch-pi.sh` 48,
`plan/delete.test.ts` 46, `.gitignore` 26, `subagent/rundir.ts` 19,
`.githooks/pre-commit` 15, `herdr/client.ts` 14, `subagent/mirror.ts` 11,
`subagent/reaper.ts` 10, `dynamic-prompt.ts` 9, `subagent/native.ts` 8,
`herdr/socket.ts` 8, `agent/settings.json` 4 — plus small ADR amendments
(`docs/adr/0016`, `0019`, `0020`, `0021`, `0028`, `0033`, `0040`, `0045`,
2–4 lines each; `0034` 16). Every remaining file (all skills, agent
definitions, most ADRs) has 0 post-introduction commits.

## Scope recommendation

**Core (ranked hotspots):** `plan/index.ts`, `subagent/index.ts`,
`plan/review.ts`. These three carry 57% of all post-introduction changed lines
(2,113 of 3,688 across the repo) and were each touched by 5+ later commits.

**Second tier (material post-introduction change, ≥50 lines):**
`spawnlimit.ts`, `rework-report.test.ts`, `thinking-indicator.ts`,
`review-route.test.ts`, `runindex.ts`, `tasks.ts`, `mcp/index.ts`,
`herdr-names.ts`, `board.ts`.

**Architecture-driven additions (not ranked hot, included on purpose):**
`subagent/watcher.ts`, `subagent/native.ts`, `subagent/child-done.ts`. All
three were introduced by `e90f305` ("Run autonomous reviews and reworks as
native Runs"), the single largest non-root commit in the repo (2,163 insertions) and the
dominant post-introduction contributor to **two of the three** core hotspots:
444 of 707 lines in `subagent/index.ts` and 199 of 443 in `plan/review.ts`. It
is *not* dominant in the top-ranked hotspot: only 13 of `plan/index.ts`'s 963
lines are its, because that file's churn is the plan tool's own evolution
(**Review Route**, **Autonomous Mode**, **Rework**) rather than the native-Run
work. (An earlier draft claimed "every core hotspot" and cited `spawnlimit.ts`,
which is second tier, not core.) A review of `subagent/index.ts` and
`plan/review.ts` that omits this commit's
introductions would review the modifications while skipping the code they
modify. `watcher.ts` (402 lines) is additionally the largest chunk of code
with zero post-introduction history — the least battle-tested code in the
repo, which is the opposite of "hot" and the reason it must be added by
explanation rather than by rank.

**Excluded, with reasons:**

- `herdr/socket.ts` (492 lines at introduction, `e8c2058`) and
  `dynamic-prompt.ts` (large at root): big files with ≤9 post-introduction
  changed lines — size is not churn. `socket.ts` appears in the introduction
  table below; `dynamic-prompt.ts` cannot, because it exists at the root commit
  and that table covers only files introduced after it.
- Docs (`CONTEXT.md`, `PATCHES.md`, `docs/adr/*`): ranked in the table, out of
  code-review scope.

## Files introduced after the root commit (introduction churn, separate table)

All 31 of them, at snapshot `27e3bb1`, largest first. (An earlier draft
listed only the top 12 while claiming to list every file — the claim, not the
cut-off, was the error.)

| Lines at introduction | Commit | File |
|---|---|---|
| 492 | `e8c2058` | `agent/extensions/herdr/socket.ts` |
| 402 | `e90f305` | `agent/extensions/subagent/watcher.ts` |
| 311 | `232b43e` | `agent/extensions/subagent/prompts.test.ts` |
| 291 | `e90f305` | `agent/extensions/subagent/native.ts` |
| 227 | `e50542f` | `agent/extensions/plan/review-route.test.ts` |
| 203 | `d08348c` | `agent/extensions/plan/rework-liveness.test.ts` |
| 197 | `46a587f` | `agent/extensions/plan/delete.test.ts` |
| 195 | `e90f305` | `agent/extensions/subagent/child-done.ts` |
| 193 | `3b6a1af` | `agent/extensions/lib/dotenv.ts` |
| 180 | `3b6a1af` | `agent/extensions/litellm.ts` |
| 147 | `232b43e` | `agent/extensions/subagent/prompts.ts` |
| 145 | `c2ff96a` | `scripts/check-thinking-label-patch.mjs` |
| 136 | `0d0fd3d` | `agent/extensions/plan/rework-report.test.ts` |
| 119 | `3b6a1af` | `docs/adr/0042-credentials-come-from-a-dotenv-file.md` |
| 114 | `da3e4b8` | `agent/extensions/subagent/spawnlimit.ts` |
| 104 | `7d5383e` | `scripts/check.sh` |
| 100 | `6f5c571` | `agent/extensions/herdr/names.test.ts` |
| 83 | `43ef5f5` | `agent/extensions/herdr-names.ts` |
| 80 | `e90f305` | `agent/extensions/subagent/native.test.ts` |
| 76 | `e90f305` | `docs/adr/0044-native-runs-herdr-owns-the-process.md` |
| 75 | `f0a866f` | `agent/extensions/git-hooks.ts` |
| 75 | `e90f305` | `herdr-plugin/README.md` |
| 43 | `7d5383e` | `.githooks/pre-commit` |
| 26 | `e90f305` | `herdr-plugin/dispatch.sh` |
| 21 | `e90f305` | `herdr-plugin/herdr-plugin.toml` |
| 19 | `8935a8d` | `docs/adr/0041-rework-is-done-by-a-fresh-run.md` |
| 17 | `da3e4b8` | `docs/adr/0040-one-spawn-cap-for-every-child.md` |
| 12 | `bfcd5f3` | `docs/adr/0045-injected-prompt-joins-the-run-directory.md` |
| 12 | `3b6a1af` | `agent/.env.example` |
| 10 | `3b6a1af` | `agent/mcp.json` |
| 9 | `1693f59` | `docs/adr/0043-card-title-is-the-whole-item-text.md` |
