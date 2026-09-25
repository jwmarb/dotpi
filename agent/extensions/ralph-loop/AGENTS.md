# ralph-loop — completion-loop commands

Owns `/ralph-loop`, `/ulw-loop`, and `/loop-stop`. Re-prompts the agent every
time it stops, until it declares completion by emitting
`<promise>DONE</promise>`, the iteration cap is reached, it stalls, or the user
stops it.

A port of oh-my-openagent's `/ralph-loop` + `/ulw-loop` (itself a hook-driven
take on Geoffrey Huntley's "Ralph Wiggum" `while :; do cat PROMPT.md | agent;
done`). Upstream has since retired both in favour of `/goal`.

## WHERE TO LOOK

| File | Owns |
|---|---|
| `lib.ts` | All pure logic: arg parsing, completion + stall detection, prompt rendering — side-effect free, unit-testable |
| `index.ts` | Session wiring: the `agent_settled` state machine, observation hooks, the three commands |
| `gate.ts` | The **static** gate: resolves the oracle definition, captures the git baseline, runs the headless audit child |
| `image.ts` | Container image provisioning: prefers the project's Dockerfile, else synthesises one extending the reference base; keyed by manifest hash |
| `../../docker/verify-base.Dockerfile` | **Tracked** reference base image: browser + agent-browser CLI. Project images `FROM` this when the project has a UI |
| `runtime-gate.ts` | The **runtime** gate: runs the `verifier` agent, which executes the project's checks in Docker |
| `lib.test.ts` | The pure parts, both gate protocols, image + web detection (135 tests) |

## HOW IT WORKS

`agent_settled` is the loop edge — it is the only event that fires *after*
auto-retry and auto-compaction have settled, so it means "the agent genuinely
stopped", not "the agent paused". On each settle:

1. abort/error → stop (never re-prompt over a user's escape)
2. progress accounting → stall counter. **Runs before the completion branch**, so
   a turn that only re-emits the tag without fixing anything still counts as a
   stall.
3. completion tag in the message tail → with `--verify=off`, stop; otherwise run
   the active gates (static, then runtime — see below)
4. `stallCount >= 4` → stop; first stall → nudge once
5. `iteration >= maxIterations` → ask the user whether to extend
6. otherwise → inject the continuation and let it run again

## THE `--verify` GATES

Off by default. `--verify` runs **both** gates; `--verify=static`, `=runtime`, or
`=off` narrow it. A completion claim is only accepted if every active gate does.

**Static** (`gate.ts`, the `oracle` agent) *reads* the repository: goal, starting
`HEAD` + `git status`, touched paths, and the agent's own claim. Catches "runs
green but does the wrong thing". ~20 s.

**Runtime** (`runtime-gate.ts`, the `verifier` agent) *executes* the project's own
tests in Docker. Catches "reads fine but does not run". Minutes on a cold build,
~20 s once the image is cached.

They run in sequence, static first, and a static rejection short-circuits — no
point spending a container run to prove a defect already found.

### The container

```
docker run --rm --network none --memory=2g --pids-limit=256 \
  -v <project>:/project:ro -w /project \
  --user "$(id -u):$(id -g)" -e HOME=/tmp <image> <test command>
