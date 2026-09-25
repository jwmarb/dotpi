# .pi — Project Knowledge Base

## OVERVIEW

Personal configuration repository for the `pi` coding agent (`@earendil-works/pi-coding-agent`, installed globally via bun). It owns everything the user tunes: local pi extensions (TypeScript, auto-discovered), the subagent fleet definitions, the skills library, prompt templates, the TUI theme, the LiteLLM provider setup, and the MCP gateway wiring. Everything pi *generates* (sessions, caches, vendored package checkouts) is gitignored — the rule of thumb in `.gitignore`: if deleting it costs nothing but a re-run, ignore it.

**The git root is `~/Nextcloud/.pi`; `~/.pi` is a symlink to it.** pi resolves its agent directory as `~/.pi/agent` (`lib/layout.ts`, override with `PI_CODING_AGENT_DIR`), so docs and code say `~/.pi/...` while `git rev-parse --show-toplevel` says `~/Nextcloud/.pi`. Same files, two names — do not "fix" one into the other.

## STRUCTURE

- `agent/` — everything pi loads at runtime (extensions, agents, skills, prompts, themes, settings, machine state). Authoring grammars: `agent/AGENTS.md`
- `agent/extensions/` — local pi extensions; **every top-level `*.ts` is auto-loaded by pi at startup** (subdirs are entered only via `index.ts`, e.g. `mcp/`). Per-file inventory: `agent/extensions/AGENTS.md`
- `agent/agents/` — subagent definitions (Markdown + YAML frontmatter)
- `agent/skills/` — skills library, one dir per skill (`SKILL.md` + reference docs; mostly the matt-pocock set). Some skills are personal and gitignored, so this directory holds more locally than the repo publishes.
- `agent/prompts/` — prompt templates (`git-commit.md`: Conventional Commits)
- `agent/themes/` — TUI theme (`tokyo-night.json`)
- `agent/settings.json` — pi config: default provider/model/thinking level, retry policy, installed packages (`git:`/`npm:` refs)
- `agent/mcp.json` — MCP servers (litellm-gateway); URL and key sent as `${LITELLM_MCP_URL}` / `${LITELLM_MCP_KEY}` placeholders
- `agent/.env` — the ONLY file with live credentials (gitignored; `agent/.env.example` is the committed template)
- `agent/docker/verify-base.Dockerfile` — tracked reference image for runtime verification
- `agent/fff/`, `agent/npm/`, `agent/git/`, `agent/pi-blackhole/`, `agent/sessions/`, `agent/subagent-runs/`, `agent/verify-images/` — machine state, all gitignored
- `.githooks/` — tracked `pre-commit`, `post-checkout`, `post-merge` (self-armed by `git-hooks.ts`)
- `scripts/setup-deps.sh` — installs each extension's npm dependencies; run at startup and by the checkout/merge hooks

## WHERE TO LOOK

