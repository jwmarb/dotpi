---
name: remove-ai-slop
description: "Removes AI-generated slop from a branch diff or an explicit file list, behind a green regression baseline. Use when the user asks to remove AI slop, deslop, or clean up AI-generated code smells from recent changes or a set of files."
argument-hint: "[file ...]"
---

# Remove AI Slop

Cleans AI-generated slop from a bounded set of changed files while strictly preserving behavior. The safety invariant: **behavior is locked by green tests before a single line is removed**. A checklist is not safety; a passing regression test is.

## Scope

- **Default**: branch diff vs `merge-base main` (no arguments).
- **Explicit**: file list passed as arguments.

## Categories (what counts as slop)

The canonical list. A removal worker evaluates **every** category in this section verbatim — it works from this section, never a restated subset.

### Stylistic

1. **Obvious comments** — comments restating code, trivial docstrings, section dividers, commented-out code, vague TODOs/Notes.
   - KEEP: comments explaining WHY (business logic, edge cases, workarounds), ticket links, regex/algorithm explanations.
2. **Over-defensive code** — null checks for guaranteed values, try/except around code that cannot raise, isinstance checks on statically typed params, defaults for required params, backward-compat shims, validation duplicated across layers, broad exception catching (`except Exception`, empty `catch {}`, `catch (e) { log(e) }` without narrowing).
   - KEEP: validation at system boundaries (user input, external APIs), I/O error handling, nullable DB fields; a top-level boundary catch-all (CLI `main()`, HTTP handler) with explicit logging + re-raise.
   - REFACTOR: `except Exception` → the specific exception you expect; empty `catch {}` → `instanceof` narrowing or re-throw; `catch (e) { log(e) }` → narrow, handle known cases, re-throw unknown.
   - PROOF REQUIRED: before deleting any guard at a trust boundary, the pass must include an **adversarial** regression (malformed or hostile input) that fails if the guard is removed. No adversarial test → the guard stays. Redundant defense to remove is a duplicate of a check that already runs *inside* the boundary; a guard with no proof of redundancy is load-bearing.
3. **Excessive complexity** — deep nesting (>3 levels), nested ternaries, boolean expressions combining 4+ predicates, >5 args without a struct/object, god functions (>50 lines doing many things), overly clever one-liners, `if/elif` chains for type/enum/literal discrimination (must be `match/case` + `assert_never`).
   - KEEP: established complexity patterns in this codebase, intentional hot-path idioms; `if/else` for boolean conditions and range checks (not variant discrimination).
   - REFACTOR: nested if-chains → guard clauses / early returns; complex ternaries → explicit if/else; enum if/elif chains → `match/case` with `assert_never` on the wildcard.

### Structural

4. **Needless abstraction** — pass-through wrappers, single-use helpers, speculative indirection ("we might need this later"), interfaces with one implementer that add no testability, factory functions that just call a constructor.
   - KEEP: abstractions that provide a real seam (testability, multiple implementers, framework-required boundaries).
5. **Boundary violations** — wrong-layer imports (UI importing DB driver), handler doing business logic that belongs in a service, module A reading module B's private state, side effects in pure-named functions.
   - KEEP: pragmatic short-circuits already established as a pattern here. Flag for human judgment if unsure.
6. **Dead code** — unused imports, unused private functions/methods, unreachable branches, stale feature flags, debug leftovers (`console.log`, `print(...)`, `dbg!`).
   - KEEP: code referenced via reflection, dynamic dispatch, or string lookup; intentional feature-flag rollback paths (verify with the user).

### Hidden cost

7. **Duplication** — copy-pasted branches with trivial differences, redundant helpers doing the same thing in two places, repeated magic-number sequences.
   - KEEP: incidental duplication — similar-looking code serving different intents that could diverge. Separate beats a premature shared abstraction.
8. **Performance equivalences** — provably equivalent, cheaper: set lookup vs list scan (O(n²)→O(n)), hoisting repeated computation out of a loop, an eager collection iterated once → lazy, string concat in a loop → join, redundant calls in a loop → batch, redundant deep copies, `len()`/`.length` recomputed in a loop → cache.
   - Hard rule: only when equivalence is obvious. A subtle algorithm change is a refactor, not a slop fix — separate change. If in doubt, SKIP.

### Behavior coverage

