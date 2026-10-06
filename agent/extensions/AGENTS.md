# agent/extensions — the local pi extensions pi auto-loads at startup

Every top-level `*.ts` here is one independent extension (the inventory below is the list —
the count is whatever `ls agent/extensions/*.ts` says, not a number restated in prose);
`lib/` is the shared, pi-free helper layer. `ralph-loop/`, `subagent-herdr/` and
`model-fallback/` have their own AGENTS.md.

## WHERE TO LOOK

| File | Registers / owns |
|---|---|
| `ask-user.ts` | `questionnaire` tool — TUI option list + free-text fallback, `executionMode: "sequential"` so two questions cannot open at once |
| `changed-files.ts` | `/changed-files`, `/diff` — session change widget; tracks `write`/`edit` inputs *and* `git status --porcelain` on turn end |
| `display-file.ts` | `display_file` tool — spawns the platform opener detached, then checks for a non-zero exit instead of faking success |
| `dynamic-prompt.ts` | No tool. Hooks `before_agent_start` and **returns `{ systemPrompt }`, replacing pi's default prompt entirely** with runtime-discovered agents/tools/skills/context |
| `firecrawl-cli.ts` | No tool, no command. Loads `agent/.env` so `FIRECRAWL_API_URL` reaches the real `process.env`, where the `firecrawl` CLI (run via `bash`) can see it — the librarian's research path. Also sets `FIRECRAWL_NO_UPDATE_CHECK`/`_NO_TELEMETRY` when unset, so a registry banner cannot land inside an agent's `<result>`. Reports a missing URL and returns rather than throwing: pi must start without the research stack |
| `git-hooks.ts` | No tool. Self-arms `core.hooksPath` and runs `scripts/setup-deps.sh` at startup; swallows every failure |
| `init.ts` | `/init` — local deterministic tiering (score > 15 create, >= 8 candidate, `--max-depth` default 3; root 50–150 lines, nested 30–80), then hands the model a brief |
| `litellm.ts` | `registerProvider("litellm")` — model catalog, per-token + cache costs, `contextWindow`, thinking-level maps |
| `model-fallback/` | `registerVirtualModel("fallback/auto")` + `/fallback-chain` — on an error, route the retry to the **next** model in a chain, then hand the following request back to the original. One full lap of the chain is one logical retry. Consumed by the orchestrator (settings), delegated children (`PI_FALLBACK_CHAIN`) and both ralph-loop gates. Own AGENTS.md |
| `sessions.ts` | `/sessions` — resumable session list from pi's own `SessionManager.list()`; no JSONL re-parsing |
| `thinking-indicator.ts` | No tool. Live spinner (alt+t) + `setHiddenThinkingLabel` transcript record |
| `todo.ts` | `todo` tool + `/todos` — in-session checklist as a `belowEditor` widget. State replays from tool-result `details` on the current branch, so no file and no lock. Also holds the turn open on `agent_before_settle` while items are still pending/in-progress, injecting a `custom_message` nudge — once per distinct list state, and only on `outcome: "completed"` |
| `auto-update/` | `/update` + `pi_update` tool — version check on `session_start`, at most every 4h |
| `trade-journal/` | `trade_journal` tool — journal in `~/.agentic-trading/journal/` (`AGENTIC_TRADING_JOURNAL` overrides). Modes `record`/`read`/`stats`/`dupes`. Mechanics only — judgment belongs to the `technical-analysis` skill's agents, and the tool is gated on that skill being active |
| `lib/dotenv.ts` | The single `agent/.env` parser; `requireEnv(name, purpose)` throws *named* |
| `lib/layout.ts` | Resolves the agent dir, plus the named paths with more than one caller. **Never throws** — falls back to `~/.pi/agent`. Single-owner segments live with their owner, not here (`subagent-runs/` → `subagent-herdr/rundir.ts`; `docker/`, `verify-images/` → `ralph-loop/image.ts`) |
| `lib/agents.ts` | The single agent-frontmatter parser (`discoverAgents`, `discoverSkillAgents`, `mergeAgents`, `parseAgentFile`) — reads both `agents/*.md` and `skills/<category>/<skill>/agents/*.md`. Also owns the frontmatter *list* grammar (`extractStringList`, `frontmatterOf`), which `skill-activation.ts` imports rather than re-implementing |
| `lib/skill-tree.ts` | Where skills live on disk (`findSkills`, `categoryFromPath`, `SkillLocation`) — the single walker of `skills/<category>/<skill>/`, mirroring pi's rule that a dir holding `SKILL.md` is a skill root. The three readers below it each did their own one-level `readdir` once, and nesting broke all three *silently* |
| `lib/skill-categories.ts` | Which category a skill belongs to (`groupByCategory`, `categoryFor`, `CATEGORY_ORDER`, `PACKAGE_SKILL_CATEGORIES`) — path wins for a local skill, a name-keyed map covers the vendored package skills, and an unmapped one degrades to `other` rather than vanishing |
| `lib/skill-activation.ts` | Which skills are live this session (`SkillActivation`, `skillsInPrompt`, `isSkillLoad`, `gateTools`, `parseOwnedTools`, `skillDirFromPath`, `loadSkillToolOwners`) — the inference behind skill-gated tools and agents |
| `lib/todo.ts` | The `todo` reducer — `applyOp` is pure and never mutates a past snapshot. Also owns the forgetting guards: `unfinished`, `nudgeFor`, `progressSignature` (settle-time reminder + its dedupe key) and `demotedBy` (the item a `start` silently knocked back to pending) |
| `lib/trade-journal-store.ts` | The single journal markdown grammar (`parseDay`, `renderDay`, `recordObservations`, `mergeObservations`, `findDuplicates`, `summarize`) — same format the journal agents hand-edit |
| `lib/widget.ts` | `fitLines`, `fittedWidget`, `row`, `frame`, `cachedByWidth` — the measuring seam |