```

All four safety properties are measured, not assumed: network blocked, writes to
the mount refused, the **live working tree** visible (so edits need no rebuild),
and real exit codes propagated.

### The image

Three-layer scheme:

1. **The reference base** (`agent/docker/verify-base.Dockerfile`, tag
   `ralph-verify/base:latest`) — **tracked in this repo**, not generated. Node 24 +
   Chrome + the `agent-browser` CLI. Built on demand, then shared by every web
   project on the machine. ~30 s warm, 1.5 GB.
2. **The project image** — `image.ts` prefers the project's own `Dockerfile`; else
   synthesises one. Web projects `FROM ralph-verify/base`; non-web projects use a
   plain language image, because pulling a browser for a library with no UI is
   1.5 GB of nothing.
3. **The live tree** — bind-mounted `:ro` at run time, so code edits need no
   rebuild.

Web detection reads `package.json` dependency *names* (`next`, `vite`, `react`,
`vue`, `svelte`, `astro`, ...) — a declaration of intent, unlike the presence of an
`index.html`. Malformed JSON falls back to a quoted-name scan rather than to
`false`: over-detecting costs a bigger image, under-detecting silently skips every
UI check.

The tag is `ralph-verify/<slug>:<digest>` where the digest hashes the manifests,
the lockfiles, **and** the web flag. Change a dependency or flip web/non-web → new
tag → rebuild. Otherwise instant reuse (measured: 15 s cold, 0.0 s warm).

If no image can be produced — no Docker, no recognised manifest, failed build —
the verdict is `inconclusive` and the loop stops. "I could not run it" must never
read as "it works".

### UI verification

For web projects the verifier drives the real app, cheapest signal first:

```
agent-browser snapshot -i     # a11y tree with @e1 refs — text, not pixels
agent-browser get text "#x"   # DOM assertions (white-box)
agent-browser click @e2       # interact as a user (black-box)
agent-browser a11y            # axe-core: contrast, labels, alt text — deterministic
agent-browser screenshot --annotate /artifacts/ui.png
```

Then it `read`s the PNG and judges it visually (opus-5 is vision-capable; verified
it reports rendered content accurately).

**Measured end to end:** a checkout page whose discount note was styled `#0d8` on
`#0b7` passed `npm test` (exit 0) and `is visible` (`true`), and was still caught —
axe reported `[serious] color-contrast - #note`, the screenshot read as "a faint
smudge rather than text", and the verifier independently computed **1.40:1 vs the
required 4.5:1** before returning `<verdict>FAIL</verdict>`.

Artifacts go to a per-audit host scratch dir mounted at `/artifacts`, so
`/project` stays read-only.

### Budget

`maxVerifications` (default 3) bounds gate rounds per loop, and in `both` mode one
round can cost two model calls plus a container run. A rejection also consumes a
normal iteration, so the existing cap keeps bounding the work.

## CONVENTIONS (local)

- **Continuations dispatch from `setTimeout(0)`, never inline.** Not for the
  obvious reason: `agent_settled` is emitted inside `_runAgentPrompt`'s `finally`
  *after* `_isAgentRunActive` is already false, so `prompt()` would **not** refuse
  the call — it would re-enter `_runAgentPrompt` inside the outer run's own
  `finally`, nesting agent runs and emitting a nested `agent_settled` per level.
  Yielding to the macrotask queue lets the outer run unwind. Do not "simplify"
  the timeout away.
- **The dispatched send is wrapped in `try`/`catch`.** `pi.sendUserMessage` calls
  `assertActive()` synchronously, which throws once the runtime is invalidated
  (`/reload`, new session, switch). An uncaught throw from a timer callback hits
  pi's `uncaughtException` handler, which calls `process.exit(1)` — a loop must
  never be able to kill the session.
- **Timer callbacks check `state !== snapshot`, not just `state`.** `startLoop`
  replaces `state` wholesale, so a null check alone would let a superseded
  loop's continuation fire into its successor.
- **Assistant text comes from `message_end`, not the session manager.**
  `ctx.sessionManager` is a `ReadonlySessionManager` and does **not** expose
  `getLastAssistantText()` — that is on the full session/RPC surface only.
- **File paths come from `tool_execution_start`.** `tool_execution_end` carries
  `result`, not `args`.
- **Observation buffers reset on `agent_start`**, the real turn boundary — not
  only when the loop dispatches. Otherwise turns the loop skipped leave stale
  tools/files behind and a stale `lastStop` can be read as completion a settle
  late.
- **Continuations are sent with `expandPromptTemplates: false`**, so a goal
  beginning with `/` is never re-dispatched as a slash command.
