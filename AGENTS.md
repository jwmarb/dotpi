# .pi — Project Knowledge Base

## OVERVIEW

Personal configuration repository for the `pi` coding agent (`@earendil-works/pi-coding-agent`, installed globally via bun). It owns everything the user tunes: local pi extensions (TypeScript, auto-discovered), the subagent fleet definitions, the skills library, prompt templates, the TUI theme, the LiteLLM provider setup, and the MCP gateway wiring. Everything pi *generates* (sessions, caches, vendored package checkouts) is gitignored — the rule of thumb in `.gitignore`: if deleting it costs nothing but a re-run, ignore it.

## STRUCTURE

- `agent/extensions/` — local pi extensions; **every top-level `*.ts` is auto-loaded by pi at startup** (subdirs are entered only via `index.ts`, e.g. `mcp/`)
- `agent/agents/` — subagent definitions (Markdown + YAML frontmatter: `name`, `description`, `tools`, `model`, `fallback_models`)
- `agent/skills/` — skills library, one dir per skill (`SKILL.md` + reference docs; mostly the matt-pocock set plus `uarizona-hpc`)
- `agent/prompts/` — prompt templates (`git-commit.md`: Conventional Commits)
- `agent/themes/` — TUI theme (`tokyo-night.json`)
- `agent/settings.json` — pi config: default provider/model/thinking level, installed packages (`git:`/`npm:` refs)
- `agent/mcp.json` — MCP servers (litellm-gateway); key sent as `${LITELLM_MCP_KEY}` placeholder
- `agent/.env` — the ONLY file with live credentials (gitignored; `agent/.env.example` is the committed template)
- `agent/fff/`, `agent/git/`, `agent/pi-blackhole/`, `agent/sessions/` — machine state, all gitignored
- `.githooks/` — tracked `pre-commit`, `post-checkout`, `post-merge` (self-armed by `git-hooks.ts`)
- `scripts/setup-deps.sh` — installs each extension's npm dependencies; run at startup and by the checkout/merge hooks

## WHERE TO LOOK

| Task | Path |
|---|---|
| Add a local extension | `agent/extensions/<name>.ts` (or a subdir with `index.ts`, like `mcp/`) |
| Add/modify a subagent | `agent/agents/<name>.md` |
| Add a skill | `agent/skills/<name>/SKILL.md` |
| Change default model / provider / thinking | `agent/settings.json` |
| Provider key, model catalog, pricing | `agent/extensions/litellm.ts` + `agent/.env` |
| Add/repair an MCP server | `agent/mcp.json` (runtime: `/mcp status` · `list` · `refresh`) |
| Add a credential | `agent/.env` (template: `agent/.env.example`) |
| The orchestrator's system prompt | `agent/extensions/dynamic-prompt.ts` (replaces pi's default prompt with discovered inventories) |
| Shared extension helpers | `agent/extensions/lib/` (dotenv loader, widget line construction/fitting, repo layout) |
| Where a repo file lives (agent dir, agents/, skills/, .env, mcp.json) | `agent/extensions/lib/layout.ts` (single resolver — never throws, so top-level extension code can import it) |
| Agent definition grammar (`agents/*.md`) | `agent/extensions/lib/agents.ts` (single parser — prompt + spawn import it; one parser per format, like dotenv) |
| Commit message style | `agent/prompts/git-commit.md` |
| Install extension npm dependencies | `scripts/setup-deps.sh` |

## CONVENTIONS

- **Parse errors are startup-fatal.** Pi auto-loads every top-level `agent/extensions/*.ts`; a test file placed there (it imports `bun:test`) breaks pi startup. Tests live in subdirectories — currently `agent/extensions/lib/widget.test.ts` and `agent/extensions/subagent-herdr/lib.test.ts`.
- **One dotenv loader.** `agent/extensions/lib/dotenv.ts` is the single parser for `agent/.env`; do not add a second (two parsers drift, and drift is how credentials get out of sync).
- **Widgets must measure.** Hand-built widget lines render through `fitLines`/`fittedWidget` (`lib/widget.ts`): a line wider than the terminal throws in pi's TUI host and kills the `pi` process (measured with `visibleWidth`, never `String.length`).
- **Secrets live only in `agent/.env`.** `mcp.json` uses the `${LITELLM_MCP_KEY}` placeholder and `litellm.ts` reads `LITELLM_API_KEY` lazily; a literal key in a tracked file defeats both.
- **Commits follow Conventional Commits** per `agent/prompts/git-commit.md`.

