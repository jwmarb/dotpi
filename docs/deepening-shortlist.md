# Deepening shortlist — deletion-test results

Generated 2026-09-15 (rework of the 2026-09-15 architecture review, run
`pln-aa925cfc-1`). Every candidate below was evaluated against the deletion
test: *imagine deleting the module. If complexity vanishes, it was a
pass-through. If complexity reappears across N callers, it was earning its
keep.* For each candidate this records **what interface would disappear,
where the complexity would reappear, how many callers/consumers are
involved, and whether the seam has two real adapters** (one adapter =
hypothetical seam; two = real). Vocabulary from the `codebase-design` skill:
module, interface, implementation, depth, seam, adapter, leverage, locality.

Candidates evaluated: the seven in the HTML report
(`/tmp/architecture-review-20260915-004037.html`), a superset of the six-item
note — the seventh (herdr transports) was added when the report was written.

## Verdicts

| # | Candidate | Deletion test | Verdict |
|---|-----------|---------------|---------|
| 1 | Spawn-path seam (`subagent/index.ts`) | Complexity reappears in two permanent, already-diverging implementations | **Keep — Strong** |
| 2 | Plan-mutation transaction module | Complexity reappears across 13+ mutation sites and a second process writer | **Keep — Strong** |
| 3 | Run outcome / liveness module | Complexity reappears across four consumers; the ADR log is a bug ledger for exactly this drift | **Keep — Strong** |
| 4 | Plan-file format module (cross-process) | Complexity reappears in both processes; hand-sync is already the documented burden | **Keep — Worth exploring** |
| 5 | `getPiInvocation` "interlock duplication" | Deletion restores today's state, which is deliberate, not drift | **Reject** |
| 6 | "pi is patched" predicate | No such predicate exists; zero callers — complexity vanishes | **Reject** |
| 7 | Reconcile the two herdr transports | Convention layer reappears in both, but the bodies share no implementation | **Keep — Speculative** |

## 1 · Spawn-path seam — keep (Strong)

**Current state.** `executeAttemptWithSlot`
(`subagent/index.ts:1250`) inlines two adapters in one function: the
**native** branch (`herdrSocketAvailable()` at 1280 → `executeNativeAttempt`,
1058–1247: `buildLaunchPlan`, wrapper script, `openPluginPane`, pane naming,
close-on-cancel, herdr-socket observation, `.exitcode` sidecar) and the
**fallback** JSON path (1298+: `--mode json` spawn, NDJSON parse, stall
watchdog, TERM→KILL reaping, Mirror Pane).

**Evidence of drift already present.** The prelude is duplicated verbatim
across the two branches: skill resolution and `runResult` population appear
identically in both (1083–1095 native, 1304–1316 fallback); the `prompt.md`
sidecar (ADR 0045) is written in both; `sessionDir` mkdir happens in both.
Every new Run concern since ADR 0044 has had to be added twice.

**Two real adapters.** Both are live, and ADR 0044 records that the JSON path
"cannot be deleted … **two spawn paths exist indefinitely** and may drift —
the same maintenance burden 0021 accepted for its fallback, now permanent and
larger."

**Deletion test.** Deleting the seam leaves the duplication in place and
repeats the add-it-twice cost for every future Run concern. The interface
that would disappear is the inline `if` plus the duplicated prelude; the
deepened shape is one `executeAttempt` interface over two adapters with the
prelude behind the interface.

**Callers.** One entry point (`executeAttempt`), two permanent
implementations; the seam's value is locality for the implementations, not
call-site count.

## 2 · Plan-mutation transaction — keep (Strong)

**Current state.** Inlined in `plan/index.ts`: the in-process
`withFileMutationQueue`, the cross-process `acquirePlanLock` (owner token,
stale-break, refusal via `PlanLockTimeoutError`, 815–905), `loadPlan`
validation (722), the `NO_WRITE` sentinel (999–1016), meta read/rewrite,
temp-file write and atomic `rename` — all inside `mutatePlan` (1030–1094).

**Callers.** 13 `mutatePlan` call sites and 12 `loadPlan` call sites in
`plan/index.ts` alone.

