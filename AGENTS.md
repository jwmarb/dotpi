# .pi — Project Knowledge Base

## OVERVIEW

Personal configuration repository for the `pi` coding agent (`@earendil-works/pi-coding-agent`, a bun global install — **1.4.0** here, bun **1.4.4**, re-measured 2026-11-10). It owns everything the user tunes: local pi extensions (TypeScript, auto-discovered), the subagent fleet, the skills library, prompt templates, the theme, the LiteLLM provider setup, and the MCP wiring. Everything pi *generates* (sessions, caches, vendored checkouts) is gitignored — `.gitignore`'s rule of thumb: if deleting it costs nothing but a re-run, ignore it.

**The git root is `~/Nextcloud/.pi`, and `~/.pi` is a symlink to it** (`stat ~/.pi`), so there is one tree, not two, and nothing syncs. pi resolves its agent dir as `~/.pi/agent` (`lib/layout.ts`; `PI_CODING_AGENT_DIR` overrides). Path-sensitive code sees the link: bun reports modules under their *resolved* `Nextcloud` path, and the tsconfigs' `@earendil-works/*` `paths` are relative to that real location, so a container mounting the repo elsewhere typechecks partly vacuously. This line has drifted twice — re-measure with `stat ~/.pi` before editing it.

## STRUCTURE