- **The cap always holds.** Reaching it asks; it never silently becomes
  unbounded (upstream's `N/unbounded` drift is the failure this avoids).
- **`WRITE_TOOLS` lists only tools this install really registers** (`write`,
  `edit`, `undo_last_edit`). `bash` counts as a write only when the command
  *looks* like one (`WRITING_SHELL`), because heredocs and `sed -i` are how a lot
  of work reaches disk; without that, read-only-looking turns cause false stalls.
- **The gate fail-STOPS, never fail-opens.** A timeout, a non-zero exit, an
  unavailable model, or an unparseable reply all become `inconclusive`, which
  halts the loop without declaring success. Fail-open would make an outage
  indistinguishable from approval; fail-closed-by-continuing would feed
  infrastructure errors to the agent as if they were code defects and burn the
  audit budget on something it cannot fix.
- **The audit request crosses as a file, not argv.** A goal is arbitrary user
  text; a multi-kilobyte prompt with newlines and quotes has no business on a
  command line. Goal and claim are additionally fenced and labelled as data, so a
  goal cannot instruct the auditor to approve itself.
- **`gate.ts` never throws.** `runGate` resolves a verdict on every path, and
  `verifyCompletion` clears the `verifying` latch in a `finally` — a stuck latch
  would wedge the loop permanently.
- **The gate has its own latch (`verifying`), not `awaitingDecision`.** Two
  distinct states; conflating them would make cancellation and status ambiguous.
- **`--no-extensions` must never be passed to the gate child.** The provider that
  serves the gate model is itself a local extension (`litellm.ts`), so disabling
  discovery makes the model unresolvable (`Model "…" is ambiguous across
  providers` — measured).
- **The runtime gate never runs tests on the host.** A test suite is arbitrary
  code; the whole point of the sandbox is that nobody read it first. Docker only,
  `--network none`, `:ro` mount, non-root, memory and pid capped.
- **Nothing is ever written into the user's project.** A generated Dockerfile goes
  to `agent/verify-images/<slug>/` (gitignored), never into the tree being
  verified.
- **The image digest hashes manifests, not sources.** The tree is bind-mounted at
  run time, so code edits need no rebuild; a dependency change must force one.
- **The two gates use different verdict vocabularies** (`APPROVE/REJECT` vs
  `PASS/FAIL`), so one gate's reply can never be silently read by the other's
  parser. Both map onto the same internal `approve/reject/inconclusive`.
- **Exit codes must not be piped.** `docker run ... | tail` reports `tail`'s status
  — always `0`. The verifier prompt spells out `out=$(...); code=$?` because this
  mistake silently turns every failing suite into a pass.
- **The reference Dockerfile is tracked; generated ones are not.** Every line of
  `agent/docker/verify-base.Dockerfile` encodes a measured behaviour (Node >= 24,
  `sudo` needed by `install --with-deps`, Chrome landing in root's `$HOME`, the
  versioned Chrome directory). Regenerating it from scratch rediscovers all four
  the hard way. Change it only against a real container.
- **agent-browser is pinned.** It is pre-1.0 and moving fast, and the base image
  depends on install-path behaviour that is not a documented API. Bump
  `AGENT_BROWSER_VERSION` only together with a re-verification.
- **Every COPY source in a generated Dockerfile must be glob-shaped.** Docker fails
  the whole build on a missing non-glob source, and most projects have exactly one
  lockfile — measured: `COPY ... yarn.lock ...` dies with `"/yarn.lock": not found`.
  See `lockfilePatterns`.
- **`/artifacts` is where evidence goes.** `/project` is read-only by design, so
  screenshots and reports need a separate writable mount. It is world-writable
  because a project Dockerfile may declare its own `USER`.
- **The pi binary comes from `process.argv[1]`, not `PATH`.** That is the install
  owning the alias map and the litellm provider; a `PATH` lookup can find a
  different one (see the root AGENTS.md note on the pre-rename copy).

## COMMANDS

```sh
bun test agent/extensions/ralph-loop/lib.test.ts   # 135 tests

# Rebuild the tracked reference base image (also built on demand by the gate):
docker build -f agent/docker/verify-base.Dockerfile -t ralph-verify/base:latest agent/docker/
```

Usage:

```
/ralph-loop <goal> [--verify[=static|runtime|both]] [--max-iterations=N] [--promise=WORD]
/ulw-loop   <goal>      # same loop, plus the ultrawork intensity directive
/loop-stop              # stop the running loop

# Gates are off by default. --verify runs both; narrow it if you want one.
/ralph-loop --verify         Fix the failing parser tests   # audit + container tests
/ralph-loop --verify=runtime Fix the failing parser tests   # container tests only
/ralph-loop --verify=static  Rename the config keys         # audit only (no tests to run)
/ulw-loop   --verify         Refactor the session layer
```

## ANTI-PATTERNS

- **Un-anchoring the completion match.** This is the bug that made the first
  version of this module useless: the opening prompt *names* the tag, so the
  likeliest first reply quotes it ("I'll emit `<promise>DONE</promise>` when
  finished") — an unanchored `includes`-style match then reported "complete" on
  iteration 1, before any work. The tag must be the **sign-off**: at the end of
  the message, modulo decoration. Guard tests that pad with 600+ filler chars
  give false confidence; test the short acknowledgement directly.
- **Matching the completion tag too strictly, either.** Upstream's exact-string
  match is why agents that wrote "Task complete" looped forever (upstream #2489,
  #1233). Documented near-misses of the *tag* are accepted — the anchoring above
  is what keeps that safe.
- **Accepting prose as completion.** "I'm done" / "Done." must not stop the loop,
  or the sentinel means nothing. Hence the bare-word form is case-sensitive and
  rejects trailing punctuation: `DONE` is a signal, `Done.` is English.
- **Re-prompting after an abort.** `stopReason: "aborted"` is the user pressing
  escape; continuing would be the extension fighting the human.
- **Letting a loop outlive its session.** `session_start` cancels it: a loop
  from the previous transcript would be prompting into a context it never saw.
- **Calling the gate "verification" without qualification.** oracle is read-only
  and forbidden from running tests or builds, so the gate audits *code and
  evidence*, not runtime behaviour. That is exactly why `inconclusive` exists: "I
  cannot confirm this without executing it" is a correct answer. If you ever need
  behavioural proof, add a separate verifier definition that may run bounded
  non-interactive tests — do not quietly widen oracle's tool list from here.
- **Gating only the first claim, or only "substantive" turns.** The state most in
  need of audit is the *repair*, so every claim gets audited. Conditioning on
  `wrote` would be worse than useless: it is heuristic, and a goal can legitimately
  be satisfied by analysis or by proving no change is needed.
- **Resetting `stallCount` because the audit supplied new information.** The
  agent's turn either made observable progress or it did not. A rejection prompt
  may help it escape, but it must not erase the history — otherwise an agent that
  re-claims completion forever never trips the stall guard.
- **Putting oracle's prose into the stall fingerprint.** The fingerprint measures
  *agent* activity; letting reviewer wording vary it would manufacture fake
  progress.
- **Letting the verifier write a test to create evidence.** Authoring the test
  makes it the author, which destroys the independence that makes its verdict
  worth anything. No executable evidence is INCONCLUSIVE, not an invitation.
- **Dropping `:ro` because a tool wants to write.** Redirect the write instead
  (`-p no:cacheprovider`, `COVERAGE_FILE=/tmp/...`, `TMPDIR=/tmp`). A gate that
  can mutate what it is verifying is not a gate.
- **Treating a broken harness as a failing goal.** A missing interpreter or an
  uninstalled dev dependency means the *evidence* is invalid — INCONCLUSIVE, not
  FAIL. Feeding it back as a code defect sends the agent chasing a phantom.
- **Generating a Dockerfile when the project ships one.** The project's own
  definition is the authoritative answer; a synthesised one is the fallback.
- **Believing a green suite about a UI goal.** The measured case: unit tests exit 0,
  `is visible` says `true`, and the feature is invisible to users. If the goal is
  user-facing, the UI must be driven — a passing suite is a regression guard, not
  evidence the feature works.
- **Pulling the browser base for a project with no UI.** 1.5 GB and a Chrome
  download to test a library. `detectsWebProject` exists to avoid this.
