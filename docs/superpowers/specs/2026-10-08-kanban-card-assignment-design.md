# Kanban card assignment, review gating and verdicts — design

Status: approved in conversation 2026-10-08; this document is the spec the plan is written from.
Builds on the kanban extension (`agent/extensions/kanban/`) and subagent-herdr
(`agent/extensions/subagent-herdr/`).

## Goal

A kanban card becomes a unit of delegated work with a verified ending:

1. The orchestrator can **assign** a subagent to a card. The subagent sees the card as its
   goal and plans it with its own `todo` list.
2. When the subagent finishes, the **orchestrator decides**: send the card to review, or
   close it at once.
3. Moving a card to **review automatically launches** a reviewer and/or verifier on it.
4. A card reaches **done** only when every grader returns OK — or when the orchestrator
   explicitly **closes** it.
5. A **failed** card (its worker crashed, or a grader failed it) notifies the orchestrator
   and holds its turn until the card is addressed.

## Decisions (chosen by the user)

| Question | Decision |
|---|---|
| How is a subagent assigned? | `subagent(agent, task, card: "k3")` — the existing spawn path gains an optional `card`. |
| Who launches graders on a review move? | The kanban extension, from the move itself: `move k3 review` carries `graders` and a `brief`. |
| What do verdicts do? | Fully automatic: all OK → done; any failure → failed state; any INCONCLUSIVE → stays in review, flagged. |
| Where does a failed card go? | Back to `in_progress` with a failure flag; the settle guard holds the turn until it is handled. |
| What is "close"? | A `close` op with a required reason: any card → done, skipping review, recorded as *closed*, not *verified*. A plain move to done is refused. |

## Non-goals

- Subagents never read or write the board. They get no `kanban` tool; the card reaches them
  only as prompt text.
- No assignment from a subagent (grandchildren): `card` is refused outside the orchestrator.
- No automatic decision after a *worker* finishes — that step is deliberately the orchestrator's.
- No new grader agents: `reviewer` and `verifier` as defined in `agent/agents/`.
- No board interactivity: `board.ts` stays a read-only viewer.

## Invariants carried over (must not regress)

- **One writer.** Only the orchestrator's kanban extension mutates board state; every
  automatic transition happens in that process, applied synchronously to the in-memory state.
- **Branch-backed.** Canonical state is still a snapshot in a successful `kanban` tool result
  or a `kanban-state` custom entry; reconstruction, rewind, fork and the `turn_end` /
  `agent_settled` digest repair work unchanged.
- **Streaming-safe persistence.** A mutation made outside a kanban tool call (event handler,
  slash command) persists with `appendEntry` only when idle; while streaming it relies on the
  `turn_end` repair, exactly as `/kanban` edits do today.
- **Verdicts are strict.** Exactly one marker or it is INCONCLUSIVE; prose is never a verdict;
  an unreadable result is never OK.

The one deliberate reversal: today a linked run's status is advisory and never moves a card.
After this change, **grader** runs move cards. Worker runs and manually linked runs stay advisory.

## Architecture

### Components and seams

```
 orchestrator pi process (one runtime, one pi.events bus)
 ┌───────────────────────────────┐   pi.events (sync request/reply)   ┌──────────────────────────────┐
 │ subagent-herdr                │ ── kanban:card-lookup ───────────▶ │ kanban/index.ts              │
 │  subagent(card) → spawnRun    │ ── kanban:card-assigned ─────────▶ │  applyOp (lib.ts, pure)       │
 │  finishRun → result text      │ ── kanban:run-finished ──────────▶ │  verdict → card transition    │
 │  briefing += "Board: …" line  │ ◀─ reply(note) ─────────────────── │  persist + publish projection │
 │  spawn service                │ ◀─ subagent:spawn ──────────────── │  review move launches graders │
 └───────────────────────────────┘                                    └──────────────────────────────┘
        │ child panes (herdr tabs)                                         │ projection file
        ▼                                                                   ▼
   worker / reviewer / verifier children                              board.ts (read-only viewer)
```

