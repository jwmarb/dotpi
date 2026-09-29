# Trading journal

Accumulated knowledge about how a specific name behaves. Scripts recompute indicators on
demand; the journal holds what no script can derive — that this ticker round-trips its
earnings gaps, that a level has held three times, that RSI divergence is worthless on it.

Lives in `~/.agentic-trading/journal/`, one markdown file per day (`2026-07-26.md`), with a
`## <TICKER>` heading per name.

## Tool for mechanics, agents for judgment

There are two ways in, and picking the wrong one is the main cost here.

The **`trade_journal` tool** does the deterministic work — it is a file operation, so it is cheap
enough to use on every read:

| Mode | Does |
|---|---|
| `record` | Appends observations to a day file; skips exact duplicates |
| `read` | Plays back one day, or one ticker across days (narrow with `since`/`until`/`limit`; newest first, default 30 days) |
| `stats` | Corpus shape: files, tickers, observation counts, date span |
| `dupes` | Byte-identical bullets across days — consolidation candidates |

The **three agents** do the judgment, and each costs a subagent spawn:

| Agent | Role | Access |
|---|---|---|
| `journal-observer` | Decides what is worth recording, and writes it | read/write |
| `journal-reflector` | Reads the corpus, returns patterns with counts | **read-only** |
| `journal-curator` | Decides what is safe to prune or merge | read/write |

**The rule:** use the tool when you already know what to write or want raw entries back;
delegate an agent when the answer requires a verdict. Recording a line you just computed is
`trade_journal record`, not a subagent — spawning a process to append one bullet is pure overhead.
Asking "does this level actually hold?" is `journal-reflector`, because that is a judgment
across many entries with sample sizes attached.

Both read and write the same markdown files, so they interoperate freely: the tool can read
what an agent wrote by hand, and vice versa. `record` rewrites the whole day file, but it
parses it losslessly first — a `## Patterns` heading, curator prose and `<!-- ... -->`
comments all survive. Only `## TICKER` (uppercase) is a ticker heading; anything else is
preserved as-is rather than absorbed into the ticker above it.

The agents' read-only/read-write split is enforced by their tool lists — the reflector
*cannot* rewrite the corpus it analyzes.

Delegation is asynchronous: you get a task id, then end your turn and the agent wakes you.

## When to reach for each

**Before the read — `trade_journal read`.** At step 1, once the ticker is fixed. A file read, so do
it every time:

```
trade_journal mode:read ticker:NVDA
```

Recorded history changes how you weigh live signals: a level the journal shows holding three
times deserves more than one seen once on today's chart.

**Delegate the reflector instead when you need the pattern, not the entries.** It reads the
whole corpus and returns counts — which is also why it is the cheaper path once a ticker has
many entries: twenty files in, ten lines out.

```
subagent journal-reflector "What does the journal record about NVDA? Report repeat
behaviors, level reliability with counts, what has not worked, and anything that changed."
```

**After the read — `trade_journal record`.** When the session produced something a future read
could not recompute. Hand it the numbers you actually computed:

```
trade_journal mode:record ticker:NVDA date:2026-09-25 observations:[
  "Bullish FVG 221.71-223.92 (1.52x ATR) held the retest on 2.8x average volume; third defense.",
  "Dealer gamma positive +34.4M per 1%; pinned within 0.3% of the 770 call wall all session."
]
```

Not every read earns an entry, and recomputable values never do. `date` is the day the
observation is **about** — recording Friday's session on Saturday still uses Friday.

**Delegate the observer instead** when you want it to decide *what* is worth recording from a
session, rather than writing lines you have already chosen.

**Occasionally — `trade_journal dupes`, then the curator.** Once a ticker has many entries, recall
degrades. The tool finds the identical lines; the curator decides what merging is safe:

```
trade_journal mode:dupes ticker:NVDA
subagent journal-curator "Consolidate these duplicates, preserving the counts and dates.
<paste the dupes output>. Report the plan before removing anything."
```

## Writing a good observation

The test is whether it survives three months. Compare:

| Worthless | Usable |
|---|---|
| "NVDA looked strong" | "Held 221.71 on 2.8× average volume, third defense of that zone" |
| "Earnings went well" | "Gapped +6.3%, closed +8.7%, gave back −4.6% next session — gap and go then round-trip" |
| "Gamma was positive" | "Positive gamma +34M/1%; pinned within 0.3% of the 770 call wall all session, as predicted" |
| "RSI was 62" | (drop — a script recomputes this) |

State the observation and your interpretation separately, so a later session can
re-interpret the same fact without inheriting today's conclusion.

## Rules

- **The date belongs to the observation, not the writing.** Recording Friday's session on
  Saturday still goes in Friday's file.
- **Match the cost to the question.** `trade_journal record` / `read` are file operations; use them
  freely. Delegate an agent only for a verdict — what is worth keeping, what repeats, what is
  safe to prune. A subagent spawned to append one line is pure overhead.
- **A silent journal is a valid answer.** If the reflector reports no entries, say so and
  proceed on live data. Never let an empty journal become invented history.
- **Never ask the observer to record a prediction.** The journal records what happened.
  A thesis is recorded as the thesis held at entry, with its outcome appended later — never
  revised to look correct.
