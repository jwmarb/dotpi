# Architecture review — outcome (2026-10-14)

The durable record of what this review found, what was decided, and what was done.
The visual report (four candidate cards, before/after diagrams) was
`/tmp/architecture-review-20261014-065847.html`; it is scratch and not kept. The
previous review's record is `architecture-review-2026-10.md`, and its rulings
held: none of its "deliberately NOT done" items was re-suggested.

## Process

`improve-codebase-architecture`, scoped by churn: `subagent-herdr/index.ts` had 22
commits, more than any other source file, and had just absorbed the health-check,
run-ownership, revival and stall-watchdog work. Two `explorer` recons (one on
subagent-herdr, one on everything else). Every claim was re-measured before it went
in the report, and two were corrected in the process (kanban's sidecar-only rule is
conservative, not wrong; `initialState` is `advance`'s test surface, not dead).
The candidates were then put to a `stress-test-thinking` interview with the user
(two rounds) and a design-it-twice pass (three `planner`s, three interface
constraints). Each step went to a `worker` with a planner-written, file-and-line
plan. Every commit was graded by a `reviewer` that had not written it.

## Candidates and rulings

| # | Candidate | Ruling |
|---|---|---|
| C1 | Deepen the **run lifecycle**: 5 status writers and the completion predicate written out twice in `index.ts`, plus a third copy in `kanban/runs.ts`; `9ce5377` touched four functions to fix one misclassification | Done. `read()` returns a cached `result()`, and tests go through one effects object (house precedent: `InterruptEffects`, `ChildDoneEffects`). Kanban shares only the sidecar half. Launch failures are terminal. Revival is bounded by a six-interval window plus a size/mtime stamp. `saveMeta` stays best-effort |
| C2 | Lift the **release ledger** out of the factory closure: "health check briefed ⇒ target released" enforced at 5 sites over 8 mutable closure variables; tests reachable only through a herdr mock and 123.5 s of real sleeps | Done. The ledger owns flush, and the factory keeps wiring, one timer and steer delivery. Time is passed in. `wake.test.ts` moves to fake timers |
| C3 | Put the `fallback/auto` **registration decision** behind model-fallback's interface | Done as the decision only. The three exports used only by tests stay: they are the model-ref grammar's test surface |
| C4 | Delete `lib/todo.ts`'s dead **settle guard** (orphaned since `d7afeed` moved it to kanban) | Done, with an ANTI-PATTERNS entry against re-adding it |

Rejected as already deep or as real seams (do not re-suggest without new evidence):
- `ralph-loop/gate.ts` vs `runtime-gate.ts`: two adapters over `gate-agent.ts`.
- The two skill-catalogue renderers: different audiences, and classification is already shared.
- `herdr.ts`: a deep adapter.
- `dynamic-prompt.ts` and `ralph-loop/image.ts`: deep.
- `kanban/lib.ts`'s pane-command cluster: moving it relocates code without concentrating it.

## Commits (on master, rebased onto `2523fe9`)

| Commit | What |
|---|---|
| `de8c252` | `fix(scripts)`: setup-deps links pi's **managed install** (`agent/install/releases/<current-version>/node_modules`). `pi` is now a launcher script, so `readlink -f` found nothing and every pi-importing suite failed to load |
| `33139d2` | `fix(scripts)`: read `current-version` exactly as the launcher does |
| `e9fa280` | `fix(extensions)`: `lib/git-env.ts` — strip the repo-locating env from every git spawn that targets a cwd (incident below) |
| `672d925` | `refactor(todo)`: dead settle guard deleted, 12 tests with it |
| `9e01c5b` | `refactor(model-fallback)`: `planRegistration`, one pure decision |
| `7bc1160` | `fix(subagent-herdr)`: **three-way pane probe**. Before, any herdr failure read as "pane gone", so a live run could be classified `failed`. Now only `agent_not_found` means gone (measured, herdr 0.9.1) |
| `d7fbd34` | `refactor(subagent-herdr)`: `run-lifecycle.ts` |
| `114c358` | `refactor(subagent-herdr)`: `release-ledger.ts` |
| `c61a834` | `test(subagent-herdr)`: `wake.test.ts` on fake timers |
| `b5a5ac2` | `chore(extensions)`: dead exports (`collectFinished`, `getAgent`) and doc drift, from the branch-wide review |

## Before → after

| | before (`9ce5377`) | after (`b5a5ac2`) |
|---|---|---|
| `check.sh` | 1167 pass, 0 fail | **1246 pass, 0 fail**, 5/5 typecheck scopes |
| `wake.test.ts` wall-clock | 137 s | **~0.7 s** (10× sequential + 4× concurrent all green) |
| `subagent-herdr/index.ts` | 2370 lines | 1505 (+ `run-lifecycle.ts` 346, `release-ledger.ts` 757) |
| sites writing a run's status | 5 | 1 (`run-lifecycle.ts`) |
| spellings of the completion predicate | 3 (two in `index.ts`, one in kanban) | 1, and kanban shares only the sidecar half |
| enforcement sites for "HC briefed ⇒ target released" | 5, over 8 closure variables | 1 module, explicit-clock tests |
| tests that need `mock.module` to reach lifecycle/release policy | all of it | none (in-memory effects) |
| tests importable on a fresh checkout | none that import pi (no `node_modules` link) | all |

## Defects found and fixed along the way

1. **herdr unreachable read as pane gone** (`7bc1160`). `getAgent` returned `null` on *any*
   failure, and `reconcile` read `null` as "the child exited", so a herdr timeout could
   classify a live run `failed`. Fixed with a three-way probe, and the two-way `getAgent`
   was deleted rather than kept for compatibility.
2. **Result-cache leak and staleness** (`d7fbd34`, from its review). The degraded-release
   bound marked a pair briefed without retiring its cached result: one entry leaked per
   pair. Cache freshness also relied on every writer remembering to refresh. Entries are
   now keyed to `finishedAt`, so a result cached before a revival can never be served.
   The regression test was proven to fail on the old code.
3. **A tick that throws strands its batch** (`114c358`, from its review). A tick that
   enqueued and then threw never handed back its deadline. It now always does, and the
   test fails without the guard.
4. **Revival scanned forever** (`d7fbd34`). Every `failed` run's whole transcript (up to
   1 MB) was re-read every 60 s for the life of the process. Now it is never re-read for
   a launch failure, nor outside the window, nor when the file is unchanged.