9. **Missing tests** — behavior present in changed files that no test locks. The fix is to ADD the narrowest test that pins it. A prose file (prompt, `SKILL.md`, rule, markdown) has no behavioral seam: no text/phrase pin — cover only a machine-consumed value (parsed field, sentinel a runtime greps) or leave it to review.

### Size

10. **Oversized modules** — a source file exceeding **250 pure LOC** (non-blank, non-comment: `awk '!/^[[:space:]]*$/ && !/^[[:space:]]*(#|\/\/)/' <file> | wc -l`). An architectural defect, not a style preference. When found, execute a modular split, not a flag:
    1. Identify the file's distinct responsibilities.
    2. Name each new file after the concept it owns (never `utils.py`, `helpers.py`, `part_1.py`).
    3. Present the split plan to the user before executing.
    4. Extract; verify every file ≤250 pure LOC, then run tests, typecheck, lint.
    - Forbidden escapes: counting blanks/comments toward budget; splitting by token count; catch-all dump files; "230 LOC, close enough".
    - KEEP: a genuinely self-contained single-responsibility script; opt out with a `# noqa: SIZE_OK` in the first 5 lines plus a why.

## Process

Create todos for phases 1–6; mark one in_progress at a time.

### Phase 1: Scope

```bash
git diff $(git merge-base main HEAD)..HEAD --name-only
```

Filter out deleted files, binaries, generated/vendored files (`node_modules/`, `dist/`, `target/`, lockfiles). List the final scope.

### Phase 2: Lock behavior

For each in-scope source file:

1. Identify the observable behavior it exposes (exported functions, handlers, CLI commands, classes used elsewhere).
2. Check whether existing tests cover it.
3. If uncovered or weakly covered, write the narrowest regression test pinning current observable output — before editing the file. Prose files are exempt (category 9).
4. Run the suite. It must be **green** before any cleanup begins.

No green baseline (e.g., the runner is broken)? STOP and report. No cleanup on unverified ground.

### Phase 3: Cleanup plan — the deletion ladder

The largest, safest deletion is code that should not have existed. Run the deletion ladder on each changed unit **before** categorizing smells:

- **Delete entirely** — the behavior is not needed (YAGNI, speculative, dead on arrival).
- **Reuse** — a helper or pattern in this repo already does it.
- **Platform / stdlib / dependency** — the language, runtime, or an installed dependency already does it (hand-rolled date picker → `<input type="date">`, custom query parser → `URLSearchParams`).
- **Simplify in place** — it must exist; make it smaller.

Only units that land on *simplify in place* proceed to the smell categories. One function replaced by a platform call is a bigger, safer win than any in-place cleanup.

For a diff that fixes a bug: grep the callers of every shared function it touches. Prefer one root-cause fix at the shared seam over repeated guards at each caller.

Then write an explicit per-file plan before dispatching removal:

```
File: src/foo.py
  Ladder: 2 units simplify-in-place; 1 delete (native <input> replaces custom picker)
  Categories: dead code, excessive complexity, performance
  Order: dead code → complexity → performance
  Risk: medium (touches caching layer)
```

Intentional shortcuts (a naive scan fine under N rows, a global lock, an O(n²) path) get a `debt:` comment naming the ceiling and the upgrade trigger, plus a line under "Remaining Risks / Deferred" in the report — the **debt ledger**. A simplification with a known ceiling and no marker is indistinguishable from a bug.

Order rule (safest → riskiest): comments → dead code → defensive → duplication → complexity → abstraction/boundary → performance → tests → oversized modules.

### Phase 4: Parallel removal, batches of 5

Slice the scope into chunks of ≤5 files. Per chunk: launch one `worker` subagent per file **in a single turn**, then end the turn — the children wake you as they finish; collect each with `subagent_tasks` (`action: "result"`), launch the next chunk. More than 5 at once drowns in result-merging noise; serial runs waste parallelism.

Per-file task (self-contained — the child sees nothing else):

```
Remove AI slop from: {file_path}

First read the remove-ai-slop skill (`read_skill`, name `remove-ai-slop`; it lives at
agent/skills/review-and-verification/remove-ai-slop/SKILL.md in the agent dir).

Run its Phase 3 deletion ladder on this file (delete entirely / reuse / platform-stdlib / simplify in place); only code that must exist proceeds to smell removal.

Then evaluate EVERY category in its "Categories" section, applying that section's KEEP and REFACTOR rules verbatim.

Apply changes in this order: comments → dead code → defensive → duplication → complexity → abstraction/boundary → performance → oversized modules.

Hard constraints:
- Behavior preserved; when equivalence is not obvious, SKIP.
- Public API signatures unchanged.
- Type hints intact.
- No new abstractions or dependencies.
- Diff minimal and scoped to slop.

Report changes grouped by category with before/after, why-slop, why-safe; list every skipped issue with its reason.
```

