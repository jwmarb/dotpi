/**
 * The environment every git spawn that targets a `cwd` must run under.
 *
 * Git locates its repository from the environment *before* it looks at the
 * working directory: an exported `GIT_DIR` (or `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
 * …) wins over `cwd` outright. A normal checkout's hooks export none of these,
 * but a **linked worktree's** hooks run with `GIT_DIR=<common>/.git/worktrees/<name>`
 * and `GIT_INDEX_FILE=<that>/index` exported. `.githooks/pre-commit` runs
 * `scripts/check.sh` → `bun test`, which inherits them, so every
 * `execFileSync("git", …, { cwd })` below it silently operated on the *outer*
 * repository instead of the one at `cwd`. That is not hypothetical:
 * `lib/init.test.ts`'s fixture `git init`/`git config` once set `core.bare=true`
 * and a test `user.email` in the real `.git/config` and committed junk onto the
 * branch, from a commit run in `.worktrees/deepen`.
 *
 * This module is **one environment rule, not a git wrapper.** It wraps no git
 * call and imposes no error policy — the rejected `lib/git.ts` wrapper (see
 * `agent/extensions/AGENTS.md` ANTI-PATTERNS: four call sites, four error
 * contracts) stays rejected. Each caller keeps its own `execFileSync` and its own
 * error handling and only passes `env: gitEnv()`.
 *
 * Callers: `init.ts` (`git()`), `changed-files.ts` (`execSyncGit`, `runGitDiff`)
 * and the fixtures in `lib/init.test.ts`. Not callers: `ralph-loop/gate.ts` and
 * `git-hooks.ts`, which go through `pi.exec` with an explicit `-C`/cwd under
 * pi's own environment — they run inside pi, never under a hook.
 *
 * Pi-free (no imports at all) and never throws, because top-level extension
 * code imports it.
 */

/**
 * The variables that relocate git's repository, index, object store, worktree or
 * ref namespace away from what `cwd` discovers. Identity and behaviour variables
 * (`GIT_AUTHOR_*`, `GIT_CONFIG_*`, `GIT_SSH`, …) are deliberately kept.
 */
export const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  // Legacy: with no `--file`, `git config` reads AND writes this path instead of
  // the repo's own `.git/config` — the same damage class as the incident.
  "GIT_CONFIG",
] as const;

/** A copy of `base` without the repo-locating variables; `base` is not mutated. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of GIT_LOCATION_VARS) delete env[key];
  return env;
}
