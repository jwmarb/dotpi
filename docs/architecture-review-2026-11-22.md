# Architecture review — outcome (2026-11-22)

This file is the lasting record of this review. The visual report was
`/tmp/architecture-review-20261122-010152.html`, a scratch file that is not kept.
Earlier records are `architecture-review-2026-10.md`, `-10-14.md`, `-10-17.md` and
`-10-31.md`. Their rulings still hold, and nothing here re-litigates one of them:
no herdr/disk/clock ports were added, `layout.ts`, `run-lifecycle.ts` and
`release-ledger.ts` were not restructured, no shared `lib/git.ts` appeared, and
the effects-object shape is still the house way to inject a dependency.

## Process

The review used `improve-codebase-architecture`, scoped by churn since 10-31 (49
commits; hottest in subagent-herdr, kanban, model-fallback, and the `lib/` layer).

Four `explorer` recons ran over the areas those commits touched. Two of the first
briefings arrived corrupted — the harness delivered their task payloads with stray
control characters, the panes received nothing usable, and both produced reports
that **looked** authoritative and were fabricated (`lib/skill-catalogue.ts` does not
exist; `lib/widget.ts` was described as orphaned and has six importers). Every
claim was re-checked against the code before it entered the report, which is what
caught it. Nothing from those two briefings was used, and the burned runs were
replaced rather than patched. The precedent this review now records: a sub-report
is evidence only after its claims are measured.

The user then chose **all nine** candidates, and the design was settled by two
rounds of `stress-test-thinking` — thirteen decisions, each with the alternatives
it beat (see the rulings table and the trade-offs below). One planner per cluster,
one worker per cluster, and the branch is `refactor/deepen-2026-11-22`; master is
untouched.

## Candidates and rulings

| # | Candidate | Ruling |
|---|---|---|
| C1 | **Settings read/write seam.** `model-fallback` read `settings.json` at load time and `startup-fetch` both read and wrote it, with a separate reader each. Only one tolerated a BOM, and the writer was a hand-rolled non-atomic rewrite kept that way by a test-mock comment | Done (`024f8ce`). `lib/settings.ts` owns merged reads (project `<cwd>/.pi/settings.json` over the agent file, whole-object replace per key) and one atomic global-only write rule. `model-fallback/settings.ts` is deleted. `startupFetch` is now project-overridable — the one deliberate behaviour change this review makes. An existing file that does not parse is **refused**, not overwritten |
| C2 | **The pending-spawn relation.** Three call sites spelled the parent half inline, and the ledger hand-mirrored the `DEFER_MAX_MS` bound that `pendingSpawnsOf` already applies — the repo's own named anti-pattern | Done (`922635f`). `ParentRef` is the one parent shape; `deferWithin` is the one bound, shared by `pendingSpawnsOf`'s tail and the ledger's spawns-block fallback; `withinLifetime` is the ledger's lifetime clause, moved out of the renderer. Behaviour identical, boundary pinned by tests at both ends |
| C3 | **Briefing renderers.** ~220 lines of "the text a finished run becomes" lived in the 2323-line `index.ts` and were testable only through the 4,500-line `wake.test.ts` harness | Done (`d55949a`, `b92cd6e`). `subagent-herdr/briefing.ts` is pi-free, its six reads arrive as an effects bag, and `Briefing extends ReleaseRenderer` — so its result *is* the ledger's renderer with no forwarding literal. Every `wake.test.ts` assertion passes unedited, including the byte-exact pins |
| C4 | **The run-evidence read.** Three readers each gathered the same four facts (sidecar, evidence stamp, bounded tail, pending spawns) themselves | Done (`235804a`). `run-evidence.ts` owns the read; each site keeps its own memo. The memos deliberately did **not** merge: the settle path pins the pending-spawn input off through `completedDead` while the display read passes it, so one memo would let a cached answer to one question speak for another. `RunLifecycleEffects` untouched, so `run-lifecycle.test.ts` and `settle-stuck.test.ts` stay unedited. Also: `foreignRunningRecord` and `undeliverableClause`, the two record-level clauses the `subagent_tasks` arms repeated |
| C5 | **`hasRunId`'s type lie.** Documented as returning a `RunRecord`, checking only `runId` | Done (`922635f`). It narrows to `RunIdBearing`; load and adoption widen through `asRunRecord`, the single documented unvalidated cast. Runtime tolerance unchanged — a truncated `meta.json` still loads |
| C6 | **`PI_FALLBACK_CHAIN` partial drop.** A chain of three where one token was malformed registered two, silently | Done (`500791e`). `parseChainEnvReport` returns the drops, `formatDroppedEntries` is the one wording, and the parsing process warns once naming each token. Survivors still register — dropping the whole chain would leave an already-launched process on `fallback/auto` with no resolvable model. Settings drops stay silent as before, because the child is the only process that can see its own inherited value |
| C7 | **Update status.** Four surfaces re-derived the same three status tests, and `getUpdateStatus`'s memo rules (4 h window, errors not cached, force bypass) were untested | Done (`63bd576`). `auto-update/status.ts` holds `UpdateStatus`, the flat `UpdateDescriptor`, the pure `describeUpdate`, and `createUpdateStatusMemo` as an effects object with nine tests. Each surface keeps its own wording and theme; only the decision is shared. `index.ts` keeps the globalThis store, because the loader re-imports modules on `/reload` |
| C8 | **Hand-maintained inventories.** Four live drifts: a row claiming 1035 lines for a 1073-line file, prose saying a one-importer derivation is shared by "every prompt builder", the same claim in a table, and a kanban cap restated as a numeral inside the generated prompt | Done (`8b22cdb`, `792926f`). Line totals are gone repo-wide; the cap is named by the tool's own refusal (`kanban/lib.ts:224` interpolates it) instead of copied into the prompt; `lib/module-graph.test.ts` walks the live tree, resolves every import, and fails when the documented `lib/` consumer table drifts or a cycle appears. 41 stale code anchors re-measured |
| C9 | **Persona-removal closeout.** A tracked `orchestrator → agent` symlink with no consumers, dead "takeover" vocabulary, stale guard note | Done (`c4c0598`). Symlink deleted, wording singularised, the 10-31 record's historical note extended to cover `quant-prompt.ts` and `lib/profiles.test.ts`, and `profileDir` documented as the *global agent dir* (the name stays — it is the seam that keeps `project-layer.ts` testable). The gitignored `quant-trader/` tree moved to `~/archive/dotpi-quant-trader-20261122` rather than deleted |

