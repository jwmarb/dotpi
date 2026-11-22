# subagent-herdr — herdr-backed delegation: `subagent`/`subagent_tasks`, run dirs, the child completion handshake

Every delegation is a herdr tab in the orchestrator's workspace running a native `pi` TUI. If the workspace is
unknown or `tab create` is unavailable, it falls back to a pane split (`herdr.ts:293-300`). Each delegation also
gets a run dir under `agent/subagent-runs/`. Line refs were checked on 2026-11-10 against herdr **0.9.0** (`herdr --version`).

## WHERE TO LOOK

| File | Owns |
|---|---|
| `index.ts` (2123) | Entry — the only module pi loads here (`before_agent_start` `:1248`, `session_start` `:1262`, tools `:1306`/`:1383`, `input` `:1636`, `session_shutdown` `:1653`). Registers the tools, spawn (with the bounded launch-time Enter recovery, and the `parentRunId` stamp at `:972`), the **briefing wiring** — the effects bag at `:1193`, handed to the ledger as `renderer` at `:1453`; it renders no briefing block itself, it only binds `briefing.ts` to this process's run dirs and pane reads — the `input` hook that swallows child notices, the coalesced wake, and the 60 s liveness tick (ownership-gated for children at `:1730`) |
| `briefing.ts` (306) | Pi-free briefing renderers — the text a finished run becomes: the header (`formatResultHeader` `:71`, `startedAtOf` `:67`), the block itself (`renderResultBlock` `:177`, inside `createBriefing` `:153`), its salvage labels and todos line, the pane diagnostic (`paneDiagnostic` `:48`), the mid-run report join (`pushReports` `:159`), `truncate` (`:104`) with `RESULT_MAX_CHARS`, `COLLECTED_DONE_IDS` (`:102`), and the I/O-free `fallback` (`fallbackBriefing` `:268`); the spawns block rides at `:224`. **No pi, no `herdr.ts`, no `node:`** — its six reads arrive as `BriefingEffects` (`:114`) bound by the caller. `Briefing extends ReleaseRenderer` (`:130`), so `createBriefing`'s result *is* the ledger's renderer: `index.ts`'s `renderer: briefing` plus the ledger's declared field type is the conformance check, and there is no forwarding literal to drift |
| `rundir.ts` (1153) | **The contract, spelled once**: run-dir paths, `RunRecord` (`:296`, persisted verbatim as `meta.json`, with `parentRunId` at `:367`), `RunStatus` (derived from `RUN_STATUSES`, `:216`), `RUN_ID_PATTERN`, the wake-notice grammar, the ancestry grammar, the answer predicate `qualifiesAsAnswer` with `visibleTextOf`, the transcript-selection rule `pickSessionName`, **the one parent shape** `ParentRef` (`:438`) that both detectors pass, and **the one pending-spawn rule** `pendingSpawnsOf` (`:503`) with `DEFER_MAX_MS` (`:421`) spelled once as `deferWithin` (`:533`) — the age clause the ledger's spawns-block fallback shares — alongside the ledger's lifetime clause `withinLifetime` (`:546`), and the record-level terminal test `isTerminalRecord` (`:257`) |
| `lib.ts` (1459) | Pure launch/result contract: `admitSpawn` (`:1261`: refuses a `cwd` that is not a usable string path, then agent lookup → `lineageRejection` → `childFallbackChain`), `normalizeChildCwd` (`:1211`), `buildChildArgv` (`:285`), `buildChildEnv` (`:166`), the trust pair `childApproveFlag`/`childTrustDecisionSaved` (`:346`/`:373`), `rootsForRun` (`:415`), result extraction (`extractRunResult` `:792`), skill selection (`selectSkills` `:446`, `discoverSkills` `:582`), `buildHealthCheckTask` (`:1061`), `herdrAgentName` (`:1366`), `projectLayerNotices` (`:1442`) |
| `run-lifecycle.ts` (464) | Pi-free. Has the one completion predicate `completionSignal` (`:139`, three inputs: sidecar, result, pending spawns), is the sole writer of `status`/`finishedAt`/`failedAttempts`, and owns `settleFromSidecar` (`:452`; interface `:206`) — the only way a sidecar-proven `running` record becomes `done`. Handles per-run serialization and gone-pane settle retries |
| `settle-stuck.ts` (201) | Pi-free start-up settle: `settleStuckRecords`, `settleOrphans` (`:172`, a running child whose parent is terminal, past `STUCK_SIDECAR_MIN_AGE_MS` = 6 backstops, settled through the lifecycle) and `isOrphanSettleable` |
| `release-ledger.ts` (1099) | Pi-free wake policy: coalescing (`NOTICE_COALESCE_MS` 1.2 s `:153`), dedup, the health-check/target release pairing (`MAX_DEGRADED_RELEASE_ATTEMPTS` `:187`), and `LIVENESS_BACKSTOP_MS` 60 s (`:167`). Every briefing branch adds the reroute note through `withRerouteNote`. Also `ownsRunningRecord` (`:239`, the child-tick gate) and `renderSpawnsBlock` (`:298`). Its `ReleaseRenderer` (`:402`) is the seam `briefing.ts` implements. Takes `now` and has no timers |
| `parent-proof.ts` (192) | Pi-free running-parent proof for reroutes: `createParentProof(effects)` with the positive-only, TTL-bounded memo, plus `WAKE_PROBE_TIMEOUT_MS`/`PARENT_PROOF_TTL_MS` (re-exported by `index.ts`) |
| `herdr.ts` (594) | The only herdr seam, a CLI wrapper (`HERDR_TIMEOUT_MS` 30 s). The measured herdr behaviours are in its header. It also exports the pane primitives that kanban uses |
| `child-done.ts` (1683) | The child half, loaded with `-e`: `subagent_done`/`subagent_report`/`subagent_ask` (card children only), the answer gate, the truncation continuation, the **pending-spawn deferral** (`agent_end` returns early at `:854`; `subagent_done` refuses at `:749`), the `.exit` sidecar, and the detached notice |
| `package.json` / `tsconfig.json` | Dev-only `typescript` + `@types/node`, with no `main`/`scripts`/runtime deps. The tsconfig has **no `paths`** |

