# Nested subagent completion — design

> **2026-11-05:** the nesting this spec describes (worker → reviewer/verifier) was later removed: workers no longer launch their graders, and the orchestrator grades each deliverable once.

Date: 2026-11-01 · Module: `agent/extensions/subagent-herdr/`
Full analysis: `/tmp/oracle-full.md` · Plan: `../plans/2026-11-01-nested-subagent-completion.md`

## Intent and why

Delegation nests: orchestrator → worker → reviewer/verifier. `agent/agents/worker.md:65`
tells a worker to launch its graders, end its turn, and be woken by them. Both completion
detectors instead read that waiting turn as the run being finished, so the worker is shut
down and its graders' verdicts are lost or dumped on the orchestrator raw.

Measured over ~640 run dirs (116 with a subagent parent): 83 graders finished AFTER their
worker was closed, 18 before; ~95 nested records sit `running` forever although all have
`.exit` sidecars. Of 12 sampled early-finishing workers, 11 wrote a `<result>` explicitly
saying the pass was still pending — they were waiting, as instructed.

## Goals

- A subagent is not finished while runs it launched are unfinished.
- The parent sees, right after a child's `</result>`, which runs that child launched.
- Orphaned records get settled instead of lying `running` forever.

## Non-goals / anti-goals

- Not a durable mailbox or a rewrite of the reroute walk (both ruled out: they fix routing,
  not the cause, and leave the worker's fix-and-re-verify step lost).
- Anti-goal: a block that reads like the graders' verdicts reached the parent when they did not.

## Constraints

No blocking wait or poll loop in the parent. Ancestry and `parentRunId` stamped by processes,
never trusted from model output. Terminal write order mutate → `saveMeta` → close pane;
`failed` never closes. `subagent-runs/` is world-writable: every field off disk is hostile.
Never widen `NOTICE_RE`. Never write the literal `<result>` into composed prompts.

## Approaches considered

- **A. Structured concurrency (chosen).** Don't finish while own spawns are unfinished.
  Removes the cause; keeps the worker alive so it can act on verdicts.
- **B. Durable mailbox.** Reliable delivery, but the recipient is still a dead worker. Backstop later.
- **C. Grandparent adopts orphans.** Orchestrator gets raw grader output instead of a worker
  that acted on it. Its narrow "orphan settle" form is kept for cleanup only.
- **D. Repair the reroute walk.** Routing, not cause.

Within A, refusal-only was rejected: bounded by `MAX_REFUSED_COMPLETIONS`, and run `sub-6aab`
shows a model will deliberately burn that budget. Deferral at `agent_end` is load-bearing
because it involves no model choice.

## Decisions

1. **One shared predicate** in `rundir.ts`: a run has pending spawns when records with
   `parentRunId === run.runId` (legacy fallback `ownerPane === run.paneId`) have no `.exit`
   sidecar. Sidecar, not `status`. Enumerated across `runDirBases()`, memoized per tick.
2. **Deferral in both detectors.** Child `onAgentEnd` returns early (no sidecar, notice, nudge
   or close) while spawns are pending; `subagent_done` is refused with guidance reusing the
   existing refusal bound. Parent's `completionSignal` becomes
   `hasSidecar || (answered && !salvagedFrom && !hasPendingSpawns)`, pending check injected so
   `run-lifecycle.ts` stays pi-free. Reroute walk unchanged as fallback.
3. **Bound (user chose both).** Children get a liveness tick only while they own `running`
   records; `DEFER_MAX` = 75 min (observed p90 31 min, max 67 min), applied parent-side from the
   pending child's `startedAt` so a planted record can delay settlement by at most `DEFER_MAX`.
4. **The block (user's request).** Built by the receiving parent in `renderResultBlock`, one line
   after the answer, so it renders immediately after `</result>` — never written to transcript,
   sidecar or `system-prompt.md`. Ids, agents, statuses, timestamp only; never `task` text.
   Marked a snapshot; a `done` child's verdict is "not reflected above" unless its id appears in
   a `[subagent … done]` input in the parent's transcript.
5. **`parentRunId`** optional on `RunRecord`, stamped at spawn from `PI_SUBAGENT_RUN_ID`;
   old records stay valid.
6. **Cleanup.** One-time settle of ~95 stuck records from sidecar `at` via lifecycle transition
   legality, closing no panes; ongoing orphan settle (parent terminal + owner pane `gone` +
   sidecar present), sidecar-only, never `failed`.

## Accepted failure mode

A worker can idle in an open pane up to `DEFER_MAX` behind a hung grader; the orchestrator sees
`running`, which is true. Fan-out holds more panes open.

## Verified assumption

Idle nested children ARE woken by a steered notice: 8 of 8 live recipients on disk started a new
assistant turn. The one apparent miss (`sub-9887`) had already shut down before its notice —
consistent with the cause.

## Left to the builder

Exact memoization point, helper names, migration script placement, and test fixtures.
