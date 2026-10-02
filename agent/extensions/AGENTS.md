# agent/extensions — the local pi extensions pi auto-loads at startup

Each of the 12 top-level `*.ts` is one independent extension; `lib/` is the shared,
pi-free helper layer. `ralph-loop/`, `subagent-herdr/` and `model-fallback/` have their own
AGENTS.md.

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
| `mcp-gateway.ts` | No tool, no command. Registers the `litellm-gateway` MCP server with pi's built-in MCP extension via `pi.registerMcpServer()`. Exists only because the builtin validates `mcp.json` `url` with `URL.canParse()` *before* expansion, so a `${LITELLM_MCP_URL}` placeholder cannot live there. Servers, transport, OAuth, tool naming and `/mcp` are all the builtin's |
| `sessions.ts` | `/sessions` — resumable session list from pi's own `SessionManager.list()`; no JSONL re-parsing |
| `thinking-indicator.ts` | No tool. Live spinner (alt+t) + `setHiddenThinkingLabel` transcript record |
| `todo.ts` | `todo` tool + `/todos` — in-session checklist as a `belowEditor` widget. State replays from tool-result `details` on the current branch, so no file and no lock. Also holds the turn open on `agent_before_settle` while items are still pending/in-progress, injecting a `custom_message` nudge — once per distinct list state, and only on `outcome: "completed"` |
| `auto-update/` | `/update` + `pi_update` tool — version check on `session_start`, at most every 4h |
| `trade-journal/` | `trade_journal` tool — journal in `~/.agentic-trading/journal/` (`AGENTIC_TRADING_JOURNAL` overrides). Modes `record`/`read`/`stats`/`dupes`. Mechanics only — judgment belongs to the `technical-analysis` skill's agents, and the tool is gated on that skill being active |
| `lib/dotenv.ts` | The single `agent/.env` parser; `requireEnv(name, purpose)` throws *named* |
| `lib/layout.ts` | Where repo files live. **Never throws** — falls back to `~/.pi/agent` |
| `lib/agents.ts` | The single agent-frontmatter parser (`discoverAgents`, `discoverSkillAgents`, `mergeAgents`, `parseAgentFile`) — reads both `agents/*.md` and `skills/<skill>/agents/*.md`. Also owns the frontmatter *list* grammar (`extractStringList`, `frontmatterOf`), which `skill-activation.ts` imports rather than re-implementing |
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
  questionnaire and planning sections only when the `questionnaire` / `plan` tools are
  actually in `selectedTools`. The `plan` extension was removed in `7a54a3b`, so the
  planning branch is currently dead but harmless.
- **`todo.ts` is not the old `plan` extension and must not grow into it.** That dead branch
  gates on a tool named `plan`; `todo` is a different tool and deliberately does not re-arm
  it. What `plan` was is worth knowing first: a plan file (`agent/plans/<key>.jsonl`) plus a
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
- **Keep pure logic out of `index.ts`.** Every subdirectory extension splits `lib.ts` (pure,
  tested) from `index.ts` (session wiring). `trade-journal/` is the worked example of *why*:
  its mode logic wanted tests, and a `*.test.ts` cannot sit beside a top-level extension.
  Logic that deserves a test is the signal to become a directory, not a bigger file.
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
cd subagent-herdr && npm install   # the one dir with npm dependencies (dev-only: tsc 5.9.3)
```

There are now **three** `tsc -p` scopes: `subagent-herdr`'s four sources,
`model-fallback`'s three, and `ralph-loop`'s five (added when the gates gained a fallback
chain — a change to a spawn argv deserves a typecheck). What matters here is what they do **not** cover: `lib/` and every
top-level `*.ts` are in no typecheck scope at all — nothing type-checks `dynamic-prompt.ts`,
`litellm.ts` or `mcp-gateway.ts` but pi loading them. Beware the skew when you check one by
hand: the `@earendil-works/*` in `~/node_modules` is 0.75.4 against a running pi of 1.0.0,
so typechecking `mcp-gateway.ts` there reports a phantom "`registerMcpServer` does not exist
on type `ExtensionAPI`" — it exists in the live bundle (`core/mcp-servers.js`). 0.75.4 has
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
- Growing a top-level `*.ts` past the point where its logic wants tests. That logic cannot
  live at this level (see above) — it is the signal to move the extension into a
  subdirectory and split `lib.ts` from `index.ts`.

(The repo-wide rules those imply — one parser per format, widgets measure through
`lib/widget.ts` — are in the root CONVENTIONS.)
