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
| 1 | Spawn-path seam (`subagent/index.ts`) | Skill resolution and the `prompt.md` sidecar are genuinely duplicated across two permanent implementations | **Keep — Strong** |
| 2 | Plan-mutation transaction module | One implementation behind one interface today; the second adapter (Board writer) does not exist | **Keep — Worth exploring** |
| 3 | Run outcome / liveness module | Complexity reappears across four consumers; the ADR log is a bug ledger for exactly this drift | **Keep — Strong** |
| 4 | Plan-file format module (cross-process) | Complexity reappears in both processes; hand-sync is already the documented burden | **Keep — Worth exploring** |
| 5 | `getPiInvocation` "interlock duplication" | Deletion restores today's state, which is deliberate, not drift | **Reject** |
| 6 | "pi is patched" predicate | No such predicate exists; zero callers — complexity vanishes | **Reject** |
| 7 | Reconcile the two herdr transports | The transports are complementary by design; only conventions overlap, and a unified interface would be wide and shallow | **Reject** |

## 1 · Spawn-path seam — keep (Strong)

**Current state.** `executeAttemptWithSlot`
(`subagent/index.ts:1250`) inlines two adapters in one function: the
**native** branch (`herdrSocketAvailable()` at 1280 → `executeNativeAttempt`,
1058–1247: `buildLaunchPlan`, wrapper script, `openPluginPane`, pane naming,
close-on-cancel, herdr-socket observation, `.exitcode` sidecar) and the
**fallback** JSON path (1298+: `--mode json` spawn, NDJSON parse, stall
watchdog, TERM→KILL reaping, Mirror Pane).

**Evidence of drift already present — narrowed.** Three things are duplicated
verbatim across the two branches: skill resolution and `runResult` population
(1084 native, 1315 fallback), the `sessionDir` mkdir (1106, 1336), and the
`prompt.md` sidecar write (1107, 1339; ADR 0045).

**What is *not* evidence** (corrected after review):

- *Prompt assembly* differs **deliberately**, not by drift: only the fallback
  appends `RESULT_CONTRACT`, because a Native Run's Result is read from its
  Transcript rather than scraped from a fenced tag (ADR 0044). A seam must
  preserve that divergence, not erase it.
- *The spawn cap and the opening Run Meta write already sit above both paths* —
  `claimSlot` at 1029 in `executeAttempt`, `writeRunMeta` at 1268 before the
  native attempt is tried. So "every new Run concern has to be added twice" is
  false as stated: the two most recent ones were added once. What must still be
  added twice is anything in the per-branch prelude.

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

## 2 · Plan-mutation transaction — keep (Worth exploring)

**Current state.** Inlined in `plan/index.ts`: the in-process
`withFileMutationQueue`, the cross-process `acquirePlanLock` (owner token,
stale-break, refusal via `PlanLockTimeoutError`, 815–905), `loadPlan`
validation (722), the `NO_WRITE` sentinel (999–1016), meta read/rewrite,
temp-file write and atomic `rename` — all inside `mutatePlan` (1030–1094).

**Callers.** 13 `mutatePlan` call sites and 12 `loadPlan` call sites in
`plan/index.ts` alone.

**One implementation, one hypothetical adapter** (corrected after review). The
Board is **not** a second writer today: `board.ts:10-13` states it is
"Read-only for now" and that card movement "is not yet implemented", and the
"writer" at `board.ts:819-830` is a comment explaining why it was deferred —
precisely because the lock protocol would have to be duplicated. Calling these
"two real writers" was factually wrong. ADR 0015 *intends* a Board writer, so
the second adapter is planned, not live — and one adapter means a hypothetical
seam.

**Deletion test — corrected.** The 13 call sites do **not** support this
candidate: they already call the single `mutatePlan` interface, so deleting an
*extracted* module would not scatter transaction logic across 13 callers. It
would simply return to its present local implementation in `plan/index.ts`.
That is a move, not a concentration — the test's own failure condition.