| Task | Path |
|---|---|
| Add a local extension | `agent/extensions/<name>.ts` (or a subdir with `index.ts`, like `mcp/`) |
| What each extension owns | `agent/extensions/AGENTS.md` |
| Add/modify a subagent | `agent/agents/<name>.md` (grammar: `agent/AGENTS.md`) |
| Add a skill | `agent/skills/<name>/SKILL.md` (frontmatter keys: `agent/AGENTS.md`) |
| Change default model / provider / thinking / retry | `agent/settings.json` |
| Provider key, model catalog, pricing, thinking-level mapping | `agent/extensions/litellm.ts` + `agent/.env` |
| Add/repair an MCP server | `agent/mcp.json` (docs: `agent/extensions/mcp/README.md`; runtime: `/mcp status` · `list` · `refresh`) |
| Add a credential | `agent/.env` (template: `agent/.env.example`) |
| The orchestrator's system prompt | `agent/extensions/dynamic-prompt.ts` (replaces pi's default prompt with discovered inventories) |
| List/resume previous sessions | `agent/extensions/sessions.ts` (`/sessions` modal) |
| Loop the agent on a goal until it declares completion | `agent/extensions/ralph-loop/` (`/ralph-loop`, `/ulw-loop`, `/loop-stop`; `--verify[=static\|runtime\|both]`) |
| Delegate work to a subagent | `agent/extensions/subagent-herdr/` (`subagent`, `subagent_tasks` tools) |
| Review changed files (+/− counts) | `agent/extensions/changed-files.ts` (`/diff` modal, `/changed-files`) |
| Regenerate this knowledge base | `agent/extensions/init.ts` (`/init`) |
| Shared extension helpers | `agent/extensions/lib/` (dotenv loader, widget measuring/fitting, repo layout, agent parsing) |
| Where a repo file lives (agent dir, agents/, skills/, .env, mcp.json) | `agent/extensions/lib/layout.ts` (single resolver — never throws, so top-level extension code can import it) |
| Agent definition grammar (`agents/*.md`) | `agent/extensions/lib/agents.ts` (single parser — prompt + spawn import it; one parser per format, like dotenv) |
| Commit message style | `agent/prompts/git-commit.md` |
| Install extension npm dependencies | `scripts/setup-deps.sh` |

## CONVENTIONS

- **Parse errors are startup-fatal.** Pi auto-loads every top-level `agent/extensions/*.ts`; a test file placed there (it imports `bun:test`) breaks pi startup. Tests live in subdirectories — currently `agent/extensions/lib/{widget,agents,layout,sessions}.test.ts`, `agent/extensions/subagent-herdr/lib.test.ts`, `agent/extensions/ralph-loop/lib.test.ts`.
- **One parser per format.** `lib/dotenv.ts` owns `agent/.env`, `lib/agents.ts` owns the `agents/*.md` frontmatter, `subagent-herdr/rundir.ts` owns the run-directory shapes. Do not add a second reader of any of them — two parsers drift, and drift is how credentials and spawn arguments get out of sync.
- **Widgets must measure.** Hand-built widget lines render through `fitLines`/`fittedWidget` (`lib/widget.ts`): a line wider than the terminal throws in pi's TUI host and kills the `pi` process (measured with `visibleWidth`, never `String.length`).
- **Secrets live only in `agent/.env`.** `mcp.json` uses the `${LITELLM_MCP_KEY}` placeholder and `litellm.ts` reads `LITELLM_API_KEY` lazily; a literal key in a tracked file defeats both.
- **Commits follow Conventional Commits** per `agent/prompts/git-commit.md`.

## COMMANDS

```sh
bun test agent/extensions/lib/                          # widget/agents/layout/sessions tests (59)
bun test agent/extensions/subagent-herdr/lib.test.ts    # herdr tests (41)
bun test agent/extensions/ralph-loop/lib.test.ts        # ralph-loop tests (135)
bun test agent/extensions/lib/widget.test.ts            # one file
bun test agent/extensions/lib/ -t "wide characters"     # one test by name

pi /update                                     # check for + install a pi update (checks at most every 4h)
pi /mcp status | list [server] | refresh [server]  # MCP server health and tool registration
pi /reload                                     # hot-reload extensions after editing them
git config core.hooksPath .githooks            # normally done for you at pi startup by agent/extensions/git-hooks.ts
bash scripts/setup-deps.sh                     # repair a missing extension node_modules
```

Typecheck (`noEmit`) has two scopes; there is no root `tsconfig.json`:

```sh
cd agent/extensions/mcp           && ./node_modules/.bin/tsc -p tsconfig.json
cd agent/extensions/subagent-herdr && ../mcp/node_modules/.bin/tsc -p tsconfig.json
```

