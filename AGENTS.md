# .pi — Project Knowledge Base

## OVERVIEW

Personal configuration repository for the `pi` coding agent (`@earendil-works/pi-coding-agent`, installed globally via bun). It owns everything the user tunes: local pi extensions (TypeScript, auto-discovered), the subagent fleet definitions, the skills library, prompt templates, the TUI theme, the LiteLLM provider setup, and the MCP gateway wiring. Everything pi *generates* (sessions, caches, vendored package checkouts) is gitignored — the rule of thumb in `.gitignore`: if deleting it costs nothing but a re-run, ignore it.

**The git root is `~/.pi` itself.** pi resolves its agent directory as `~/.pi/agent` (`lib/layout.ts`, override with `PI_CODING_AGENT_DIR`). `~/Nextcloud/.pi` is a non-git leftover holding only an old `agent/` tree — the two are separate directories with no link between them on this host, so nothing "syncs" them. An earlier revision claimed `~/.pi` was a symlink to `~/Nextcloud/.pi`; `git rev-parse --show-toplevel` run from `~/.pi` is the authority, and this line has drifted before.

## STRUCTURE

- `agent/` — everything pi loads at runtime (extensions, agents, skills, prompts, themes, settings, machine state). Authoring grammars: `agent/AGENTS.md`
- `docs/` — durable records (`architecture-review-2026-10.md`: the 2026-10-02 architecture review, its 13 findings and the six commits that closed them; `architecture-review-2026-10-14.md`: the 2026-10-14 review — run lifecycle, release ledger, the linked-worktree `GIT_DIR` incident, and its rejected candidates; `superpowers/specs/2026-10-08-kanban-card-assignment-design.md`: the kanban card-assignment design spec)
- `agent/extensions/` — local pi extensions; **every top-level `*.ts` is auto-loaded by pi at startup** (subdirs are entered only via `index.ts`, e.g. `subagent-herdr/`). Per-file inventory: `agent/extensions/AGENTS.md`
- `agent/agents/` — subagent definitions (Markdown + YAML frontmatter)
- `agent/skills/` — skills library, **grouped by category**: `skills/<category>/<skill>/SKILL.md` (+ reference docs; mostly the matt-pocock set). The *skill directory* name is the identity, never its category path — that is what makes refiling a skill a pure `git mv`. Every skill sits under a category, and so does any gitignored personal one (`lib/skill-catalogue.test.ts` walks the **live tree** and fails on one left loose). The live set is whatever is on disk plus whatever the `superpowers` package contributes (`settings.json` `packages`) — count it with `find agent/skills -name SKILL.md` rather than trusting a number here; every hand-maintained total in this repo has drifted at least once. The category of a package skill lives in `extensions/lib/skill-categories.ts`, since its checkout is vendored and gitignored. Grammar and the package-skill rules: `agent/AGENTS.md`.
- `agent/prompts/` — prompt templates (`git-commit.md`: Conventional Commits)
- `agent/themes/` — TUI theme (`tokyo-night.json`)
- `agent/settings.json` — pi config: default provider/model/thinking level, retry policy, installed packages (`git:`/`npm:` refs)
- `agent/mcp.json` — MCP servers for **pi's built-in MCP extension** (`+builtin:mcp`). Two servers: `github` (Bearer `${GITHUB_TOKEN}` in `headers` — a placeholder *is* legal in `headers`/`env`, which is exactly where expansion happens) and `robinhood`, **disabled** (`enabled: false` — no secret in the file: it authenticates by OAuth, whose client+token state lands in the gitignored `agent/mcp-auth.json`). The builtin validates `url` with `URL.canParse()` *before* expansion, so a secret URL cannot be a `${VAR}` placeholder in `url` itself; `${VAR}`/`!cmd` are expanded in `headers`/`env` only
- `agent/.env` — the ONLY file with live credentials (gitignored; `agent/.env.example` is the committed template)
- `agent/docker/verify-base.Dockerfile` — tracked reference image for runtime verification
- `agent/fff/`, `agent/npm/`, `agent/git/`, `agent/bin/`, `agent/pi-blackhole/`, `agent/sessions/`, `agent/subagent-runs/`, `agent/verify-images/` — machine state, all gitignored. `agent/bin/` holds local `fd.exe`/`rg.exe` search binaries (no tracked script installs them). **One exception:** `agent/pi-blackhole/pi-blackhole-config.json` is tracked configuration (see below). So are the loose files beside them: `pi-debug.log`, `pi-tui-crash.log`, `run-history.jsonl`, `settings.json.bak`, `auth.json`, `models-store.json`, `trust.json` (pi's per-machine trust store) and `mcp-auth.json` — which is the file **pi's builtin actually writes**. `agent/mcp-auth/` (one file per OAuth'd server, e.g. `robinhood.json`) is the *old local extension's* directory, kept ignored only so a leftover never lands in git; it does not supersede the file, as a previous revision here claimed — `.gitignore:24-28` is the authority
- `.githooks/` — tracked `pre-commit`, `post-checkout`, `post-merge` (self-armed by `git-hooks.ts`)
- `scripts/setup-deps.sh` — installs the npm dependencies declared under `agent/extensions/` **and** `agent/skills/` (a skill's are what its own tool imports at run time); run at startup and by the checkout/merge hooks. It links the repo-root `node_modules` to pi's packages, resolving either a bun global tree or pi's managed install (`agent/install/releases/<current-version>/node_modules`). `scripts/setup-deps.ps1` is the native Windows twin (no repo-root link step — see NOTES)
- `scripts/install-chafa.sh` — builds chafa 1.16.2 (libchafa static, system image loaders) into `~/.local/bin` (autotools + glib headers; idempotent). `install.sh` step 5b3; powers the quad/sextant/octant/braille/ascii startup-image styles
- `scripts/install-catimg.sh` — builds catimg from a pinned commit into `~/.local/bin` (no sudo; idempotent via a ref stamp). Run by `install.sh` step 5b2; used by `startup-fetch.ts` for the startup-panel image. Images live in `agent/images/` (contents gitignored except its README, which documents `startupFetch` modes)
- `scripts/migrate-pi-bolt.sh` — one-step Pi-Bolt setup that keeps pi working. It installs Pi-Bolt if missing and checks that the bun `pi` is still there. It writes the two Pi-Bolt-only `settings.json` entries directly, because `pi-bolt install` would put opensec-pi-fff in the shared `packages` list and plain pi would load both fff builds. It installs opensec-pi-fff into `agent/npm`, then runs `pi-bolt-compile.sh`. Every step is idempotent and a timestamped settings backup is kept. `--check` reports without changing anything, `--undo` removes the Pi-Bolt-only settings and turns the compiled build off, and `--no-compile` skips the compile. `install.sh --pi-bolt` runs it as step 7
- `scripts/pi-bolt-compile.sh` — compiles the extensions into Pi-Bolt (`pi-bolt compile`), excluding `@ff-labs/pi-fff` (needs the JIT; Pi-Bolt runs `opensec-pi-fff` via `settings.json` `piBolt.packages`) and raising the AOT bytecode limit. It smoke-tests the result by comparing the tool count before and after, without calling a model, and runs `pi-bolt update --rollback` on failure. `--status` and `--off` pass through to `pi-bolt compile`. Re-run it after editing an extension: a changed one is loaded from its files with a warning until it is recompiled
- `scripts/check.sh` — the load/typecheck/test guard the pre-commit hook runs (see NOTES)

- `install.sh` / `install.ps1` — the dotpi installers: bare machine → working pi config (checks bun/git/npm, clones the repo, arms the hooks, installs deps + the firecrawl/agent-browser CLIs, offers herdr, seeds `agent/.env` from the template)
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
| Pause and end the current agent turn | `agent/extensions/sleep.ts` (`sleep` tool — required timeout in seconds, max 3600; the terminating call must be alone in its tool batch) |
| Loop the agent on a goal until it declares completion | `agent/extensions/ralph-loop/` (`/ralph-loop`, `/ulw-loop`, `/loop-stop`; `--verify[=static\|runtime\|both]`) |
| Delegate work to a subagent | `agent/extensions/subagent-herdr/` (`subagent`, `subagent_tasks` tools incl. `interrupt`; event-driven — no blocking wait, the child wakes the parent; stalled or unanswered runs are auto-diagnosed by a read-only `healthcheck` child whose `healthCheckOf` tags the target, and the target's no-answer briefing is held until the health check completes) |
| Review changed files (+/− counts) | `agent/extensions/changed-files.ts` (`/diff` modal, `/changed-files`) |
| Track the orchestrator's work on a board | `agent/extensions/kanban/` (`kanban` tool, `/kanban`; a read-only herdr side pane opened on every session start except `/reload` (which adopts the open pane, or respects that you closed it), widget fallback. State lives in the session branch — the board only reads a projection. Orchestrator only) |
| A subagent's private checklist | `agent/extensions/todo.ts` (`todo` tool, `/todos`; registered **only** in a spawned child, which gets it appended to its `--tools` by `subagent-herdr`) |
| Record/read trading-journal observations | `agent/extensions/trade-journal/` (`trade_journal` tool; modes record/read/stats/dupes. Gated on the `technical-analysis` skill being active; grammar in `lib/trade-journal-store.ts`) |
| Regenerate this knowledge base | `agent/extensions/init.ts` (`/init`) |
| Shared extension helpers | `agent/extensions/lib/` (dotenv loader, widget measuring/fitting, repo layout, agent parsing) |
| Run under Pi-Bolt (compiled pi) / spawn "bun" or "pi" from an extension | `agent/extensions/lib/runtime.ts` (`runningCompiled()`, `piExecutable()`, `BE_BUN_ENV`, `piShimDir()`; see NOTES) |
| Spawn git against a cwd (the env it must run under) | `agent/extensions/lib/git-env.ts` (`gitEnv()` — an environment rule, not a git wrapper) |
| Where a repo file lives (agent dir, agents/, skills/, .env, settings.json) | `agent/extensions/lib/layout.ts` (resolves the agent dir — never throws, so top-level extension code can import it). It owns *resolution* plus the paths with more than one caller; a segment with a single owner stays with that owner — `subagent-runs/` in `subagent-herdr/rundir.ts`, `docker/` and `verify-images/` in `ralph-loop/image.ts` |
| Agent definition grammar (`agents/*.md`) | `agent/extensions/lib/agents.ts` (single parser — prompt + spawn import it; one parser per format, like dotenv) |
| Commit message style | `agent/prompts/git-commit.md` |
| Install declared npm dependencies (extensions + skills) | `scripts/setup-deps.sh` |
| Check the repo loads, type-checks and passes tests | `scripts/check.sh` (`CHECK_STAGED=1` for the index) |
| Fresh machine → working pi config | `install.sh` (Linux/macOS) / `install.ps1` (Windows) |

## CONVENTIONS

- **Parse errors are startup-fatal.** Pi auto-loads every top-level `agent/extensions/*.ts`; a test file placed there (it imports `bun:test`) breaks pi startup. Tests therefore live in subdirectories, which pi enters only via `index.ts` — `agent/extensions/lib/*.test.ts` plus one `lib.test.ts` per subdirectory extension (`trade-journal/`, `subagent-herdr/`, `ralph-loop/`, `model-fallback/`, `kanban/`); `bun test agent/extensions/lib/` and the COMMANDS block below are the live list. **This bars the test file's location, not its imports:** a test in `lib/` may import `../<extension>.js` and exercise a top-level extension's pure logic directly, which `lib/sessions.test.ts` already does. Needing a test is not by itself a reason to make an extension a directory.
- **One parser per format.** `lib/dotenv.ts` owns `agent/.env`, `lib/agents.ts` owns the `agents/*.md` frontmatter *and* the frontmatter list grammar every `SKILL.md` shares (`extractStringList`, `frontmatterOf`), `lib/skill-tree.ts` owns the **shape of `agent/skills/`** (where a skill is, and what category it is in), `lib/trade-journal-store.ts` owns the journal markdown, `subagent-herdr/rundir.ts` owns the run-directory shapes *and the child→parent wake-notice grammar*, `model-fallback/lib.ts` owns the model-reference grammar and the `PI_FALLBACK_CHAIN` handoff (`subagent-herdr` imports `CHAIN_ENV`/`FALLBACK_MODEL_REF` from it rather than restating either). Do not add a second reader of any of them — two parsers drift, and drift is how credentials and spawn arguments get out of sync. This has already happened twice here: `skill-activation.ts` shipped a second copy of the list grammar that had *already* diverged on whether to `.trim()` before testing for `-`, and three separate readers each hardcoded a flat `skills/` layout, so categorizing the library silently cost every nested skill its tools and agents until `skill-tree.ts` became the one walker.
- **Widgets must measure.** Hand-built widget lines render through `fitLines`/`fittedWidget` (`lib/widget.ts`): a line wider than the terminal throws in pi's TUI host and kills the `pi` process (measured with `visibleWidth`, never `String.length`).
- **Secrets live only in `agent/.env`.** `litellm.ts` reads `LITELLM_API_KEY` lazily and `firecrawl-cli.ts` loads `FIRECRAWL_API_URL` into the real `process.env` so the `firecrawl` CLI can see it; a literal key in a tracked file defeats both.
- **Every git spawn that targets a cwd strips the repo-locating env** (`env: gitEnv()` from `agent/extensions/lib/git-env.ts`: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, …). A linked worktree's hooks export `GIT_DIR`/`GIT_INDEX_FILE`, which override `cwd`; under the pre-commit hook `lib/init.test.ts`'s fixture git once rewrote the real `.git/config` (`core.bare=true`, a test `user.email`) through them.
- **Commits follow Conventional Commits** per `agent/prompts/git-commit.md`.

## COMMANDS

```sh
./scripts/check.sh                                      # every suite group + every typecheck scope + every source loads
bun test agent/extensions/lib/                          # widget/agents/layout/sessions/todo/skill-*/journal-store
                                                        #   + dynamic-prompt/changed-files/init (top-level extensions,
                                                        #     imported from here — legal, and the only legal place)
bun test agent/extensions/trade-journal/lib.test.ts     # trade-journal mode logic
bun test agent/extensions/subagent-herdr/               # herdr: lib + child-done + run-lifecycle + release-ledger + wake (5 suites)
bun test agent/extensions/ralph-loop/lib.test.ts        # ralph-loop
bun test agent/extensions/kanban/                       # kanban: reducer, replay, guard, layout, board args, runs, the role gate + projection publish (Windows rename)
bun test agent/extensions/model-fallback/lib.test.ts    # fallback-chain state machine
bun test agent/extensions/lib/widget.test.ts            # one file
bun test agent/extensions/lib/ -t "wide characters"     # one test by name
```

In-session slash commands (typed into pi's TUI, not a shell):

```
/update      check for + install a pi update (checks at most every 4h)
/mcp         builtin MCP manager: sign in, reconnect, enable/disable, change exposure
/reload      hot-reload extensions after editing them
/kanban      reopen the orchestrator's board pane after closing it; add/move/note/link/drop/…, show/close/restart (/kanban help)
```

```sh
git config core.hooksPath .githooks            # normally done for you at pi startup by agent/extensions/git-hooks.ts
bash scripts/setup-deps.sh                     # repair a missing node_modules (extensions + skills)
./scripts/check.sh                             # every gate the pre-commit hook runs
CHECK_STAGED=1 ./scripts/check.sh              # ...against the git index, as the hook does
docker build -f agent/docker/verify-base.Dockerfile \
  -t ralph-verify/base:latest agent/docker/    # the tracked verifier base image (also built on demand)
```

Typecheck (`noEmit`) has five scopes; there is no root `tsconfig.json`:

```sh
cd agent/extensions/subagent-herdr && ./node_modules/.bin/tsc -p tsconfig.json
cd agent/extensions/model-fallback && ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
cd agent/extensions/ralph-loop     && ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
cd agent/extensions/kanban         && ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
cd agent/extensions                && subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
```

Which tree a file's `@earendil-works/*` imports resolve to is **decided by the nearest
`tsconfig.json` above that file — bun honours `paths` at runtime** (measured on bun 1.4.3),
not just at typecheck. The nearest tsconfig wins outright: one with no `paths` falls back to the
node upward walk and does *not* inherit an ancestor's mapping. Four scopes (`agent/extensions`,
`ralph-loop`, `model-fallback`, `kanban`) map `paths` at the running pi's global bun tree, and
dirs with no tsconfig (`auto-update/`, `trade-journal/`) inherit that. `subagent-herdr`'s tsconfig
has **no `paths`**, so it opts out and resolves whatever an upward walk finds. `typebox` is in no
`paths` map, so it always resolves by the upward walk.

The global tree is `$BUN_INSTALL/install/global/node_modules`, and the two synced machines
disagree on `BUN_INSTALL` (`~/.cache/.bun` here, unset → `~/.bun` on the other) and on the pi
version. Every past revision that wrote these down drifted, so measure instead: put
`console.log(import.meta.resolve("@earendil-works/pi-ai"))` in `<scope>/probe.ts`, `bun` it,
delete it (resolution keys off the file's location, not cwd).

**Measured on this host (Windows, 2026-10-13):** `BUN_INSTALL` is unset, so the global tree is
`~/.bun/install/global/node_modules` — pi **1.2.0**, typebox 1.3.27. A repo-root `node_modules`
symlink points there (a manual repair on this machine — see NOTES), so the upward walk from
every scope, `subagent-herdr` included, lands on that same 1.2.0; the ancestor `~/node_modules`
(once a stale 0.75.4) is gone from this machine, and without the link every `@earendil-works/*`
import fails loudly. `subagent-herdr`'s type-only `ExtensionAPI` imports (`index.ts:101`,
`child-done.ts:98` — its only two such imports) are load-bearing through that link: without it,
the module is missing outright. Anything reaching for a newer API in a paths-less scope needs a
`paths` entry; copy `model-fallback/tsconfig.json`'s for anything new.

The absence of a resolvable tree is a loud failure, not a silent degradation: `trade-journal`
and `model-fallback` import `@earendil-works/pi-ai` and simply fail to load. On the machine
whose links went missing that took `scripts/check.sh` from 749 passing tests to 594 plus two
load failures — treat the *load failures* as the signature rather than any total. This tree
passes its tests as of this revision; count it with `scripts/check.sh` rather than comparing against a fixed figure. On this Windows host, two artifacts are not code defects: every source file fails the load gate because `pwd` hands Git Bash POSIX paths (`/c/Users/…`) that bun cannot import (the same files import fine by relative path), and the handful of tests that spawn `/bin/sh` (kanban's `shell quoting`, `lib/init.test.ts`'s git discovery) fail with `uv_spawn '/bin/sh'`. The 1.2.0 upgrade briefly turned the top-level typecheck scope red: `dynamic-prompt.ts` read `event.prompt` un-narrowed, but 1.2.0 moved it behind the `messageType` discriminator of `BeforeAgentStartEvent` (user events carry `prompt`, custom events `message`); it is now narrowed on `messageType === 'user'` and all five scopes pass.

## NOTES

- **No build system, no root `package.json`/`tsconfig`.** Extensions are TS interpreted by pi (bun runtime); only `agent/extensions/subagent-herdr/` has npm dependencies, and they are dev-only (`typescript` 5.9.3, `@types/node` 22) — nothing in the repo needs npm *at runtime* any more, now that the MCP SDK dependency is gone with the old `extensions/mcp/`. Its `node_modules` holds **only** those two (plus `undici-types`): every other bare import resolves out of a tree above the repo, per COMMANDS above.
- **`thinking-indicator.ts` is fully live.** Both halves work: the alt+t spinner during reasoning, and the `setHiddenThinkingLabel` transcript record ("Thought for 12s (ctrl+t to expand)") afterwards. The second half requires `"hideThinkingBlock": true` in `agent/settings.json` — without it pi renders thinking in full, there is no placeholder to relabel, and that half silently does nothing. The setting is **`false` now**, so the relabelling half is inert; setting it to `true` activates it, while the spinner is unaffected either way.
- **The pre-commit hook enforces `scripts/check.sh`.** The script answers one question — "does the committed repo load, type-check and pass its tests?" — over three gates: every `agent/extensions/**/*.ts` is *imported* (a shebang marks a CLI entrypoint, which is parsed instead), a top-level `*.test.ts` is rejected by name, every discovered `tsconfig.json` scope runs `tsc -p`, and every discovered `*.test.ts` runs. `CHECK_STAGED=1` (what the hook sets) materialises the **git index** into `.git-check/` and checks that, so a partially staged file cannot pass here and ship broken; typecheck is skipped in that mode because the scratch copy cannot resolve the running pi's bundle. Gates two and three discover their inputs rather than listing them, so a new scope or suite is covered the day it is added. It was deleted in `7a54a3b` as collateral damage and the hook then `|| exit 0`'d for every commit after — silently, while `git-hooks.ts` kept advertising the protection. The hook now **refuses the commit** when the script is missing: the failure being guarded is silence, so the guard must not be able to vanish quietly. Bypass a single commit with `--no-verify`.
- **`PATCHES.md`, `CONTEXT.md` and `docs/adr/` no longer exist** (removed in `1993878` and `a784c57`); pi is not patched in `node_modules` anymore. Remaining `docs/adr/00NN` mentions in comments (litellm.ts, dotenv.ts, .env.example, .gitignore) are historical dead references. `agent/extensions/mcp/` holds only an ignored leftover `node_modules` (no `index.ts`, so pi skips it).
- **`pi` must come from bun's global bin (`$BUN_INSTALL/bin/pi`; `~/.bun/bin/pi` on this machine).** Extensions import `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, which pi injects by loading each extension through jiti with an **alias map** to its own bundled copies (`getAliases()`). The packages are only resolvable when the running binary is the one that owns them. An older `@mariozechner/pi-coding-agent` on `PATH` (the pre-rename scope) has no `@earendil-works/*` aliases, so every extension fails at startup with a misleading `Cannot find module '@earendil-works/pi-tui'`. **`BUN_INSTALL` is unset on this machine**, so bun derives the install path itself and the global tree is `~/.bun/install/global/node_modules`; elsewhere read the path from `echo $BUN_INSTALL` — the machines differ. `~/.bashrc` is empty on this machine — `~/.bun/bin` reaches `PATH` through the Windows user environment, and `pi` there is a bun `.exe` shim rather than a symlink (which is also why `setup-deps.sh` cannot find the global tree; see the next note).
- `agent/git/` holds vendored checkouts of the `git:` packages — currently **`samfoy/pi-lsp-extension` and `obra/superpowers` only** (pi-blackhole moved to npm in `b4f5d65`); the `npm:` packages install under `agent/npm/node_modules`. Always run this repo's tests **by explicit path**: a bare `bun test` also sweeps in the 11 vendored suites under `agent/git/` (7 of them superpowers' own), which fail for reasons unrelated to this repo. `agent/npm/node_modules/pi-lens` is a leftover: it is installed but **not** listed in `settings.json` `packages`, so pi does not load it.
- `agent/subagent-runs/` is the on-disk registry of the subagent-herdr extension (gitignored): one dir per delegated run holding the child's session file, its `.exit` sidecar, the child system prompt, `reports.jsonl`, and `meta.json`.
- Runtime verification needs a working Docker daemon — without one the `--verify` gate returns `inconclusive` and the loop stops rather than assuming success. `agent/verify-images/` holds the generated per-project Dockerfiles (gitignored; rebuildable).
- `agent/pi-blackhole/` holds the pi-blackhole package's pending-Run state and `debug.ndjson` (gitignored), **plus the one tracked file in it: `pi-blackhole-config.json`**, the compaction/observational-memory config. `.gitignore` ignores the directory's *contents* (`agent/pi-blackhole/*`) rather than the directory, because git never descends into an excluded directory and a negation under one is silently dead. Tuned for a 262k-token window via `compactAfterRatio` (not a fixed `compactAfterTokens`), so the threshold follows whichever `modelFallback.chain` member actually answered. `herdr.jsonl` at the root is herdr's activity log (gitignored), not repo content.
- **On this Windows host, the repo-root `node_modules` link is a manual repair.** `setup-deps.sh` locates the global tree by `readlink -f`-ing `pi` and stripping `/@earendil-works/pi-coding-agent/*` from the result; on Windows `pi` is a standalone `.exe`, so `readlink -f` returns the exe itself, the pattern never matches, and the script ends with "could not locate pi's node_modules (bun global tree or managed install)". `setup-deps.ps1` has no link step at all. Create it by hand from the repo root: `ln -s ~/.bun/install/global/node_modules node_modules`. While it is missing, every typecheck scope and every suite importing pi packages fails — `scripts/check.sh` went from green to 47 failed checks on this machine for exactly that reason.
- **`agent/extensions/herdr-agent-state.ts` is auto-loaded but not in git.** herdr installs and overwrites it itself (its header says so), and `.gitignore` keeps it out of the tree — so the top-level extension list includes one file `git ls-files` will never show, and a fresh clone gets its first copy when herdr next starts.
- **Pi-Bolt (`pi-bolt`, the AOT-compiled pi) runs this config unchanged, with four adaptations in `lib/runtime.ts`.** Under it `process.versions.bun` is set, `process.execPath` is the pi-bolt executable itself and `process.argv[1]` is the virtual `/$bunfs/root/pi`. (1) **kanban**: `findBun()` used to return `execPath` for any bun-hosted pi, so Pi-Bolt was asked to run `board.ts` and died parsing `--file` as a pi flag. The board pane now runs `env BUN_BE_BUN=1 <pi-bolt> board.ts …`, which makes the compiled executable behave as plain bun. (2) **subagent-herdr**: `herdr agent start --kind pi` types a bare `pi`, which `~/.bashrc` resolves to the bun install, so children silently ran node pi. Under Pi-Bolt, the pane shell first exports `agent/cache/pi-shim/` (gitignored; refused unless it is a private dir we own), which holds a `pi` → pi-bolt symlink. `--env PATH=` does not survive `.bashrc`. This needs a POSIX shell and is skipped on Windows, where children still run the bun `pi`. (3) **`settings.json` `-builtin:herdr`**: Pi-Bolt's built-in herdr reporter reports the pane as agent `pi-bolt`, and `--kind pi` then fails with `agent_kind_mismatch`. Disabling it leaves herdr's own pi detection in charge, which is what node pi always used. (4) **ralph-loop / auto-update**: the gate spawns `piExecutable()` instead of `argv[1]`. Under Pi-Bolt, `/update` checks the `pi-bolt` npm package and runs `pi-bolt update`, never `bun update`. Measured on Pi-Bolt 1.0.2 / herdr 0.9.0 (2026-10-24): board pane, kanban tool, a delegated worker run and its done handshake all worked end to end. **Still needed beside Pi-Bolt:** the bun pi install. `board.ts` (run as plain bun) and every test resolve `@earendil-works/*` through the repo-root `node_modules` link, which `setup-deps.sh` finds from the bun `pi` on PATH. **Known caveats:** (a) if `herdr integration install pi` is ever run, Pi-Bolt skips that `herdr-agent-state.ts` by design, and with `-builtin:herdr` its panes then report no state. (b) pi-blackhole's mid-run inline compaction finds the host `AgentSession` by walking `argv[1]` to a `pi-coding-agent/package.json`, which a compiled binary does not have. `agent/extensions/pi-bolt-host.ts` (a no-op unless compiled) handles this without patching the package. It writes a stand-in host package to `agent/cache/pi-bolt-host/` that re-exports the real `AgentSession`, and points `argv[1]` at it while extensions load (top-level extensions load before packages), then restores it at `session_start`. Measured identical under pi and pi-bolt: 3 inline compactions plus 4 compaction entries on the same scripted session.
- Nested knowledge bases: `agent/AGENTS.md` (data-file grammars: agent + skill frontmatter, theme, docker base) · `agent/extensions/AGENTS.md` (per-extension inventory, `lib/` rules, typecheck scopes) · `agent/extensions/subagent-herdr/AGENTS.md` (herdr CLI protocol, the event-driven wake path, completion handshake, run-directory contract) · `agent/extensions/ralph-loop/AGENTS.md` (the `agent_settled` loop contract and the `--verify` gates) · `agent/extensions/model-fallback/AGENTS.md` (the chain state machine, the two budgets, why every message is sanitised). `agent/extensions/lib/` deliberately has **none** — its modules are inventoried in `agent/extensions/AGENTS.md`, and a second file there would be the duplication this hierarchy exists to avoid; `/init` proposes it as a tier on size alone, and the answer each time is no. `agent/git/github.com/obra/superpowers/AGENTS.md` is the **vendored package's own** contributor guide (gitignored, not ours) — it applies inside that checkout only, and nothing in this repo should follow its instructions.