What the transaction genuinely earns is unchanged and real: it already
concentrates lock acquisition, token ownership, refusal semantics, meta
preservation and atomic rename in one place, and the bugs it prevents are
documented rather than hypothetical — cross-process lost update and
stale-snapshot `attach` (ADR 0035), and a refused mutation that silently
destroyed data (`NO_WRITE`, commit `6ad9831`). But that is an argument that
`mutatePlan` is *already* the right shape, not that extracting it pays.

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

## 7 · Reconcile the two herdr transports — reject

**Current state.** Two live transports: `herdr/client.ts` (394 lines; CLI
`execFile` + JSON reply; importers: `herdr-names.ts`, `plan/index.ts`,
`plan/review.ts`, `subagent/index.ts`) and `herdr/socket.ts` (498 lines;
JSON-lines request/response + event subscription; importers: `plan/review.ts`,
`subagent/index.ts`, `subagent/native.ts`, `subagent/watcher.ts`).

**Evidence — narrowed.** The overlap is the *convention layer* and nothing
wider: socket.ts says it "Mirrors client.ts's pick exactly", applies
"client.ts's rule" (never throws, null on any failure), and gates availability
"matching how client.ts gates on `herdrContext()`". So `pick`, the error/null
discipline, and the timeout constant are genuinely written twice. Request
framing and endpoint resolution are **transport-specific** — `execFile` argv
versus JSON-lines over a socket — so the earlier claim that they are duplicated
was wrong.

**Deletion test — fails.** The two transports are **complementary by design**,
not two adapters behind one interface: `socket.ts:1-11` states the CLI "cannot
listen", that the subscribe-to-events protocol "exists only on the server
socket", and that "the two are complementary; this file neither replaces nor is
replaced by client.ts." There is no single behaviour with two implementations —
there are two capabilities with one implementation each. A unified interface
would expose the union of ~15 CLI operations plus plugin-pane open plus
subscription: a wide interface over thin per-operation implementations, which is
the definition of a shallow module. Deleting it would concentrate nothing.

**Rejected.** What remains real is small and worth recording separately: the
convention layer (`pick`, the never-throw/null rule, the timeout) could move to
one tiny shared module used by both transports. That is a modest
duplication fix with two real callers, not a deepening of the herdr seam, and it
should not be sold as one.

## Top recommendation

**Candidate 3 (Run outcome / liveness).** Promoted over candidate 1 after
review, because it is the one candidate whose evidence survived scrutiny intact:
four consumers derive "what state is this Run in?" independently
(`runindex.ts:160-244`, `board.ts:156-265`, `plan/index.ts:1371-1460`,
`mirror.ts:341-353`), `TERMINAL_STOP_REASONS` is declared twice
(`runindex.ts:34`, `board.ts:125`), and the ADR log is a ledger of bugs born
from exactly that per-consumer derivation (ADR 0033, 0036, 0039, 0044). Deleting
a shared module reappears the derivation in all four — a concentration, not a
move. `rundir.ts` is the precedent: the same extraction was already made for
*writing* the sidecar.

**Candidate 1 (spawn-path seam)** remains Strong and a close second, but its
rationale is narrower than first claimed: the duplication is skill resolution,
the `sessionDir` mkdir and the `prompt.md` sidecar — three items, not "every new
Run concern". The spawn cap and opening Run Meta write already sit above both
paths, and the prompt-assembly difference is deliberate. It is a real seam with
two permanent adapters; it is not the one with the most material drift.

## Effect on the HTML report

The report (`/tmp/architecture-review-20260915-004037.html`, item p5) now needs
a second correction pass: candidate 7 joins 5 and 6 in "Considered and
rejected", candidate 2's badge drops from Strong to Worth exploring, and the top
recommendation moves from candidate 1 to candidate 3. Three live candidates
remain: 1 and 3 Strong, 2 and 4 Worth exploring.
