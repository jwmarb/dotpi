# agent/extensions — the local pi extensions pi auto-loads at startup

Each top-level `*.ts` is one independent extension; `lib/` is the shared, pi-free
helper layer. `ralph-loop/` and `subagent-herdr/` have their own AGENTS.md.

## WHERE TO LOOK

| File | Registers / owns |
|---|---|
| `ask-user.ts` | `questionnaire` tool — TUI option list + free-text fallback, `executionMode: "sequential"` so two questions cannot open at once |
| `changed-files.ts` | `/changed-files`, `/diff` — session change widget; tracks `write`/`edit` inputs *and* `git status --porcelain` on turn end |
| `display-file.ts` | `display_file` tool — spawns the platform opener detached, then checks for a non-zero exit instead of faking success |
| `dynamic-prompt.ts` | No tool. Hooks `before_agent_start` and **returns `{ systemPrompt }`, replacing pi's default prompt entirely** with runtime-discovered agents/tools/skills/context |
| `git-hooks.ts` | No tool. Self-arms `core.hooksPath` and runs `scripts/setup-deps.sh` at startup; swallows every failure |
| `init.ts` | `/init` — local deterministic tiering (score > 15 create, >= 8 candidate, `--max-depth` default 3), then hands the model a brief |
| `litellm.ts` | `registerProvider("litellm")` — model catalog, per-token + cache costs, `contextWindow`, thinking-level maps |
| `sessions.ts` | `/sessions` — resumable session list from pi's own `SessionManager.list()`; no JSONL re-parsing |
| `thinking-indicator.ts` | No tool. Live spinner (alt+t) + `setHiddenThinkingLabel` transcript record |
| `todo.ts` | `todo` tool + `/todos` — in-session checklist as a `belowEditor` widget. State replays from tool-result `details` on the current branch, so no file and no lock |
| `auto-update/` | `/update` + `pi_update` tool — version check on `session_start`, at most every 4h |
| `mcp/` | `/mcp status\|list\|refresh`; registers each MCP tool as `mcp__<server>__<tool>`. Docs: its `README.md` |
| `trade-journal/` | `trade_journal` tool — trading journal in `~/.agentic-trading/journal/` (`AGENTIC_TRADING_JOURNAL` overrides). Modes `record`/`read`/`stats`/`dupes`. `index.ts` is wiring; `lib.ts` holds the tested mode logic; the markdown grammar is `lib/trade-journal-store.ts`. Mechanics only — judgment belongs to the `technical-analysis` skill's journal agents. Gated on that skill being active |
| `lib/dotenv.ts` | The single `agent/.env` parser; `requireEnv(name, purpose)` throws *named* |
| `lib/layout.ts` | Where repo files live. **Never throws** — falls back to `~/.pi/agent` |
| `lib/todo.ts` | The `todo` reducer — `applyOp` is pure and never mutates a past snapshot |
| `lib/agents.ts` | The single agent-definition frontmatter parser (`discoverAgents`, `discoverSkillAgents`, `mergeAgents`, `parseAgentFile`) — reads both `agents/*.md` and `skills/<skill>/agents/*.md`. Also owns the frontmatter *list* grammar (`extractStringList`, `frontmatterOf`), which `skill-activation.ts` imports rather than re-implementing |
| `lib/skill-activation.ts` | Which skills are live this session (`SkillActivation`, `skillsInPrompt`, `isSkillLoad`, `gateTools`, `parseOwnedTools`, `skillDirFromPath`, `loadSkillToolOwners`, `clearSkillToolOwnersCache`) — the inference behind skill-gated tools and agents |
| `lib/trade-journal-store.ts` | The single trading-journal markdown grammar (`parseDay`, `renderDay`, `parseDayDocument`, `renderDayDocument`, `recordObservations`, `mergeObservations`, `findDuplicates`, `summarize`) — same format the journal agents hand-edit |
| `lib/widget.ts` | `fitLines`, `fittedWidget`, `row`, `frame`, `cachedByWidth` — the measuring seam |

## CONVENTIONS

- **A skill can own tools and subagents, gated on being loaded.** A skill declares
  `tools: <name>` in its `SKILL.md` frontmatter and ships agents in
  `skills/<skill>/agents/*.md`; `dynamic-prompt.ts` withholds both until that skill is
  active. Ownership is opt-in and one-directional — an unclaimed tool is always offered, so
  adding the key to one skill cannot hide another's tool. A gated tool also withholds its
  `promptGuidelines`: pi folds a tool's guidelines into the prompt only while the tool is in
  the active set, so gating the tool and gating its advice are the same act.
- **Skill activation is inferred, not reported, and the inference is load-bearing.** Probed
  against pi 0.87.1: there is **no `skill_invoke` event**, and
  `systemPromptOptions.skills` is the **catalogue** (all 40 discovered skills, every turn),
  *not* the loaded set — reading it as "loaded" is a bug that silently ungates everything.
  The two real signals are a `/skill:x` invocation, which pi expands into
  `before_agent_start`'s `event.prompt` as `<skill name=… location=…>`, and a model-invoked
  skill, which appears only as a `read_skill`/`read` tool call on a `SKILL.md`.
  `lib/skill-activation.ts` owns both.
