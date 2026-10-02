# .pi — Project Knowledge Base

## OVERVIEW

Personal configuration repository for the `pi` coding agent (`@earendil-works/pi-coding-agent`, installed globally via bun). It owns everything the user tunes: local pi extensions (TypeScript, auto-discovered), the subagent fleet definitions, the skills library, prompt templates, the TUI theme, the LiteLLM provider setup, and the MCP gateway wiring. Everything pi *generates* (sessions, caches, vendored package checkouts) is gitignored — the rule of thumb in `.gitignore`: if deleting it costs nothing but a re-run, ignore it.

**The git root is `~/Nextcloud/.pi`; `~/.pi` is a symlink to it.** pi resolves its agent directory as `~/.pi/agent` (`lib/layout.ts`, override with `PI_CODING_AGENT_DIR`), so docs and code say `~/.pi/...` while `git rev-parse --show-toplevel` says `~/Nextcloud/.pi`. Same files, two names — do not "fix" one into the other.

## STRUCTURE

- `agent/` — everything pi loads at runtime (extensions, agents, skills, prompts, themes, settings, machine state). Authoring grammars: `agent/AGENTS.md`
- `agent/extensions/` — local pi extensions; **every top-level `*.ts` is auto-loaded by pi at startup** (subdirs are entered only via `index.ts`, e.g. `subagent-herdr/`). Per-file inventory: `agent/extensions/AGENTS.md`
- `agent/agents/` — subagent definitions (Markdown + YAML frontmatter)
- `agent/skills/` — skills library, one dir per skill (`SKILL.md` + reference docs; mostly the matt-pocock set), **flat by construction** — the directory name is the skill's identity. 37 local dirs, plus 15 discovered from the `superpowers` package (`settings.json` `packages`), which is why the catalogue reads 52. Some skills are personal and gitignored, so this directory holds more locally than the repo publishes. Grammar and the package-skill rules: `agent/AGENTS.md`.
- `agent/prompts/` — prompt templates (`git-commit.md`: Conventional Commits)
- `agent/themes/` — TUI theme (`tokyo-night.json`)
- `agent/settings.json` — pi config: default provider/model/thinking level, retry policy, installed packages (`git:`/`npm:` refs)
- `agent/mcp.json` — MCP servers for **pi's built-in MCP extension** (`+builtin:mcp`). Holds `robinhood` only, and it carries no secret: it authenticates by OAuth, whose client+token state lands in the gitignored `agent/mcp-auth.json`. **There is no `${...}` placeholder in this file** — the litellm gateway is registered from `agent/extensions/mcp-gateway.ts` instead, because the builtin validates `url` with `URL.canParse()` *before* expansion. `${VAR}`/`!cmd` are expanded in `headers`/`env` only, which is where that extension puts `${LITELLM_MCP_KEY}`
- `agent/.env` — the ONLY file with live credentials (gitignored; `agent/.env.example` is the committed template)
- `agent/docker/verify-base.Dockerfile` — tracked reference image for runtime verification
- `agent/fff/`, `agent/npm/`, `agent/git/`, `agent/pi-blackhole/`, `agent/sessions/`, `agent/subagent-runs/`, `agent/verify-images/` — machine state, all gitignored. So are the loose files beside them: `pi-debug.log`, `pi-tui-crash.log`, `run-history.jsonl`, `settings.json.bak`, `auth.json`, `models-store.json`, `mcp-auth.json`
- `.githooks/` — tracked `pre-commit`, `post-checkout`, `post-merge` (self-armed by `git-hooks.ts`)
- `scripts/setup-deps.sh` — installs each extension's npm dependencies; run at startup and by the checkout/merge hooks

## WHERE TO LOOK

