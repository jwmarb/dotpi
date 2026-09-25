# agent/extensions — the local pi extensions pi auto-loads at startup

Each top-level `*.ts` is one independent extension; `lib/` is the shared, pi-free
helper layer. `ralph-loop/` and `subagent-herdr/` have their own AGENTS.md.

## WHERE TO LOOK

| File | Registers / owns |
|---|---|
| `ask-user.ts` | `questionnaire` tool — TUI option list + free-text fallback, `executionMode: "sequential"` so two questions cannot open at once |
| `changed-files.ts` | `/changed-files`, `/diff` — session change widget; tracks `write`/`edit` inputs *and* `git status --porcelain` on turn end |
| `display-file.ts` | `display_file` tool — spawns the platform opener detached, then checks for a non-zero exit instead of faking success |
| `dynamic-prompt.ts` | No tool. Hooks `before_agent_start` and **returns `{ systemPrompt }`, replacing pi's default prompt entirely** with runtime-discovered agents/tools/skills/context |
| `git-hooks.ts` | No tool. Self-arms `core.hooksPath` and runs `scripts/setup-deps.sh` at startup; swallows every failure |
| `init.ts` | `/init` — local deterministic tiering (score > 15 create, >= 8 candidate, `--max-depth` default 3), then hands the model a brief |
| `litellm.ts` | `registerProvider("litellm")` — model catalog, per-token + cache costs, `contextWindow`, thinking-level maps |
| `sessions.ts` | `/sessions` — resumable session list from pi's own `SessionManager.list()`; no JSONL re-parsing |
| `thinking-indicator.ts` | No tool. Live spinner (alt+t) + `setHiddenThinkingLabel` transcript record |
| `auto-update/` | `/update` + `pi_update` tool — version check on `session_start`, at most every 4h |
| `mcp/` | `/mcp status\|list\|refresh`; registers each MCP tool as `mcp__<server>__<tool>`. Docs: its `README.md` |
| `lib/dotenv.ts` | The single `agent/.env` parser; `requireEnv(name, purpose)` throws *named* |
| `lib/layout.ts` | Where repo files live. **Never throws** — falls back to `~/.pi/agent` |
| `lib/agents.ts` | The single `agents/*.md` frontmatter parser (`discoverAgents`, `parseAgentFile`) |
| `lib/widget.ts` | `fitLines`, `fittedWidget`, `row`, `frame`, `cachedByWidth` — the measuring seam |

## CONVENTIONS

- **A subdirectory is invisible to pi unless it has `index.ts`.** That is what makes
  `lib/` safe for `*.test.ts` and `mcp/` loadable. Adding a bare `foo.ts` at this
  level ships it into every session whether you meant to or not.
- **`lib/` modules import no pi package.** `node:*` only. They are imported from
  extension *top-level* code, which runs before pi can report an error, so a throw
  or a missing alias there is a startup failure with no diagnostic. This is why
  `layout.ts` never throws and `dotenv.ts` defers `requireEnv` to call time.
- **Import siblings with a `.js` extension** (`./lib/widget.js`) even though the file
  is `.ts` — that is what pi's jiti loader resolves. So do the `tsconfig`s
  (`moduleResolution: "bundler"`).
- **A feature detected, not assumed.** `dynamic-prompt.ts` emits its
  questionnaire and planning sections only when the `questionnaire` / `plan` tools
  are actually in `selectedTools`. The `plan` extension was removed in `7a54a3b`,
  so the planning branch is currently dead but harmless — do not emit a section
  whose tool may not exist.
- **Keep pure logic out of `index.ts`.** Both subdirectory extensions split
  `lib.ts` (pure, tested) from `index.ts` (session wiring). New complexity at this
  level should follow that split rather than growing a 1000-line top-level file.

## COMMANDS

```sh
cd mcp && npm install     # the one dir with real npm dependencies
```

The two `tsc -p` scopes are in the root COMMANDS section. What matters here is what
they do **not** cover: `lib/` and every top-level `*.ts` are in no typecheck scope at
all — nothing type-checks `dynamic-prompt.ts` or `litellm.ts` but pi loading them.

## ANTI-PATTERNS

- Putting a `*.test.ts` at this level — it imports `bun:test`, pi auto-loads it, and
  pi will not start.
- Doing real work at module top level. Register inside the default export; anything
  eager becomes a startup hazard for *every* session, and the failure surfaces before
  pi can report which extension caused it.
- Growing a top-level `*.ts` past the point where its logic wants tests. Logic that
  deserves a test cannot live at this level (see above) — that is the signal to move
  the extension into a subdirectory and split `lib.ts` from `index.ts`.

(The repo-wide rules those imply — one parser per format, widgets measure through
`lib/widget.ts` — are in the root CONVENTIONS.)
