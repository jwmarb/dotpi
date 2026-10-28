# agent/extensions — the local pi extensions pi auto-loads at startup

Every top-level `*.ts` here is one independent extension (the inventory below is the list —
the count is whatever `ls agent/extensions/*.ts` says, not a number restated in prose);
`lib/` is the shared, pi-free helper layer, inventoried below rather than in its own
AGENTS.md — a second file there is the duplication this hierarchy exists to avoid.
`ralph-loop/`, `subagent-herdr/` and `model-fallback/` have their own AGENTS.md; this tier's
only config file is `tsconfig.json` (the top-level typecheck scope — no `package.json`, no
scripts, so every command below comes from the repo root).

## WHERE TO LOOK

| File | Registers / owns |
|---|---|
| `ask-user.ts` | `questionnaire` tool — TUI option list + free-text fallback, `executionMode: "sequential"` so two questions cannot open at once |
| `changed-files.ts` | `/changed-files`, `/diff` — session change widget (moves into the kanban side pane when that is open, via `pi.events` `changed-files:update` / `kanban:pane`); tracks `write`/`edit` inputs *and* `git status --porcelain` on turn end |
| `display-file.ts` | `display_file` tool — spawns the platform opener detached, then checks for a non-zero exit instead of faking success |
| `dynamic-prompt.ts` | No tool. Hooks `before_agent_start` and **returns `{ systemPrompt }`, replacing pi's default prompt entirely** with runtime-discovered agents/tools/skills/context. The handler only loads (skill activation, tool owners, `delegationRoster`, lineage) and applies the gated `selectedTools`; the pure, synchronous `promptInputs` does the gating and assembles `buildOrchestratorPrompt`'s parameter object, and both are tested from `lib/dynamic-prompt.test.ts`. Each advice section is capability-gated: `## Kanban Board` on `hasKanban` and `## Asking the User` on `hasQuestionnaire` (both from `promptInputs`), `## Available Agents` on `hasSubagent` ∩ a non-empty roster, `## Plan Before You Implement` on `hasPlanner`, `## Delegate the Implementation` on `canDelegate` with the agent name on `hasWorker`, `## Quality Pass` on `graders`, `## Available Skills` on a non-empty `skillInventory`. The four roster-derived gates are `hasPlanner`, `canDelegate`, `hasWorker`, `graders` — all four require `hasSubagent` **and** `!isSubagent` (each derives it itself; do not remove one to "match" a doc sentence: on a host where `callable_by` already filters the child rosters, the deletion is invisible until a roster edit makes a child print it). `## Available Agents` is the one **roster-derived** section printed *without* `!isSubagent`, so a child renders its own spawnable roster; the tool-gated `## Asking the User`, `## Kanban Board` and inventory-gated `## Available Skills` are likewise not `!isSubagent`-gated, and the board reaches a child only if the tool is offered to one (`kanban/index.ts` returns early on `PI_SUBAGENT_RUN_ID`, which is why `hasKanban` needs no conjunct) |
| `firecrawl-cli.ts` | No tool, no command. Loads `agent/.env` so `FIRECRAWL_API_URL` reaches the real `process.env`, where the `firecrawl` CLI (run via `bash`) can see it — the librarian's research path. Also sets `FIRECRAWL_NO_UPDATE_CHECK`/`_NO_TELEMETRY` when unset, so a registry banner cannot land inside an agent's `<result>`. Reports a missing URL and returns rather than throwing: pi must start without the research stack |
| `git-hooks.ts` | No tool. Self-arms `core.hooksPath` and runs `scripts/setup-deps.sh` at startup; swallows every failure |
| `herdr-agent-state.ts` | **Not in git** — herdr installs and overwrites this file itself (`.gitignore` excludes it); auto-loaded like every top-level `*.ts`, a fresh clone's first copy arrives from herdr's next start |
| `pi-bolt-host.ts` | No tool. Under Pi-Bolt only: gives pi-blackhole's inline-compaction adapter a resolvable host (stand-in `@earendil-works/pi-coding-agent` package in `agent/cache/pi-bolt-host/` re-exporting the running `AgentSession`; `argv[1]` pointed at it during extension load, restored at `session_start`). Must load before `settings.json` packages, which a top-level extension always does |
| `init.ts` | `/init` — local deterministic tiering (score > 15 create, >= 8 candidate, `--max-depth` default 3; root 50–150 lines, nested 30–80), then hands the model a brief |
| `litellm.ts` | `registerProvider("litellm")` — model catalog, per-token + cache costs, `contextWindow`, thinking-level maps |
| `model-fallback/` | `registerVirtualModel("fallback/auto")` + `/fallback-chain` — on an error, route the retry to the **next** model in a chain, then hand the following request back to the original. One full lap of the chain is one logical retry. Consumed by the orchestrator (settings), delegated children (`PI_FALLBACK_CHAIN`) and both ralph-loop gates. Own AGENTS.md |
| `sessions.ts` | `/sessions` — resumable session list from pi's own `SessionManager.list()`; no JSONL re-parsing |
| `sleep.ts` | `sleep` tool — pauses for a required timeout in seconds (0 < timeout <= 3600), then returns an ordinary result so the turn **resumes** (it must never return `terminate: true` — that ended the run when the timer fired and stranded the work); wakes early (`status: "woken"`) when `ctx.hasPendingMessages()` goes false→true, polled every `WAKE_POLL_MS` — edge-triggered so a follow-up already queued at start (delivered only once tools stop) cannot make every sleep wake instantly; abortable — an aborted wait settles promptly with `isError: true`; `executionMode: "sequential"`; pure `validateTimeout` tested from `lib/sleep.test.ts` |
| `thinking-indicator.ts` | No tool. Live spinner (alt+t) + `setHiddenThinkingLabel` transcript record |
| `todo.ts` | `todo` tool + `/todos` — **a spawned subagent's** checklist as a `belowEditor` widget; the factory returns unless `PI_SUBAGENT_RUN_ID` is set, and `subagent-herdr` appends `todo` to every child's `--tools`. State is in memory, rebuilt from tool-result `details` on `session_start`/`session_tree` only (replaying per op lost parallel updates). No settle guard: a child's completion handshake fires on `agent_end`, before `agent_before_settle` could continue it |
| `kanban/` | `kanban` tool + `/kanban` — **the orchestrator's** board, replacing `todo` for it. Columns backlog → in_progress → blocked → review → done; cards link subagent runs (advisory badges, never auto-moved). `index.ts` is the single writer (snapshots in tool-result `details` or `kanban-state` custom entries, in-memory authoritative, digest repair at `turn_end`/`agent_settled`) and holds the settle guard; `board.ts` (shebang, bun) is the read-only side-pane viewer of a projection in `$XDG_RUNTIME_DIR/pi-kanban/`; `lib.ts` is pure; `runs.ts` reads `meta.json` through `rundir.ts`. Opens a side pane on every non-reload session start inside herdr's TUI, widget fallback otherwise |
| `auto-update/` | `/update` + `pi_update` tool — version check on `session_start` via memoised `getUpdateStatus()` (current/available/error; cached 4h on `globalThis` so `/reload` keeps it; shared with `startup-fetch.ts`) |
| `startup-fetch.ts` | `/fetch`, `/builtin-header` — neofetch-style startup header (`ctx.ui.setHeader`): image via `catimg` from the gitignored `agent/images/` folder — `settings.json` `startupFetch.mode` `fixed`(`image`)/`cycle`/`random`/`off`, selection in `lib/startup-images.ts`, state in `images/.startup-fetch-state.json`, one pick per pi process (kept across `/reload` unless `mode`/`image` changed; warnings once per pick; skipped in subagent panes via `PI_SUBAGENT_RUN_ID`), `/fetch` advances, `/fetch list`; `startupFetch.style` (`renderArt`): `block`/`half` (catimg), `quad`/`sextant`/`octant`/`braille`/`ascii` (chafa, `scripts/install-chafa.sh`), `pixels` (Kitty only, downscaled via `resizeImage`, anchor row text-free; iTerm2 falls back) — missing tool/protocol falls back to `half`; `/fetch style [name]` and `/fetch mode [name]` write `settings.json` (picker when no name); `height` in rows, default 13, width capped at 40 columns; animated GIFs draw their first frame; binaries found on PATH or `~/.local/bin`; with no image (or empty folder), quietly the ASCII distro logo in brand truecolor (`lib/distro-logos.ts`, picked from os-release `ID`/`ID_LIKE`, Tux fallback; `NO_COLOR` forces plain ASCII), user@host, pi version + update status (`auto-update` `getUpdateStatus`, shared memo — one `npm view` per 4h; "unknown" when offline), cwd + git branch, model (a `fallback/auto` selection reads `fallback/auto → <primary>`: the chain `model-fallback` registered, read from `model-fallback/served.ts` rather than settings, resolved by its `computeDisplay`, walked past unreachable entries by its own `resolve()`), OS/kernel/uptime/shell/terminal/CPU/memory. Pairs with `quietStartup: true` in `settings.json`, which hides the built-in resource listing; ASCII distro logos in `lib/distro-logos.ts` are generated with ascii-silhouettify from Simple Icons SVGs; GPU(s) via `lspci`/`system_profiler`/CIM (async, memoised per process) and disk usage via `statfs` (`/`, plus cwd's fs when its `dev` differs); an **Updates** block replaces pi's two boxed startup notices — `captureNotices()` wraps `InteractiveMode.prototype.showNewVersionNotification`/`showPackageUpdateNotification` at load time (pi's own pi.dev release check + package check, as of startup), falling back to pi's boxes when no panel is listening (e.g. `/builtin-header`) or the methods moved; auto-update's npm check still fills the pi row if pi's check is silent |
| `trade-journal/` | `trade_journal` tool — journal in `~/.agentic-trading/journal/` (`AGENTIC_TRADING_JOURNAL` overrides). Modes `record`/`read`/`stats`/`dupes`. Mechanics only — judgment belongs to the `technical-analysis` skill's agents, and the tool is gated on that skill being active |
| `lib/dotenv.ts` | The single `agent/.env` parser; `requireEnv(name, purpose)` throws *named* |
| `lib/layout.ts` | Resolves the agent dir, plus the named paths with more than one caller. **Never throws** — falls back to `~/.pi/agent`. Single-owner segments live with their owner, not here (`subagent-runs/` → `subagent-herdr/rundir.ts`; `docker/`, `verify-images/` → `ralph-loop/image.ts`) |
| `lib/runtime.ts` | Which pi binary is running: script pi vs a compiled Bun executable (Pi-Bolt). `runningCompiled()`, `piExecutable()` (for re-spawning pi), `BE_BUN_ENV` (`BUN_BE_BUN=1` makes Pi-Bolt act as `bun`), `piShimDir()`/`prependPathCommand()` (make a herdr pane's bare `pi` this executable). Pure but for the shim's symlink; tested in `lib/runtime.test.ts` |
| `lib/agents.ts` | The single agent-frontmatter parser (`discoverAgents`, `discoverSkillAgents`, `mergeAgents`, `parseAgentFile`) — reads both `agents/*.md` and `skills/<category>/<skill>/agents/*.md`. `delegationRoster` is the one composition of those plus `spawnableAgents` that both agent consumers call: `.all` (merged, global wins) and `.spawnable` (what this lineage may spawn). Also owns the frontmatter *list* grammar (`extractStringList`, `frontmatterOf`), which `skill-activation.ts` imports rather than re-implementing |
| `lib/skill-tree.ts` | Where skills live on disk (`findSkills`, `categoryFromPath`, `SkillLocation`) — the single walker of `skills/<category>/<skill>/`, mirroring pi's rule that a dir holding `SKILL.md` is a skill root. The three readers below it each did their own one-level `readdir` once, and nesting broke all three *silently* |
| `lib/skill-categories.ts` | Which category a skill belongs to (`groupByCategory`, `categoryFor`, `CATEGORY_ORDER`, `PACKAGE_SKILL_CATEGORIES`) — path wins for a local skill, a name-keyed map covers the vendored package skills, and an unmapped one degrades to `other` rather than vanishing |
| `lib/skill-activation.ts` | Which skills are live this session (`SkillActivation`, `skillsInPrompt`, `isSkillLoad`, `gateTools`, `parseOwnedTools`, `skillDirFromPath`, `loadSkillToolOwners`) — the inference behind skill-gated tools and agents |
| `lib/todo.ts` | The `todo` reducer — `applyOp` is pure and never mutates a past snapshot. Also owns `demotedBy` (the item a `start` silently knocked back to pending) — the module's one drift-catcher. It has no settle guard (subagent-only; the orchestrator's guard is `kanban/lib.ts`) |
| `lib/trade-journal-store.ts` | The single journal markdown grammar (`parseDay`, `renderDay`, `recordObservations`, `mergeObservations`, `findDuplicates`, `summarize`) — same format the journal agents hand-edit |
| `lib/git-env.ts` | `gitEnv()` / `GIT_LOCATION_VARS` — strips `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`… for any git spawn against a cwd; used by `init.ts`, `changed-files.ts`; tested in `lib/git-env.test.ts` |
| `lib/widget.ts` | `fitLines`, `fittedWidget`, `row`, `frame`, `cachedByWidth` — the measuring seam |

## CONVENTIONS

- **A skill can own tools and subagents, gated on being loaded.** A skill declares
  `tools: <name>` in its `SKILL.md` frontmatter and ships agents in
  `skills/<skill>/agents/*.md`; `dynamic-prompt.ts` withholds both until that skill is
  active. Ownership is opt-in and one-directional — an unclaimed tool is always offered, so
  adding the key to one skill cannot hide another's tool. A gated tool also withholds its
  `promptGuidelines`: pi folds those into **its own** prompt (its `rules` section) only while the
  tool is in the active set, so gating the tool and gating its advice are the same act. Under this
  extension that advice reaches nobody — see the `## Kanban Board` bullet below.
- **Skill activation is inferred, not reported, and the inference is load-bearing.**
  Re-probed against the installed pi (1.2.0; 1.4.0 now — re-check): there is still **no `skill_invoke` event**,
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
  tools, so it cannot withdraw one another extension relies on. The gate itself is computed
  by the pure `promptInputs` (which returns a gated *copy*); the handler is what assigns it
  back to `event.systemPromptOptions.selectedTools`, and only when some skill owns a tool.
- **Activation is sticky for the session.** A loaded skill's guidance stays in context, so
  its tools must not vanish next turn. `session_start` also fires with reason `reload` and
  `fork`, which keep the same transcript, so the handler resets on `new`/`resume` only. A
  tool lingering is better than one disappearing mid-task.
- **The two agent consumers gate differently on purpose.** Both read the roster through
  `lib/agents.ts`'s `delegationRoster`, and differ only in its `activeSkills` option.
  `dynamic-prompt.ts` passes the active set, so it advertises a skill's agents only while the
  skill is active. The spawn path in `subagent-herdr/index.ts` omits it, so it deliberately
  does **not** gate: it runs with no session context, so a skill loaded
  mid-session would otherwise be invisible and fail a delegation the model was just told to
  make. A global `agents/*.md` name always wins a collision, so a skill cannot silently
  redirect `worker`. Skill identity is the **directory** name — frontmatter `name` may differ.
- **A subdirectory is invisible to pi unless it has `index.ts`.** That is what makes `lib/`
  safe for `*.test.ts`. Adding a bare `foo.ts` at this level ships it into every session
  whether you meant to or not.
- **`lib/` modules import no pi package** — `node:*` only, with one exception: `widget.ts:46` imports `@earendil-works/pi-tui` (`visibleWidth`, `truncateToWidth`), never `pi-coding-agent`. They are imported from extension
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
  `## Kanban Board` is gated the same way on a `hasKanban` flag computed in `promptInputs` from the
  gated `selectedTools`, or failing that the snippet inventory — never as a `toolInventory.some(name === 'kanban')`
  inside the builder: the inventory is snippet-filtered. A field on `buildOptions` is checked against
  the builder's real parameter type at every call site (`Parameters<typeof buildOrchestratorPrompt>[0]`);
  a bare name match inside the builder is not
  (that is how the `plan` section outlived its tool). `hasKanban` carries no `isSubagent` conjunct —
  `kanban/index.ts`'s factory returns early for children, so the tool is never offered there and the
  flag is naturally false. Sections that *name an agent* gate one level finer: `canDelegate` (spawn
  tool + non-empty roster + not a child) for the section, `hasWorker` for the name. A roster with no
  `worker` gets the same push naming "the roster agent whose role fits the step", because naming an
  agent the roster does not have is the same unobeyable instruction one level down. That naming is
  qualified by a **joint** condition — the row must fit the role *and* show `write`/`edit` — and it
  is stated in `implName` itself, so the Execute step (prompt line 12, far above the section) carries
  it too: a role-only test there denotes `planner` ("Writes no code") in the real fleet minus `worker`,
  and a capability-only test denotes `spiker`, which has both tools and a throwaway-sandbox role.
  The writer count in that sentence is derived (`writerRows`; `tools: []` counts, since it renders
  as "all"), never a hardcoded quantifier, and the step-shaped `Delegate when:` bullets carry
  "and a row does both" in the no-`worker` arm.
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
  The board and the roster join the same rule set. `## Plan Before You Implement` gained a
  planner→board clause gated on the **conjunction** `hasKanban && hasPlanner`, nested as a **sibling**
  of the `graders.length > 0` block and never inside it: a planner-without-graders install is a real
  shape (it has its own test), and a board clause nested in the grader block vanishes there. The first
  cut nested it, and the pre-existing "no dangling comma" test caught it through its `\n\n\n`
  assertion — the pinned formatting rule is load-bearing, not cosmetic. `## Delegate the
  Implementation` owns *which work is yours and which is the child's*; `## Quality Pass` owns *how to
  write a pass*. The worker self-grade exemption is now stated in **three** sections (planning,
  delegation, Quality Pass), and every number-sensitive phrase in all three stays derived from
  `graders.length` / `plural`. Change the exemption in all three. The premise behind it — that only
  `worker` ends its own run with a grading pass — is pinned by the test "only worker declares a
  self-grading pass" in `subagent-herdr/lib.test.ts`, so an agent file that starts self-grading breaks it.
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
  like safety.
- **Neither `todo.ts` nor `kanban/` is the old `plan` extension, and neither may grow into
  it.** What `plan` was is worth knowing first: a plan file (`agent/plans/<key>.jsonl`) plus a
  live kanban Board in its own pane, which needed a *second* writer and then a cross-process
  lock that could still lose updates, and whose last commits before deletion were all
  stale-card fixes. Both successors avoid all of it by keeping canonical state in the session
  branch — one writer, and a rewind cannot leave a stale board describing work the agent no
  longer remembers doing. `kanban/board.ts` is a *viewer*: it reads a disposable projection
  and writes nothing. **Do not give it an inbox, a marker file or any other write path** —
  that is the second writer again; user edits go through `/kanban`, which runs in the
  extension. And do not rebuild either list from the branch inside `execute`: pi persists a
  parallel tool batch only after the whole batch, so every call replays the same stale
  branch and the last snapshot erases the rest (measured on `todo`).
- **The settle guard and `## Kanban Board` are one rule, stated in two places on purpose.**
  `kanban/lib.ts`'s `nudgeFor` enforces the accounting at end-of-turn; `dynamic-prompt.ts`'s
  `## Kanban Board` states it up front. `kanban/index.ts`'s per-tool `promptGuidelines` look like a
  third copy, but they **never arrive**: pi stores them in `toolGuidelines`, which feeds only pi's own
  `rules` section, and this extension returns `{ systemPrompt }` → `forceSystemPrompt`, so
  `buildSystemPromptState` returns `{ content }` with no sections and the forced-prompt projection drops
  every system message pi built (probed: a sentinel passed through `toolGuidelines`/`toolInventory` is
  absent from a build, while the flat `guidelines` field does print under `## Guidelines`). So the
  section is the **only** copy the model reads; prose in the tool's `promptGuidelines` (a separate field
  from its `description`) documents the module for humans — it does not steer behaviour.
  The two copies share the prohibition (`nudgeFor`: "Never move a card just to clear this message";
  the section: "Never move a card to silence the guard") and every disposition **except `review`**.
  The section's accounted list must stay a subset of `actionableCards`' exemptions: `done`,
  `blocked` with a note, a dropped card, a card linked to a run that is still running. `review` is
  **not** exempt — `actionableCards` keeps counting it while nothing else is waiting — so the section
  omits it and `nudgeFor` offers it only while another card waits on a running run. It used to offer
  it flat, which told the model to perform the exact shuffle the guard punishes; the wording and
  `lib.test.ts` now agree with `actionableCards`.
  The prompt must never phrase the rule
  as a way to get past the guard: the guard is answered by doing the work or by moving the card to the
  column that is true, and a section that teaches shuffling converts a real signal into noise the model
  learns to ignore.
- **A boundary handler must not gate on the `canContinue` it was handed.** `kanban/`'s
  `agent_before_settle` guard returns `{ continue: true }` with a `custom_message` draft to
  stop the agent abandoning an unfinished board. At handler time `event.context.canContinue`
  is `false` — the last message is still the assistant's — and pi only recomputes it *after*
  committing the drafts (`_runBeforeSettleBoundary`), where the committed message is what
  makes the continuation legal. Reading that flag as a precondition is a silent no-op that
  looks like a safety check. Pair any such continuation with a cap keyed on real progress
  (`settleSignature`): an unconditional one re-asks forever and wedges the session.
- **A test may import a top-level extension; only the test *file* is barred from this
  directory.** The constraint is where the file sits, not what it may reach: pi auto-loads
  every top-level `*.ts`, so a `*.test.ts` here imports `bun:test` and kills startup. A test
  in `lib/` is invisible to pi and can import `../<extension>.js` freely —
  `lib/sessions.test.ts` has done exactly that all along, and all 14 top-level extensions
  import cleanly from there (measured, 14/14 — including `herdr-agent-state.ts`, which is gitignored). Export the pure logic and test it in place.
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

There are **five** `tsc -p` scopes: `subagent-herdr`'s seven sources (including `run-lifecycle.ts` and `release-ledger.ts`; `rundir.ts` was
reached transitively for a while but not *declared*, which left the module owning a
cross-process grammar outside the stated scope),
`model-fallback`'s three, `ralph-loop`'s six, `kanban`'s four (`board.ts` included), and the top-level `agent/extensions` scope
(all top-level `*.ts` plus `lib/*.ts`, excluding tests — so `dynamic-prompt.ts` **is** covered;
this file claimed the opposite for several revisions). What matters here is what they do
**not** cover: the subdirectory extensions' internal modules are each in their own scope, and
`auto-update/` and `trade-journal/` have no `tsconfig.json` at all, so they remain untyped —
though they still resolve the live bundle at runtime, since with no tsconfig of their own they
inherit this directory's `paths`.