| Task | Path |
|---|---|
| Add a local extension | `agent/extensions/<name>.ts` (or a subdir with `index.ts`, like `subagent-herdr/`) |
| What each extension owns | `agent/extensions/AGENTS.md` |
| Add/modify a subagent | `agent/agents/<name>.md` (grammar: `agent/AGENTS.md`) |
| Add a skill | `agent/skills/<name>/SKILL.md` (frontmatter keys: `agent/AGENTS.md`) |
| Change default model / provider / thinking / retry | `agent/settings.json` |
| Provider key, model catalog, pricing, thinking-level mapping | `agent/extensions/litellm.ts` + `agent/.env` |
| Add/repair an MCP server | `agent/mcp.json` (schema: pi's built-in MCP extension; runtime: `/mcp`). A server needing a secret *URL* goes in `agent/extensions/mcp-gateway.ts` instead |
| Add a credential | `agent/.env` (template: `agent/.env.example`) |
| The orchestrator's system prompt | `agent/extensions/dynamic-prompt.ts` (replaces pi's default prompt with discovered inventories) |
| List/resume previous sessions | `agent/extensions/sessions.ts` (`/sessions` modal) |
| Loop the agent on a goal until it declares completion | `agent/extensions/ralph-loop/` (`/ralph-loop`, `/ulw-loop`, `/loop-stop`; `--verify[=static\|runtime\|both]`) |
| Delegate work to a subagent | `agent/extensions/subagent-herdr/` (`subagent`, `subagent_tasks` tools; event-driven — no blocking wait, the child wakes the parent) |
| Review changed files (+/− counts) | `agent/extensions/changed-files.ts` (`/diff` modal, `/changed-files`) |
| Track multi-step work in a visible checklist | `agent/extensions/todo.ts` (`todo` tool, `/todos`; widget below the editor, state lives in tool-result `details` — no plan file) |
| Record/read trading-journal observations | `agent/extensions/trade-journal/` (`trade_journal` tool; modes record/read/stats/dupes. Gated on the `technical-analysis` skill being active; grammar in `lib/trade-journal-store.ts`) |
| Regenerate this knowledge base | `agent/extensions/init.ts` (`/init`) |
| Shared extension helpers | `agent/extensions/lib/` (dotenv loader, widget measuring/fitting, repo layout, agent parsing) |
| Where a repo file lives (agent dir, agents/, skills/, .env, mcp.json) | `agent/extensions/lib/layout.ts` (single resolver — never throws, so top-level extension code can import it) |
| Agent definition grammar (`agents/*.md`) | `agent/extensions/lib/agents.ts` (single parser — prompt + spawn import it; one parser per format, like dotenv) |
| Commit message style | `agent/prompts/git-commit.md` |
| Install extension npm dependencies | `scripts/setup-deps.sh` |

## CONVENTIONS

- **Parse errors are startup-fatal.** Pi auto-loads every top-level `agent/extensions/*.ts`; a test file placed there (it imports `bun:test`) breaks pi startup. Tests live in subdirectories — currently `agent/extensions/lib/{widget,agents,layout,sessions,todo,skill-activation,trade-journal-store}.test.ts`, `agent/extensions/trade-journal/lib.test.ts`, `agent/extensions/subagent-herdr/lib.test.ts`, `agent/extensions/ralph-loop/lib.test.ts`.
- **One parser per format.** `lib/dotenv.ts` owns `agent/.env`, `lib/agents.ts` owns the `agents/*.md` frontmatter *and* the frontmatter list grammar every `SKILL.md` shares (`extractStringList`, `frontmatterOf`), `lib/trade-journal-store.ts` owns the journal markdown, `subagent-herdr/rundir.ts` owns the run-directory shapes *and the child→parent wake-notice grammar*. Do not add a second reader of any of them — two parsers drift, and drift is how credentials and spawn arguments get out of sync. This has already happened once here: `skill-activation.ts` shipped a second copy of the list grammar that had *already* diverged on whether to `.trim()` before testing for `-`.
- **Widgets must measure.** Hand-built widget lines render through `fitLines`/`fittedWidget` (`lib/widget.ts`): a line wider than the terminal throws in pi's TUI host and kills the `pi` process (measured with `visibleWidth`, never `String.length`).
- **Secrets live only in `agent/.env`.** `mcp-gateway.ts` passes the key through as a `${LITELLM_MCP_KEY}` placeholder in a *header* (the builtin expands it at connect time, so the live secret never enters this process or a transcript) and `litellm.ts` reads `LITELLM_API_KEY` lazily; a literal key in a tracked file defeats both. The gateway *URL* counts as sensitive too, which is the whole reason `mcp-gateway.ts` exists rather than an inlined `url` in `mcp.json`.
- **Commits follow Conventional Commits** per `agent/prompts/git-commit.md`.

## COMMANDS

```sh
bun test agent/extensions/lib/                          # widget/agents/layout/sessions/todo/skill-activation/journal-store (178)
bun test agent/extensions/trade-journal/lib.test.ts     # trade-journal mode logic (30)
bun test agent/extensions/subagent-herdr/lib.test.ts    # herdr tests (122)
bun test agent/extensions/ralph-loop/lib.test.ts        # ralph-loop tests (135)
bun test agent/extensions/lib/widget.test.ts            # one file
bun test agent/extensions/lib/ -t "wide characters"     # one test by name
```