**Two real writers.** The plan extension (in-process) and the **Board**
(standalone process; ADR 0015 permits it to write "directly under the shared
lock", writer stub at the end of `board.ts`, lock protocol acknowledged at
`board.ts:825–826`). The lock exists for exactly this second writer
(ADR 0035: "the contending writer is another process").

**Deletion test.** Deleting the transaction reappears it across 13+ mutation
sites *and* in the Board's future writer: lock acquisition and token
ownership, refusal semantics, meta preservation, atomic rename. The bugs it
prevents are all documented, not hypothetical: cross-process lost update
(ADR 0035), stale-snapshot `attach` (ADR 0035), and a refused mutation that
silently destroyed data (the `NO_WRITE` fix, commit `6ad9831` "Make a refused
plan mutation write nothing at all").

**Deepening.** Extract the transaction as a dependency-free module so the
Board can share it without importing the pi host (the Board is a bare pane by
design, `board.ts:5–8`).

## 3 · Run outcome / liveness — keep (Strong)

**Current state.** "What state is this Run in?" is derived independently in
four consumers:

- `subagent/runindex.ts:160–244` — `scanRunDir`: live/archived/empty cases,
  outcome override "in both directions", `running` deliberately not honoured
  for archived.
- `plan/board.ts:156–265` — `readRunProgress`: terminal-outcome check,
  session scan for turns and last stopReason, sidecar override.
- `plan/index.ts:1371–1460` — `reworkStillRunning`: `outcome === "running"`
  plus `.exit`/`.exitcode` sidecars, the child's own pid probe, then
  transcript/directory age as a bound.
- `subagent/mirror.ts:341–353` — terminal-outcome reader for the no-transcript
  case.

`TERMINAL_STOP_REASONS` is defined twice: `runindex.ts:34` and `board.ts:125`.

**Deletion test.** Deleting a shared "Run state" module reappears the
derivation in all four consumers. The ADR log is a ledger of bugs born from
exactly this per-consumer derivation: the `toolUse`-as-finished bug in the
Run Index and again in the Board (ADR 0039, 0033), the dishonest-waiting bug
(ADR 0036), and `dismissed` as a fourth outcome that "the **Board**, **Run
Index** and `run.json` must all learn" (ADR 0044) — each new outcome value
must be taught to N readers by hand today.

**Precedent.** `subagent/rundir.ts` already exists as the shared layout +
sidecar module (ADR 0039), extracted because "letting the plan extension
re-implement the layout" was rejected as "the drift this module exists to
prevent". This candidate extends that contract from *writing* the sidecar to
*deriving state* from a Run directory.

**Callers.** Four disk-derived consumers, all by design (ADR 0026/0039) —
no process handles — so the module is pure and testable through its
interface.

## 4 · Plan-file format across processes — keep (Worth exploring)

**Current state.** The plan file's format is implemented twice:
`plan/board.ts` has its own `PlanState` union, `PlanItem`, `COLUMNS` /
`GLYPH` / `ROUTE_GLYPH` (comment at 63–68: "Kept in sync with `BOARD_COLUMNS`
in plan/index.ts **by hand**: this process is deliberately
dependency-free"), `canonical()` (133) and `load()` (279); `plan/index.ts`
has `PlanState`, the `PlanItem` superset (adds `reviews`, `reworkRunId`),
`canonicalState()` (395), `loadPlan()` (722) and `loadMeta()` (791).

**Two real consumers.** Writer: `plan/index.ts`. Reader: `plan/board.ts`
(standalone process, dependency-free constraint).

**Deletion test.** Deleting a shared format module reappears parse /
validate / canonicalize in both processes. The hand-sync comment is a
documented, standing drift liability; the two `canonical` functions already
differ (board.ts misfiles unknown states into `backlog` to survive a newer
writer; index.ts has a `KNOWN_STATES` allowlist).

**Overlap with 2.** One dependency-free `plan-file` module could carry both
format and transaction. They are kept as separate candidates because the
transaction has its in-process caller count (13+ sites) that the format
module does not share.

## 5 · `getPiInvocation` "interlock duplication" — reject

The "duplication" is three implementations of *three different policies*,
not one behaviour copied three times:

- `subagent/index.ts:346–357` — `getPiInvocation`: re-executes
  `process.argv[1]`. Correct only under the assumption the extension "only
  ever runs inside pi" (ADR 0037).
- `subagent/index.ts:382–408` — `nativePiCommand`: resolves pi for a *child*
  (PI_BIN, then executable on PATH, then runtime+entry script), never
  returns empty. Created by the ADR 0044 `node: bad option: --session-dir`
  defect; its doc comment states it is "Separate from `getPiInvocation`
  because the two answer different questions."
- `plan/review.ts:149–194` — `getPiInvocation`: *proves* the target
  (acceptable pi script names, generic-runtime detection, `PATH` + `X_OK`),
  refuses with `null` → Dead review (ADR 0037).

ADR 0037 explicitly records that importing the subagent helper into review
was **rejected** because it "would propagate the same unsafe assumption
rather than fix it." The divergence is a recorded decision, not accidental
drift.

**Deletion test.** Deleting a shared target module reappears the complexity
in three places — which is today's state, deliberately. What varies across
the seam is *policy* (re-execute self / resolve for child / prove target),
not *adapter*: there is no single behaviour with three copies, so there is
no duplication for a module to concentrate. A common interface over three
distinct policies would be a shallow policy switch, and "one adapter =
hypothetical seam" applies to each policy slot the same way it applied to
the rejected registry extraction of ADR 0039.

**Rejected** as framed. (A shared herdr *transport* convention layer is
candidate 7, a different seam.)

## 6 · "pi is patched" predicate — reject

No such predicate exists in the reviewed source. There is no
`isPatched` / `hasPatch` / `PI_PATCH` in any extension;
`thinking-indicator.ts:36–41` only *documents* that the local patch is
required, while patch application lives in `scripts/patch-pi.sh`
(install-time, standalone) and verification in
`scripts/check-thinking-label-patch.mjs` (standalone).

**Deletion test.** A predicate with zero in-process callers is, by
definition, a seam whose deletion makes its complexity vanish — it reappears
in no caller. It fails the test before the test starts, and the underlying
fact (is the installed pi patched?) is an install-time property that the
standalone scripts already own, per ADR 0034.

**Rejected.** The original six-item note shortlisted this item in
contradiction of the deletion test; the shortlist above removes it.

## 7 · Reconcile the two herdr transports — keep (Speculative)

**Current state.** Two live transports: `herdr/client.ts` (394 lines; CLI
`execFile` + JSON reply; importers: `herdr-names.ts`, `plan/index.ts`,
`plan/review.ts`, `subagent/index.ts`) and `herdr/socket.ts` (498 lines;
JSON-lines request/response + event subscription; importers: `plan/review.ts`,
`subagent/index.ts`, `subagent/native.ts`, `subagent/watcher.ts`).

**Evidence.** The duplication is the *convention layer*, and it is
acknowledged in the code: socket.ts comments say it "Mirrors client.ts's
pick exactly", applies "client.ts's rule" (never throws, null on any
failure), and gates availability "matching how client.ts gates on
`herdrContext()`". The availability checks, request framing,
pick-from-response, and endpoint resolution are each written twice.

**Deletion test.** Deleting a merged transport reappears the convention
layer in both modules. But the two transports' bodies share no
implementation (CLI exec vs socket framing), and a unified interface would
expose the union of ~15 CLI operations plus plugin-pane open plus
subscription — a wide interface over thin per-operation implementations,
i.e. a shallow-module risk.

**Kept at Speculative** — two real adapters exist and the convention
duplication is real, but the depth payoff is unproven.

## Top recommendation

**Candidate 1 (spawn-path seam).** It is the only candidate where the drift
cost is *already material* (the duplicated prelude), the two adapters are
both permanent by ADR decision, and the next Run concern (spawn cap,
planKey env, prompt sidecar — all recent) will have to be added twice again
until the seam exists.

## Effect on the HTML report

The report (`/tmp/architecture-review-20260915-004037.html`, item p5) must
be regenerated from this shortlist: cards 5 and 6 move to a
"considered and rejected" section with the reasons above, and card 7 keeps
its Speculative badge. Report regeneration is item p5's scope, not this
rework's.
