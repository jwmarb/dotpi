# ralph-loop — completion-loop commands with optional verification gates

Owns `/ralph-loop`, `/ulw-loop`, and `/loop-stop`. Re-prompts the agent every time it
stops, until it declares completion by emitting `<promise>DONE</promise>`, the iteration
cap is reached, it stalls, or the user stops it. A port of oh-my-openagent's
`/ralph-loop` + `/ulw-loop` (itself a take on Geoffrey Huntley's "Ralph Wiggum"
`while :; do cat PROMPT.md | agent; done`); upstream has since retired both for `/goal`.

## WHERE TO LOOK

| File | Owns |
|---|---|
| `lib.ts` | All pure logic: arg parsing, completion + stall detection, prompt rendering |
| `index.ts` | Session wiring: the `agent_settled` state machine, observation hooks, the three commands |
| `gate.ts` | The **static** gate — resolves the oracle definition, captures the git baseline, runs the headless audit child |
| `runtime-gate.ts` | The **runtime** gate — runs the `verifier` agent, which executes the project's checks in Docker |
| `image.ts` | Container image provisioning: prefers the project's Dockerfile, else synthesises one extending the reference base; keyed by manifest hash |
| `lib.test.ts` | The pure parts, both gate protocols, image + web detection (135 tests) |

The loop edge is `agent_settled` — the only event that fires *after* auto-retry and
auto-compaction, so it means "the agent genuinely stopped", not "the agent paused". Per
settle: abort/error stops; **progress accounting runs before the completion branch**, so a
turn that only re-emits the tag without fixing anything still counts as a stall; a
completion tag in the message tail runs the active gates; `stallCount >= 4` stops and the
first stall nudges once; hitting `maxIterations` asks the user to extend.

## THE `--verify` GATES

Off by default. `--verify` runs **both**; `=static`, `=runtime`, `=off` narrow it. A
completion claim is accepted only if every active gate agrees. They run in sequence,
static first, and a static rejection short-circuits — no point spending a container run to
prove a defect already found. `maxVerifications` (default 3) bounds gate rounds per loop.

**Static** (`gate.ts`, `oracle`) *reads* the repo: goal, starting `HEAD` + `git status`,
touched paths, and the agent's claim. Catches "runs green but does the wrong thing". ~20s.

**Runtime** (`runtime-gate.ts`, `verifier`) *executes* the project's own tests in Docker.
Catches "reads fine but does not run". Minutes cold, ~20s once the image is cached:

```
docker run --rm --network none --memory=2g --pids-limit=256 \
  -v <project>:/project:ro -w /project \
  --user "$(id -u):$(id -g)" -e HOME=/tmp <image> <test command>
```

All four safety properties are measured, not assumed: network blocked, writes to the mount
refused, the **live working tree** visible (so edits need no rebuild), real exit codes
propagated. Artifacts go to a per-audit host scratch dir mounted at `/artifacts`, because
`/project` is read-only by design.

Images are three layers: the tracked reference base
(`../../docker/verify-base.Dockerfile`, tag `ralph-verify/base:latest` — Node 24 + Chrome +
the pinned `agent-browser` CLI, ~30s warm, 1.5 GB); the project image, preferring the
project's own `Dockerfile` and otherwise synthesised (web projects `FROM` the base, non-web
use a plain language image); and the live tree, bind-mounted `:ro` at run time. The tag is
`ralph-verify/<slug>:<digest>` where the digest hashes manifests, lockfiles **and** the web
flag, so a dependency change or a web/non-web flip forces a rebuild and nothing else does
(measured: 15s cold, 0.0s warm). Web detection reads `package.json` dependency *names* — a
declaration of intent, unlike the presence of an `index.html`; malformed JSON falls back to
a quoted-name scan rather than to `false`, since over-detecting costs a bigger image while
under-detecting silently skips every UI check. **If no image can be produced the verdict is
`inconclusive` and the loop stops** — "I could not run it" must never read as "it works".