## CONVENTIONS

- **A skill can own tools and subagents, gated on being loaded.** A skill declares
  `tools: <name>` in its `SKILL.md` frontmatter and ships agents in
  `skills/<skill>/agents/*.md`; `dynamic-prompt.ts` withholds both until that skill is
  active. Ownership is opt-in and one-directional — an unclaimed tool is always offered, so
  adding the key to one skill cannot hide another's tool. A gated tool also withholds its
  `promptGuidelines`: pi folds those into the prompt only while the tool is in the active
  set, so gating the tool and gating its advice are the same act.
- **Skill activation is inferred, not reported, and the inference is load-bearing.**
  Re-probed against the installed pi (1.0.0): there is still **no `skill_invoke` event**,
  and `systemPromptOptions.skills` is the **catalogue** (every discovered skill, every
  turn), *not* the loaded set — reading it as "loaded" silently ungates everything. The two
  real signals are a `/skill:x` invocation, which pi expands into `before_agent_start`'s
  `event.prompt` as `<skill name=… location=…>`, and a model-invoked skill, which appears
  only as a `read_skill`/`read` call on a `SKILL.md`. `lib/skill-activation.ts` owns both.
- **`selectedTools` in `before_agent_start` gates the current run; `pi.setActiveTools` is
  the only way to change the next one.** `selectedTools` is mutable and is what the model
  is offered. `registerTool` has no counterpart, and `setActiveTools`/`getActiveTools` are
  **absent from that event's `ctx`** — verified, not assumed. They exist on the **`pi` API
  object** (`core/agent-session.js`), and the distinction is load-bearing: a model-invoked
  skill is only observable as a `tool_call`, which fires *after* this run's gate ran, and
  pi snapshots the tool set once per run. Without a `pi.setActiveTools` refresh the model
  reads a `SKILL.md` telling it to call a tool that stays invisible for the rest of the
  run. `dynamic-prompt.ts` does that refresh **additively** — it only ever *adds* ungated
  tools, so it cannot withdraw one another extension relies on.