- `agent/` — everything pi loads at runtime (extensions, agents, skills, prompts, themes, settings, machine state). Authoring grammars: `agent/AGENTS.md`
- `agent/extensions/` — local pi extensions; **every top-level `*.ts` is auto-loaded at startup** (a subdir is entered only via its `index.ts`). 15 tracked top-level files on this host; per-file inventory: `agent/extensions/AGENTS.md`
- `agent/agents/` — subagent definitions (Markdown + YAML frontmatter). `agent/skills/` — skills library grouped by category, `skills/<category>/<skill>/SKILL.md`; `agent/prompts/` — prompt templates (`git-commit.md`: Conventional Commits); `agent/themes/` — `tokyo-night.json`
- **Skills identity is the leaf directory name, never its category path** — that is what makes refiling a skill a pure `git mv`. Every skill sits under a category, including a gitignored personal one (`lib/skill-catalogue.test.ts` walks the **live tree** and fails on one left loose). The loaded set is what is on disk plus what `settings.json` `packages` contributes — count with `find agent/skills -name SKILL.md`; every hand-maintained total in this repo has drifted. A package skill's category lives in `extensions/lib/skill-categories.ts` because its checkout is vendored.
- `agent/settings.json` — pi config (default provider/model/thinking, retry, `extensions`, `packages` with `git:`/`npm:` refs, `modelFallback`). `agent/models.json` — provider overrides (`eagle` → `http://eagle.lan:8080/v1`, LAN-only). `agent/mcp.json` — pi's builtin MCP config (robinhood + github)
- `agent/mcp.json` — servers for **pi's built-in MCP extension** (`+builtin:mcp`): `robinhood` (OAuth, `exposure: "deferred"` with a 4-getter `toolExposure` pin — `get_accounts`, `get_equity_quotes`, `get_equity_positions`, `get_portfolio` direct; no secret in the file, state lands in gitignored `agent/mcp-auth.json`) and `github` (`Authorization: Bearer ${GITHUB_TOKEN}` header, `exposure: "deferred"` with a 4-tool pin — `issue_read`, `list_issues`, `pull_request_read`, `get_file_contents` direct). The builtin validates `url` with `URL.canParse()` *before* expansion, so a secret URL cannot be a `${VAR}` in `url` itself — `${VAR}`/`!cmd` expand in `headers`/`env` only
- `agent/.env` — the ONLY file with live credentials (gitignored; `agent/.env.example` is the template)
- `agent/docker/verify-base.Dockerfile` — tracked reference image for runtime verification
- `agent/fff/`, `npm/`, `git/`, `bin/`, `pi-blackhole/`, `sessions/`, `subagent-runs/`, `verify-images/`, `cache/`, `images/` + the loose logs/JSON beside them (`trust.json` is pi's per-machine trust store) — machine state, all gitignored, none of it configuration. `agent/bin/` (search-binary drop-in) is **absent on this Linux host**; `fd`/`rg` come from `PATH`. **One exception:** `agent/pi-blackhole/pi-blackhole-config.json` is tracked config
- `.githooks/` — tracked `pre-commit`, `post-checkout`, `post-merge` (self-armed by `git-hooks.ts` on the `startup` session reason)
- `scripts/setup-deps.sh` (+ `.ps1` twin) — installs the npm deps declared under `agent/extensions/` **and** `agent/skills/` (a skill's are what its own tool imports at run time); run at startup and by the checkout/merge hooks. It links the repo-root `node_modules` to pi's packages (a bun global tree or pi's managed install). The Windows twin has no link step — see NOTES
- `scripts/install-chafa.sh` + `install-catimg.sh` — build the two startup-panel image renderers into `~/.local/bin` (no sudo, idempotent); `install.sh` runs both. `.ps1` twins exist
- `scripts/migrate-pi-bolt.sh` + `pi-bolt-compile.sh` (+ `.ps1` twins) — Pi-Bolt (AOT-compiled pi) setup, idempotent, with a timestamped settings backup. `migrate` writes the two Pi-Bolt-only `settings.json` entries itself (a `pi-bolt install` would put `opensec-pi-fff` in the shared `packages` list and plain pi would load both fff builds); `compile` excludes `@ff-labs/pi-fff` (needs the JIT), raises the AOT bytecode limit, smoke-tests the tool count without calling a model, and rolls back on failure. Re-run after editing an extension: a changed one loads from files with a warning until recompiled. README "Pi-Bolt ⚡" owns the recommendation and flags
- `scripts/check.sh` — the load/typecheck/test gate the pre-commit hook runs; `install.sh`/`install.ps1` — dotpi installers (bare machine → working config). `README.md` is the human-facing twin: keep it in sync by pointing here, not by forking the prose. `docs/` — tracked human docs incl. `model-configuration.md`. `.firecrawl/` — gitignored scrape scratch

## WHERE TO LOOK

| Task | Path |
|---|---|
| Add a local extension | `agent/extensions/<name>.ts`, or a subdir with `index.ts` |
| Ask the user a question mid-task | `agent/extensions/ask-user.ts` (`questionnaire`, `executionMode: "sequential"` so questions cannot stack) |
| Open a file in the user's default app | `agent/extensions/display-file.ts` (`display_file`) |
| Check for / install a pi update | `agent/extensions/auto-update/` (`/update`, `pi_update`; ≤ once per 4h) |
| What each extension owns | `agent/extensions/AGENTS.md` |
| Add/modify a subagent | `agent/agents/<name>.md` (grammar: `agent/AGENTS.md`) |
| Add a skill / refiler it / categorize a package skill | `agent/skills/<category>/<name>/SKILL.md`; move the dir; `lib/skill-categories.ts` |
| Find a skill wherever it sits | `agent/extensions/lib/skill-tree.ts` (the one walker) |
| Default model / provider / thinking / retry | `agent/settings.json` (`$schema` → `schemas/pi-settings.schema.json`) |
| Provider key, model catalog, pricing, thinking mapping | `agent/extensions/litellm.ts` + `agent/.env` |
| Fall back to another model when one errors | `agent/extensions/model-fallback/` (`fallback/auto`, `/fallback-chain`, `settings.json` `modelFallback`) |
| How models are configured (user guide) | `docs/model-configuration.md` |
| Add/repair an MCP server | `agent/mcp.json` (schema: pi's built-in MCP extension; runtime `/mcp`). A secret *URL* cannot be a `${VAR}` in `url` — register from an extension with `pi.registerMcpServer()` |
| Add a credential | `agent/.env` (template `agent/.env.example`) |
| The orchestrator's system prompt | `agent/extensions/dynamic-prompt.ts` (replaces pi's default with discovered inventories) |
| List/resume previous sessions | `agent/extensions/sessions.ts` (`/sessions`) |
| Pause for a bounded delay, then resume | `agent/extensions/sleep.ts` (`sleep`; required timeout ≤ 3600 s, never ends the run, wakes early on a queued message) |
| Loop on a goal until it declares completion | `agent/extensions/ralph-loop/` (`/ralph-loop`, `/ulw-loop`, `/loop-stop`; `<promise>DONE</promise>`; `--verify[=static|runtime|both]`; loop state is in-memory per session — `.claude/ralph-loop/` + `RALPH_*` belong to the legacy skill, not this extension) |
| Delegate work to a subagent | `agent/extensions/subagent-herdr/` (`subagent`, `subagent_tasks`; event-driven, no blocking wait; a stalled run is auto-diagnosed by a read-only `healthcheck` child) |
| Review changed files | `agent/extensions/changed-files.ts` (`/diff`, `/changed-files`) |
| Track the orchestrator's work on a board | `agent/extensions/kanban/` (`kanban` tool, `/kanban`, read-only side pane, widget fallback; state lives in the session branch; orchestrator only) |
| A subagent's private checklist | `agent/extensions/todo.ts` (`todo`, `/todos`; registered **only** in a spawned child) |
| Record/read trading-journal observations | `agent/extensions/trade-journal/` (`trade_journal`; gated on the `technical-analysis` skill; grammar in `lib/trade-journal-store.ts`) |
| Regenerate this knowledge base | `agent/extensions/init.ts` (`/init`) |
| Shared extension helpers | `agent/extensions/lib/` (dotenv, widget measuring, layout, agent parsing, runtime detection, skill tree/activation, project layer) |
| Run under Pi-Bolt / spawn "bun" or "pi" from an extension | `agent/extensions/lib/runtime.ts` (`runningCompiled()`, `piExecutable()`, `BE_BUN_ENV`, `piShimDir()`) |
| Spawn git against a cwd | `agent/extensions/lib/git-env.ts` (`gitEnv()` — an environment rule, not a git wrapper) |
| Where a repo file lives | `agent/extensions/lib/layout.ts` (never throws). It owns resolution plus paths with >1 caller; a single-owner segment stays with its owner (`subagent-runs/` in `subagent-herdr/rundir.ts`, `docker/` + `verify-images/` in `ralph-loop/image.ts`) |
| Agent definition grammar | `agent/extensions/lib/agents.ts` (one parser per format, like dotenv) |
| Commit message style | `agent/prompts/git-commit.md` |
| Install declared npm deps / check the repo | `scripts/setup-deps.sh` / `scripts/check.sh` (`CHECK_STAGED=1` for the index) |
| Fresh machine → working config | `install.sh` / `install.ps1` |
| Explain the setup to a human | `README.md` |
| Make anything **branded** | `~/jwmarb` — read its `AGENTS.md` first; the brand's values, contrast rules and mark live there, not here |

## CONVENTIONS

- **Parse errors are startup-fatal.** pi auto-loads every top-level `agent/extensions/*.ts`, so a test file placed there (it imports `bun:test`) breaks startup. Tests live in `agent/extensions/lib/*.test.ts` (one per module plus files that test a top-level extension) and inside each subdir extension. `scripts/check.sh` *discovers* every `*.test.ts`, so the live list is `find agent/extensions -name '*.test.ts'`, never a count kept here. **This bars the file's location, not its imports** — a test in `lib/` may import `../<extension>.js` and exercise a top-level extension directly (`lib/sessions.test.ts` does). Needing a test is not a reason to make an extension a directory.
- **One parser per format.** `lib/dotenv.ts` owns `agent/.env`; `lib/agents.ts` the `agents/*.md` frontmatter *and* the list grammar every `SKILL.md` shares; `lib/skill-tree.ts` the **shape of `agent/skills/`**; `lib/trade-journal-store.ts` the journal markdown; `subagent-herdr/rundir.ts` the run-dir shapes *and the child→parent wake-notice grammar*; `model-fallback/lib.ts` the model-reference grammar and the `PI_FALLBACK_CHAIN` handoff (`subagent-herdr` imports `CHAIN_ENV`/`FALLBACK_MODEL_REF` rather than restating them). Never add a second reader: two parsers drift, and drift is how credentials and spawn arguments go out of sync. It has happened twice here (`skill-activation.ts` shipped a copy of the list grammar that had already diverged on `.trim()`; three readers each hardcoded a flat `skills/` layout, so categorizing the library silently cost every nested skill its tools).
- **Widgets must measure.** Widget lines render through `fitLines`/`fittedWidget` (`lib/widget.ts`): a line wider than the terminal throws in pi's TUI host and kills the `pi` process (measure with `visibleWidth`, never `String.length`).
- **Extension API rules (pi runtime constraints).** Lifecycle events go through `pi.on()`; a handler must not throw — an uncaught throw in a loop handler exits the process. `pi.sendUserMessage()` is fire-and-forget, so anything that injects claims its own pending slot first. Do not block `session.settle`: a settle-time guard is a *nudge* (`agent_before_settle`, kanban `index.ts:759`; ralph-loop drives off `agent_settled`), not a gate that holds the turn open forever. `pi.getLastAssistantText()` is not on `ctx.sessionManager`, so extensions that need the transcript read the session file. An orchestrator-only extension bails out when `PI_SUBAGENT_RUN_ID` is set (kanban `index.ts:297`) so a child never registers the parent's tools.
- **Secrets live only in `agent/.env`.** `litellm.ts` reads `LITELLM_API_KEY` lazily; `firecrawl-cli.ts` loads `FIRECRAWL_API_URL` into the real `process.env` for the CLI. A literal key in a tracked file defeats both.
- **Every git spawn that targets a cwd strips the repo-locating env** (`env: gitEnv()` — `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, …). A linked worktree's hooks export them and they override `cwd`; under the pre-commit hook, `lib/init.test.ts`'s fixture git once rewrote the real `.git/config` through them.
- **Commits follow Conventional Commits** per `agent/prompts/git-commit.md`.

## COMMANDS

```sh
./scripts/check.sh                                      # every suite group + every typecheck scope + every source loads
bun test agent/extensions/lib/                          # every lib suite + the top-level extensions imported from here
bun test agent/extensions/lib/widget.test.ts            # one file
bun test agent/extensions/lib/ -t "wide characters"     # one test by name
bun test agent/extensions/trade-journal/lib.test.ts     # trade-journal mode logic
bun test agent/extensions/subagent-herdr/               # herdr: lib + child-done + run-lifecycle + release-ledger + wake + rundir + settle
bun test agent/extensions/ralph-loop/lib.test.ts        # ralph-loop
bun test agent/extensions/kanban/                       # kanban: reducer/replay/guard/layout/args/runs + publish (mocks node:fs process-wide)
bun test agent/extensions/model-fallback/               # fallback-chain state machine + the footer
find agent/extensions -name '*.test.ts'   # the live suite list (check.sh discovers, never lists)
```

In-session slash commands (typed into pi's TUI, not a shell): `/update`, `/mcp`, `/reload`, `/kanban` (`/kanban help`).

```sh
git config core.hooksPath .githooks            # normally done for you by agent/extensions/git-hooks.ts at startup
bash scripts/setup-deps.sh                     # repair a missing node_modules (extensions + skills)
CHECK_STAGED=1 ./scripts/check.sh              # the pre-commit gate, against the git index
docker build -f agent/docker/verify-base.Dockerfile -t ralph-verify/base:latest agent/docker/
```

Typecheck (`noEmit`) has **five** scopes and there is no root `tsconfig.json` (`check.sh` discovers them, so a new scope is covered the day it is added):

```sh
cd agent/extensions                && subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
cd agent/extensions/subagent-herdr && ./node_modules/.bin/tsc -p tsconfig.json   # this scope's tsc serves every scope
cd agent/extensions/model-fallback && ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
cd agent/extensions/ralph-loop     && ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
cd agent/extensions/kanban         && ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
```

Which tree a file's `@earendil-works/*` imports resolve to is **decided by the nearest `tsconfig.json` above that file — bun honours `paths` at runtime** (measured bun 1.4.3, installed 1.4.4), not just at typecheck. The nearest tsconfig wins outright: one with no `paths` falls back to the upward node walk and does *not* inherit an ancestor's mapping. `agent/extensions`, `ralph-loop`, `model-fallback` and `kanban` map `paths` to the running pi's global bun tree; `auto-update/` and `trade-journal/` (no tsconfig) inherit the parent's. `subagent-herdr` has **no `paths`**, so it opts out and resolves whatever an upward walk finds — it always needs the repo-root link. `typebox` is in no map and always resolves by the walk. The global tree is `$BUN_INSTALL/install/global/node_modules`, and the two synced machines disagree on `BUN_INSTALL` (unset here → `~/.bun`) and on the pi version — every revision that wrote these down drifted, so measure: `console.log(import.meta.resolve("@earendil-works/pi-ai"))` in a probe file in the scope, `bun` it, delete it (resolution keys off the file's location, not cwd).

## NOTES

- **No build system, no root `package.json`/`tsconfig`.** Extensions are TS interpreted by pi (bun runtime). Only `agent/extensions/subagent-herdr/` has npm deps and they are dev-only (`typescript` 5.9.3, `@types/node` 22, plus `undici-types`); nothing needs npm *at runtime* now that the MCP SDK left with the old `extensions/mcp/`. Every other bare import resolves out of a tree above the repo.
- **The pre-commit hook enforces `scripts/check.sh`.** It answers one question — does the committed repo load, type-check and pass its tests? — over gates that each *discover* their inputs: every `agent/extensions/**/*.ts` is imported (a shebang marks a CLI entrypoint, which is parsed instead), a top-level `*.test.ts` is rejected by name, every `tsconfig.json` scope runs `tsc -p`, every `*.test.ts` runs. `CHECK_STAGED=1` (what the hook sets) materialises the **git index** into `.git-check/`, so a partially staged file cannot pass here and ship broken; typecheck is skipped in that mode. The hook exits 0 early when no `^agent/extensions/.*\.ts$` is staged, and **refuses the commit** when the script is missing — it was deleted in `7a54a3b` and the hook then `|| exit 0`'d every commit after, silently, while `git-hooks.ts` kept advertising the protection.
- **`thinking-indicator.ts` is fully live** (alt+t spinner + the `setHiddenThinkingLabel` transcript record). The second half requires `"hideThinkingBlock": true`; it is **`false`** (`agent/settings.json:7`, grep it, the line moves), so the relabelling half is inert and the spinner is unaffected either way.
- **`PATCHES.md`, `CONTEXT.md` and `docs/adr/` no longer exist** (removed in `1993878`/`a784c57`); remaining `docs/adr/00NN` mentions in comments are dead references. `agent/extensions/mcp/` holds only an ignored leftover `node_modules` (no `index.ts`, so pi skips it).
- **`pi` must come from bun's global bin** (`~/.bun/bin/pi` here). Extensions import `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`, which pi injects through jiti with an **alias map** to its own bundled copies — resolvable only when the running binary owns them. An older `@mariozechner/pi-coding-agent` on `PATH` yields a misleading `Cannot find module '@earendil-works/pi-tui'`. `~/.bashrc` is empty on this host; `~/.bun/bin` reaches `PATH` through the Windows user environment.
- **`agent/git/` holds vendored `git:` checkouts — currently `samfoy/pi-lsp-extension` and `obra/superpowers` only** (pi-blackhole moved to npm in `b4f5d65`); `npm:` packages install under `agent/npm/node_modules`. Always run tests **by explicit path**: a bare `bun test` sweeps the vendored suites too. `agent/npm/node_modules/pi-lens` is installed but **not** in `settings.json` `packages`, so pi does not load it.
- **Runtime verification needs a Docker daemon** — without one the `--verify` gate returns `inconclusive` and the loop stops rather than assuming success. `agent/verify-images/` holds the generated per-project Dockerfiles (gitignored, rebuildable); synthesized Dockerfiles never land in the verified tree.
- **`agent/pi-blackhole/`** holds pending-Run state and `debug.ndjson` (gitignored) **plus the one tracked file, `pi-blackhole-config.json`**. `.gitignore` ignores the directory's *contents* (`agent/pi-blackhole/*`) rather than the directory, because git never descends into an excluded directory and a negation under one is silently dead. Tuned for a 262k window via `compactAfterRatio`, so the threshold follows whichever `modelFallback.chain` member answered.
- **On the Windows host the repo-root `node_modules` link is a manual repair.** `setup-deps.sh` locates the global tree by `readlink -f`-ing `pi` and stripping `/@earendil-works/pi-coding-agent/*`; on Windows `pi` is a standalone `.exe`, so the pattern never matches. Create it by hand: `ln -s ~/.bun/install/global/node_modules node_modules`. While missing, every scope and every pi-importing suite fails. Also on that host (not code defects): every source fails the load gate because `pwd` hands Git Bash POSIX paths bun cannot import, and the few tests spawning `/bin/sh` die in `uv_spawn`.
- **`agent/extensions/herdr-agent-state.ts` is herdr's file, never git's** — when present herdr installed it itself and `.gitignore` keeps it out of the tree, so it joins the auto-loaded set without ever appearing in `git ls-files`. **Absent on this host** (re-check with `ls agent/extensions/*.ts`), so the top-level set here is exactly the 15 tracked files.
- **Pi-Bolt (`pi-bolt`, AOT-compiled pi) runs this config unchanged, with four adaptations in `lib/runtime.ts`.** Under it `process.versions.bun` is set, `execPath` is the pi-bolt executable and `argv[1]` is `/$bunfs/root/pi`. (1) kanban: the board pane runs `env BUN_BE_BUN=1 <pi-bolt> board.ts …` — otherwise the compiled binary parses `--file` as its own flag and dies. (2) subagent-herdr: under Pi-Bolt the pane shell first exports `agent/cache/pi-shim/` (a `pi` → pi-bolt symlink; refused unless it is a private dir we own) because `herdr agent start --kind pi` types a bare `pi`; `--env PATH=` does not survive `.bashrc`; skipped on Windows (needs a POSIX shell). (3) `-builtin:herdr`: Pi-Bolt's reporter labels the pane `pi-bolt`, so `--kind pi` fails `agent_kind_mismatch`; disabling it leaves herdr's own detection in charge. (4) ralph-loop/auto-update spawn `piExecutable()`, not `argv[1]`. **Compilation is Linux/macOS only** (upstream refuses on Windows, so there none of *this config's* extensions are compiled in; the pi-level startup/memory gains still apply, but the edit loop is slower than under plain pi). **Still needed beside Pi-Bolt:** the bun `pi` install — `board.ts` and every test resolve `@earendil-works/*` through the repo-root link. A `paths` entry's five-level climb only lands in `$HOME` when the clone sits three levels below it, so at `install.sh`'s default `~/.pi` depth the link is what works; `subagent-herdr` always needs it. **Caveats:** if `herdr integration install pi` is ever run, Pi-Bolt skips `herdr-agent-state.ts` by design and with `-builtin:herdr` its panes report no state; pi-blackhole's inline compaction finds the host `AgentSession` by walking `argv[1]` to a `pi-coding-agent/package.json`, which a compiled binary lacks — `pi-bolt-host.ts` (a no-op unless compiled) writes a stand-in host package to `agent/cache/pi-bolt-host/` and points `argv[1]` at it during load.
- **Nested knowledge bases** (each owns its own subtree; never restate them here): `agent/AGENTS.md` (data-file grammars: agent + skill frontmatter, theme, docker base, machine-state map) · `agent/extensions/AGENTS.md` (per-extension inventory, `lib/` module map, typecheck scopes) · `agent/extensions/subagent-herdr/AGENTS.md` (herdr CLI protocol, the wake path, completion handshake, run-dir contract) · `agent/extensions/ralph-loop/AGENTS.md` (the `agent_settled` loop contract, the `--verify` gates) · `agent/extensions/model-fallback/AGENTS.md` (chain state machine, budgets, leases, sanitising exhaustion inputs) · `agent/extensions/kanban/AGENTS.md` (one-writer projection, settle guard, viewer gotchas). `agent/extensions/lib/` deliberately has **none** — its modules are inventoried in `agent/extensions/AGENTS.md`, and `/init` proposes the tier on size alone every time; the answer each time is no. `agent/git/github.com/obra/superpowers/AGENTS.md` is the **vendored package's own** guide (gitignored, not ours) — it applies inside that checkout only.