## CONVENTIONS (local)

- **No blocking wait, and the wake is `deliverAs: "steer"`.** The parent ends its turn. The child types a notice into
  the parent's pane (`herdr agent prompt`), and the parent drains it at the end of *every* turn. `followUp` is only
  drained when the agent is idle, and that is the dropped-wake bug.
- **The contract lives in `rundir.ts`.** Both halves import it, and the child imports only shared modules. The notice
  regex is strict because the parent silently swallows anything that matches.
- **Ids.** Pane and tab ids come from herdr responses and are never predicted. Run ids (`sub-` + 4 hex) and herdr
  agent names (`<agent>-<runId>`, unique among live agents server-wide) are built locally. Validate the *scoped* name.
- **`herdr.ts` never throws.** A refusal comes on **stderr** with a non-zero exit. `agent read` returns raw text, not
  JSON. `probeAgent` (`:472`) has three outcomes, and a pane counts as `gone` **only** on `agent_not_found`.
- **Completion = the `.exit` sidecar OR a clean transcript answer.** A `done` notice only tells the parent to look.
  Neither signal fires without a visible answer: both halves call one `qualifiesAsAnswer`. Parent-side salvage is
  deliberately *looser* than the gate. `stopReason: "length"` is continued, up to `MAX_CONTINUATIONS` = 3, not finished.
- **Every child allowlist gets `todo`** plus the handshake tools, appended by `buildChildArgv`. A plain `--tools`
  list replaces pi's selection.
- **Children run `--model fallback/auto`** with `PI_FALLBACK_CHAIN` (`CHAIN_ENV`) built by `childFallbackChain` from
  the agent's `model` + `fallback_models`. The chain-item grammar (`ref|level`) is owned by `../model-fallback/lib.ts`.