Batch failure: a child that completes without its report, acks only, is explicitly BLOCKED, or is no longer running → retry that file once, and let its batch-mates stand. A second failure escalates under "Issues Found & Fixed".

### Phase 5: Verify

Run every applicable quality gate; a gate that is genuinely not configured is reported `N/A` with a reason — a silent skip and a PASS without evidence are both lies.

| Gate | Tool | Pass condition |
|---|---|---|
| Regression tests | project test runner | all green |
| Lint | project linter | zero errors (pre-existing warnings OK) |
| Typecheck | `lsp_diagnostics` on changed files + project type-checker | zero new errors |
| Unit/integration | project test runner | all green; pre-existing failures noted, not introduced |
| Static/security scan | project scanner | zero new findings, or `N/A` |

Then walk the critical review:

- **Safety**: no functional logic removed; error handling preserved (I/O, network, external APIs); type hints intact; imports valid; public APIs unbroken.
- **Behavior**: return values, side effects, exception behavior, edge cases unchanged — verified by the Phase 2 tests.
- **Quality**: removed code was genuinely slop; remaining code follows project conventions; no orphaned references; performance changes obviously equivalent; no new abstractions.

### Phase 6: Fix issues

A failed gate or a flipped checklist item:

1. Identify the change that caused it and why it broke.
2. Revert it: `git checkout` the file, or a targeted edit of the offending hunk.
3. If genuine slop remains, edit directly — only changes you can prove safe.
4. Re-run the failing gate and re-walk the checklist for that file.
5. Three failures on the same file: STOP and escalate with the file, what you tried, what failed, your hypothesis.

## Output format

```text
AI SLOP REMOVAL REPORT
======================

Scope: [branch diff vs merge-base main / explicit file list]
Files: [N]
  - path/to/file1.ts

Behavior Lock:
  - Existing coverage: [N files already covered]
  - Tests added: [M new regression tests at path]
  - Baseline: GREEN

Cleanup Plan:
  - path/to/file1.ts: [ladder: ...] → [category → category]

Per-File Results:
  path/to/file1.ts
    - Ladder: custom DatePicker (48 lines) → <input type="date"> (native), import removed
    - Dead code: 3 removed (lines X-Y, A-B, C) → nothing
    - Complexity: 1 simplified (nested ternary L42 → if/else)
    - Performance: 1 (list scan → set lookup, O(n²)→O(n), behavior identical)
    - Skipped: 2 (boundary null check; WHY comment at L88)

Quality Gates:
  - Regression tests: PASS (12 tests, 0 failed)
  - Lint: PASS
  - Typecheck: PASS (0 new errors)
  - Unit/integration: PASS (45 tests, 0 failed)
  - Static/security scan: N/A (not configured)

Critical Review:
  - Safety: PASS
  - Behavior: PASS
  - Quality: PASS

Issues Found & Fixed:
  - [None] OR [issue → fix]

Net Impact:
  - LOC: -74 (removed 91, added 17)
  - Files deleted: 1 (src/date-picker-wrapper.ts — native replacement)

Remaining Risks / Deferred (the debt ledger):
  - [None] OR [flagged but not refactored — needs human judgment]
  - `debt:` markers kept: [None] OR [file:line — ceiling → upgrade trigger]

Final Status: CLEAN | ISSUES FIXED | REQUIRES ATTENTION
```

## Anti-patterns

- **Skipping Phase 2.** Removing code on uncovered ground is a behavior-change time bomb. The regression test is the safety mechanism; the checklist is its complement.
- **Bundling unrelated refactors.** One "cleanup" change mixing dead-code deletion + abstraction removal + performance shifts is impossible to review and impossible to bisect. Stay scoped to slop.
- **Algorithm changes disguised as performance.** If equivalence needs a proof, it is a refactor in a separate change.
- **Removing comments that explain WHY.** "Obvious from the code" is rarely true for the next reader. Only WHAT-restating comments go.
- **Touching files outside scope.** Slop noticed elsewhere goes under "Remaining Risks", not into the diff.