Four of the five scopes carry a `paths` entry aiming `@earendil-works/*` at the running pi's
bundle; `subagent-herdr` is the lone holdout, and because the **nearest** tsconfig wins
outright its paths-less config shadows this directory's mapping rather than inheriting it — so
it resolves the stale `~/node_modules` (0.75.4) instead. It survives that because it imports
`ExtensionAPI` as a **type** only. The skew is real for anything newer: 0.75.4 reports phantom
errors for APIs that exist only in the live bundle (`registerMcpServer`, from
`core/mcp-servers.js` — plausible but not re-measured) and has no virtual-model API at all, so
`model-fallback` could not typecheck against it even nominally. Copy its `paths` entry rather
than re-deriving one, and note `Model<Api>` comes from `@earendil-works/pi-ai`, not from
`pi-coding-agent`. The root AGENTS.md COMMANDS section has the per-scope table and the probe
that measures it — `paths` governs **bun's runtime resolution too**, not just tsc.

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
- Re-adding a settle guard to `todo.ts`/`lib/todo.ts`. A child's completion handshake fires
  on `agent_end` first, so the guard either dies with the pane or keeps editing after the
  parent was told it finished. The orchestrator's guard is `kanban/`.

(The repo-wide rules those imply — one parser per format, widgets measure through
`lib/widget.ts` — are in the root CONVENTIONS.)