For web projects the verifier drives the real app cheapest-signal-first (`agent-browser
snapshot -i` → `get text` → `click` → `a11y` → `screenshot --annotate`) and then `read`s
the PNG to judge it visually. Measured end to end: a discount note styled `#0d8` on `#0b7`
passed `npm test` and `is visible`, and was still caught — axe reported `[serious]
color-contrast`, the screenshot read as "a faint smudge rather than text", and the verifier
computed **1.40:1 against the required 4.5:1** before returning `<verdict>FAIL</verdict>`.

## CONVENTIONS (local)

- **Continuations dispatch from `setTimeout(0)`, never inline.** Not for the obvious
  reason: `agent_settled` is emitted inside `_runAgentPrompt`'s `finally` *after*
  `_isAgentRunActive` is already false, so `prompt()` would **not** refuse the call — it
  would re-enter `_runAgentPrompt` inside the outer run's own `finally`, nesting agent runs
  and emitting a nested `agent_settled` per level. Do not "simplify" the timeout away.
- **The dispatched send is wrapped in `try`/`catch`.** `pi.sendUserMessage` calls
  `assertActive()` synchronously, which throws once the runtime is invalidated (`/reload`,
  new session, switch). An uncaught throw from a timer callback hits pi's
  `uncaughtException` handler, which calls `process.exit(1)` — a loop must never be able to
  kill the session.
- **Timer callbacks check `state !== snapshot`, not just `state`.** `startLoop` replaces
  `state` wholesale, so a null check alone lets a superseded loop fire into its successor.
- **Assistant text comes from `message_end`; file paths come from
  `tool_execution_start`.** `ctx.sessionManager` is a `ReadonlySessionManager` without
  `getLastAssistantText()`, and `tool_execution_end` carries `result`, not `args`.
- **Observation buffers reset on `agent_start`**, the real turn boundary — not only when
  the loop dispatches, or turns the loop skipped leave stale tools/files behind and a stale
  `lastStop` reads as completion a settle late.
- **Continuations are sent with `expandPromptTemplates: false`**, so a goal beginning with
  `/` is never re-dispatched as a slash command.