- **Transport: `pi.events`.** pi gives every extension in one runtime the same `EventBus`
  (`core/extensions/loader.js`: one `createEventBus()` per loader, passed to every extension).
  `emit` runs handlers synchronously up to their first `await`, so a request carries a
  `reply` callback that the handler calls *synchronously*. If `reply` was not called by the
  time `emit` returns, the other extension is not loaded (a subagent child, a print-mode run,
  kanban disabled), and the caller treats the feature as unavailable. Handlers never throw
  (pi's bus logs handler errors with `console.error`, which would scribble over the TUI).
- **Channel names** are constants exported from one module both sides import
  (`kanban/protocol.ts`, pure: types + names only), so the contract is spelled once.
- **Verdict grammar** moves to a single owner, `agent/extensions/lib/verdict.ts`: the existing
  `parseVerdict` (APPROVE/REJECT/INCONCLUSIVE) and `parseRuntimeVerdict` (PASS/FAIL/INCONCLUSIVE)
  plus `extractResultBody`, moved verbatim from `ralph-loop/lib.ts` and
  `ralph-loop/runtime-gate.ts`. ralph-loop imports them back. No third parser.

### Event contracts (`kanban/protocol.ts`)

| Channel | Emitted by | Payload | Reply |
|---|---|---|---|
| `kanban:card-lookup` | subagent-herdr, before spending anything on a `card` spawn | `{ cardId }` | `{ ok: true, card: { id, title, note?, column } }` or `{ ok: false, error }` — unknown id, card in `done`. |
| `kanban:card-assigned` | subagent-herdr, after a launch succeeded | `{ cardId, runId, agent, role: "worker" \| "reviewer" \| "verifier", cwd }` | `{ note }` — a one-line board effect for the tool result. |
| `kanban:run-finished` | subagent-herdr `finishRun`, once per run, after `saveMeta` | `{ runId, agent, status: "done" \| "failed" \| "cancelled", answer: string }` | `{ note } \| undefined` — the "Board: …" line, only for runs linked to a card. |
| `subagent:spawn` | kanban, for each grader on a review move | `{ agent, task, card, role, cwd }` | sync `accept()` marks the service present; async `done({ ok, runId? , error? })`. |
| `subagent:reconcile` | kanban, on session start and settle | `{ runIds }` | none; finished runs surface through `kanban:run-finished`. |

`kanban:run-finished` carries the answer text `finishRun` already extracted, so the kanban
side parses it synchronously and the reply lands in the *same* wake briefing — one wake, the
grader's result and the board move together.

### State model — schema v2

`KanbanState.schemaVersion` becomes `2`. v1 snapshots still load (see Migration).

```ts
interface CardRun {            // replaces runIds: string[]
  id: string;                  // sub-xxxx
  role: "worker" | "reviewer" | "verifier" | "linked";   // "linked" = manual `link`, advisory
  round?: number;              // review round, graders only
}
interface ReviewRound {
  round: number;               // 1, 2, … per card
  brief: string;               // orchestrator's grading brief, ≤ 4000 chars
  graders: ("reviewer" | "verifier")[];
  verdicts: Record<string, GraderOutcome>;   // runId → outcome, filled as graders finish
  outcome?: "approved" | "failed" | "inconclusive" | "abandoned";   // set once: the round is settled
}
type GraderOutcome = "approve" | "reject" | "pass" | "fail" | "inconclusive" | "crashed" | "cancelled" | "launch-failed";
interface CardFailure { kind: "worker" | "review" | "launch"; detail: string /* ≤ 500 */ }

interface KanbanCard {
  id; title; column; note?; enteredAt?;      // as today
  runs?: CardRun[];                          // ≤ 10
  review?: ReviewRound;                      // the current/last round only
  failure?: CardFailure;                     // set → card is "failed"
  closed?: { reason: string };               // done via `close`
  verified?: string;                         // done via an approved round: "reviewer APPROVE, verifier PASS"
}
```

All new strings go through `cleanText` and their caps, like titles and notes today.

### Reducer ops (`kanban/lib.ts`, pure)

| Op | Who | Effect |
|---|---|---|
| `assign { id, runId, role, … }` | event `kanban:card-assigned` | Add the run with its role. Role `worker`: move to `in_progress` (from backlog/blocked/in_progress/review — leaving review abandons the round), clear `failure`. Grader roles: attach to the current round. |
| `move { id, column: "review", graders, brief }` | tool | Requires ≥1 grader and a non-blank brief; refused if a round is still running. Opens round N+1, clears `failure`. Graders are launched by the extension *after* the synchronous apply. |
| `move { id, column: "done" }` | tool / command | **Refused**: "use close (with a reason), or send it to review." |
| `move` out of `review` | tool / command | Abandons a running round (`outcome: "abandoned"`); its graders keep running, their verdicts are recorded but move nothing. |
| `close { id, reason }` | tool; `/kanban done <id> [reason]` | Any column → done, `closed.reason` set (required for the tool; the command defaults to "closed by the user"). Abandons a running round, clears `failure`. |
| `verdict { runId, outcome }` | event `kanban:run-finished` / restart pass | Records the grader's outcome in its round; settles the round when it decides (below). Ignored, with a note, if the round is already settled or the card is gone. |
| `worker-failed { runId, detail }` | event `kanban:run-finished` (worker, status failed) | Sets `failure: { kind: "worker" }`. Column stays `in_progress`. |
| `link` / `unlink` / `drop` / `note` / `rename` / `add` / `clear_done` | unchanged | `link` adds role `linked`. |

**Round settlement** (pure, `settleRound`), evaluated after every recorded verdict:

1. Any `reject` / `fail` / `crashed` / `launch-failed` → `outcome: "failed"`: card moves to
   `in_progress`, `failure: { kind: "review", detail: "<grader> <VERDICT> (sub-xxxx)…" }`.
   Settles at the *first* failure; later verdicts of that round are recorded, nothing moves.
2. Else, once every grader has an outcome: all `approve`/`pass` → `outcome: "approved"`: card
   moves to `done` with `verified` set; any `inconclusive`/`cancelled` → `outcome:
   "inconclusive"`: card stays in `review`, flagged.
3. Otherwise the round is still running.

A round settles exactly once; `outcome` is never overwritten.

### Mapping a finished run to an outcome

| Run | status `done` | status `failed` | status `cancelled` |
|---|---|---|---|
| reviewer | `parseVerdict(answer)`: APPROVE → approve, REJECT → reject, else inconclusive | crashed | cancelled |
| verifier | `parseRuntimeVerdict(answer)`: PASS → pass, FAIL → fail, else inconclusive | crashed | cancelled |
| worker | nothing changes; card shows "worker finished — decide" | `worker-failed` | nothing changes (orchestrator cancelled it) |
| linked | advisory badge only, as today | — | — |

### Flows

**Assign.** `subagent({ agent, task, card: "k3" })` → subagent-herdr emits `kanban:card-lookup`;
a refusal or no reply refuses the spawn before any run dir, registry entry or pane exists
("cards can only be assigned from the orchestrator" when kanban is absent). On success the
goal block is **prepended to the task text** the child is prompted with, and the run record's
`task` stores the combined text, so `meta.json` and the pane show exactly what the child was
told. The system prompt (`system-prompt.md`, the agent definition) is untouched. The block is
built by the pure `cardGoalBlock` in `subagent-herdr/lib.ts`:

```
## Your goal: kanban card k3 — "<title>"
<note, if any>

This card is your whole assignment. Plan it with your todo tool — one item per step —
finish every item, then report. The orchestrator decides whether the card is done; do not
claim it is.
```

After a successful launch, `kanban:card-assigned` (role `worker`) links the run and moves the
card to `in_progress`. The `subagent` tool result names the board effect.

**Worker finishes.** `finishRun` emits `kanban:run-finished`. Done: no state change; the card
is "worker finished — decide" (derived from the run's role + status), and the reply adds
`Board: k3's worker finished — send it to review (kanban move k3 review, graders, brief) or close it.`
to the wake briefing. Failed: `worker-failed`; reply `Board: k3 FAILED — its worker sub-xxxx crashed.`

**Review.** `kanban move k3 review graders:["reviewer","verifier"] brief:"<files, check command, image tag>"`
→ synchronous apply opens round N → the extension emits `subagent:spawn` per grader with a
composed task (card title, note, the brief, "you are grading this card; end with your verdict
marker"), `card: "k3"`, its role, and `cwd` = the card's latest worker run's cwd (else the
orchestrator's). Each launched grader links through `kanban:card-assigned`. A launch failure
records `launch-failed` for that grader, which fails the round. The tool result lists the
grader run ids. If subagent-herdr does not `accept()`, the move is refused (no state change)
before anything else.

**Verdicts.** Each grader's `kanban:run-finished` records its outcome; settlement may move the
card. The reply line is the board effect, e.g. `Board: k3 → done (verified: reviewer APPROVE, verifier PASS).`
or `Board: k3 FAILED review round 2 — verifier FAIL (sub-xxxx). It is back in progress; fix, reassign, re-review, block, or close it.`

**Close.** `kanban close k3 reason:"…"` → done, recorded as closed. Running graders are not
cancelled (that is `subagent_tasks cancel`); their verdicts no longer move the card.

**Restart.** Runs that finished while pi was down never pass through this process's
`finishRun`, and their `meta.json` still says `running` (subagent-herdr reclassifies a record
only when something calls its `reconcile`; `loadRegistry` deliberately does not probe herdr at
load). So on `session_start` (non-reload) and `agent_settled`, kanban emits
`subagent:reconcile { runIds }` with the runs of every unsettled round and of every in-progress
worker. subagent-herdr reconciles each through its normal path, so a finished run goes through
`finishRun` and emits `kanban:run-finished` exactly as a live finish would. One code path
applies verdicts, whether pi stayed up or not. A run already terminal on disk whose outcome is
unrecorded is replayed by the same handler: it emits `kanban:run-finished` for it, reading the
answer with `extractRunResult`. Effects of a reconcile pass that lands outside a wake briefing
are announced with a visible custom message (`customType: "kanban-review"`, no new turn), and
the settle guard makes them actionable.

### Settle guard (replaces today's actionable rules)

Actionable (holds the turn, deduped by signature as today):

- any card with `failure` — even while other runs on it are still running;
- `in_progress` with a finished worker and no running worker — "decide: review or close";
- `review` whose round settled `inconclusive` — "re-review or close";
- `review` with an unsettled round but no grader still running (graders lost) — "re-review or close";
- `in_progress` with no running run of any role, and `backlog` when nothing on the board is running — as today.

Never actionable: `done`, `blocked`, and any card with a running worker or a running grader
of an unsettled round. The signature adds roles, round outcome and the failure flag.

### Rendering (`lib.ts` → board and widget)

- Run badges show the role: `▶ sub-xxxx worker running`, `✓ sub-xxxx reviewer APPROVE`,
  `✗ sub-xxxx verifier FAIL`, `? sub-xxxx reviewer inconclusive`.
- A failed card gets a red `✗ FAILED — <detail>` line; review cards show `review round N`.
- Done cards are tagged `verified` or `closed: <reason>`.
- All within the existing width guarantees (`fit`/`cleanText`), fuzz-tested.

### Agent definition change

`agent/agents/reviewer.md` gains a required verdict line inside `<result>`, kept beside the
human-readable `## Verdict` prose:

- `<verdict>APPROVE</verdict>` — no Critical and no Warning remain (Suggestions never block);
- `<verdict>REJECT</verdict>` — any Critical or Warning;
- `<verdict>INCONCLUSIVE</verdict>` — the review could not be done (files missing, out of scope).

Exactly one marker. The verifier already emits `<verdict>PASS|FAIL|INCONCLUSIVE</verdict>`.

### Tool and command surface

- `subagent`: new optional `card` (string, `k<n>`). Guideline: "To work a kanban card, pass
  `card`; the child gets the card as its goal."
- `kanban` tool: `move` gains `graders` (`["reviewer"]`, `["verifier"]` or both) and `brief`,
  both required when `column` is `review`; new op `close` (`id`, `reason`). Guidelines updated:
  done is reached only through review or `close`.
- `/kanban done <id> [reason]` — the user's close. `/kanban move <id> review` is refused with
  "ask the orchestrator to send it to review (it needs graders and a brief)". `/kanban close`
  stays the pane command.

## Errors and edge cases

| Case | Behaviour |
|---|---|
| `card` given to a subagent spawned by a subagent | No kanban in that process → no reply → refused before launch. |
| Card dropped while its runs are live | Later `run-finished` events find no card: no-op, no note. |
| Two review moves racing | The second is refused: a round is already running. |
| Grader launch partially succeeds | Launched graders run; the failed one records `launch-failed`, which fails the round at once. |
| A worker assigned while a round is running | `assign` (worker) leaves review → round abandoned → card `in_progress`. |
| `/reload` mid-review | The registry, run records and in-memory rounds are rebuilt (branch + `meta.json`); the reconcile pass picks up any verdict missed during the reload. |
| Malformed or v1 snapshot | v1 migrates (below); malformed is skipped, as today. |
| Answer text huge or hostile | Only the marker is parsed; failure `detail` is composed by kanban from the marker and run id, never copied from the answer. |

## Migration and rollout

- `parseSnapshot` accepts `schemaVersion: 1` and upgrades it: `runIds` → `runs` with role
  `linked`; no rounds, failures or close records. Snapshots are written as v2 only.
- The projection's `schemaVersion` becomes 2. An already-open board pane runs the old
  `board.ts` and cannot read it, so the registry record stores the board protocol it launched;
  on `/reload` a mismatch (or a record created by older code, which lacks the field) restarts
  the pane automatically.

## Testing and acceptance

Unit (pure, `bun test`):

- `lib/verdict.test.ts`: both parsers, moved with their existing ralph-loop cases unchanged.
- `kanban/lib.test.ts`: every op above, round settlement (first failure wins, all-OK, mixed
  inconclusive, settles once, late verdicts), v1 → v2 migration, guard actionability per rule,
  rendering widths with the new badges.
- `kanban/protocol` contract tests: kanban's handlers against a fake bus (lookup refusals,
  assignment, run-finished → note), and subagent-herdr's side (refuse on no reply, goal block
  in the prompt, `finishRun` emits once per run).
- `subagent-herdr/lib.test.ts`: `cardGoalBlock`.
- `./scripts/check.sh` green; mutation spot-checks on the settle-once rule and the
  refuse-done-move rule.

Live herdr acceptance (scratch tabs, cleaned up afterwards):

1. `subagent(card)` → card moves to in_progress with a worker badge; the child's pane shows
   the goal block and it builds a todo list.
2. Worker finishes → one wake briefing carrying the "decide" board line; the card has not moved.
3. Review move with reviewer + verifier → both launch, both linked; an APPROVE + PASS moves the
   card to done, tagged verified, in the same wake.
4. A REJECT (seeded defect) → card back in progress, ✗ FAILED, wake carries the board line,
   and the guard holds the turn until it is handled.
5. `close` with a reason → done, tagged closed; a later grader verdict moves nothing.
6. Plain `move … done` is refused; `/kanban done k1` works.
7. Kill pi mid-review, let a grader finish, restart → the reconcile pass applies the verdict.
8. A subagent passing `card` is refused; a print-mode run has no kanban and no card path.

## Files

| File | Change |
|---|---|
| `agent/extensions/lib/verdict.ts` (+ test) | New single owner of both verdict grammars (moved from ralph-loop). |
| `agent/extensions/ralph-loop/lib.ts`, `runtime-gate.ts` | Import the moved parsers; behaviour unchanged. |
| `agent/extensions/kanban/protocol.ts` | New: channel names + payload types, pure. |
| `agent/extensions/kanban/lib.ts` | Schema v2, new ops, round settlement, guard rules, rendering. |
| `agent/extensions/kanban/index.ts` | Bus handlers, grader launch on review moves, reconcile pass, tool/command surface, board-protocol restart. |
| `agent/extensions/kanban/runs.ts` | Roles in the run info the board renders; badges for grader outcomes. |
| `agent/extensions/kanban/board.ts` | v2 projection; new badges. |
| `agent/extensions/subagent-herdr/index.ts` | `card` param; lookup, assigned and run-finished emits; `subagent:spawn` and `subagent:reconcile` services; "Board:" line in result blocks. |
| `agent/extensions/subagent-herdr/lib.ts` | `cardGoalBlock`. |
| `agent/agents/reviewer.md` | Required verdict marker. |
| `AGENTS.md`, `agent/extensions/AGENTS.md`, `agent/extensions/subagent-herdr/AGENTS.md` | Document the lifecycle, the bus contract, the verdict owner and the reversed "runs never move cards" rule. |