## Trade-offs accepted

- **`startupFetch` became project-overridable.** That is what "one merge rule for
  every key" means; it was chosen over a `globalOnly` read mode that would exist for
  exactly one key. The consequence is documented at the writer: a repo that pins
  `startupFetch` in its own `.pi/settings.json` shadows global writes, so
  `/fetch style` there has no visible effect until the pin is removed.
- **A write refuses an existing file that does not parse.** Writing from the `{}` a
  read reports would discard a hand-edited file over one stray comma. A refused
  write costs a command that does not apply; a successful one costs the user their
  settings.
- **`scripts/check.sh` now isolates suites that mock a `node:` builtin.** Not
  tidying: `kanban/publish.test.ts` mocks `node:fs`'s `renameSync` process-wide with
  Windows semantics, and `lib/runtime.test.ts` already performs a real rename in the
  same invocation — the atomic write would have been tested against a broken rename.
  The test's own header already named isolation as the remedy.
- **`updateLines` takes a `compiled` parameter and derives `current` from
  `updatePending`.** Without it the extraction silently printed Pi's version beside
  a Pi-Bolt release, which the comment above it says must never happen.
- **`interruptRun`'s own guard stays a boolean.** It is inside the never-throws,
  effects-injected seam, which has no launching set, and tests exercise it directly.
- **Empty separator tokens are not drops.** `PI_FALLBACK_CHAIN="a/1,"` must not
  start warning; split on separators yields empty strings, which were always
  silent. Pinned by tests so a later simplification cannot reintroduce the noise.

## Verification environment

The gate ran in `oven/bun:1.4.4` with the repo read-only at its host-identical path
*and* at `~/.pi`, `~/.bun` (also at `/.bun`, for the `tsconfig.json` alias),
`~/.local/bin`, `HOME` set to the real home and `TMPDIR=/var/tmp`:

```bash
docker run --rm --network none \
  -v /home/joseph/Nextcloud/.pi:/home/joseph/Nextcloud/.pi:ro \
  -v /home/joseph/Nextcloud/.pi:/home/joseph/.pi:ro \
  -v /home/joseph/.bun:/home/joseph/.bun:ro -v /home/joseph/.bun:/.bun:ro \
  -v /home/joseph/.local/bin:/home/joseph/.local/bin:ro \
  -w /home/joseph/Nextcloud/.pi --user "$(id -u):$(id -g)" \
  -e HOME=/home/joseph -e TMPDIR=/var/tmp \
  oven/bun:1.4.4 bash -c 'bash scripts/check.sh'
```