- **`selectedTools` in `before_agent_start` is the gate for the current run; `pi.setActiveTools`
  is the only way to change the next one.** `selectedTools` is mutable and is what the model is
  offered. `registerTool` has no counterpart (there is no `unregisterTool`), and
  `setActiveTools`/`getActiveTools` are **absent from that event's `ctx`** — verified, not
  assumed. They do exist on the **`pi` API object** (`agent-session.js` wires them), and that
  distinction is load-bearing: a model-invoked skill is only observable as a `tool_call`, which
  fires *after* this run's gate already ran, and pi snapshots the tool set once per run
  (`createContextSnapshot`, and it sets no `prepareNextTurn`). So without a `pi.setActiveTools`
  refresh the model reads a `SKILL.md` telling it to call a tool that stays invisible for the
  rest of the run. `dynamic-prompt.ts` does that refresh, additively — it only ever *adds*
  ungated tools, so it cannot withdraw one another extension is relying on.
- **Activation is sticky for the session.** A loaded skill's guidance stays in context, so
  its tools must not vanish on the next turn. Only a genuinely new conversation resets the
  set: `session_start` also fires with reason `reload` and `fork`, which keep the same
  transcript, so the handler resets on `new`/`resume` only. A tool disappearing mid-task is
  worse than one lingering.
- **The two agent consumers gate differently on purpose.** `dynamic-prompt.ts` advertises a
  skill's agents only while the skill is active. The spawn path in
  `subagent-herdr/index.ts` deliberately does **not** gate: it runs with no session context,
  so a skill loaded mid-session would otherwise be invisible and fail a delegation the model
  was just told to make. A global `agents/*.md` name always wins a collision, so a skill
  cannot silently redirect `worker`. Skill identity is the **directory** name (`skill.baseDir`,
  or `basename(dirname(filePath))`) — the frontmatter `name` may differ.
- **A subdirectory is invisible to pi unless it has `index.ts`.** That is what makes
  `lib/` safe for `*.test.ts` and `mcp/` loadable. Adding a bare `foo.ts` at this
  level ships it into every session whether you meant to or not.
- **`lib/` modules import no pi package.** `node:*` only. They are imported from
  extension *top-level* code, which runs before pi can report an error, so a throw
  or a missing alias there is a startup failure with no diagnostic. This is why
  `layout.ts` never throws and `dotenv.ts` defers `requireEnv` to call time.
- **Import siblings with a `.js` extension** (`./lib/widget.js`) even though the file
  is `.ts` — that is what pi's jiti loader resolves. So do the `tsconfig`s
  (`moduleResolution: "bundler"`).
- **A feature detected, not assumed.** `dynamic-prompt.ts` emits its
  questionnaire and planning sections only when the `questionnaire` / `plan` tools
  are actually in `selectedTools`. The `plan` extension was removed in `7a54a3b`,
  so the planning branch is currently dead but harmless — do not emit a section
  whose tool may not exist.
- **`todo.ts` is not the old `plan` extension, and must not grow into it.** The
  dead planning branch above gates on a tool named `plan`; `todo` is a different
  tool and deliberately does not re-arm it. That prompt section describes a
  session-wide plan file, delegation Task IDs and survival across compaction —
  none of which `todo` has. What `plan` was is worth knowing before extending
  this: a plan file (`agent/plans/<key>.jsonl`) plus a live kanban Board in its
  own pane, which needed a *second* writer (ADR 0015) and then a cross-process
  lock that could still lose updates (ADR 0035), and whose last commits before
  deletion were all stale-card fixes (ADR 0048). `todo` avoids all of it by
  having no file: state is replayed from tool-result `details` on the current
  branch, so there is exactly one writer and a rewind cannot leave a stale list
  describing work the agent no longer remembers doing.
- **Keep pure logic out of `index.ts`.** Every subdirectory extension splits
  `lib.ts` (pure, tested) from `index.ts` (session wiring). New complexity at this
  level should follow that split rather than growing a 1000-line top-level file.
  `trade-journal/` is the worked example of *why*: its mode logic (date-window
  filtering, a newest-first window, four output shapes) wanted tests, and a
  `*.test.ts` cannot sit beside a top-level extension — pi auto-loads it and the
  `bun:test` import takes startup down. Logic that deserves a test is the signal to
  become a directory, not a bigger file.

## COMMANDS

```sh
cd mcp && npm install     # the one dir with real npm dependencies
```

The two `tsc -p` scopes are in the root COMMANDS section. What matters here is what
they do **not** cover: `lib/` and every top-level `*.ts` are in no typecheck scope at
all — nothing type-checks `dynamic-prompt.ts` or `litellm.ts` but pi loading them.

## ANTI-PATTERNS

- Putting a `*.test.ts` at this level — it imports `bun:test`, pi auto-loads it, and
  pi will not start.
- Doing real work at module top level. Register inside the default export; anything
  eager becomes a startup hazard for *every* session, and the failure surfaces before
  pi can report which extension caused it.
- Growing a top-level `*.ts` past the point where its logic wants tests. Logic that
  deserves a test cannot live at this level (see above) — that is the signal to move
  the extension into a subdirectory and split `lib.ts` from `index.ts`.

(The repo-wide rules those imply — one parser per format, widgets measure through
`lib/widget.ts` — are in the root CONVENTIONS.)