`bun test` resolves the packages pi normally injects (`@earendil-works/pi-tui`, `typebox`) and tsc's `types: ["node"]` by **walking up to `~/node_modules`** — an ancestor of both `~/.pi` and `~/Nextcloud/.pi`. There is no `node_modules/` in this repo, and none is needed while that tree exists. Beware the skew: `~/node_modules/@earendil-works/*` is 0.75.4 while the running pi is 0.85.1, so a test that passes here can still disagree with the live host. If that tree ever disappears, symlink what is missing into a gitignored root `node_modules/` from `~/.bun/install/global/node_modules`.

## NOTES

- **No build system, no root `package.json`/`tsconfig`.** Extensions are TS interpreted by pi (bun runtime); only `agent/extensions/mcp/` has real npm dependencies.
- **`thinking-indicator.ts` is half-inert right now.** It requires `"hideThinkingBlock": true` in `agent/settings.json` to relabel pi's collapsed thinking block ("Thought for 12s"); the setting is currently `false` (commit `0e30dff` deliberately shows thinking in the transcript). The live spinner still works; the transcript record silently does nothing. Flip the setting if you want both.
- **The pre-commit hook is dormant.** `.githooks/pre-commit` invokes `scripts/check.sh`, which was removed in `7a54a3b` (along with the old herdr/plan/subagent extensions); the hook then silently exits 0. Nothing currently enforces "extension sources must load" at commit time — `/reload` after editing is the only guard.
- **`PATCHES.md`, `CONTEXT.md` and `docs/adr/` no longer exist** (removed in `1993878` and `a784c57`); pi is not patched in `node_modules` anymore. Remaining `docs/adr/00NN` mentions in comments (litellm.ts, dotenv.ts, .env.example, .gitignore) are historical dead references.
- **`pi` must come from bun's global bin (`~/.bun/bin/pi`).** Extensions import `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, which pi injects by loading each extension through jiti with an **alias map** to its own bundled copies (`getAliases()`). The packages are only resolvable when the running binary is the one that owns them. An older `@mariozechner/pi-coding-agent` on `PATH` (the pre-rename scope) has no `@earendil-works/*` aliases, so every extension fails at startup with a misleading `Cannot find module '@earendil-works/pi-tui'`. `~/.bashrc` prepends `~/.bun/bin` for this reason. (`BUN_INSTALL` is unset, so bun derives the install path itself — it currently lands on `~/.bun`, not the `~/.cache/.bun` an earlier revision of this file claimed.)
- `agent/git/` holds vendored checkouts of the `git:` packages (pi-lsp-extension, pi-blackhole); the `npm:` packages install under `agent/npm/node_modules`. Those trees carry ~437 of their own test files — always run this repo's tests by explicit path; a bare `bun test` sweeps the vendored suites in and reports hundreds of failures unrelated to this repo. `agent/npm/node_modules/pi-lens` is a leftover: it is installed but **not** listed in `settings.json` `packages`, so pi does not load it.
- `agent/subagent-runs/` is the on-disk registry of the subagent-herdr extension (gitignored): one dir per delegated run holding the child's session file, its `.exit` sidecar, the child system prompt, `reports.jsonl`, and `meta.json`.
- Runtime verification needs a working Docker daemon — without one the `--verify` gate returns `inconclusive` and the loop stops rather than assuming success. `agent/verify-images/` holds the generated per-project Dockerfiles (gitignored; rebuildable).
- `agent/pi-blackhole/` holds the pi-blackhole package's pending-Run state (gitignored); `herdr.jsonl` at the root is herdr's activity log (gitignored), not repo content.
- Nested knowledge bases: `agent/AGENTS.md` (data-file grammars: agent + skill frontmatter, theme, docker base) · `agent/extensions/AGENTS.md` (per-extension inventory, `lib/` rules, typecheck scopes) · `agent/extensions/subagent-herdr/AGENTS.md` (herdr CLI protocol, completion handshake, run-directory contract) · `agent/extensions/ralph-loop/AGENTS.md` (the `agent_settled` loop contract and the `--verify` gates) · `agent/git/github.com/k0valik/pi-blackhole/AGENTS.md` (the vendored package's own KB — pnpm test/typecheck/lint/build; applies inside that checkout only).