- **Children inherit the project layer's trust explicitly.** The roster and skills come from `projectRoots` (`../lib/project-layer.ts`); `RunRecord.projectDir` is read at launch and when a health check is created (revival only extracts results), and `projectTrusted` is what grants trust — a record lacking it re-derives profile-only. A model-chosen relative `cwd` is normalized against the parent's cwd before admission (`normalizeChildCwd`), so the record, the pane, and the trust flag all see one absolute path. `childApproveFlag` adds `--approve`/`--no-approve` for a same-`projectDir` child (trusted/untrusted) and `--no-approve` for a foreign cwd that is trust-requiring with no saved decision (a saved one is honored silently; `--approve` never crosses to a foreign cwd) — an unflagged child in an unwatched pane answers its default-"Trust" prompt from herdr's keystrokes and *persists* trust. The parent's own layer state rides `projectLayerNotices` at `session_start` — once per fresh parent session, child-skipped, `console.error` fallback when there is no UI.
- **Ancestry is stamped by processes, not trusted from models** (`PI_SUBAGENT_LINEAGE`, `PI_SUBAGENT_ANCESTRY`).
  When a child's parent has finished, its notice is rerouted to the nearest surviving ancestor, bounded by `timeout(1)`.
- **A record is registered before its pane exists**, and the launch window is not evidence of anything.
  Terminal-write order: `done`/`cancelled` mutate → `saveMeta` → close the pane. `failed` mutates → `saveMeta` and
  **never closes**, because the scrollback is the failure evidence.
- **The run dir is global to every pi process, and ownership is per pane** (`ownerPane` = `HERDR_PANE_ID`). Only the
  owner sweeps or ticks. Unknown runs are adopted from disk on demand. Load and adoption use `hasRunId`
  (`rundir.ts:682`), which narrows to `RunIdBearing` (`:664`) — the run id and nothing else — and widen the
  survivor through `asRunRecord` (`:697`), the one documented unvalidated cast at that boundary; `isRunRecord`
  (`:707`) stays the strict reader guard (`status` ∈ `RUN_STATUSES`) and only kanban's reader uses it.
- **A `running` record a sidecar proves finished belongs to no pane any more.** The owner settles it on its next tick;
  at factory start the root process settles the ones owners never came back for — sidecar `at` older than
  `STUCK_SIDECAR_MIN_AGE_MS` (6 backstops), `done` at the sidecar's own time, and it closes no pane. Records whose
  `ownerPane` is this process are left to the sweep. It scans only **this process's own** run dir (not
  `allRunCandidates()`, whose import-time base is the real dir in a test process), and it writes only
  `status`/`finishedAt` — idempotent, so running it on every root start *is* the migration.
- **Health checks diagnose, they do not complete runs.** A `stalled`/unanswered target spawns at most one read-only
  `healthcheck` child, keyed by `healthCheckOf`. The target's briefing is held until that child finishes.
