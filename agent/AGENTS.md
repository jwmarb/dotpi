# agent — the runtime tree pi reads: data files, their grammars, and machine state

This tier owns the **non-code** configuration: agent and skill definitions, prompts, the
theme, provider/MCP config, the verification base image, and the gitignored state dirs.
Code that reads them lives in `extensions/` (own AGENTS.md); the delegation mechanism behind
`skills:`/`callable_by` is in `extensions/subagent-herdr/AGENTS.md`. **No commands are
declared here** — it is data; checks run from the repo root (`scripts/check.sh`), and the
grammars are pinned by `extensions/lib/agents.test.ts` and `skill-catalogue.test.ts` (walks the live `skills/`).

## WHERE TO LOOK

| Question | Answer |
|---|---|
| Which agents exist, on what model | `agents/*.md` — 10: explorer, healthcheck, librarian, oracle, planner, reviewer, spiker, summarizer, verifier, worker. Read frontmatter for models; never copy a table here |
| Which skills exist / are slash-only | `find agent/skills -name SKILL.md`; `grep -rl 'disable-model-invocation: true' agent/skills` (15 today). 12 category dirs; `skills/other/` holds only the ignored `uarizona-hpc` |
| Skill with its own tool/agents | `technical-analysis` alone (`tools: trade_journal`, 3 `agents/*.md`, no `openai.yaml`); `automate-browser` has `allowed-tools:` + `hidden: true`. Other `agents/` dirs hold `openai.yaml` only (presentation, defines no agents) |
| Prompt templates | `prompts/git-commit.md` (`name: git-commits`) |
| Builtins / packages / router | `settings.json`: `+builtin:mcp`, `+codemode`, `-llama.cpp`, `-tool-search`, `-herdr`; `defaultProvider/defaultModel` = `fallback/auto`; `modelFallback.*`; `packages`; `piBolt.*` |
| Provider overrides | `models.json` — `providers.<name>.{baseUrl, api, apiKey, models[{id, contextWindow, maxTokens}]}`; `eagle` → `http://eagle.lan:8080/v1` (LAN host, not portable) |
| MCP servers | `mcp.json`: only `robinhood`, `enabled: false`, OAuth (`oauth.clientName`). `persona-mcp.json`: `github` with `Authorization: Bearer ${GITHUB_TOKEN}`, `exposure: "direct"` |
| Secret key names | `.env.example` (`LITELLM_API_KEY`, `LITELLM_BASE_URL`, `FIRECRAWL_API_URL`, `GITHUB_TOKEN`); real `.env` is ignored |
| Theme keys | `themes/tokyo-night.json` (`$schema` → pi's bundled `theme-schema.json`) |
| Verifier container | `docker/verify-base.Dockerfile` — `node:24-slim`, `AGENT_BROWSER_VERSION=0.38.1`, no CMD/ENTRYPOINT; parent of generated `verify-images/<proj>-<hash>/` |

## CONVENTIONS

- **`settings.json` load-bearing keys:** `fallback/auto` (a real model disables the router),
  `retry.provider.maxRetries: 0` (provider retry fights the router), `modelFallback.*`,
  `extensions`, `packages` (object form `extensions: ["-…"]` excludes a package extension),
  `piBolt.packagesOverlay` (boolean; keeps `opensec-pi-fff` out of plain pi). `-builtin:herdr` matters:
  Pi-Bolt's reporter labels the pane `pi-bolt`, so `herdr agent start --kind pi` fails `agent_kind_mismatch`.
- **MCP is pi's built-in extension** (`+builtin:mcp`); no local `extensions/mcp/`. `${VAR}` expands
  in `headers`/`env` only — `url` is validated before expansion, so a secret URL needs
  `pi.registerMcpServer()` from an extension. OAuth tokens land in ignored `mcp-auth.json`
  (`mcp-auth/` is old leftovers). Manage with `/mcp`.
- **Agent frontmatter vocabulary** (parsed only by `extensions/lib/agents.ts`): `name`,
  `description`, `tools`, `model`, `fallback_models`, `skills`, `callable_by`. snake_case —
  a camelCase key silently never matches. Body = child system prompt verbatim (+ skills catalogue).
- **`description` is the routing signal** ("use me when…"). **`tools` is an allowlist and the
  read-only agents' enforcement** — never widen one; add a new definition.
- **`skills:` is the only way a child sees skills**; it also needs `read`/`read_skill`. Identity is
  the leaf dir name (category is path only); skill-tree lookup belongs to `extensions/lib/skill-tree.ts`.
- **`callable_by` is the delegation graph; absent = orchestrator-only.** Sentinels `orchestrator`
  and `any` (unused). Live edges: `worker → reviewer, verifier, librarian`; `reviewer, verifier,
  spiker, oracle → librarian`; `librarian → summarizer, spiker, explorer`. Adding an edge = callee's
  `callable_by` + caller's body + `EXPECTED` in `subagent-herdr/lib.test.ts`. Enforced by
  `lineageRejection`/`delegationRoster` in `extensions/lib/agents.ts`.
- **`fallback_models` feeds the child's router**: `childFallbackChain` (`subagent-herdr/lib.ts`) →
  `PI_FALLBACK_CHAIN`, child always on `fallback/auto`. Entries may pin `ref|level`
  (`off|minimal|low|medium|high|xhigh|max`; grammar in `model-fallback/lib.ts` `parseChainItem`).
  An explicit delegation `model` yields a singleton chain. Verify refs on the gateway
  (`/model_group/info`) — an unreachable tail degrades a running child.
- **Searching agents declare `ffgrep`/`fffind`**; never `fff-multi-grep` (needs `PI_FFF_MULTIGREP=1`).
  **Spawning agents declare `subagent_tasks`** and pass `cwd` when the grandchild must read another tree.
- **`healthcheck` is spawned only by `subagent-herdr`** (`requestHealthCheck`); it lacks `subagent`
  tools, which blocks recursive health checks.
- **Mentioning `<result>` in a prompt makes it a runtime contract**: the child cannot complete until
  it writes a full `<result>…</result>` as visible text (not reasoning, not a `subagent_done` argument).
- **Slash-only skills** (`disable-model-invocation: true`) need a human; `argument-hint` prefills.
- **Personal-identity skills stay untracked** via a `.gitignore` path (`skills/other/uarizona-hpc/`), not placeholders.
- **The superpowers bootstrap extension is excluded** (`-.pi/extensions/superpowers.ts`): its every-turn
  mandate pressures slash-only skills and its tool mapping is wrong here. `pi list` shows `(filtered)`.

## ANTI-PATTERNS

- Hand-editing gitignored state: `sessions/`, `subagent-runs/`, `verify-images/`, `fff/`, `npm/`,
  `git/`, `cache/`, `.firecrawl/`, `pi-blackhole/*`, `auth.json`, `models-store.json`, `mcp-auth.json`,
  `trust.json`, `run-history.jsonl`, `settings.json.bak`, `*.log`. **Exception:** tracked
  `pi-blackhole/pi-blackhole-config.json` (edit directly or `/blackhole settings`). Ignore shapes differ
  (contents vs path); check `git check-ignore -v <path>`.
- `du`/`grep -r` over all of `agent/` (~1.1 GB: runs, sessions, skill `node_modules`, npm).
- Following `git/github.com/obra/superpowers/AGENTS.md` — the vendored package's guide, not this repo's.
- Editing `docker/verify-base.Dockerfile` without building and running it; every line was a bug first.
- Duplicating a skill to tweak a section, or restating one `superpowers` already ships.
