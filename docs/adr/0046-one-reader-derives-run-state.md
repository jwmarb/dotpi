# 0046. One reader derives Run State; the contract gains a read side

Date: 2026-09-15

## Status

Accepted. Design only — no code has been written yet.

## Context

Four consumers each derive "what state is this **Run** in?" from a **Run**
directory, independently:

- `subagent/runindex.ts:176` — `scanRunDir`, for the **Run Index** (`/runs`)
- `plan/board.ts:186` — `readRunProgress`, for **Board** card progress
- `plan/index.ts:1384` — `reworkStillRunning`, before dispatching a re-review
- `subagent/mirror.ts:341` — the **Mirror Pane**'s no-transcript case

None of them holds a handle on the process that produced the directory; all
four read only `node:fs` and `node:path`. The derivation they share is not
obvious, and the ADR log is a ledger of the same bug found separately in
different consumers:

- `toolUse` treated as terminal called a 9-turn Run finished at turn 1 — fixed
  in the **Board** (0033), then again in the **Run Index** (0038).
- A **Run** killed mid-tool-call keeps `toolUse` as its last stop reason
  forever, so the transcript alone reads `running` for a Run that died hours
  ago; a Run retrying a provider error has `error` as its last stop reason, so
  the transcript alone reads `failed` for a Run that is alive and will probably
  recover. **Run Meta** was promoted to real state for exactly this (0036), and
  the retry patch (0034) made the second case routine rather than rare.
- **Dismissed** arrived as a fourth outcome that "the **Board**, **Run Index**
  and `run.json` must all learn" (0044) — a new value taught to N readers by
  hand.

`TERMINAL_STOP_REASONS` is declared identically in two files
(`runindex.ts:34`, `board.ts:125`); `runindex.ts:159` says the two "now share
one definition of terminal" by convention, not by import.

`rundir.ts` is the precedent: it was extracted (0039) so the layout's *write*
side could not be re-implemented by a second producer, on the reasoning that
"without a shared writer the two would each re-implement the layout, and the
invariant most likely to be dropped is the one that is easiest to miss". The
read side was never given the same treatment.

## Decision

**A new module, `subagent/runstate.ts`, owns the derivation.** One function,
`readRunState(runDir) → RunState`, returning state, turns, start time, agent
and an `archived` flag. Consumers take the fields they need.

**It is a sibling of `rundir.ts`, not an extension of it.** Writing a sidecar
and deriving state from a directory are different jobs, and keeping them apart
keeps each module's purpose describable in one line.

**It imports `RunOutcome` from `rundir.ts` rather than restating it.** The
outcome values are the vocabulary of the contract, not of writing, and a
duplicated union across two files that must agree forever is the precise
failure this ADR exists to stop — `TERMINAL_STOP_REASONS` is how that ends.

**It takes a directory path; it never resolves one.** Two of the four consumers
are standalone `bun` processes in bare **Panes** and cannot import the pi host,
so `getAgentDir()` stays at the call sites that already have it.
`reworkStillRunning` keeps resolving its own path and passes the result in.

**Liveness moves behind the same interface.** "Is a writer editing the tree
right now?" is the same question asked to a stricter standard, against the same
sidecar. Behind one interface its evidence ladder — sidecar, then `.exit` /
`.exitcode` sidecars, then the child's pid, then transcript and directory age as
a bound — becomes available to every consumer instead of being plan-private. Its
asymmetry is preserved and is the reason the ladder exists: claiming
still-running wedges a **Plan Item** recoverably, while claiming finished judges
a tree a worker is mid-way through editing (0041).

**`archived` is a field, and the reader never thaws.** A scan must stay as cheap
as a listing (0022), and `running` beside `archived: true` is self-contradictory,
so a stale `running` on an archived directory is not honoured. Folding archived
into the state value would make "unknown" mean two things.

**`TERMINAL_STOP_REASONS` collapses into the reader.** Both consumers stop
needing it.

**It lands incrementally**: the reader and its tests first, then one consumer
per commit. `board.ts` and `mirror.ts` go last, because they are CLI entrypoints
that `check.sh` can only parse — they migrate once the interface is already
proven by the callers that can be tested.

**Tests use fixture Run directories in a temp directory**, exercised through the
one interface, with a named regression case per bug above. This also fixes a
standing defect: `rework-liveness.test.ts` resolves `RUNS_ROOT` from the default
agent dir, so it writes fixtures into the real `~/.pi/agent/subagent-sessions`.

## Consequences

The **Run directory contract** becomes a module on both sides — `rundir.ts`
writes, `runstate.ts` derives — and a new outcome value is taught to one reader
instead of four. Roughly 100 lines of directory forensics leave `plan/index.ts`,
so plan logic stops adapting up to process details. `board.ts` and `mirror.ts`
gain their first shared, tested code path; the derivation becomes testable at
all, which it is not today.

Costs: a third module in the Run-directory story, so a reader must know that
`rundir.ts` writes and `runstate.ts` reads. Two modules must agree about
`run.json`'s shape — mitigated, not eliminated, by importing `RunOutcome`. And
`runstate.ts` may not import the pi host, a constraint invisible at its own call
sites and enforced only by the two bare-pane consumers breaking if it is
violated.

## Considered

**Extending `rundir.ts`** would have put the whole contract in one module and
needed no shared vocabulary at all; rejected to keep writing and deriving
separately describable.

**A predicate kit** (`isTerminal`, `outcomeWins`, the constant) would have been
the smallest change, but it sells the rules while leaving each consumer to
assemble the answer — a wider interface and less depth, so the next consumer can
still assemble it wrongly.

**Leaving liveness in the plan extension** was genuinely arguable: pid probing
is different evidence from reading a transcript, and excluding it keeps the
shared module pure disk-reading. Rejected because it is the same question, and
splitting it would leave the strictest reading of a Run's state unavailable to
everyone else.

**One big commit** was rejected because it would move the two least-testable
consumers before the interface had been exercised anywhere.