## COMMANDS

```sh
bun test agent/extensions/lib/widget.test.ts            # widget tests (32)
bun test agent/extensions/subagent-herdr/lib.test.ts    # herdr tests (41)
pi /update                                     # check for + install a pi update (auto-update extension; checks at most every 4h)
pi /mcp status | list [server] | refresh [server]  # MCP server health and tool registration
pi /reload                                     # hot-reload extensions after editing them
git config core.hooksPath .githooks            # normally done for you at pi startup by agent/extensions/git-hooks.ts
```

Both test files import packages pi normally injects itself (`@earendil-works/pi-tui`, `typebox`), so `bun test` — which has no access to pi's alias map — only resolves them via a gitignored root `node_modules/` of symlinks into bun's global tree:

```sh
G=$HOME/.cache/.bun/install/global/node_modules
mkdir -p node_modules
ln -sfn $G/@earendil-works node_modules/@earendil-works
ln -sfn $G/typebox         node_modules/typebox
ln -sfn "$PWD/agent/extensions/mcp/node_modules/@types" node_modules/@types   # also satisfies tsc's types:["node"]
```

## NOTES

- **No build system, no root `package.json`/`tsconfig`.** Extensions are TS interpreted by pi (bun runtime). Two typecheck scopes exist (`noEmit`): `agent/extensions/mcp/tsconfig.json` (its dir has its own `package.json` + `node_modules`) and `agent/extensions/subagent-herdr/tsconfig.json` (run with `../mcp/node_modules/.bin/tsc -p tsconfig.json`; needs the root `node_modules/@types` symlink above, or it fails with `TS2688: Cannot find type definition file for 'node'`).
- **The pre-commit hook is currently dormant.** `.githooks/pre-commit` invokes `scripts/check.sh`, which was removed in `e7039b0`; the hook then silently exits 0. Nothing currently enforces "extension sources must load" at commit time.
- **`PATCHES.md` and `CONTEXT.md` no longer exist** (deleted in `5eea62b`); pi is not patched in `node_modules` anymore. Remaining `docs/adr/00NN` mentions in comments (litellm.ts, dotenv.ts, .env.example, .gitignore) are historical — the ADRs were deleted in `e7039b0`.
- **`pi` must come from bun's global bin.** Extensions import `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, which are never installed locally: pi injects them by loading each extension through jiti with an **alias map** to its own bundled copies (`getAliases()` in the bundle). So the packages are only resolvable when the running binary is the one that owns them — `$HOME/.cache/.bun/bin/pi`. An older `@mariozechner/pi-coding-agent` on `PATH` (the pre-rename scope, e.g. under `~/.local/share/pi-node/`) has no `@earendil-works/*` aliases, so every extension fails at startup with a misleading `Cannot find module '@earendil-works/pi-tui'`. `~/.bashrc` pins `BUN_INSTALL` and prepends `$BUN_INSTALL/bin` for this reason; bun otherwise derives that path from `XDG_CACHE_HOME` and falls back to a different, empty `~/.bun`.
- **`agent/git/` holds vendored checkouts of installed packages** (`settings.json` `packages`: pi-lsp-extension, pi-fff, pi-blackhole, pi-better-edit). They carry their own `.git` and their own test suites — always run this repo's tests by explicit path; a bare `bun test` sweeps in the vendored tests (~1975 tests, hundreds failing) for reasons unrelated to this repo.
- `agent/subagent-runs/` holds one dir per delegated run (gitignored): the child's session file, its `.exit` sidecar, the child system prompt, `reports.jsonl` (child → orchestrator messages from `subagent_report`), and `meta.json` — the on-disk registry of the subagent-herdr extension (`agent/extensions/subagent-herdr/`). Each subagent spawn opens a new herdr tab in the orchestrator's workspace (`herdr tab create`, labelled `<agent> <runId>`); the child closes its own pane on completion (closing the tab's only pane closes the tab; parent backstops), failed panes stay open as evidence. Messaging is bidirectional: `subagent_tasks` action "message" sends a prompt to a running child, and the child's `subagent_report` tool messages the orchestrator (live via herdr, durably in the report log).
- `agent/pi-blackhole/` holds the pi-blackhole package's pending-Run state (gitignored); `herdr.jsonl` at the root is herdr's activity log (gitignored), not repo content.
- Nested AGENTS.md: `agent/git/github.com/k0valik/pi-blackhole/AGENTS.md` — the vendored package's own knowledge base (pnpm test/typecheck/lint/build), applies inside that checkout only.