In-session slash commands (typed into pi's TUI, not a shell):

```
/update      check for + install a pi update (checks at most every 4h)
/mcp         builtin MCP manager: sign in, reconnect, enable/disable, change exposure
/reload      hot-reload extensions after editing them
```

```sh
git config core.hooksPath .githooks            # normally done for you at pi startup by agent/extensions/git-hooks.ts
bash scripts/setup-deps.sh                     # repair a missing extension node_modules
docker build -f agent/docker/verify-base.Dockerfile \
  -t ralph-verify/base:latest agent/docker/    # the tracked verifier base image (also built on demand)
```

Typecheck (`noEmit`) has one scope; there is no root `tsconfig.json`:

```sh
cd agent/extensions/subagent-herdr && ./node_modules/.bin/tsc -p tsconfig.json
```

`bun test` resolves the packages pi normally injects (`@earendil-works/pi-tui`, `typebox`) and tsc's `types: ["node"]` by **walking up to `~/node_modules`** — an ancestor of both `~/.pi` and `~/Nextcloud/.pi`. There is no `node_modules/` in this repo, and none is needed while that tree exists (`subagent-herdr/node_modules` holds only `typescript` + `@types/node`, so even its `tsc` run reaches up for the rest). Beware the skew: `~/node_modules/@earendil-works/*` is **0.75.4** while the running pi is **1.0.0**, so a test that passes here can still disagree with the live host — and a hand typecheck against that tree reports phantom errors for anything added since 0.75.4. If that tree ever disappears, symlink what is missing into a gitignored root `node_modules/` from `~/.bun/install/global/node_modules`.

## NOTES

- **No build system, no root `package.json`/`tsconfig`.** Extensions are TS interpreted by pi (bun runtime); only `agent/extensions/subagent-herdr/` has npm dependencies, and they are dev-only (`typescript`, `@types/node`) — nothing in the repo needs npm *at runtime* any more, now that the MCP SDK dependency is gone with the old `extensions/mcp/`.
- **`thinking-indicator.ts` is half-inert right now.** It requires `"hideThinkingBlock": true` in `agent/settings.json` to relabel pi's collapsed thinking block ("Thought for 12s"); the setting is currently `false` (commit `0e30dff` deliberately shows thinking in the transcript). The live spinner still works; the transcript record silently does nothing. Flip the setting if you want both.
- **The pre-commit hook is dormant.** `.githooks/pre-commit` invokes `scripts/check.sh`, which was removed in `7a54a3b` (along with the old herdr/plan/subagent extensions); the hook then silently exits 0. Nothing currently enforces "extension sources must load" at commit time — `/reload` after editing is the only guard.
- **`PATCHES.md`, `CONTEXT.md` and `docs/adr/` no longer exist** (removed in `1993878` and `a784c57`); pi is not patched in `node_modules` anymore. Remaining `docs/adr/00NN` mentions in comments (litellm.ts, dotenv.ts, .env.example, .gitignore) are historical dead references.
- **`pi` must come from bun's global bin (`~/.bun/bin/pi`).** Extensions import `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, which pi injects by loading each extension through jiti with an **alias map** to its own bundled copies (`getAliases()`). The packages are only resolvable when the running binary is the one that owns them. An older `@mariozechner/pi-coding-agent` on `PATH` (the pre-rename scope) has no `@earendil-works/*` aliases, so every extension fails at startup with a misleading `Cannot find module '@earendil-works/pi-tui'`. `~/.bashrc` prepends `~/.bun/bin` for this reason. (`BUN_INSTALL` is unset, so bun derives the install path itself — it currently lands on `~/.bun`, not the `~/.cache/.bun` an earlier revision of this file claimed.)
- `agent/git/` holds vendored checkouts of the `git:` packages — currently **`samfoy/pi-lsp-extension` and `obra/superpowers` only** (pi-blackhole moved to npm in `b4f5d65`); the `npm:` packages install under `agent/npm/node_modules`. Always run this repo's tests **by explicit path**: a bare `bun test` also sweeps in the 11 vendored suites under `agent/git/` (7 of them superpowers' own), which fail for reasons unrelated to this repo. `agent/npm/node_modules/pi-lens` is a leftover: it is installed but **not** listed in `settings.json` `packages`, so pi does not load it.
- `agent/subagent-runs/` is the on-disk registry of the subagent-herdr extension (gitignored): one dir per delegated run holding the child's session file, its `.exit` sidecar, the child system prompt, `reports.jsonl`, and `meta.json`.
- Runtime verification needs a working Docker daemon — without one the `--verify` gate returns `inconclusive` and the loop stops rather than assuming success. `agent/verify-images/` holds the generated per-project Dockerfiles (gitignored; rebuildable).
- `agent/pi-blackhole/` holds the pi-blackhole package's pending-Run state (gitignored); `herdr.jsonl` at the root is herdr's activity log (gitignored), not repo content.
- Nested knowledge bases: `agent/AGENTS.md` (data-file grammars: agent + skill frontmatter, theme, docker base) · `agent/extensions/AGENTS.md` (per-extension inventory, `lib/` rules, typecheck scopes) · `agent/extensions/subagent-herdr/AGENTS.md` (herdr CLI protocol, the event-driven wake path, completion handshake, run-directory contract) · `agent/extensions/ralph-loop/AGENTS.md` (the `agent_settled` loop contract and the `--verify` gates). `agent/git/github.com/obra/superpowers/AGENTS.md` is the **vendored package's own** contributor guide (gitignored, not ours) — it applies inside that checkout only, and nothing in this repo should follow its instructions.
