# subagent-herdr — herdr-backed delegation: `subagent`/`subagent_tasks`, run dirs, the child completion handshake

Every delegation is a herdr tab in the orchestrator's workspace running a native `pi` TUI. If the workspace is
unknown or `tab create` is unavailable, it falls back to a pane split (`herdr.ts:293-300`). Each delegation also
gets a run dir under `agent/subagent-runs/`. Line refs were checked on 2026-10-31 against herdr **0.9.0** (`herdr --version`).

## WHERE TO LOOK

| File | Owns |
|---|---|
| `index.ts` (1961) | Entry (`:1250`). Registers the tools, spawn (with the bounded launch-time Enter recovery), the briefing renderers, the `input` hook (`:1676`) that swallows child notices, the coalesced wake (`:1612`), and the 60 s liveness tick |
| `rundir.ts` (711) | **The contract, spelled once**: run-dir paths, `RunRecord` (`:181`, persisted verbatim as `meta.json`), `RunStatus` (derived from `RUN_STATUSES`, `:151`), `RUN_ID_PATTERN` (`:498`), the wake-notice grammar, the ancestry grammar, and the answer predicate `qualifiesAsAnswer` (`:644`) with `visibleTextOf` (`:598`) |
| `lib.ts` (1289) | Pure launch contract: `admitSpawn` (agent lookup → `lineageRejection` → `childFallbackChain`), `buildChildArgv` (`:302`), `buildChildEnv` |
| `run-lifecycle.ts` (378) | Pi-free. Has the one completion predicate `completionSignal` (`:112`), and is the sole writer of `status`/`finishedAt`/`failedAttempts`. Handles per-run serialization and gone-pane settle retries |
| `release-ledger.ts` (975) | Pi-free wake policy: coalescing (`NOTICE_COALESCE_MS` 1.2 s), dedup, the health-check/target release pairing, and `LIVENESS_BACKSTOP_MS` 60 s. Every briefing branch adds the reroute note through `withRerouteNote`. Takes `now` and has no timers |
| `parent-proof.ts` (191) | Pi-free running-parent proof for reroutes: `createParentProof(effects)` with the positive-only, TTL-bounded memo, plus `WAKE_PROBE_TIMEOUT_MS`/`PARENT_PROOF_TTL_MS` (re-exported by `index.ts`) |
| `herdr.ts` (594) | The only herdr seam, a CLI wrapper (`HERDR_TIMEOUT_MS` 30 s). The measured herdr behaviours are in its header. It also exports the pane primitives that kanban uses |
| `child-done.ts` (1557) | The child half, loaded with `-e`: `subagent_done`/`subagent_report`/`subagent_ask` (card children only), the answer gate, the truncation continuation, the `.exit` sidecar, and the detached notice |
| `package.json` / `tsconfig.json` | Dev-only `typescript` + `@types/node`, with no `main`/`scripts`/runtime deps. The tsconfig has **no `paths`** (`persona/` is the only other scope without one) |

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
  Under a persona switch, `buildChildEnv` also sets `LEASE_DIR_ENV` to `leaseDir()` (`lib.ts:188`), so the child's concurrency leases use the parent's lease dir.
- **Ancestry is stamped by processes, not trusted from models** (`PI_SUBAGENT_LINEAGE`, `PI_SUBAGENT_ANCESTRY`).
  When a child's parent has finished, its notice is rerouted to the nearest surviving ancestor, bounded by `timeout(1)`.
- **A record is registered before its pane exists**, and the launch window is not evidence of anything.
  Terminal-write order: `done`/`cancelled` mutate → `saveMeta` → close the pane. `failed` mutates → `saveMeta` and
  **never closes**, because the scrollback is the failure evidence.
- **The run dir is global to every pi process, and ownership is per pane** (`ownerPane` = `HERDR_PANE_ID`). Only the
  owner sweeps or ticks. Unknown runs are adopted from disk on demand. Load and adoption use `hasRunId`
  (`rundir.ts:251`), which checks only `runId`; `isRunRecord` (`:265`) is strict (`status` ∈ `RUN_STATUSES`) and
  only kanban's reader uses it.
- **Health checks diagnose, they do not complete runs.** A `stalled`/unanswered target spawns at most one read-only
  `healthcheck` child, keyed by `healthCheckOf`. The target's briefing is held until that child finishes.
- **`interrupt`** = reconcile → Escape → bounded idle wait (30 s) → replacement prompt.

## COMMANDS

```sh
bun test agent/extensions/subagent-herdr/              # all five suites (lib, child-done, run-lifecycle, release-ledger, wake)
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
- `additionalProperties: false` on `subagent_done`. A schema rejection gets retried with no guidance.
- Collapsing the bounded launch-time Enter recovery to a single Enter, or making it unbounded.
