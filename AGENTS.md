# .pi — Project Knowledge Base

## OVERVIEW

Personal configuration repository for the `pi` coding agent (`@earendil-works/pi-coding-agent`, installed globally via bun). It owns everything the user tunes: local pi extensions (TypeScript, auto-discovered), the subagent fleet definitions, the skills library, prompt templates, the TUI theme, the LiteLLM provider setup, and the MCP gateway wiring. Everything pi *generates* (sessions, caches, vendored package checkouts) is gitignored — the rule of thumb in `.gitignore`: if deleting it costs nothing but a re-run, ignore it.

**The git root is `~/Nextcloud/.pi`; `~/.pi` is a symlink to it.** pi resolves its agent directory as `~/.pi/agent` (`lib/layout.ts`, override with `PI_CODING_AGENT_DIR`), so docs and code say `~/.pi/...` while `git rev-parse --show-toplevel` says `~/Nextcloud/.pi`. Same files, two names — do not "fix" one into the other.

## STRUCTURE

- `agent/` — everything pi loads at runtime (extensions, agents, skills, prompts, themes, settings, machine state). Authoring grammars: `agent/AGENTS.md`
- `docs/` — durable records (currently `architecture-review-2026-10.md`: the 2026-10-02 architecture review, its 13 findings and the six commits that closed them)
- `agent/extensions/` — local pi extensions; **every top-level `*.ts` is auto-loaded by pi at startup** (subdirs are entered only via `index.ts`, e.g. `subagent-herdr/`). Per-file inventory: `agent/extensions/AGENTS.md`
- `agent/agents/` — subagent definitions (Markdown + YAML frontmatter)
- `agent/skills/` — skills library, **grouped by category**: `skills/<category>/<skill>/SKILL.md` (+ reference docs; mostly the matt-pocock set). The *skill directory* name is the identity, never its category path — that is what makes refiling a skill a pure `git mv`. Every skill sits under a category, including a gitignored personal one (`lib/skill-catalogue.test.ts` walks the **live tree** and fails on one left loose). The live set is whatever is on disk plus whatever the `superpowers` package contributes (`settings.json` `packages`) — count it with `find agent/skills -name SKILL.md` rather than trusting a number here; every hand-maintained total in this repo has drifted at least once. The category of a package skill lives in `extensions/lib/skill-categories.ts`, since its checkout is vendored and gitignored. Grammar and the package-skill rules: `agent/AGENTS.md`.
- `agent/prompts/` — prompt templates (`git-commit.md`: Conventional Commits)
- `agent/themes/` — TUI theme (`tokyo-night.json`)
- `agent/settings.json` — pi config: default provider/model/thinking level, retry policy, installed packages (`git:`/`npm:` refs)
- `agent/mcp.json` — MCP servers for **pi's built-in MCP extension** (`+builtin:mcp`). Two servers: `github` (Bearer `${GITHUB_TOKEN}` in `headers` — a placeholder *is* legal in `headers`/`env`, which is exactly where expansion happens) and `robinhood` (no secret in the file: it authenticates by OAuth, whose client+token state lands in the gitignored `agent/mcp-auth.json`). The builtin validates `url` with `URL.canParse()` *before* expansion, so a secret URL cannot be a `${VAR}` placeholder in `url` itself; `${VAR}`/`!cmd` are expanded in `headers`/`env` only
- `agent/.env` — the ONLY file with live credentials (gitignored; `agent/.env.example` is the committed template)
- `agent/docker/verify-base.Dockerfile` — tracked reference image for runtime verification
- `agent/fff/`, `agent/npm/`, `agent/git/`, `agent/pi-blackhole/`, `agent/sessions/`, `agent/subagent-runs/`, `agent/verify-images/` — machine state, all gitignored. **One exception:** `agent/pi-blackhole/pi-blackhole-config.json` is tracked configuration (see below). So are the loose files beside them: `pi-debug.log`, `pi-tui-crash.log`, `run-history.jsonl`, `settings.json.bak`, `auth.json`, `models-store.json`, `mcp-auth.json`, and the `agent/mcp-auth/` directory that supersedes it (one file per OAuth'd server, e.g. `robinhood.json`)
- `.githooks/` — tracked `pre-commit`, `post-checkout`, `post-merge` (self-armed by `git-hooks.ts`)
- `scripts/setup-deps.sh` — installs the npm dependencies declared under `agent/extensions/` **and** `agent/skills/` (a skill's are what its own tool imports at run time); run at startup and by the checkout/merge hooks
- `scripts/check.sh` — the load/typecheck/test guard the pre-commit hook runs (see NOTES)

## WHERE TO LOOK

| Task | Path |
|---|---|
| Add a local extension | `agent/extensions/<name>.ts` (or a subdir with `index.ts`, like `subagent-herdr/`) |
| Ask the user a question mid-task | `agent/extensions/ask-user.ts` (`questionnaire` tool; `executionMode: "sequential"` so questions cannot stack) |
| Open a file in the user's default app | `agent/extensions/display-file.ts` (`display_file` tool) |
| Check for / install a pi update | `agent/extensions/auto-update/` (`/update`, `pi_update` tool; checks at most every 4h) |
| What each extension owns | `agent/extensions/AGENTS.md` |
| Add/modify a subagent | `agent/agents/<name>.md` (grammar: `agent/AGENTS.md`) |
| Add a skill | `agent/skills/<category>/<name>/SKILL.md` (frontmatter keys: `agent/AGENTS.md`) |
| Find a skill wherever it sits in the tree | `agent/extensions/lib/skill-tree.ts` (single walker — the three readers that used to each do their own one-level `readdir`) |
| Change a skill's category / categorize a package skill | move the directory; for a package skill, `agent/extensions/lib/skill-categories.ts` |
| Change default model / provider / thinking / retry | `agent/settings.json` |
| Provider key, model catalog, pricing, thinking-level mapping | `agent/extensions/litellm.ts` + `agent/.env` |
| Fall back to another model when one errors | `agent/extensions/model-fallback/` (`fallback/auto` virtual model, `/fallback-chain`; chain in `settings.json` `modelFallback`, own AGENTS.md) |
| Add/repair an MCP server | `agent/mcp.json` (schema: pi's built-in MCP extension; runtime: `/mcp`). A server needing a secret *URL* cannot use a `${VAR}` placeholder in `url` — register it from an extension with `pi.registerMcpServer()` instead |
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
| Where a repo file lives (agent dir, agents/, skills/, .env, settings.json) | `agent/extensions/lib/layout.ts` (resolves the agent dir — never throws, so top-level extension code can import it). It owns *resolution* plus the paths with more than one caller; a segment with a single owner stays with that owner — `subagent-runs/` in `subagent-herdr/rundir.ts`, `docker/` and `verify-images/` in `ralph-loop/image.ts` |
| Agent definition grammar (`agents/*.md`) | `agent/extensions/lib/agents.ts` (single parser — prompt + spawn import it; one parser per format, like dotenv) |
| Commit message style | `agent/prompts/git-commit.md` |
| Install declared npm dependencies (extensions + skills) | `scripts/setup-deps.sh` |
| Check the repo loads, type-checks and passes tests | `scripts/check.sh` (`CHECK_STAGED=1` for the index) |

## CONVENTIONS

- **Parse errors are startup-fatal.** Pi auto-loads every top-level `agent/extensions/*.ts`; a test file placed there (it imports `bun:test`) breaks pi startup. Tests therefore live in subdirectories, which pi enters only via `index.ts` — `agent/extensions/lib/*.test.ts` plus one `lib.test.ts` per subdirectory extension (`trade-journal/`, `subagent-herdr/`, `ralph-loop/`, `model-fallback/`); `bun test agent/extensions/lib/` and the COMMANDS block below are the live list. **This bars the test file's location, not its imports:** a test in `lib/` may import `../<extension>.js` and exercise a top-level extension's pure logic directly, which `lib/sessions.test.ts` already does. Needing a test is not by itself a reason to make an extension a directory.
- **One parser per format.** `lib/dotenv.ts` owns `agent/.env`, `lib/agents.ts` owns the `agents/*.md` frontmatter *and* the frontmatter list grammar every `SKILL.md` shares (`extractStringList`, `frontmatterOf`), `lib/skill-tree.ts` owns the **shape of `agent/skills/`** (where a skill is, and what category it is in), `lib/trade-journal-store.ts` owns the journal markdown, `subagent-herdr/rundir.ts` owns the run-directory shapes *and the child→parent wake-notice grammar*, `model-fallback/lib.ts` owns the model-reference grammar and the `PI_FALLBACK_CHAIN` handoff (`subagent-herdr` imports `CHAIN_ENV`/`FALLBACK_MODEL_REF` from it rather than restating either). Do not add a second reader of any of them — two parsers drift, and drift is how credentials and spawn arguments get out of sync. This has already happened twice here: `skill-activation.ts` shipped a second copy of the list grammar that had *already* diverged on whether to `.trim()` before testing for `-`, and three separate readers each hardcoded a flat `skills/` layout, so categorizing the library silently cost every nested skill its tools and agents until `skill-tree.ts` became the one walker.
- **Widgets must measure.** Hand-built widget lines render through `fitLines`/`fittedWidget` (`lib/widget.ts`): a line wider than the terminal throws in pi's TUI host and kills the `pi` process (measured with `visibleWidth`, never `String.length`).
- **Secrets live only in `agent/.env`.** `litellm.ts` reads `LITELLM_API_KEY` lazily and `firecrawl-cli.ts` loads `FIRECRAWL_API_URL` into the real `process.env` so the `firecrawl` CLI can see it; a literal key in a tracked file defeats both.
- **Commits follow Conventional Commits** per `agent/prompts/git-commit.md`.

## COMMANDS

```sh
./scripts/check.sh                                      # all five suites + every typecheck scope + every source loads
bun test agent/extensions/lib/                          # widget/agents/layout/sessions/todo/skill-*/journal-store
                                                        #   + dynamic-prompt/changed-files/init (top-level extensions,
                                                        #     imported from here — legal, and the only legal place)
bun test agent/extensions/trade-journal/lib.test.ts     # trade-journal mode logic
bun test agent/extensions/subagent-herdr/lib.test.ts    # herdr
bun test agent/extensions/ralph-loop/lib.test.ts        # ralph-loop
bun test agent/extensions/model-fallback/lib.test.ts    # fallback-chain state machine
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
bash scripts/setup-deps.sh                     # repair a missing node_modules (extensions + skills)
./scripts/check.sh                             # every gate the pre-commit hook runs
CHECK_STAGED=1 ./scripts/check.sh              # ...against the git index, as the hook does
docker build -f agent/docker/verify-base.Dockerfile \
  -t ralph-verify/base:latest agent/docker/    # the tracked verifier base image (also built on demand)
```

Typecheck (`noEmit`) has four scopes; there is no root `tsconfig.json`:

```sh
cd agent/extensions/subagent-herdr && ./node_modules/.bin/tsc -p tsconfig.json
cd agent/extensions/model-fallback && ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
cd agent/extensions/ralph-loop     && ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
cd agent/extensions                && subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
```

`model-fallback` resolves `@earendil-works/*` through a `paths` entry pointing at the
**running pi's** bundle, because the 0.75.4 tree described below has no virtual-model API at
all. Copy that pattern for anything new that touches a post-0.75.4 API.

`bun test` resolves the packages pi normally injects (`@earendil-works/*`, `typebox`) and tsc's `types: ["node"]` from **whichever of two trees the host has**. This file is synced between machines that genuinely differ here, and each arrangement has been written into this paragraph as the only one — so verify before trusting either: `cd agent/extensions/lib && bun -e 'console.log(import.meta.resolve("@earendil-works/pi-ai"))'` names the winner.

- **An ancestor `~/node_modules`** (what this machine has), a parent of both `~/.pi` and `~/Nextcloud/.pi`. No `node_modules/` in this repo is needed while it exists — `subagent-herdr/node_modules` holds only `typescript` + `@types/node`, so even its `tsc` run reaches up for the rest. Beware the skew: its `@earendil-works/*` is **0.75.4** while the running pi is **1.0.2**, so a test that passes here can still disagree with the live host, and a hand typecheck against that tree reports phantom errors for anything added since 0.75.4. The `paths` entry above is `model-fallback` dodging exactly this.
- **A gitignored root `node_modules/` in this repo**, whose entries are per-package symlinks into bun's global tree and so resolve to **1.0.2**, the same version as the running pi — test and hand typecheck then agree with the live host, and the skew warning above does not apply. Build it by symlinking each missing package out of bun's global `node_modules` (see below for where that is), **one entry per package rather than one link for the whole scope directory**: `@earendil-works/` holds three such links and a scope-level link would shadow them.

Either way the absence of a resolvable tree is a loud failure, not a silent degradation: `trade-journal` and `model-fallback` import `@earendil-works/pi-ai` and simply fail to load. On the machine whose links went missing that took `scripts/check.sh` from 749 passing tests to 594 plus two load failures — those are the figures from that incident, not a current count to compare against (this tree passes **753** as of this merge), so treat the *two load failures* as the signature rather than any total.

## NOTES

- **No build system, no root `package.json`/`tsconfig`.** Extensions are TS interpreted by pi (bun runtime); only `agent/extensions/subagent-herdr/` has npm dependencies, and they are dev-only (`typescript`, `@types/node`) — nothing in the repo needs npm *at runtime* any more, now that the MCP SDK dependency is gone with the old `extensions/mcp/`.
- **`thinking-indicator.ts` is fully live.** Both halves work: the alt+t spinner during reasoning, and the `setHiddenThinkingLabel` transcript record ("Thought for 12s (ctrl+t to expand)") afterwards. The second half requires `"hideThinkingBlock": true` in `agent/settings.json` — without it pi renders thinking in full, there is no placeholder to relabel, and that half silently does nothing. The setting is **`false` now**: with it off, reasoning renders inline and the transcript record is inert; the spinner is unaffected either way. Flipping it back to `true` restores the record.
- **The pre-commit hook enforces `scripts/check.sh`.** The script answers one question — "does the committed repo load, type-check and pass its tests?" — over three gates: every `agent/extensions/**/*.ts` is *imported* (a shebang marks a CLI entrypoint, which is parsed instead), a top-level `*.test.ts` is rejected by name, every discovered `tsconfig.json` scope runs `tsc -p`, and every discovered `*.test.ts` runs. `CHECK_STAGED=1` (what the hook sets) materialises the **git index** into `.git-check/` and checks that, so a partially staged file cannot pass here and ship broken; typecheck is skipped in that mode because the scratch copy cannot resolve the running pi's bundle. Gates two and three discover their inputs rather than listing them, so a new scope or suite is covered the day it is added. It was deleted in `7a54a3b` as collateral damage and the hook then `|| exit 0`'d for every commit after — silently, while `git-hooks.ts` kept advertising the protection. The hook now **refuses the commit** when the script is missing: the failure being guarded is silence, so the guard must not be able to vanish quietly. Bypass a single commit with `--no-verify`.
- **`PATCHES.md`, `CONTEXT.md` and `docs/adr/` no longer exist** (removed in `1993878` and `a784c57`); pi is not patched in `node_modules` anymore. Remaining `docs/adr/00NN` mentions in comments (litellm.ts, dotenv.ts, .env.example, .gitignore) are historical dead references.
- **`pi` must come from bun's global bin (`~/.bun/bin/pi` on this machine).** Extensions import `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, which pi injects by loading each extension through jiti with an **alias map** to its own bundled copies (`getAliases()`). The packages are only resolvable when the running binary is the one that owns them. An older `@mariozechner/pi-coding-agent` on `PATH` (the pre-rename scope) has no `@earendil-works/*` aliases, so every extension fails at startup with a misleading `Cannot find module '@earendil-works/pi-tui'`. `~/.bashrc` prepends that bin directory for this reason. (**`BUN_INSTALL` is unset here**, so bun derives the install path itself and the global tree is `~/.bun/install/global/node_modules`; the `~/.cache/.bun` a previous revision asserted does not exist on this host. This line has now drifted three times, in both directions, because the two synced machines disagree — so read it out of `~/.bashrc` or `echo $BUN_INSTALL` rather than trusting any claim here, including this one.)
- `agent/git/` holds vendored checkouts of the `git:` packages — currently **`samfoy/pi-lsp-extension` and `obra/superpowers` only** (pi-blackhole moved to npm in `b4f5d65`); the `npm:` packages install under `agent/npm/node_modules`. Always run this repo's tests **by explicit path**: a bare `bun test` also sweeps in the 11 vendored suites under `agent/git/` (7 of them superpowers' own), which fail for reasons unrelated to this repo. `agent/npm/node_modules/pi-lens` is a leftover: it is installed but **not** listed in `settings.json` `packages`, so pi does not load it.
- `agent/subagent-runs/` is the on-disk registry of the subagent-herdr extension (gitignored): one dir per delegated run holding the child's session file, its `.exit` sidecar, the child system prompt, `reports.jsonl`, and `meta.json`.
- Runtime verification needs a working Docker daemon — without one the `--verify` gate returns `inconclusive` and the loop stops rather than assuming success. `agent/verify-images/` holds the generated per-project Dockerfiles (gitignored; rebuildable).
- `agent/pi-blackhole/` holds the pi-blackhole package's pending-Run state and `debug.ndjson` (gitignored), **plus the one tracked file in it: `pi-blackhole-config.json`**, the compaction/observational-memory config. `.gitignore` ignores the directory's *contents* (`agent/pi-blackhole/*`) rather than the directory, because git never descends into an excluded directory and a negation under one is silently dead. Tuned for a 262k-token window via `compactAfterRatio` (not a fixed `compactAfterTokens`), so the threshold follows whichever `modelFallback.chain` member actually answered. `herdr.jsonl` at the root is herdr's activity log (gitignored), not repo content.
- Nested knowledge bases: `agent/AGENTS.md` (data-file grammars: agent + skill frontmatter, theme, docker base) · `agent/extensions/AGENTS.md` (per-extension inventory, `lib/` rules, typecheck scopes) · `agent/extensions/subagent-herdr/AGENTS.md` (herdr CLI protocol, the event-driven wake path, completion handshake, run-directory contract) · `agent/extensions/ralph-loop/AGENTS.md` (the `agent_settled` loop contract and the `--verify` gates) · `agent/extensions/model-fallback/AGENTS.md` (the chain state machine, the two budgets, why every message is sanitised). `agent/extensions/lib/` deliberately has **none** — its nine modules are inventoried in `agent/extensions/AGENTS.md`, and a second file there would be the duplication this hierarchy exists to avoid. `agent/git/github.com/obra/superpowers/AGENTS.md` is the **vendored package's own** contributor guide (gitignored, not ours) — it applies inside that checkout only, and nothing in this repo should follow its instructions.
