# Architecture review — outcome (2026-10-17)

The durable record of this review. The visual report was
`/tmp/architecture-review-20261017-153805.html` (scratch, not kept). Earlier
records: `architecture-review-2026-10.md`, `architecture-review-2026-10-14.md`;
their rulings held (no herdr/disk/clock ports, lifecycle and release ledger
untouched, `buildOrchestratorPrompt` not redesigned).

## Process

`improve-codebase-architecture`, scoped by churn right after issue #3
(`826330f`, explicit `callable_by`): `subagent-herdr/index.ts` (29 commits),
`dynamic-prompt.ts`, `lib/agents.ts`. Two `explorer` recons; several of their
claims were wrong (e.g. which module imports the skill helpers) and were
re-measured before reaching the report. The user chose all three candidates. A
`planner` wrote one ordered plan, a `worker` implemented it, and a `reviewer`
that wrote none of it graded the three commits (verdict: ship, no Critical).

## Candidates and rulings

| # | Candidate | Ruling |
|---|---|---|
| C1 | Deepen **spawn admission**: lookup, `callable_by`/cycle guard, health-check bypass and model-chain refusal lived in private, effectful `spawnRun` with no direct test; the `healthCheckOf` smuggling hole fixed in `826330f` lived there | Done (`c473d50`). Pure `admitSpawn` in `subagent-herdr/lib.ts`; the privilege is a typed `SpawnOrigin` (`tool-delegation` / `system-health-check`), never an optional field. `childNameRejection` stays in `spawnRun` because it validates the allocated run id. Error strings unchanged; 11 direct tests |
| C2 | **One delegation roster**: prompt and spawn each assembled discover + merge + lineage filter | Done (`240ec0d`). `delegationRoster` returns `{all, spawnable}`: spawn looks up in `all` so a forbidden agent gets the specific refusal; `activeSkills` (skill directory names) is the one intended difference |
| C3 | Test the **prompt hook's inputs** (tool gating, roster, subagent flags) | Done (`e51699e`). Pure `promptInputs`; the handler keeps I/O and the `selectedTools` write-back under the old condition |

Also fixed: `wake.test.ts` now clears an inherited `PI_SUBAGENT_LINEAGE`, so
`scripts/check.sh` passes when run inside a subagent (it failed 9 tests before).

## Deliberately NOT done

- No lineage/env port for `spawnRun`: the test clears the variable instead.
- Reviewer suggestions left: widening `lineage` to `readonly string[]` across
  `lib/agents.ts`; dropping the echoed `task`/`cwd` from `SpawnAdmission`.
