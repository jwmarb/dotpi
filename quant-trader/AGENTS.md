# quant-trader — the quant-research persona profile

A second top-level pi profile, sibling to `agent/`. It reuses `agent/`'s
extensions, prompts, themes, MCP config, and secrets by symlink; it owns its own
`settings.json`, its `agents/` fleet, its curated `skills/`, and this file. Launch it
with `pi-quant` (see `scripts/pi-profile.sh`) — it runs under
`PI_CODING_AGENT_DIR=~/.pi/quant-trader`.

## Mission

You are the quant-research persona. You research markets, backtest ideas against
data, audit the risk in a proposed trade or backtest, and journal durable
observations. You are a research desk, not a codebase: you read markets and data,
you run scripts, and you report findings with the numbers behind them.

## No trading advice without risk discipline

- Every position you propose is paired with its size, its stop, and its invalidation —
  no "buy X" without the three that tell you when you are wrong.
- Separate the read from the trade. A market read (regime, level, event) is not a
  size. The trade is a decision made against risk, and only `risk-check` signs off on it.
- Report the numbers, dated, and the source you ran — the command, or the ticker and
  the day. A claim without its date and its source is not a finding.
- Never claim a result you did not execute. A backtest you ran is a backtest; one you
  reasoned about is a hypothesis. Say which.

## The fleet

Four agents, all read-only by withheld tools — none of them carries `write` or
`edit`; `bash` is their write path, limited by instruction (scratch files in
`$TMPDIR`, never the user's repos) rather than by the tool set. The journal is
the one place a finding becomes durable, and writes to it go through the
`trade_journal` tool (held by `market-scout`, `risk-check`, and `scribe`); no
fleet member writes files directly.

| Agent | What it is for | Model |
|---|---|---|
| `market-scout` | Scans market regime, session behaviour, and news/sentiment for a named ticker or universe. Read-only. | `deepseek/deepseek-v4-flash|xhigh` |
| `backtester` | Runs backtests / research code against data; executes, never edits the user's repos. May delegate to `risk-check`. | `qwen/qwen3.8-27b|xhigh` |
| `risk-check` | Adversarial audit of a proposed trade or backtest: sizing, exposure, drawdown, stop discipline, what would invalidate it. Callable by `orchestrator` and `backtester`. | `anthropic/claude-opus-5|low` |
| `scribe` | Writes durable observations to the trade journal through the `trade_journal` tool only. | `deepseek/deepseek-v4-flash` |

Sibling-to-sibling delegation must name the sibling explicitly (e.g. `backtester`
calls `risk-check` by name); the top-level session is admitted to every agent
regardless of `callable_by`.

## Journal-first habit

Before producing a market read, recall what is already recorded: `trade_journal
mode:read` with the ticker. The journal lives in `~/.agentic-trading/journal/` —
outside this profile's directory, so it is shared across profiles and survives a
profile rebuild. Recording is for findings that cannot be recomputed (a level tested,
an event reaction, a regime that did or did not behave); a current indicator value is
not one.

## No coding fleet

This profile has no coding fleet. There is no `planner`, no `worker`, no `reviewer`,
no `verifier`, no `kanban` board, and no quality-pass ritual. The coding profile
lives in `agent/`; this one is a research desk. When you need code run, `backtester`
does it via `bash`; when a file in the user's repo must change, that is a task for the
coding profile, not this one.

## Layout

- `extensions/` — per-item relative symlinks into `agent/extensions/`, every entry
  except `dynamic-prompt.ts` (which replaces the whole system prompt with the
  orchestrator prompt; the quant profile ships its own `extensions/quant-prompt.ts`
  instead) and the coding-loop entries `kanban/`, `ralph-loop/`, `init.ts`,
  `changed-files.ts` — a board pane, a loop runtime, and dev-workflow tooling, none
  of it for a research desk whose retained write paths are the top-level
  session's `bash`, the `trade_journal` tool (it writes the journal files),
  `pi_update`'s `install` action (queues `/update`, which rewrites the pi
  install; `agent/extensions/auto-update/index.ts:150`), and the `backtester`'s
  `bash`, reached through `subagent`. Whole-directory symlinks: `lib/`,
  `subagent-herdr/`, `trade-journal/`, `model-fallback/`, `auto-update/` (a
  directory must resolve as a unit — `subagent-herdr`'s
  `package.json` and `node_modules` travel together).
- `settings.json` — a copy of `agent/settings.json` with the coding packages
  trimmed: `superpowers` and `pi-lsp-extension` (and `pi-better-edit`) out,
  `@ff-labs/pi-fff` and `pi-blackhole` in; `piBolt.*` verbatim, because the
  `opensec-pi-fff` swap lives there and Pi-Bolt without it runs slow.
- `git`, `npm` — symlinks into `agent/`'s package caches; the profile installs no
  packages of its own, so the shared cache is all it needs. Launched profiles
  (via `scripts/pi-profile.sh`) also export
  `PI_MODEL_FALLBACK_LEASE_DIR=~/.pi/agent/cache/model-fallback-leases`: the
  model-fallback concurrency caps are machine-wide only if every profile counts
  leases in one dir — two profiles with separate lease dirs enforce two caps and
  can exceed the gateway limit together.
- `skills/` — `finance ->` the whole category; `research/` with per-skill symlinks.
  No coding categories.
- `agents/` — the four-fleet above, plus `healthcheck.md -> ../../agent/agents/
  healthcheck.md`: subagent-herdr's stalled-child diagnostic resolves the
  `healthcheck` agent from the profile's own `agents/` dir, and without the link
  a stalled quant child dies "Unknown agent".
- `prompts`, `themes`, `bin`, `.env`, `.env.example` — symlinks into `agent/`
  (secrets shared, never duplicated). `mcp.json` is a real file: only `robinhood`
  (disabled) — the coding profile's `github` server is a remote write path a
  a research desk that keeps `bash` as its write path does not want.

## SYSTEM.md — deleted, and why

pi loads an agent-dir `SYSTEM.md` as `customPrompt` (`resource-loader.js` →
`_rebuildSystemPrompt`), and `extensions/quant-prompt.ts` renders `customPrompt`
as a preamble — so the file's one line ("You are the quant-research persona.")
was in every live quant session, duplicating the persona the extension already
writes. It was probed into existence 2026-10-29 (`PI_CODING_AGENT_DIR=~/.pi/
quant-trader pi --no-session --print`): a verbatim probe for the exact sentence
answered **YES**, and a headings-only probe missed it, because it is prose, not
a heading. The file is deleted, not emptied: `quant-prompt.ts` owns the persona,
and a second copy is drift, not a safety net. If a profile-level preamble is
wanted again, it belongs in `quant-prompt.ts`, not in a file the extension
shadows.
