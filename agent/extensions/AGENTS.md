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
| `dynamic-prompt.ts` | `before_agent_start`: replaces pi's system prompt. Registers no tool. |
| `git-hooks.ts` | On the `session_start` reason `startup` only (`:37`): arms `core.hooksPath`, then runs `setup-deps.ps1` on Windows or `setup-deps.sh` |
| `init.ts` | `/init`: deterministic AGENTS.md tiering. Its `NESTED_LINE_RANGE` constant is the line budget these files obey |
| `litellm.ts` | `async`. Fetches the model catalog at load and registers nothing if the host is unreachable. The pure `buildModels`/`thinkingLevelMapFor` are tested in `lib/litellm.test.ts`, and a reply with no `data` now warns |
| `local.ts` | Host shim: re-points the builtin `openai` provider at a LAN host. It is tracked and loads on every machine |
| `pi-bolt-host.ts` | No-op unless compiled. Under Pi-Bolt it gives pi-blackhole a resolvable host package |
| `sessions.ts` | `/sessions`: session list from pi's `SessionManager.list()` |
| `sleep.ts` | `sleep` tool: bounded pause, edge-triggered wake. Minimal template (`:205` → `:206`) |
| `startup-fetch.ts` | `/fetch`, `/builtin-header`: neofetch-style header. Reads `settings.json` `startupFetch` through `lib/settings.ts` (so a project `.pi/settings.json` overrides it) and writes it with `patchSettingsKey` (global file only) |
| `thinking-indicator.ts` | alt+t spinner + `setHiddenThinkingLabel`. Most hooks of any single file |
| `todo.ts` | `todo` tool + `/todos`. **Registered only in a subagent child** (`PI_SUBAGENT_RUN_ID`, `:166`) |
| `auto-update/` | `/update` + `pi_update` tool. `index.ts` owns the check decision — `compareSemver` (semver prerelease order) and `planUpdateCheck`, tested in `lib/auto-update.test.ts`; a failed check is reported as an error, never as "up to date". `status.ts` owns the vocabulary shared by every update surface — `UpdateStatus`, `describeUpdate`, and the memoised check factory `createUpdateStatusMemo` (`CHECK_INTERVAL_MS`), tested in its own `lib/auto-update-status.test.ts` — the decision only: each surface writes its own sentence |
| `trade-journal/` | `trade_journal` tool. `AGENTIC_TRADING_JOURNAL` overrides the journal dir |

## lib/ — module → consumers (no AGENTS.md of its own, by decision)

