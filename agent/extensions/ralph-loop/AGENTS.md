# ralph-loop — settle-driven completion loop, plus the oracle/verifier `--verify` gates and their Docker images

The command surface, the completion tag and the `--verify` modes are in the root `AGENTS.md`. This file covers
the internals. Line refs were checked on 2026-10-31.

## WHERE TO LOOK

| File | Owns |
|---|---|
| `index.ts` (754) | Session wiring only: loop state, footer, the three `registerCommand`s (`:728-744`), and the `agent_settled` handler (`:334`), which is the whole contract |
| `lib.ts` (849) | Pure logic with **zero imports**: `parseArgs` (`:180`, the one place verify mode is decided), `detectCompletion` (`:264`), fingerprinting, prompt rendering, verdict parsing, and `decideVerificationTransition` (`:628`) |
| `gate-agent.ts` (99) | `resolveGateAgent` (`:68`) reads `agents/<name>.md` via `agentsDir()` and returns `{chain, tools, promptBody}`. It is the one seam both gates use |
| `gate.ts` (251) | Static gate (`oracle`): `captureBaseline` (`:108`), `withChainEnv` (`:70`), `runGate` |
| `runtime-gate.ts` (320) | Runtime gate (`verifier`, `RUNTIME_TIMEOUT_MS` 600 s `:61`, `parseRuntimeVerdict` `:74`). The docker-run recipe is *prompt text* for the verifier. This code never runs the tests itself |
| `image.ts` (612) | `ensureImage` (`:513`): project profile and digest, web detection, Dockerfile synthesis, base-image build. Docker is used only for `image inspect`/`version`/`build` |
| `lib.test.ts` | The only suite (it also imports `index.js` for `GATE_FALLBACK_MODEL`) |

## THE SETTLE HANDLER (`index.ts:334-405`), in order

1. Bail while `stopping`/`awaitingDecision`/`verifying`. Yield if `ctx.hasPendingMessages()`.
2. If `lastStop` is `aborted`, stop as cancelled. If it is `error`, stop as error.
3. Progress accounting (`fingerprint`/`isProgress`) runs **before** the completion check.
4. Completion: `detectCompletion` looks only at the last `COMPLETION_TAIL_CHARS` = 600 (`lib.ts:54`).
   It requires the tag (or a documented near-miss) as the sign-off. Prose such as "Done." never matches.
5. Stall: `stallCount >= STALL_LIMIT` (4). Before that, one *nudge*, which is only reworded continuation text
   (`renderContinuation(state, stalled)`), not a handler. **No `agent_before_settle` guard exists here.**
   That guard is kanban's alone.
6. Cap: `iteration >= maxIterations` (default 25) calls `askToContinue`. Otherwise `dispatchContinuation`.

Continuations go through `setTimeout(…, 0)` inside a `try/catch` (a throw in a timer exits pi) with
`expandPromptTemplates: false`. They are guarded by a state-snapshot check and the 30 s `DISPATCH_TIMEOUT_MS` watchdog.

## THE GATES

- Static runs first and short-circuits on any non-approve. Runtime runs only for `runtime|both`.
  `DEFAULT_MAX_VERIFICATIONS` = 3 (`lib.ts:348`). The static timeout is 180 s (`lib.ts:351`).
- `inconclusive` is a first-class verdict. It **stops the loop** and never approves. The causes include no Docker
  daemon, no manifest and an unbuildable image (`image.ts:518-554`).
- The gate children are headless `piExecutable() -p --no-session --model fallback/auto --tools …`, with the chain
  set as `PI_FALLBACK_CHAIN` by `withChainEnv`. Never pass `--provider` or `--no-extensions`, because the serving
  provider is `litellm.ts`, which is an extension. If an agent file has no `model`, the fallbacks are `oracle` →
  `openai/gpt-5.6-sol` and `verifier` → `anthropic/claude-opus-5`.
- Images: the base is `ralph-verify/base:latest` (`image.ts:89`), built on demand from
  `agentDir()/docker/verify-base.Dockerfile`. The project image is `ralph-verify/<slug>:<16-hex sha256>` over
  manifests, lockfiles, the shipped Dockerfile and the web flag. Synthesized Dockerfiles go to
  `agentDir()/verify-images/<slug>/` and never into the verified tree. A project that ships its own Dockerfile
  never pulls the browser base.

## CONVENTIONS (local)

- This is the only extension that spawns pi children **directly** (`pi.exec`), not through `subagent-herdr`.
  It imports only `childFallbackChain` from that extension (`gate-agent.ts:32`). The chain grammar,
  `CHAIN_ENV` and `FALLBACK_MODEL_REF` come from `../model-fallback/lib.js`.
- `withChainEnv` mutates `process.env` and **restores the previous value** rather than deleting it, because a
  loop running inside a delegated child inherits that child's chain. It is not reentrant, so gates must run one at a time.
- The `verifying` latch is cleared in `finally` (`index.ts:432-434`). If it is not, the loop wedges.
- Gate agents come from `agentsDir()`, so under a `/agent quant` switch the gate has no reviewer or verifier to use.

## COMMANDS

```sh
bun test agent/extensions/ralph-loop/lib.test.ts
cd agent/extensions/ralph-loop && ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
```

## ANTI-PATTERNS

- Un-anchoring the completion match. The opening prompt *names* the tag, so an `includes` match fires on iteration 1.
  Test the short acknowledgement directly, because padded tests give false confidence.
- Accepting prose ("Done.") as completion. On the other side, rejecting documented near-misses of the tag is what
  made agents loop forever upstream.
- Re-prompting after `aborted`, or letting a loop survive `session_start`.
- Widening oracle's tools to get behavioural proof. Use the runtime gate.
- Gating only the first claim. The repair after a rejection needs auditing most.
- Letting gate wording affect the stall fingerprint, or resetting `stallCount` on new audit info.
- Letting the verifier write a test to create evidence, or dropping `:ro` mounts. Redirect writes to `/tmp`.
- Reporting a broken harness (missing interpreter or dev dependency) as FAIL. It is INCONCLUSIVE.
- Trusting a green unit suite for a user-facing UI goal. The UI must be driven.
- `captureBaseline` (`gate.ts:114`) calls `pi.exec("git", …)` **without `gitEnv()`**, which is a known gap.
  Do not copy it.