Two suites are environment-sensitive by construction and must not be "fixed" in the
container: `lib/skill-catalogue.test.ts` fails its non-vacuity guard when `HOME` does
not hold the live tree, and three `startup-fetch` tests discover `catimg`/`chafa`
through `PATH` then `~/.local/bin` (they never spawn them - every `renderArt` call
injects a fake `exec`).

`lib/module-graph.test.ts` also pins that the tree it walks is the directory the test
file lives in, because `agentDir()` follows `HOME`/`PI_CODING_AGENT_DIR` and would
otherwise assert another tree's invariants and pass. It compares device+inode rather
than realpath: a checkout bind-mounted at `~/.pi` *and* at its own path is one
directory under two names, which `realpath` cannot collapse, while two real trees
never share an inode.

No container image available here ships `git`, so a container `git log` is
INCONCLUSIVE; read the revision on the host.

## Final state

Thirteen commits on `refactor/deepen-2026-11-22`; `master` is untouched at
`8381785`. `scripts/check.sh` reports **1958 pass, 0 fail** in the grouped run plus
**3** and **131** in the two isolated ones, with all five typecheck scopes and every
extension source loadable.

Each cluster was graded by a `reviewer` that had not written it and by a container
`verifier` that ran the gate. The first full pass returned **Ship** with no
Criticals, three Warnings and five Suggestions; the verifier returned **PASS**
(2093 tests) and, more usefully, proved that the mount recipe earlier reviews
handed down produces **eleven false failures** on green code - `HOME=/tmp` empties
the live tree that `lib/skill-catalogue.test.ts` guards against with its own
non-vacuity assertion, and three `startup-fetch` tests need `catimg`/`chafa` on
`PATH` or `~/.local/bin`. The fix commit `3c08471` closed the warnings; the second
pass returned **Ship after those two warnings**, and `a4c1ce8` closes them.

What the graders found that the workers did not is worth recording, because it is
the same class twice. `run-evidence.ts` had shipped **two** gathers - the verdict
and an exported facts read no production code called, the exact drift surface the
module exists to remove - and `lib/settings.ts` had a second writer called only by
its own tests. Both were deleted rather than documented, following the precedent
that removed `mcpConfigFile` for the same reason. Then the second pass found the
same over-claim in the *fix*: a `check.sh` comment promising tolerance its pattern
lacked, and an inventory row still saying "Both writers".

### Accepted, not fixed

- **`lib/skill-catalogue.test.ts` has the same aliasing hole** the new checkout pin
  closes in `module-graph.test.ts`: `skillsDir()` follows `agentDir()`, so on a
  machine pointed at another tree it walks that tree. Its `length > 20` guard is
  the only non-vacuity check. The same inode compare would fix it; it is a
  follow-up, not part of this branch.
- **Inode precision.** The pin compares `dev:ino` as numbers, so an inode above
  2^53 that differs only in its low bits could compare equal, and a filesystem
  that synthesizes a constant inode (Windows FAT/exFAT reports 0) would make it
  vacuous - now caught by the pin's own non-zero guard rather than silently
  passing. `statSync({ bigint: true })` would remove the precision question.
- **`writeGlobal`'s temp name is per-process, not per-writer.** Two pi processes
  writing the one global file is last-rename-wins, each built from an earlier read.
  Strictly better than the non-atomic writer it replaced, and the window is two
  syscalls wide, so it is documented rather than serialised.
- **One commit message counts assertions it did not recount** (`235804a` says 20
  "not settled by this pane" sites; the file has 15 assertion sites, 16 matches).
  Harmless, and exactly the class C8 rules out in documents - but a commit message
  cannot be re-derived by a test, which is why the rule is about inventory files.

### Where the next review should look

The three areas this review deliberately left alone are unchanged and still
plausible: `model-fallback/lib.ts` (2131 lines, the largest single domain module),
the `kanban` `BoardRuntime` facade, and `dynamic-prompt.ts`. Its own rulings from
`-2026-10-31.md` still stand: no herdr/disk/clock ports, and no restructuring of
`layout.ts`, `run-lifecycle.ts` or `release-ledger.ts`.