- **The cap always holds.** Reaching it asks; it never silently becomes unbounded
  (upstream's `N/unbounded` drift is the failure this avoids).
- **`WRITE_TOOLS` lists only tools this install really registers** (`write`, `edit`,
  `undo_last_edit`). `bash` counts as a write only when the command *looks* like one
  (`WRITING_SHELL`), because heredocs and `sed -i` are how a lot of work reaches disk.
- **The gate fail-STOPS, never fail-opens.** A timeout, non-zero exit, unavailable model or
  unparseable reply all become `inconclusive`, halting the loop without declaring success.
  Fail-open makes an outage indistinguishable from approval; fail-closed-by-continuing
  feeds infrastructure errors to the agent as if they were code defects.
- **`gate.ts` never throws**, and `verifyCompletion` clears the `verifying` latch in a
  `finally` — a stuck latch would wedge the loop permanently. That latch is deliberately
  distinct from `awaitingDecision`; conflating them makes cancellation and status ambiguous.
- **The audit request crosses as a file, not argv**, and goal + claim are fenced and
  labelled as data, so a goal cannot instruct the auditor to approve itself.
- **`--no-extensions` must never be passed to the gate child.** The provider serving the
  gate model is itself a local extension (`litellm.ts`), so disabling discovery makes the
  model unresolvable (`Model "…" is ambiguous across providers` — measured).
- **The pi binary comes from `process.argv[1]`, not `PATH`** — that is the install owning
  the alias map and the litellm provider (see the root AGENTS.md note on the pre-rename copy).
- **The two gates use different verdict vocabularies** (`APPROVE/REJECT` vs `PASS/FAIL`), so
  one gate's reply can never be silently read by the other's parser.
- **Exit codes must not be piped.** `docker run ... | tail` reports `tail`'s status, always
  `0`; the verifier prompt spells out `out=$(...); code=$?` because this mistake silently
  turns every failing suite into a pass.
- **Nothing is ever written into the user's project.** A generated Dockerfile goes to
  `agent/verify-images/<slug>/` (gitignored), never into the tree being verified.
- **Every COPY source in a generated Dockerfile must be glob-shaped.** Docker fails the
  whole build on a missing non-glob source and most projects have exactly one lockfile —
  measured: `COPY ... yarn.lock ...` dies with `"/yarn.lock": not found`. See
  `lockfilePatterns`.

## COMMANDS

```sh
bun test agent/extensions/ralph-loop/lib.test.ts   # 135 tests
```

```
/ralph-loop <goal> [--verify[=static|runtime|both]] [--max-iterations=N] [--promise=WORD]
/ulw-loop   <goal>      # same loop, plus the ultrawork intensity directive
/loop-stop              # stop the running loop
```

(The reference base image's build command is in the root COMMANDS section.)

## ANTI-PATTERNS

- **Un-anchoring the completion match.** This is the bug that made the first version
  useless: the opening prompt *names* the tag, so the likeliest first reply quotes it
  ("I'll emit `<promise>DONE</promise>` when finished") — an unanchored `includes` match
  then reported "complete" on iteration 1, before any work. The tag must be the
  **sign-off**: at the end of the message, modulo decoration. Guard tests that pad with
  600+ filler chars give false confidence; test the short acknowledgement directly.
- **Matching the tag too strictly, either.** Upstream's exact-string match is why agents
  that wrote "Task complete" looped forever (upstream #2489, #1233). Documented near-misses
  of the *tag* are accepted — the anchoring above is what keeps that safe.
- **Accepting prose as completion.** "I'm done" / "Done." must not stop the loop, or the
  sentinel means nothing: `DONE` is a signal, `Done.` is English.
- **Re-prompting after an abort**, or letting a loop outlive its session. `stopReason:
  "aborted"` is the user pressing escape; `session_start` cancels, because a loop from the
  previous transcript would be prompting into a context it never saw.
- **Calling the gate "verification" without qualification.** oracle is read-only and
  forbidden from running tests, so the static gate audits *code and evidence*, not runtime
  behaviour. That is exactly why `inconclusive` exists. If you need behavioural proof, use
  the runtime gate — do not quietly widen oracle's tool list.
- **Gating only the first claim, or only "substantive" turns.** The state most in need of
  audit is the *repair*. Conditioning on `wrote` would be worse than useless: it is
  heuristic, and a goal can legitimately be satisfied by analysis or by proving no change
  is needed.
- **Resetting `stallCount` because the audit supplied new information**, or putting
  oracle's prose into the stall fingerprint. The turn either made observable progress or it
  did not; the fingerprint measures *agent* activity, and letting reviewer wording vary it
  would manufacture fake progress.
- **Letting the verifier write a test to create evidence.** Authoring the test makes it the
  author, destroying the independence that makes its verdict worth anything. No executable
  evidence is INCONCLUSIVE, not an invitation.
- **Dropping `:ro` because a tool wants to write.** Redirect the write instead
  (`-p no:cacheprovider`, `COVERAGE_FILE=/tmp/...`, `TMPDIR=/tmp`). A gate that can mutate
  what it is verifying is not a gate.
- **Treating a broken harness as a failing goal.** A missing interpreter or uninstalled dev
  dependency means the *evidence* is invalid — INCONCLUSIVE, not FAIL. Feeding it back as a
  code defect sends the agent chasing a phantom.
- **Generating a Dockerfile when the project ships one**, or pulling the browser base for a
  project with no UI (1.5 GB and a Chrome download to test a library — `detectsWebProject`
  exists to avoid this).
- **Believing a green suite about a UI goal.** The measured case: unit tests exit 0, `is
  visible` says `true`, and the feature is invisible to users. If the goal is user-facing,
  the UI must be driven — a passing suite is a regression guard, not evidence.