- **Activation is sticky for the session.** A loaded skill's guidance stays in context, so
  its tools must not vanish next turn. `session_start` also fires with reason `reload` and
  `fork`, which keep the same transcript, so the handler resets on `new`/`resume` only. A
  tool lingering is better than one disappearing mid-task.
- **The two agent consumers gate differently on purpose.** `dynamic-prompt.ts` advertises a
  skill's agents only while the skill is active. The spawn path in `subagent-herdr/index.ts`
  deliberately does **not** gate: it runs with no session context, so a skill loaded
  mid-session would otherwise be invisible and fail a delegation the model was just told to
  make. A global `agents/*.md` name always wins a collision, so a skill cannot silently
  redirect `worker`. Skill identity is the **directory** name — frontmatter `name` may differ.
- **A subdirectory is invisible to pi unless it has `index.ts`.** That is what makes `lib/`
  safe for `*.test.ts`. Adding a bare `foo.ts` at this level ships it into every session
  whether you meant to or not.
- **`lib/` modules import no pi package.** `node:*` only. They are imported from extension
  *top-level* code, which runs before pi can report an error, so a throw or a missing alias
  there is a startup failure with no diagnostic. Hence `layout.ts` never throws and
  `dotenv.ts` defers `requireEnv` to call time.
- **Import siblings with a `.js` extension** (`./lib/widget.js`) even though the file is
  `.ts` — that is what pi's jiti loader resolves, and what `moduleResolution: "bundler"`
  expects.
- **Emit a prompt section only for a tool that exists.** `dynamic-prompt.ts` emits its
  questionnaire section only when the `questionnaire` tool is actually in `selectedTools`.
  It carried a second such branch for the `plan` tool long after the `plan` extension was
  removed in `7a54a3b`; "dead but harmless" was the wrong reading, because the branch still
  *described* a tool with ops (add/status/revise/seed/attach/archive/show) that no longer
  exists, and any future tool named `plan` would have silently inherited that stale
  contract. It is gone — a new planning tool brings its own prompt section. The same rule now
  covers *agents*: the `## Quality Pass` section (which tells the orchestrator to have its own
  implementation work graded by `reviewer`/`verifier`, the gate a `worker` already ends its run
  with) is built from the agents actually in `agentInventory`, so an install missing one names
  only the other, and one missing both omits the section entirely. The verifier-only
  image-tag caveat is nested inside that same gate, because container guidance for an absent
  agent is the identical bug one level down. `## Plan Before You Implement` is gated the
  same way on `planner`, and its grading paragraph is nested one level further inside the
  grader gate — a section promising a review that no present agent can perform is the same
  unobeyable instruction. When the planner is absent the two numbered planning steps (Core
  Responsibilities 2, Decision Framework 3) fall back to their generic wording, because a
  step pointing at a section that was never emitted is a dangling reference. All three agent
  sections carry a **second** conjunct: `hasSubagent`. `agentInventory` is read off
  `agents/*.md` on disk and says nothing about whether `subagent-herdr` loaded (it imports
  `../model-fallback/lib.js` and typebox; the documented signature when that resolution
  breaks is a silent load failure), so without it a session with no spawn tool still got a
  prompt mandating delegation. A roster is not a capability unless the tool that spawns it
  exists.
- **The planner and the graders are one rule, stated in two places on purpose.**
  `## Plan Before You Implement` pushes multi-file/multi-step work through `planner` (a skip
  is allowed but must be *named*, the same stance the skill catalogue takes) and declares
  that a `planner` plan obliges a `reviewer`+`verifier` pass over the implementation;
  `## Quality Pass` owns how to write those two tasks, and the planning section defers to it
  rather than restating it. Both carve out the **same** exception — a `worker` has already
  passed its own diff through those graders, so neither section may order a re-grade. They
  must also agree on *conditionality*: the verifier is qualified on the change being
  runtime-testable in Quality Pass and in `agents/worker.md`, so the planning section states
  it as conditional too rather than absolute, or the model launches a container run for a
  prose edit. If you change either the exemption or that condition, change it in both: the
  contradiction is invisible at a glance because the two sections sit ~50 lines apart in the
  builder.