5. **Cancel closed the pane before persisting** (`d7fbd34`). A hung close lost the
   cancellation. It now saves, then closes.

## The incident: a test rewrote the real `.git/config`

Committing from a **linked worktree** (`.worktrees/deepen`) runs the pre-commit hook with
`GIT_DIR` and `GIT_INDEX_FILE` exported. A normal checkout exports neither (verified in a
scratch repo). `scripts/check.sh` → `bun test` inherited them, and `lib/init.test.ts`'s
fixture `git init` / `git config` / `git commit` ignored their `cwd`. As a result:
- `core.bare=true` and `user.name/email = T / t@example.com` were written into
  `/home/joseph/dotpi/.git/config`, which broke every git command in the main checkout;
- four junk `init` commits were made on the branch.

Repaired by hand (backup kept until cleanup). `master` and `origin/master` were never
touched, and no commit by `T` was ever reachable from a ref.

The fix (`e9fa280`) is an **environment rule, not the rejected `lib/git.ts` wrapper**.
`gitEnv()` wraps no call and shares no error policy. Each spawn site keeps its own
`execFileSync` and passes `env: gitEnv()`. `git-env.test.ts` reproduces the incident
against a scratch outer repo. During the final rebase the same variable redirected
`scripts/setup-deps.sh` (run by post-checkout): `git -C "$here" rev-parse --show-toplevel`
answered `scripts/`, so it linked `scripts/node_modules`. The script now unsets the same
variables first, which was proven with the pre-fix script under the same env.

**Lesson for whoever works in a worktree here:** anything a hook runs inherits `GIT_DIR`.
Treat every git call that means "the repo at this path" as needing `gitEnv()` / `unset`.

## Deliberately NOT done (do not re-suggest without new evidence)

- **No ports with in-memory "adapters" for herdr, disk or clock.** One real adapter is a
  hypothetical seam, and fakes don't count as a second. The effects object is the house
  shape.
- **No plan/commit protocol for the ledger.** The atomic mark must live where both blocks
  are rendered, so the ledger owns `flush` and calls an injected renderer.
- **`saveMeta` stays best-effort.** Rollback-on-write-failure would add a run that stays
  `running` forever and gets re-reconciled every tick.
- **The three test-only model-fallback exports stay** (`parseModelRef`, `parseModelEntry`,
  `isGatewayUpstreamFailure`). They are the grammar's test surface.

## Still open

- **`scripts/setup-deps.ps1` doesn't handle the managed-install layout.** It has a
  comment saying so. No `pwsh` was available on this host to test a change.
- **The fake-timer drain is a fixed bound, not a proof.** It is 1,000 `setImmediate`
  turns, each paced by a real `fs.stat`. That held 56/56 under 28 concurrent copies, and
  heavier load could in principle starve it. On Bun 1.4.2, fake timers freeze `Date.now`
  and fake `setTimeout`, `setInterval` and `Bun.sleep`, but **not** `setImmediate`.
- **The verifier could not run.** Docker isn't installed here, and its policy forbids host
  execution. The same seven checks were run on the host by hand and all passed. That is
  weaker evidence than a container.
- **`index.ts`'s `deliverAs` comment still cites pi-agent-core 0.99.2.** This predates the
  review. Re-measure it against the installed pi.

## Verification

```sh
./scripts/check.sh                       # 1246 pass, 0 fail, 5/5 typecheck scopes
CHECK_STAGED=1 ./scripts/check.sh        # same, in pre-commit mode
GIT_DIR=<linked-worktree gitdir> GIT_INDEX_FILE=<…>/index \
  bun test agent/extensions/lib/{init,git-env,changed-files}.test.ts   # 61/0; .git/config untouched
bun test agent/extensions/subagent-herdr/wake.test.ts                  # ~0.7 s, 22/0
```
