# agent/extensions — local pi extensions auto-loaded at startup

Every top-level `*.ts` is one independent extension; `lib/` is the shared, pi-free
helper layer. Subdirectory extensions are discovered by their `index.ts`. The tier's
only config is `tsconfig.json` (typecheck scope); no `package.json`, no scripts —
all commands come from the repo root.

## WHERE TO LOOK

| File | Registers / owns |
|---|---|
| `ask-user.ts` | `questionnaire` tool — TUI option list + free-text fallback |
| `changed-files.ts` | `/changed-files`, `/diff` — session change widget |
| `display-file.ts` | `display_file` tool — spawns platform opener detached |
| `dynamic-prompt.ts` | Hooks `before_agent_start`; replaces pi's default system prompt |
| `firecrawl-cli.ts` | Loads `agent/.env` so `FIRECRAWL_API_URL` reaches `process.env` |
| `git-hooks.ts` | Self-arms `core.hooksPath`; runs `setup-deps.sh` at startup |
| `init.ts` | `/init` — deterministic AGENTS.md tiering |
| `litellm.ts` | `registerProvider("litellm")` — model catalog, costs |
| `sessions.ts` | `/sessions` — session list from pi's `SessionManager.list()` |
| `sleep.ts` | `sleep` tool — bounded pause, edge-triggered wake, abortable |
| `thinking-indicator.ts` | Live spinner (alt+t) + `setHiddenThinkingLabel` record |
| `todo.ts` | `todo` tool + `/todos` — subagent's checklist widget |
| `pi-bolt-host.ts` | Pi-Bolt only: gives pi-blackhole a resolvable host package |
| `startup-fetch.ts` | `/fetch`, `/builtin-header` — neofetch-style startup header |
| `kanban/` | `kanban` tool + `/kanban` — orchestrator's board |
| `auto-update/` | `/update` + `pi_update` tool — version check (memoised 4h) |
| `model-fallback/` | `registerVirtualModel("fallback/auto")` + `/fallback-chain` |
| `ralph-loop/` | Self-loop agent with `--verify` gates |
| `subagent-herdr/` | Spawns/tracks child pi processes; run-lifecycle |
| `trade-journal/` | `trade_journal` tool — journal in `~/.agentic-trading/journal/` |
| `lib/` | 13 shared helper modules, 17 suites, **no `index.ts`** (so pi never loads it): layout, runtime, dotenv, git-env, widget, agents, skill-tree, skill-activation, skill-categories, todo, startup-images, distro-logos, trade-journal-store. Count them with `ls agent/extensions/lib/*.ts \| grep -v test \| wc -l` — the suite names are **not** a 1:1 map to modules: `lib/skill-catalogue.test.ts` has no `skill-catalogue.ts` (it exercises the on-disk catalogue through `agents.ts` + `layout.ts` + `skill-activation.ts`), and `lib/dynamic-prompt.test.ts` tests the *root-level* `dynamic-prompt.ts` |

## CONVENTIONS

- **Default export is the entry point.** `export default function (pi: ExtensionAPI) { … }` — register tools/events/shortcuts/models inside it. Minimal: `sleep.ts:205` (one `registerTool` on the next line). Richest single file: `thinking-indicator.ts:264`. Richest multi-file: `model-fallback/index.ts:225`; named factory: `kanban/index.ts:295`. Verified 2026-10-30 — these line numbers move every time a file is touched, so re-check before quoting them.
- **Pi auto-loads every top-level `*.ts`; subdirectories need `index.ts`.** A bare
  `foo.ts` at this level ships into every session. `lib/` is invisible (no `index.ts`).
- **Import siblings with `.js` extension** (`./lib/widget.js`) — that is what jiti
  resolves and what `moduleResolution: "bundler"` expects.
- **`lib/` imports no pi package** — `node:*` only (one exception: `widget.ts:46`
  imports `@earendil-works/pi-tui`). A throw there is a startup failure with no
  diagnostic, so `layout.ts` never throws and `dotenv.ts` defers `requireEnv`.
- **Tests live in `lib/` or alongside their module; never at the top level.**
  A `*.test.ts` here imports `bun:test`, pi auto-loads it, and pi will not start.
