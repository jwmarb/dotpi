# agent/extensions — local pi extensions auto-loaded at startup

pi loads every top-level `*.ts` here as an independent extension. There is no manifest: `settings.json`
`extensions` only toggles builtins. pi enters a subdirectory only through its `index.ts`. `lib/` has none, so it is the
shared helper layer and never an extension. `kanban/`, `model-fallback/`, `ralph-loop/` and `subagent-herdr/` each
have their own AGENTS.md.

## WHERE TO LOOK

| File | Registers / owns |
|---|---|
| `ask-user.ts` | `questionnaire` tool: TUI option list + free-text fallback |
| `changed-files.ts` | `/changed-files`, `/diff`: session change widget (emits the event kanban listens to) |
| `display-file.ts` | `display_file` tool: spawns the platform opener detached |
| `dynamic-prompt.ts` | `before_agent_start`: replaces pi's system prompt. Registers no tool. 1051 lines |
| `firecrawl-cli.ts` | Registers **nothing** (its factory takes no `pi`). Loads `agent/.env` so `FIRECRAWL_API_URL` reaches `process.env`, and sets the no-telemetry/no-update env |
| `git-hooks.ts` | On `startup` only: arms `core.hooksPath`, then runs `setup-deps.ps1` on Windows or `setup-deps.sh` |
| `init.ts` | `/init`: deterministic AGENTS.md tiering. Its `NESTED_LINE_RANGE` is the 30-80 budget these files obey |
| `litellm.ts` | `async`. Fetches the model catalog at load and registers nothing if the host is unreachable. The pure `buildModels`/`thinkingLevelMapFor` are tested in `lib/litellm.test.ts`, and a reply with no `data` now warns |
| `local.ts` | 7-line host shim: re-points the builtin `openai` provider at a LAN host. It is tracked and loads on every machine |
| `pi-bolt-host.ts` | No-op unless compiled. Under Pi-Bolt it gives pi-blackhole a resolvable host package |
| `sessions.ts` | `/sessions`: session list from pi's `SessionManager.list()` |
| `sleep.ts` | `sleep` tool: bounded pause, edge-triggered wake. Minimal template (`:205` → `:206`) |
| `startup-fetch.ts` | `/fetch`, `/builtin-header`: neofetch-style header. Reads/writes `settings.json` `startupFetch` |
| `thinking-indicator.ts` | alt+t spinner + `setHiddenThinkingLabel`. Most hooks of any single file |
| `todo.ts` | `todo` tool + `/todos`. **Registered only in a subagent child** (`PI_SUBAGENT_RUN_ID`, `:166`) |
| `auto-update/` | `/update` + `pi_update` tool. The pure `compareSemver` (semver prerelease order) and `planUpdateCheck` are tested in `lib/auto-update.test.ts`; a failed check is reported as an error, never as "up to date" |
| `persona/` | `/agent` in-session profile switch (`index.ts` wiring, `lib.ts` pure, including the single prompt-kind reader `promptKindOf`). Has its **own `tsconfig.json`** scope |
| `trade-journal/` | `trade_journal` tool. `AGENTIC_TRADING_JOURNAL` overrides the journal dir |

## lib/ — module → consumers (no AGENTS.md of its own, by decision)

