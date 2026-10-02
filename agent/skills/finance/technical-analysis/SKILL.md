---
name: technical-analysis
tools: trade_journal
description: Technical and structural analysis on a stock, ETF, or index — moving averages, MACD+RSI, fair value gaps, order blocks, trading sessions, dealer gamma exposure (GEX), earnings event risk, news and social sentiment, macro event risk, and a delegated trading journal. Use when the user asks for technical analysis, a TA or chart read, indicator values (RSI, MACD, ATR, Bollinger, VWAP, pivots), support/resistance, FVG or order blocks, gamma exposure or gamma flip, session behavior (Asia/London/NY), earnings dates or expected move, whether news and sentiment back up price action, or to recall and record journal observations on a ticker.
---

# Technical Analysis

Produce a **read**: pull data, run the scripts, state each signal, then synthesize a bias
where price structure, dealer positioning, and sentiment either agree or conflict.

Scripts live in `~/.agentic-trading/scripts/` (pure stdlib — no numpy/pandas/scipy).
They exist so bulk data never enters context: a full options chain is hundreds of
records, and the script returns ~15 lines. Pass data in, read the aggregate out.

They are **machine state, not repo content** — they live outside the `.pi` git root and
are not installed by this skill. The six the steps below call are `structure.py`,
`sessions.py`, `gex.py`, `earnings.py`, `sentiment.py` and `macro.py`. If one is absent,
say so and fall back to the MCP data directly rather than inventing its output; a
fabricated aggregate is worse than a missing one.

## Steps

1. **Fix the scope, and recall what is already known.**
   Exact ticker (resolve a name with `search`). Interval: whatever the user names — default
   `day`. Depth: a **quick read** is steps 2+3+6; a **full read** adds gamma (4) and
   sentiment (5). Ask only if the request is ambiguous about depth.

   Then recall what is already recorded on the name — a file read, so do it every time:
   ```
   trade_journal mode:read ticker:<TICKER>
   ```
   Recorded history changes how you weigh live signals. When the ticker has a long history
   and you want the *pattern* rather than the entries, delegate `journal-reflector` instead
   (async: fire it here and let it land while you gather data). See [journal.md](journal.md).
   *Done: symbol, interval, which of steps 4-5 are in scope, and the journal consulted.*

