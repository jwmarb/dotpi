# Architecture review — outcome (2026-10-31)

This file is the lasting record of this review. The visual report was
`/tmp/architecture-review-20261031-091303.html`, a scratch file that is not kept.
Earlier records are `architecture-review-2026-10.md`, `-10-14.md` and `-10-17.md`.
Their rulings still hold. No herdr, disk or clock ports were added, so the
effects-object shape stays. `layout.ts`, `run-lifecycle.ts` and `release-ledger.ts`
were not restructured. No shared `lib/git.ts` was added.

## Process

The review used `improve-codebase-architecture`, scoped by churn since 10-17:
65 commits in subagent-herdr, kanban, persona/profiles (new since then) and
model-fallback. Four `explorer` recons ran, and every claim they made was checked
against the code before it went into the report. The user chose all eight
candidates. A single planner run covering all four areas failed, because it
produced only hidden reasoning, so the work was re-planned one area per planner.
After that, each area had its own `worker`. Each area was graded by a `reviewer`
that had not written the code, and by a container `verifier`. Every verdict was
Ship, with no Criticals. All work is on branch `refactor/deepen-2026-10-31`, and
master is untouched.

## Candidates and rulings

| # | Candidate | Ruling |
|---|---|---|
| C1 | **kanban run-todo memo.** It took 4 fixes in a row. The validity rule was spread over 8 branches and 3 global maps, and the code did a separate `stat` and per-rung opens | Done (`2c10ed7`). One `openSync` and one `fstatSync` feed every decision. The pure, tested functions are `memoDecision`, `eofBoundary`, `scanRegion` and `readLadder`. The 5–20 MiB test fixtures were replaced by small cases. A transcript that fails to open now caches nothing |
| C2 | **Shared prompt inputs.** Three derivations existed, and `hasSubagent` had diverged between them. A persona switch to an orchestrator target discarded that target's skills and AGENTS.md | Done (`633c38b`). `lib/prompt-inputs.ts` `derivePromptInputs` is used by dynamic-prompt, quant-prompt and the persona takeover, and the latent switch bug is fixed |
| C3 | **Hoist the running-parent proof.** It was the only unseamed dependency on the wake path | Done (`7cb33e1`). `subagent-herdr/parent-proof.ts` `createParentProof(effects)` holds the memo in its closure and has 20 direct tests. `completionEvidenceMemo` stays in `index.ts` |
| C4 | **One reservation walk.** An untested inline walk sent all-at-cap requests to the last reachable model, while the tested rule said "start" | Done (`ae6caf4`). `reserveRoute<L>` in `model-fallback/lib.ts` sends an all-at-cap request to the walk start with no lease, and re-snapshots after a refused acquire. This is the one intended routing change |
| C5 | **Settle rule as a single source.** One executable copy existed alongside four prose copies, and drift between them caused `c3ac96a` | Done (`655579f`). The rule now lives in the `SETTLE_DISPOSITION` table. The prose `SETTLE_GUIDELINE` is still written by hand but is tested against the table. A wrong `NUDGE_MOVE_TARGETS` entry is a compile error (`7f559c2`) |
| C6 | **Persona disk rules and profile invariants.** `homePromptKind` was a second copy of `promptKindOf`, and no check covered the profiles | Done (`4e45bf7`, tightened in `4e80380`). The pi-free helpers moved to `persona/lib.ts`, and `promptKindOf` is the only reader. `lib/profiles.test.ts` walks the real tree. It rejects `dynamic-prompt.ts` whether found by name or by realpath, and a real copy of a shared extension, and it checks that `.env` and `sessions/` are gitignored |
| C7 | **Reroute-note decorator.** The note was added by hand in 5 places | Done (`9920efe`). `withRerouteNote` is the single rule. Accepted output change: an unregistered, rerouted notice now shows the shared header block under the note |
| C8 | **Small seam fixes** | Done. `42ae87e`: `RUN_STATUSES` is the only source of `RunStatus`. `hasRunId` (runId only) guards load and adoption, and the strict `isRunRecord` is used only by kanban. `f9b43f3`: `lib/todo.ts` `latestTodoCounts` replaces the two copies of the walk. `47dacc1`: `sendNotice(route)`. `88f4e01`: a `\|` inside a settings.json chain string is rejected with a warning, and `5dc52bb` adds a warning when `chain` is not an array. `d034d60`: `planUpdateCheck` and a prerelease-aware `compareSemver`, so a failed check is no longer reported as "up to date". `df6d173`: pure `buildModels` and `thinkingLevelMapFor` in `litellm.ts` |

Follow-ups from the reviewers are in `5dc52bb`, `a472a5e`, `4e80380`, `7f559c2`, plus one
final docs/warning commit. They fix comment drift and two loopholes in the profile
test, add the test for the takeover skill gate, and remove a second transcript parse
in `extractRunResult`. They also make `litellm` warn when a reply has no `data`.

Final state: `scripts/check.sh` reports 1896 pass and 0 fail. All 7 typecheck scopes
pass, both on the host and in `ralph-verify/dotpi-bun:1.4.2`.

## Deliberately NOT done

- C6b (`switchSummary`) was optional and would change wording that users see.
- `hasRunId` still claims `value is RunRecord`, which is wider than what it checks.
  The reviewer graded this a Warning. Nothing downstream breaks today, because every
  `rec.status` use is a `===` comparison or display.
- `PI_FALLBACK_CHAIN` still drops a malformed item silently. Only settings.json
  reports dropped entries, because the env chain is machine-generated.
- After all-at-cap, `reserveRoute` does not probe one more acquire at `start`. The
  stale-pessimistic-snapshot window was accepted as a trade-off.
- `UpdateStatus` → message is still written out at two call sites, and the
  `getUpdateStatus` memo is not tested.

## Notes for the next review

- **Verifier containers.** `node_modules` is a symlink into the host bun install.
  Mount `~/.bun/install/global`, `~/.bun`, `~/.local/bin` (at `/tmp/.local/bin`) and
  the repo (at `/tmp/.pi`) read-only, with `HOME=/tmp` and `TMPDIR=/var/tmp`. Use a
  non-login shell, because `bash -lc` resets `PATH`.
- **Planner scope.** Give a planner one area per run.
- **`/tmp` quota.** The `/tmp` tmpfs has a per-user quota. When it is full,
  `check.sh` fails with EDQUOT, so export `TMPDIR=$HOME/.cache/test-tmp`.