- **Every grader phrase is derived from the `graders` roster, including the number.** The
  prose around the list ("launch them", "those two tasks", "these graders"/"these agents")
  was hardcoded plural while the list itself was computed, so a reviewer-only or
  verifier-only install was told to launch two agents concurrently beside a code block
  holding one call. **Both** sections had it; the planning one was fixed first and its
  comment then claimed the module was safe, which left the identical live bug next door
  looking deliberate. Anything number-sensitive branches on `graders.length` (`plural`), and
  the `ROLE` table holds each role *without* the agent's name so the name is printed exactly
  once per sentence. `Grader` is a closed union (`'reviewer' | 'verifier'`) rather than
  `string`, so the table must cover every member and a third grader fails to compile at the
  one place that must be updated — the earlier `?? fallback` was unreachable and only looked
  like safety. Note `dynamic-prompt.ts` is in **no `tsc -p` scope**, so that typing is only
  enforced when pi loads the file or you point a hand-rolled tsconfig at it.
- **`todo.ts` is not the old `plan` extension and must not grow into it.** `todo` is a
  different tool, and now that the stale `plan` prompt branch is deleted nothing re-arms it.
  What `plan` was is worth knowing first: a plan file (`agent/plans/<key>.jsonl`) plus a
  live kanban Board in its own pane, which needed a *second* writer and then a cross-process
  lock that could still lose updates, and whose last commits before deletion were all
  stale-card fixes. `todo` avoids all of it by having no file — state replays from
  tool-result `details` on the current branch, so there is exactly one writer and a rewind
  cannot leave a stale list describing work the agent no longer remembers doing.
- **A boundary handler must not gate on the `canContinue` it was handed.** `todo.ts`'s
  `agent_before_settle` guard returns `{ continue: true }` with a `custom_message` draft to
  stop the agent abandoning an unfinished list. At handler time `event.context.canContinue`
  is `false` — the last message is still the assistant's — and pi only recomputes it *after*
  committing the drafts (`_runBeforeSettleBoundary`), where the committed message is what
  makes the continuation legal. Reading that flag as a precondition is a silent no-op that
  looks like a safety check. Pair any such continuation with a cap keyed on real progress
  (`progressSignature`): an unconditional one re-asks forever and wedges the session.
- **A test may import a top-level extension; only the test *file* is barred from this
  directory.** The constraint is where the file sits, not what it may reach: pi auto-loads
  every top-level `*.ts`, so a `*.test.ts` here imports `bun:test` and kills startup. A test
  in `lib/` is invisible to pi and can import `../<extension>.js` freely —
  `lib/sessions.test.ts` has done exactly that all along, and all 11 top-level extensions
  import cleanly from there (measured, 11/11). Export the pure logic and test it in place.
- **Keep pure logic out of `index.ts`.** Every subdirectory extension splits `lib.ts` (pure,
  tested) from `index.ts` (session wiring). `trade-journal/` is the worked example. But
  become a directory when it improves the module's **interface** or **locality** — not
  merely to make testing possible, which it never gated. This file claimed the opposite for
  several revisions, and the cost was not a bad refactor: it was ~2,400 lines of pure logic
  (the whole orchestrator prompt in `dynamic-prompt.ts`, `/init`'s tiering thresholds, the
  porcelain decoder in `changed-files.ts`) left untested because the cheap option looked
  illegal and the legal option looked expensive.