2. **Pull price data and the indicator stack.**
   In one parallel batch: `get_equity_quotes`, then `get_equity_technical_indicators` per
   row of [the stack](#the-indicator-stack) with `output: latest`, and
   `get_equity_historicals` over enough bars for the longest warm-up (on `day`, ~250
   sessions for the SMA 200; intraday, ~200 bars). Add `get_index_quotes` on SPX
   (id via `get_indexes`) for the tape.
   *Done: every stack row has a value; a failed call is named in the read, never dropped.*

3. **Run price structure and sessions.**
   Save the historicals JSON, then:
   ```bash
   python3 ~/.agentic-trading/scripts/structure.py --bars bars.json --price <spot>
   python3 ~/.agentic-trading/scripts/sessions.py --bars bars.json --now
   ```
   `structure.py` returns fresh FVGs and order blocks with distance from spot;
   `sessions.py` returns which session is live and how volume splits across them.
   See [strategies.md](strategies.md) for what the zones mean and how to trade them.
   *Done: nearest support zone and resistance zone named, with their state and distance.*

4. **Gamma (full read).** Follow the bounded recipe in [gamma.md](gamma.md) — it caps the
   chain fetch so context stays affordable — then:
   ```bash
   python3 ~/.agentic-trading/scripts/gex.py --instruments i.json --quotes q.json --spot <spot>
   ```
   *Done: total GEX sign, gamma flip level, call wall, put wall — or an explicit note that
   the chain was too thin to resolve them.*

5. **Sentiment and event risk (full read).**
   ```bash
   python3 ~/.agentic-trading/scripts/sentiment.py --ticker <T> --company "<Name>"
   python3 ~/.agentic-trading/scripts/macro.py --within 72h
   ```
   Read tone from the hits, not the number — the score is a word count. Details and
   caveats in [sentiment.md](sentiment.md).

   **On a single stock, always check earnings.** `get_earnings_results` gives the next
   report date and `timing`; an earnings gap moves a name ~10× a normal session and
   respects no level on the chart:
   ```bash
   python3 ~/.agentic-trading/scripts/earnings.py --bars daily.json \
     --report-dates <past dates> --next <YYYY-MM-DD:pm> --spot <spot> --atr <atr>
   ```
   Method and interpretation in [earnings.md](earnings.md).
   *Done: tone stated with the headlines behind it; any High-impact macro event inside 72h
   named; and for a single stock, days to the next report with its expected move — or an
   explicit "no earnings inside the horizon".*

6. **Synthesize.**
   Name the **confluence**: which signals agree, which conflict, and the net bias
   (bullish / bearish / neutral). Then, in order:
   - **Levels** — nearest support and resistance from FVG/OB/pivots, and what a close
     beyond each would mean.
   - **Regime** — positive gamma damps moves toward walls, negative amplifies them. When
     structure and gamma disagree, gamma governs *how* price travels, structure *where*.
   - **Risk** — stop framed on ATR (≈1.5×ATR from entry), widened if a High-impact event
     lands inside the horizon. An earnings print inside the horizon **overrides** the
     technical stop: no ATR multiple contains a gap of ~10× a normal session.
   - **Conflicts, stated plainly.** Bullish structure into a call wall with Friday NFP is
     not a clean long, and the read should say so. A textbook setup two days before
     earnings is a coin flip wearing a chart pattern.
   *Done: a bias, two levels, an ATR stop, and every conflict named — each with its numbers.*

7. **Deliver, then record.**
   A compact table (signal → value → state), then the synthesis. End with offers, not
   actions: an alert on a level (`create_alert`), a watchlist add, a re-read at another
   interval.

   If the session produced something a future read could not recompute — a level tested, an
   event reaction, a regime that did or did not behave — record it with the numbers you
   actually computed:
   ```
   trade_journal mode:record ticker:<TICKER> date:<the day it is ABOUT> observations:["..."]
   ```
   Not every read earns an entry; recomputable values never do. Delegate `journal-observer`
   instead when you want it to judge what is worth keeping. See [journal.md](journal.md).
   *Done: the read is in front of the user; offers are explicit, nothing executed; anything
   worth recalling is in the journal.*

## The indicator stack

| Row | Call | Bullish | Bearish |
|-----|------|---------|---------|
| Trend | `ema` 20, `ema` 50, `sma` 200 | Price above all three; EMAs stacked ascending | Price below all three; stacked descending |
| Momentum | `rsi` 14 | 50–70, or recovering up from <30 | <50; >70 overbought, <30 oversold — exhaustion flags |
| Momentum | `macd` (12/26/9) | Line above signal; histogram rising; fresh zero-line cross up | Line below signal; histogram falling |
| Volatility | `atr` 14 | Not directional — sets the stop distance | |
| Volatility | `bollinger_bands` 20/2 | Upper-band ride inside an uptrend | Lower-band ride; a squeeze precedes a breakout, direction set by the first close outside |
| Volume | 30-bar history; relative volume = latest ÷ mean | Move up on relative volume >1 — confirmed | Move on <1 — unconfirmed |
| Levels | `pivot_points` classic | Price above the daily pivot | Price below the daily pivot |

**Intraday intervals:** swap the `sma` 200 row for `vwap` (price above VWAP reads bullish);
the EMAs carry the trend row. The MA + MACD/RSI playbooks are in
[strategies.md](strategies.md).

## Honesty rules

These carry the read's credibility, so they are not optional:

- **Name the regime, never a prediction.** Report what dealers must hedge and where
  structure sits; the read describes conditions, not outcomes.
- **Say when a signal is absent.** "No gamma flip in range" and "no fresh FVG" are
  findings. Fabricating a level is the one unrecoverable error.
- **Quote the freshness.** Options OI is a prior-session snapshot; `updated_at` on quotes
  can be stale out of hours; the macro feed is this-week-only. State the asof time.
- **Sentiment tone is a word count.** Show the hits that produced it and let the user judge.
