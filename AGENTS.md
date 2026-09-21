# .pi — Project Knowledge Base

## OVERVIEW

Personal configuration repository for the `pi` coding agent (`@earendil-works/pi-coding-agent`, installed globally via bun). It owns everything the user tunes: local pi extensions (TypeScript, auto-discovered), the subagent fleet definitions, the skills library, prompt templates, the TUI theme, the LiteLLM provider setup, and the MCP gateway wiring. Everything pi *generates* (sessions, caches, vendored package checkouts) is gitignored — the rule of thumb in `.gitignore`: if deleting it costs nothing but a re-run, ignore it. `CONTEXT.md` is the domain glossary (delegation/planning language) for the agent's subagent machinery; `PATCHES.md` documents local patches to the installed pi bundle.

## STRUCTURE

- `agent/extensions/` — local pi extensions; **every top-level `*.ts` is auto-loaded by pi at startup** (subdirs are entered only via `index.ts`, e.g. `mcp/`)
- `agent/agents/` — subagent definitions (Markdown + YAML frontmatter: `name`, `description`, `tools`, `model`, `fallback_models`)
- `agent/skills/` — skills library, one dir per skill (`SKILL.md` + reference docs; mostly the matt-pocock set plus `uarizona-hpc`)
- `agent/prompts/` — prompt templates (`git-commit.md`: Conventional Commits)
- `agent/themes/` — TUI theme (`tokyo-night.json`)
- `agent/settings.json` — pi config: default provider/model/thinking level, installed packages (`git:`/`npm:` refs)
- `agent/mcp.json` — MCP servers (litellm-gateway); key sent as `${LITELLM_MCP_KEY}` placeholder
- `agent/.env` — the ONLY file with live credentials (gitignored; `agent/.env.example` is the committed template)
- `agent/npm/`, `agent/git/`, `agent/fff/`, `agent/pi-blackhole/`, `agent/sessions/` — machine state, all gitignored
- `.githooks/` — tracked pre-commit hook (self-armed by `git-hooks.ts`)
- `CONTEXT.md`, `PATCHES.md` — domain glossary; local-pi-patch notes

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
| Shared extension helpers | `agent/extensions/lib/` (dotenv loader, widget line-fitting) |
| Commit message style | `agent/prompts/git-commit.md` |
| Delegation/planning vocabulary | `CONTEXT.md` |
| Why pi is patched in `node_modules` | `PATCHES.md` |

## CONVENTIONS

- **Parse errors are startup-fatal.** Pi auto-loads every top-level `agent/extensions/*.ts`; a test file placed there (it imports `bun:test`) breaks pi startup. Tests live in subdirectories — currently only `agent/extensions/lib/widget.test.ts`.
- **One dotenv loader.** `agent/extensions/lib/dotenv.ts` is the single parser for `agent/.env`; do not add a second (two parsers drift, and drift is how credentials get out of sync).
- **Widgets must measure.** Hand-built widget lines render through `fitLines`/`fittedWidget` (`lib/widget.ts`): a line wider than the terminal throws in pi's TUI host and kills the `pi` process (measured with `visibleWidth`, never `String.length`).
- **Secrets live only in `agent/.env`.** `mcp.json` uses the `${LITELLM_MCP_KEY}` placeholder and `litellm.ts` reads `LITELLM_API_KEY` lazily; a literal key in a tracked file defeats both.
- **Commits follow Conventional Commits** per `agent/prompts/git-commit.md`.

## COMMANDS

```sh
bun test agent/extensions/lib/widget.test.ts   # the repo's only test (from repo root; module resolution walks up to the pi packages in the home node_modules)
pi /update                                     # check for + install a pi update (auto-update extension; checks at most every 4h)
pi /mcp status | list [server] | refresh [server]  # MCP server health and tool registration
pi /reload                                     # hot-reload extensions after editing them
git config core.hooksPath .githooks            # normally done for you at pi startup by agent/extensions/git-hooks.ts
```

## NOTES

- **No build system, no root `package.json`/`tsconfig`.** Extensions are TS interpreted by pi (bun runtime). Two typecheck scopes exist (`noEmit`): `agent/extensions/mcp/tsconfig.json` (its dir has its own `package.json` + `node_modules`) and `agent/extensions/subagent-herdr/tsconfig.json` (resolve deps via the home `node_modules`; run with `../mcp/node_modules/.bin/tsc -p tsconfig.json`).
- **The pre-commit hook is currently dormant.** `.githooks/pre-commit` invokes `scripts/check.sh`, which was removed in `e7039b0`; the hook then silently exits 0. Nothing currently enforces "extension sources must load" at commit time.
- **`PATCHES.md` is partly stale.** Its references to `scripts/patch-pi.sh`, `scripts/check-thinking-label-patch.mjs`, `docs/adr/*` and `herdr-plugin/` were deleted in `e7039b0` (removal of the herdr/plan/subagent extensions and their docs). Remaining `docs/adr/00NN` mentions in comments (litellm.ts, dotenv.ts, .env.example, .gitignore) are historical — the ADRs no longer exist in the repo.
- **`agent/git/` and `agent/npm/` are vendored checkouts of installed packages** (`settings.json` `packages`: pi-lsp-extension, pi-fff, pi-blackhole, pi-better-edit; `agent/npm/package.json` also pins pi-lens). They carry their own `.git` and their own test suites — always run this repo's tests by explicit path; a bare `bun test` sweeps in the vendored tests and fails for reasons unrelated to this repo.
- `agent/subagent-runs/` holds one dir per delegated run (gitignored): the child's session file, its `.exit` sidecar, the child system prompt, and `meta.json` — the on-disk registry of the subagent-herdr extension (`agent/extensions/subagent-herdr/`). Each subagent spawn opens a new herdr agent pane (`herdr agent start --kind pi`); the pane is closed on success, kept open on failure as evidence.
- `agent/pi-blackhole/` holds the pi-blackhole package's pending-Run state (gitignored); `herdr.jsonl` at the root is herdr's activity log (gitignored), not repo content.
- Nested AGENTS.md: `agent/git/github.com/k0valik/pi-blackhole/AGENTS.md` — the vendored package's own knowledge base (pnpm test/typecheck/lint/build), applies inside that checkout only.