- **`interrupt`** = reconcile → Escape → bounded idle wait (30 s) → replacement prompt.
- **A run is not finished while runs it launched are unfinished.** `agent/agents/worker.md` tells a delegating child (a
  `worker` waiting on its `librarian`) to end its turn and be woken by the run it launched, and a clean `agent_end`
  holding a `<result>` used to read as completion — it shut the waiting worker down (measured while workers still
  launched graders: 83 of 116 nested graders reported after their worker was closed). Both detectors
  defer on **one** rule, `pendingSpawnsOf` (`rundir.ts:503`): the child returns from `agent_end` with no sidecar, notice,
  Unfinished means **no `.exit` sidecar AND a status that is not terminal** (`isTerminalRecord`: `done`,
  `cancelled`, `failed` *with* `failedAttempts`, or a bare `failed` **once** `REVIVAL_WINDOW_MS` (6 min) has
  passed since it settled (`finishedAt`) — while that window runs the bare `failed` is still the lifecycle's
  recoverable state, so it keeps holding; a `finishedAt` that is missing or not a finite number fails closed to
  holding, too). The sidecar alone was wrong, because a cancelled spawn or a launch that died before its process
  started can never write one (4 such nested records on disk: 3 `cancelled`, 1 `failed` with `failedAttempts`),
  which would have held the worker for the whole bound and defeated the tick that exists to end the wait.
  A missing/unrecognised `status` is NOT terminal. Bounded by `DEFER_MAX_MS` = 75 min measured from the *pending child's*
  `startedAt`, applied inside the predicate so child and parent cannot disagree, and by the child liveness tick, which
  children now run **only while they own a `running` record** (`ownsRunningRecord`, `index.ts:1730`). Refusal alone is
  not the fix — a model will deliberately burn `MAX_REFUSED_COMPLETIONS` (`sub-6aab`); the `agent_end` deferral involves
  no model choice. The reroute walk and `NOTICE_RE` are unchanged as the crash/deadline fallback.
- **The spawns block is rendered output, never a stored fact.** A briefing lists the runs the reported child launched
  (`renderSpawnsBlock`, `release-ledger.ts:298`) immediately after its `</result>`, as a snapshot. It rides in `out` only — writing it into the
  transcript, the sidecar or `system-prompt.md` would feed the salvage classifier and `requiresResultBlock`. It prints
  ids, agents and statuses ONLY, never `task` (the run dir is world-writable, so a planted `meta.json` would inject text
  into the reader's context). A finished child is labelled "delivery not provable
  from disk" unless its notice is proven collected; `COLLECTED_DONE_IDS` (`briefing.ts:102`) is empty **on purpose** — an `input` hook answering `handled` returns before pi creates
  a message, so a swallowed notice is nowhere on disk, and a briefing header is text a model can also write. The label states what the disk supports (nothing
  proves delivery), never that the block above omitted the verdict: after the deferral a delegating child settles *because* the runs it launched woke it.

## COMMANDS

```sh
bun test agent/extensions/subagent-herdr/              # all suites in this dir — one per module: lib, parent-proof, child-done, run-lifecycle,
#   release-ledger, rundir, settle-stuck, wake, briefing
bun test agent/extensions/subagent-herdr/lib.test.ts   # just the launch/pure-logic suite
cd agent/extensions/subagent-herdr && npm install && ./node_modules/.bin/tsc -p tsconfig.json
```

This paths-less scope resolves `@earendil-works/*` through the repo-root `node_modules` link. It is the first scope
to fail if that link is missing. Copy `model-fallback/tsconfig.json`'s `paths` to opt in.

## ANTI-PATTERNS

- Hand-writing run-dir paths, JSON shapes or the notice grammar outside `rundir.ts`.
- Any blocking wait, poll loop or sleep-until-done in the parent. Switching the wake back to `followUp`.
- Widening the notice regex. A false positive eats a user's message.
- Closing a failed pane "to tidy up". Treating `agent read` output as JSON.
- Registering a child under its bare agent name. Flattening a herdr error code before the launch classifies it.
- Writing the `.exit` sidecar for a refusal or nudge. The sidecar *is* the done classification.
- A second answer predicate, a hardcoded agent roster for the gate, or tightening salvage to match the gate.
- A second pending-spawn rule, or a `hasSidecarAsOf`-style replay that reads today's `status` as if it were the status at
  the moment being replayed — the migration settles those records, so the replay would report every late child as early.
- Rendering the spawns block into a transcript, sidecar or `system-prompt.md`, or printing a record's `task` text in it.
- Composing a completed-run briefing block outside `briefing.ts`. The `subagent_tasks` arms CALL its renderers
  (`briefing.renderResultBlock`, `briefing.pushReports`); they do not re-render them.
- `additionalProperties: false` on `subagent_done`. A schema rejection gets retried with no guidance.
- Collapsing the bounded launch-time Enter recovery to a single Enter, or making it unbounded.
