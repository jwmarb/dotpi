# Architecture review — outcome (2026-10-02)

Durable record of what was found, decided and done. Working notes with every raw
probe: `/tmp/arch-review-findings.md`. Visual report:
`/tmp/architecture-review-20261002-234329.html`.

## Process

`improve-codebase-architecture` → 13 findings (F1–F13), each executed not inferred →
HTML report with before/after diagrams → **oracle** adjudicated (not the user, as
instructed) → implemented its ruling in 6 Conventional Commits.

Oracle corrected me on two findings and called one framing overstated. Both
corrections were right and changed the work.

## Commits

| Commit | What |
|---|---|
| `45293e0` | `fix(skills)`: setup-deps discovers 3 manifests (was 1); personal skill filed under a category |
| `8ed413c` | `test(extensions)`: porcelain decoder + `/init` thresholds; **fixed 2 real bugs** |
| `5232337` | `refactor(dynamic-prompt)`: removed the retired plan tool's 44-line section |
| `ab381eb` | `refactor(layout)`: one owner for the run-dir segment; `rundir.ts` into tsconfig |
| `8a7e079` | `fix(checks)`: restored the load guard, made its absence loud |
| `e8afca6` | `docs`: corrected the testability rule; counts → discovery rules |

## Before → after

| | before | after |
|---|---|---|
| tests | 667, **1 failing** | **743, 0 failing** |
| test files | 13 | 16 |
| setup-deps manifests found | 1 of 3 | 3 of 3 |
| load guard | silently `exit 0` | enforced, fails loud |
| dead plan prompt | 60 lines | 0 |
| `layout.ts` exports | 10 (2 callerless) | 7 |
| orphaned `node_modules` | 232 MB | 0 |
| `rundir.ts` in a typecheck scope | no | yes |

## The two bugs the tests found

1. **Porcelain XY misread.** `GIT_STATUS_MAP` is keyed on a single letter (`"D"`),
   the lookup passed `line.slice(0, 2)` (`"D "`). Every key except `??` missed, and
   the `?? "modified"` fallback swallowed it — every staged add, delete and rename
   rendered as "modified" with nothing to suggest a bug. Verified against real git.
2. **` -> ` treated as a rename delimiter.** It is also a legal filename substring,
   and the newline form quotes paths with spaces/non-ASCII. Now reads `-z` records.

Also deleted a type-lie in `init.ts`: tier status came from `"skip" as never`, which
type-checked while misreporting the return type.

## The root cause (F1)

Both AGENTS.md tiers said a `*.test.ts` "cannot sit beside a top-level extension"
and concluded logic wanting a test "cannot live at this level". First half true,
conclusion false: the rule bars the test **file's location**, not its imports. A test
in `lib/` may import `../<extension>.js` — `lib/sessions.test.ts` always did, and all
11 top-level extensions import cleanly from there (measured 11/11).

That error is why ~2,400 lines went untested: the cheap option looked illegal and the
legal option looked expensive. Oracle confirmed it is "correct and load-bearing".

## Deliberately NOT done (oracle's ruling — do not re-suggest)

- **No `lib/git.ts`.** The four `git` call sites look like duplication and are not:
  four error contracts because four jobs (64 MB repo-wide grep; latency-capped
  status; async baseline snapshot treating failure as empty evidence; startup probe
  needing exit codes and swallowing everything). A shared wrapper exposes all four
  policies (interface as complex as implementation) or erases distinctions callers
  rely on — and forcing the two `pi.exec` callers onto sync `execFileSync` would
  block pi's event loop at startup. Two adapters exist; no shared *behaviour* does.
  `gate.ts` keeps porcelain opaque as baseline evidence, so it is **not** a second
  parser. Only `changed-files.ts` owns a grammar. Recorded in
  `agent/extensions/AGENTS.md` ANTI-PATTERNS.
- **`layout.ts` not collapsed.** `agentDir()` is genuinely deep: env lookup, tilde,
  relative semantics, fallback, and the never-throw invariant that lets top-level
  extension code import it. Deleting it re-scatters the four-way drift it fixed.
  Only the 2 callerless exports were pruned.
- **`subagent-herdr/index.ts` not reorganized.** Its pure helpers are single-caller
  presentation; moving them into an already-broad 24-symbol `lib.ts` adds no
  leverage. Extract when a second caller or a second adapter appears.
- **The live-tree skill test not weakened.** It walks the real tree *because*
  fixtures cannot catch silent reader divergence. The skill moved instead; its
  `.gitignore` path moved with it, so the NetID it contains is still unpublished.

## Still open — NOT mine, deliberately uncommitted

Three pre-existing working-tree changes, kept out of all 6 commits because they
reverse earlier deliberate decisions and need their owner's intent:

- `agent/mcp.json` — drops `"enabled": false`, re-enabling the robinhood server
  that `9f3d2bd` deliberately disabled.
- `agent/settings.json` — `hideThinkingBlock` false→true. Looks *intentional*: it
  activates the half-inert `thinking-indicator.ts` transcript record that AGENTS.md
  documents as needing exactly this. **But it also stripped the trailing newline.**
- `agent/agents/explorer.md` — model `apodex-1.1-mini` → `qwen3.8-27b`, and
  `gpt-5.6-sol` → `gpt-5.6-terra` in the fallback chain. Changed mid-session, not
  by me.

## Verification

```sh
./scripts/check.sh      # 3 gates: every source imports, 3 tsc scopes, 743 tests
pi -p "..."             # pi starts and completes a real turn with all edits live
```

Beyond the gates, confirmed live: pi boots, the skills catalogue renders 10
categories with the moved skill under `other`, and the model reports no "Planning
Discipline" section in its prompt. The restored guard also proved itself twice
during this work — it refused a commit, and it caught a syntax error present only
in the index while the worktree was clean.

One deliberate limit: in `CHECK_STAGED=1` mode the tests run against the working
tree, not the scratch index copy. The copy symlinks `node_modules` back, and bun
resolves bare imports by walking up from the importing file, so from the scratch root
`model-fallback/lib.test.ts` reaches the 0.75.4 tree in `~/node_modules` and dies on
an export only the running 1.0.0 bundle has. An artifact of the materialisation, not
a defect in the commit — and a gate that cries wolf is a gate people bypass.
Loadability is the file-local startup-fatal class staged mode exists to check, and it
*is* checked against the index.