- **Not every action method exists during extension load.** `registerTool`,
  `registerProvider`, `registerVirtualModel` and `registerMcpServer` are **queued**
  (`core/extensions/loader.js`), but `getSettings`, `setActiveTools`, `getCommands`,
  `setModel` and `getThinkingLevel` are *throwing stubs* until the runner binds its context
  — calling one at load kills the extension with "Extension runtime not initialized", which
  is how `model-fallback` first failed. Configuration a registration depends on must be read
  from disk (`model-fallback/settings.ts`); anything else belongs inside a handler, where
  the live value is also the correct one after `/reload`.
- **A model reference is not a `provider/id` pair.** pi resolves one by trying canonical
  `provider/id`, then provider+id, then an unambiguous **bare id**
  (`core/model-resolver.js` `findExactModelReferenceMatch`). That last step is the only
  reason `model: qwen/qwen3.8-27b` works in an agent file: the whole string is one litellm
  model *id*. Any new reader of a model reference must keep it whole and resolve it the same
  way — splitting on a slash invents a provider that does not exist.

## COMMANDS

```sh
cd subagent-herdr && npm install   # the one dir with npm dependencies (dev-only: tsc 5.9.3, @types/node 22)
```

There are now **four** `tsc -p` scopes: `subagent-herdr`'s five sources (`rundir.ts` was
reached transitively for a while but not *declared*, which left the module owning a
cross-process grammar outside the stated scope),
`model-fallback`'s three, `ralph-loop`'s six, and the top-level `agent/extensions` scope
(all top-level `*.ts` plus `lib/*.ts`, excluding tests). What matters here is what they do **not** cover: the
subdirectory extensions' internal modules are each in their own scope; `auto-update/` and
`trade-journal/` remain untyped. Beware the skew when you check one by
hand: the `@earendil-works/*` in `~/node_modules` is 0.75.4 against a running pi of 1.0.2,
so typechecking against it reports phantom errors for APIs that exist only in the live
bundle (for example `registerMcpServer`, from `core/mcp-servers.js`). 0.75.4 has
no virtual-model API at all, so `model-fallback` cannot typecheck against it even nominally.
Point `types`/aliases at the running pi's `dist/` instead, as `model-fallback/tsconfig.json`
does with a `paths` entry — that is the pattern to copy, and `Model<Api>` comes from
`@earendil-works/pi-ai`, not from `pi-coding-agent`.

## ANTI-PATTERNS

- Putting a `*.test.ts` at this level — it imports `bun:test`, pi auto-loads it, and pi
  will not start.
- Doing real work at module top level. Register inside the default export; anything eager
  becomes a startup hazard for *every* session, and the failure surfaces before pi can
  report which extension caused it.
- Moving an extension into a subdirectory *just* to test it. Pure logic at this level is
  testable from `lib/` already (see CONVENTIONS) — split for interface or locality, or not
  at all.
- Building a shared wrapper over operations that merely *look* alike. The four `git` call
  sites (`init.ts:72`, `changed-files.ts:166`, `ralph-loop/gate.ts:159`, `git-hooks.ts:43`)
  have four different error contracts **because they do four different jobs**: a 64 MB
  repo-wide grep, a latency-capped status, an async baseline snapshot that treats failure as
  empty evidence, and a startup probe that needs exit codes and must swallow everything. A
  `lib/git.ts` would either expose all four policies — an interface as complex as its
  implementation — or erase distinctions callers rely on, and forcing the two `pi.exec`
  callers onto synchronous `execFileSync` would block pi's event loop at startup. Two
  adapters exist; no shared *behaviour* does, so the seam is hypothetical. What is worth
  owning is the **porcelain grammar**, and only `changed-files.ts` has one —
  `gate.ts` keeps `git status --porcelain` deliberately opaque as baseline evidence, so it
  is not a second parser.

(The repo-wide rules those imply — one parser per format, widgets measure through
`lib/widget.ts` — are in the root CONVENTIONS.)