| Module | Owns · imported by |
|---|---|
| `layout.ts` | Agent-dir path resolution. Never throws · dynamic-prompt, git-hooks, kanban, model-fallback, pi-bolt-host, ralph-loop, startup-fetch, subagent-herdr |
| `settings.ts` | The load-safe `settings.json` seam. Reads merge project `.pi/settings.json` over the agent file with a **whole-object replace per key**; `{}` and never a throw. Both writers target the **global file only** and write it atomically (`<file>.<pid>.tmp` + `renameSync`), so a project's own key is never copied into the user's config — and a project pin therefore shadows those writes · model-fallback, startup-fetch |
| `project-layer.ts` | `projectRoots` (pi's two facts) + `TrustRequiringSnapshot` as the entry points, `resourceRoots` the low-level form; project-first agents/skills dirs for a cwd (`cwd/.pi`, trust-bypass rationale in its header) · dynamic-prompt, subagent-herdr |
| `agents.ts` | `agents/*.md` + SKILL.md list grammar, lineage · dynamic-prompt, ralph-loop, subagent-herdr |
| `runtime.ts` | Pi-Bolt detection, `piExecutable()` · auto-update, kanban, ralph-loop, subagent-herdr, startup-fetch, pi-bolt-host |
| `widget.ts` | `fitLines`/`fittedWidget`/`frame` · changed-files, kanban, model-fallback, sessions, thinking-indicator, todo |
| `todo.ts` | Todo model, `RUN_TODOS_EVENT` (the kanban ↔ herdr progress channel), and the one newest-snapshot walk `latestTodoCounts`/`latestTodoCountsOfEntries` · todo, kanban, subagent-herdr |
| `prompt-inputs.ts` | `derivePromptInputs`, the only prompt builder's inputs, plus the `QUESTIONNAIRE_TOOL`/`SUBAGENT_TOOL`/`KANBAN_TOOL` names · dynamic-prompt |
| `mcp-config.ts` | `synthesizeMcpServersSection` + the `mcp.json` reader — the indirect-MCP-servers note a forced prompt cannot get from core · dynamic-prompt |
| `skill-tree.ts` | Skill walker — the one place that knows skills live under a category · subagent-herdr |
| `skill-activation.ts` | Skill-owned tool gating · dynamic-prompt |
| `dotenv.ts` | `.env` parser · firecrawl-cli, litellm |
| `git-env.ts` | git env scrub · changed-files, init |
| `skill-categories.ts` | Category grouping for the skills catalogue · dynamic-prompt |
| `startup-images.ts` | Inline-image helpers for the startup header · startup-fetch |
| `distro-logos.ts` | Logo arrays — **generated** art, do not hand-edit · startup-fetch |
| `trade-journal-store.ts` | The journal grammar, kept here rather than inside the extension · trade-journal |

The lib graph has no cycles, and neither that claim nor this table is kept by hand:
`lib/module-graph.test.ts` re-derives both from the live tree (modules from
`ls agent/extensions/lib/*.ts`, suites from `find agent/extensions -name '*.test.ts'`). Suite
names do not map 1:1 to modules —
`skill-catalogue.test.ts` walks the live tree, and
`dynamic-prompt.test.ts`/`sessions.test.ts`/`sleep.test.ts`/`init.test.ts`/`changed-files.test.ts`/`startup-fetch.test.ts`
test top-level files through `../<name>.js`.

## CONVENTIONS

- **Default export is the entry point**: `export default function (pi: ExtensionAPI) { … }`. All registration goes
  inside it. A directory extension splits `lib.ts` (pure, tested) from `index.ts` (wiring). Make it a directory for
  interface or locality, not merely to get a test, because `lib/` can already host one.
- **Import siblings with `.js`** (`./lib/widget.js`), as `moduleResolution: "bundler"` expects.
  `lib/startup-fetch.test.ts`'s `.ts` imports are the lone outlier.
- **No hand-maintained totals in these files.** A count nobody checks is a lie with a stale
  date: point at the discovery command instead (`ls agent/extensions/lib/*.ts`,
  `find agent/extensions -name '*.test.ts'`, `wc -l`). A numeral is welcome only where it is
  the contract itself, and then it is name-referenced to the constant that owns it.
- **`lib/` imports no pi package.** `widget.ts` → `pi-tui` is the one exception. A throw there is a startup failure
  with no diagnostic, so `layout.ts` never throws and `dotenv.ts` defers `requireEnv`.
- **Registration happens at load, before the session API exists.** A setting a registration depends on is read from
  disk at import. `getActiveTools`/`setActiveTools` are not on every event's API (`dynamic-prompt.ts:134-140`), a tool
  gained mid-run appears on the **next** run, and there is **no `unregisterTool`**.
- **`dynamic-prompt.ts` states grading exactly once per install.** With a grader installed that statement
  lives in `## Quality Pass` (one pass per deliverable), and the planning and delegation sections only point
  at it. In a no-grader install there is no Quality Pass, so the single statement is the delegation
  section's "No child's diff comes graded in this install…" The receipt-meaning clause (a receipt is
  evidence, never a verdict) moves with the install: Quality Pass when it is emitted, the delegation
  paragraph when it is not. No agent body self-grades (pinned in `subagent-herdr/lib.test.ts`); every
  grader phrase derives from the filtered `graders` roster, and every `worker`/receipt phrase is gated on
  `hasWorker`.
- **Sibling imports resolve through the realpath.**
- **Typecheck:** `tsconfig.json`'s `include` is `*.ts` + `lib/*.ts`, so no subdirectory is named there — but tsc still
  checks what an included file imports: `startup-fetch.ts` pulls `auto-update/index.ts` and `auto-update/status.ts`
  into the program, while `trade-journal/index.ts`, imported by nothing, is genuinely unchecked. The check is
  `tsc -p tsconfig.json --listFilesOnly`, not this sentence. Its `paths` is a literal relative
  `../../../../.bun/install/global/…`, and `typeRoots` borrows
  `subagent-herdr/node_modules/@types`.

## ANTI-PATTERNS

- **`*.test.ts` at this level.** pi auto-loads it (`bun:test`) and will not start.
- **Real work at module top level**, or session work (tool state, transcript) at load time.
- **Importing a pi package from `lib/`.**
- **Rebuilding a list from the session branch inside `execute`.** Parallel tool batches replay the same stale branch.