- **Registration happens at load; the session-bound API does not exist yet.** `registerTool`/`registerProvider`/`registerVirtualModel` run when pi imports the file, so any setting a registration depends on must be read from disk at that moment (`model-fallback/index.ts:233` — "`registerVirtualModel` happens at load"). `pi.getActiveTools`/`pi.setActiveTools` are real, but are **not** members of every event's API (`dynamic-prompt.ts:137`), and a tool gained mid-run only appears on the **next** run (`dynamic-prompt.ts:118`) — so gate on `typeof pi.setActiveTools === 'function'` and expect a one-run lag, and remember there is **no `unregisterTool`** (revoking a skill's tools means `setActiveTools`, `dynamic-prompt.ts:136-157`).
- **The two prompt extensions yield to an active persona switch.** `dynamic-prompt.ts:176` and `quant-trader/extensions/quant-prompt.ts:363` both `return undefined` from `before_agent_start` when `personaOverride()` is set, so the `persona` extension is the single prompt builder for a switched run. The same check stops `dynamic-prompt.ts`'s additive `refreshActiveTools` (`dynamic-prompt.ts:128`): while a switch is active the persona extension owns the active tool set, and the additive refresh would widen it past the switch's declaration, which the switch's own `tool_call` block would then refuse. The yield is symmetric and state-based — exactly one handler returns a `systemPrompt`, in load order and out of it alike — so no `zz-` filename prefix is needed: `readdirSync` order is not guaranteed under bun, and a prefix would only paper over it.
- **Subdirectories split `lib.ts` (pure, tested) from `index.ts` (session wiring).**
  Become a directory when it improves interface or locality — not merely to test.
- **Pure logic is exported and tested from `lib/`.** `sleep.ts` exports
  `validateTimeout`; `lib/sleep.test.ts` tests it. Same pattern throughout.

## PROFILES

A profile's `extensions/` directory (e.g. `quant-trader/extensions/`) is a **per-item symlink list of this directory** — one symlink per extension the persona loads, plus the profile's own top-level `.ts` (`quant-prompt.ts`). The repo-root `AGENTS.md` `## Profiles` section owns the rest of the profile rules (what a profile is, the symlink-not-copy rule, the `.gitignore` battery); this section covers only what a profile's `extensions/` dir means for this directory. The only exclusion is `dynamic-prompt.ts`: it replaces the system prompt in every top-level session with the orchestrator's, so a non-orchestrator profile never loads it — its own prompt extension takes that role. Sibling imports inside a symlinked extension resolve through the symlink's **realpath** (`model-fallback/index.ts` importing `./lib.js` reaches `agent/extensions/model-fallback/lib.ts`, never a profile copy), so a profile adds no second copy of anything: the agent's files are the files. A profile-local top-level `.ts` follows every convention in this file — default export, no work at module top level, `.js`-extension sibling imports, tests in a subdirectory — and `scripts/check.sh` covers it: section 1 imports it, the top-level `*.test.ts` guard applies to it, and its own `tsconfig.json` is a discovered typecheck scope. That tsconfig must name its own files only (`"include": ["quant-prompt.ts"]`), never a glob (`"include": ["*.ts"]`): a glob would match the symlinked siblings and typecheck this directory's extensions a second time under the profile's paths.

## COMMANDS

```sh
./scripts/check.sh                        # all-in-one: load + typecheck + test (the pre-commit gate)
bun test agent/extensions/lib/            # shared helper tests
bun test agent/extensions/subagent-herdr/ # herdr: 5 suites
bun test agent/extensions/kanban/         # kanban: reducer, replay, guard, board args
cd subagent-herdr && npm install          # one npm install (dev-only: typescript, @types/node)
```

Per-scope `tsc -p` commands and individual test suites are in the root AGENTS.md COMMANDS section.

## ANTI-PATTERNS

- **`*.test.ts` at this level** — pi auto-loads it and will not start.
- **Real work at module top level** — register inside the default export.
- **Moving an extension into a subdirectory just to test it** — `lib/` already can.
- **Doing session work at load time** — reading tool state, calling `getActiveTools`/`setActiveTools`, touching the transcript: they are not on every event's API and not bound at import. Registration-time code reads files; everything else goes in a handler.
- **Importing a pi package from `lib/`** — startup failure with no diagnostic.
- **Rebuilding a list from the session branch inside `execute`** — parallel tool
  batches replay the same stale branch.