| Module | Owns · imported by |
|---|---|
| `layout.ts` | Agent-dir/profile path resolution. Never throws. Imported by nearly everything |
| `persona.ts` | Switch state on `globalThis[Symbol.for("pi.persona.override")]` (lib can load twice through a profile symlink), `personaDenies` · persona, dynamic-prompt, kanban, subagent-herdr, layout |
| `agents.ts` | `agents/*.md` + SKILL.md list grammar, lineage · dynamic-prompt, persona, ralph-loop, subagent-herdr |
| `runtime.ts` | Pi-Bolt detection, `piExecutable()` · auto-update, kanban, ralph-loop, subagent-herdr, startup-fetch, pi-bolt-host |
| `widget.ts` | `fitLines`/`fittedWidget`/`frame` · every widget-drawing extension |
| `todo.ts` | Todo model, `RUN_TODOS_EVENT` (the kanban ↔ herdr progress channel), and the one newest-snapshot walk `latestTodoCounts`/`latestTodoCountsOfEntries` · todo, kanban, subagent-herdr |
| `prompt-inputs.ts` | `derivePromptInputs`, the one derivation of the prompt builders' shared inputs, plus the `QUESTIONNAIRE_TOOL`/`SUBAGENT_TOOL`/`KANBAN_TOOL` names · dynamic-prompt, quant-prompt, persona |
| `skill-tree.ts`, `skill-activation.ts` | Skill walker; skill-owned tool gating · dynamic-prompt, persona, agents |
| `dotenv.ts`, `git-env.ts` | `.env` parser; git env scrub · firecrawl-cli, litellm; changed-files, init |
| single-consumer | `skill-categories.ts` (dynamic-prompt), `startup-images.ts` + `distro-logos.ts` (startup-fetch; logo arrays are **generated** art, do not hand-edit), `trade-journal-store.ts` (trade-journal; kept here as the journal grammar) |

The lib graph has no cycles. Suite names do not map 1:1 to modules: `skill-catalogue.test.ts` walks the live tree,
`profiles.test.ts` checks the real profile trees (no `dynamic-prompt.ts` by name or by realpath, only symlinks into `agent/` or pinned own files, `.env`/`sessions/` gitignored), and `dynamic-prompt.test.ts`/`sessions.test.ts` test top-level files. Count them with `ls lib/*.ts`.

## CONVENTIONS

- **Default export is the entry point**: `export default function (pi: ExtensionAPI) { … }`. All registration goes
  inside it. A directory extension splits `lib.ts` (pure, tested) from `index.ts` (wiring). Make it a directory for
  interface or locality, not merely to get a test, because `lib/` can already host one.
- **Import siblings with `.js`** (`./lib/widget.js`), as `moduleResolution: "bundler"` expects.
  `lib/startup-fetch.test.ts`'s `.ts` imports are the lone outlier.
- **`lib/` imports no pi package.** `widget.ts` → `pi-tui` is the one exception. A throw there is a startup failure
  with no diagnostic, so `layout.ts` never throws and `dotenv.ts` defers `requireEnv`.
- **Registration happens at load, before the session API exists.** A setting a registration depends on is read from
  disk at import. `getActiveTools`/`setActiveTools` are not on every event's API (`dynamic-prompt.ts:116`), a tool
  gained mid-run appears on the **next** run, and there is **no `unregisterTool`**.
- **The two prompt builders yield to a persona switch.** `dynamic-prompt.ts:147` and `quant-prompt.ts` return
  `undefined` while `personaOverride()` is set. Do not rely on filename load order.
- **`dynamic-prompt.ts` states grading exactly once per install.** With a grader installed that statement
  lives in `## Quality Pass` (one pass per deliverable), and the planning and delegation sections only point
  at it. In a no-grader install there is no Quality Pass, so the single statement is the delegation
  section's "No child's diff comes graded in this install…" The receipt-meaning clause (a receipt is
  evidence, never a verdict) moves with the install: Quality Pass when it is emitted, the delegation
  paragraph when it is not. No agent body self-grades (pinned in `subagent-herdr/lib.test.ts`); every
  grader phrase derives from the filtered `graders` roster, and every `worker`/receipt phrase is gated on
  `hasWorker`.
- **Profiles** symlink individual files from here. Sibling imports resolve through the realpath. A profile's own
  tsconfig must `include` its own files by name, never `*.ts`, or it typechecks this directory twice.
- **Typecheck:** `tsconfig.json` covers `*.ts` + `lib/*.ts` only (`auto-update/` and `trade-journal/` are not
  typechecked). Its `paths` is a literal relative `../../../../.bun/install/global/…`, and `typeRoots` borrows
  `subagent-herdr/node_modules/@types`.

## ANTI-PATTERNS

- **`*.test.ts` at this level.** pi auto-loads it (`bun:test`) and will not start.
- **Real work at module top level**, or session work (tool state, transcript) at load time.
- **Importing a pi package from `lib/`.**
- **Rebuilding a list from the session branch inside `execute`.** Parallel tool batches replay the same stale branch.
