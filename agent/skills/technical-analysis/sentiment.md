# Sentiment and event risk

Price action tells you *what* is happening; news and positioning tell you *why*, and whether
it has legs. Two scripts: `sentiment.py` (news + social tone) and `macro.py` (scheduled
event risk).

## What actually works (verified 2026-09-28)

| Source | Status | Notes |
|---|---|---|
| Google News RSS per ticker | ✅ 200, XML | The per-ticker workhorse. `?q=NVDA+stock` |
| CNBC, MarketWatch, WSJ markets | ✅ 200, XML | Market-wide tone |
| BBC business, NYT business, CNN money | ✅ 200, XML | Macro backdrop |
| Reddit **JSON** API | ❌ **403** | Blocked for every User-Agent — OAuth enforcement, not UA sniffing. The keyless JSON API is gone. |
| Reddit **`.rss`** (Atom) | ✅ 200 | The keyless path. Rate-limits hard: **429 even at 8s spacing**, so ~1 req/min sustained. |
| ForexFactory `faireconomy` JSON | ✅ 200 | Structured macro calendar, no key. **This week only** — `_nextweek`/`_lastweek` are 404. |
| Reuters RSS | ❌ | Discontinued public RSS |
| X / Twitter | ❌ keyless | API requires a paid tier; scraping is unreliable. Not wired up — say so rather than substituting. |

Everything is cached on disk (`~/.agentic-trading/cache/`). On a 429 or network failure the
scripts serve stale cache with a warning rather than failing. **This is mandatory, not an
optimization** — both Reddit and the ForexFactory mirror will throttle a naive caller.

## News and social tone

```bash
python3 ~/.agentic-trading/scripts/sentiment.py --ticker NVDA --company Nvidia
python3 ~/.agentic-trading/scripts/sentiment.py --macro                    # market-wide
python3 ~/.agentic-trading/scripts/sentiment.py --reddit --subreddits wallstreetbets stocks
```

Scoring is a **transparent finance lexicon**, and every hit is printed so any number traces
back to the words that produced it:

```
  +5  google-news   Nvidia stock moves closer to all-time high
       all-time high+3
```

**Read the hits, not the score.** The lexicon defends against three failure modes found in
live testing — word boundaries (`beat` must not match "Market**Beat**"), negation ("does
*not* beat"), and reversal cues ("rally showing **cracks**" is not bullish) — but it is a
word count, not comprehension. A headline scoring 0 is usually genuinely neutral; most
headlines are.

**Reddit specifics.** Atom carries `title`, `author`, `updated`, `link`, `content` but
**no score and no comment count** — the JSON API had those. Ranking therefore comes from
`feed_rank` (position in `hot`, i.e. what Reddit is choosing to surface) plus lexicon tone.
Treat r/wallstreetbets as a **crowd-positioning** signal rather than analysis: heavy `puts`
chatter at a low with bullish structure is a contrarian setup, not a bearish confirmation.

**How sentiment enters a read.** It confirms or contradicts — it never leads:

| Price action | Sentiment | Read |
|---|---|---|
| Breaking up | Bullish news, real catalyst | Confirmed; trend has fuel |
| Breaking up | Neutral or absent news | Technical move — more likely to mean-revert |
| Breaking up | Bearish news | Divergence. Either the market knows something or it is a squeeze — reduce conviction |
| Breaking down | Bearish catalyst | Confirmed |
| Breaking down | Bullish news | Possible capitulation/washout — watch for reversal at a support zone |

## Macro event risk

This covers **market-wide** scheduled risk. For **single-stock** event risk — earnings
dates, expected move, historical gap behavior — see [earnings.md](earnings.md).

```bash
python3 ~/.agentic-trading/scripts/macro.py --within 72h
python3 ~/.agentic-trading/scripts/macro.py --at 2026-10-02T12:29:00Z --check-blackout
```

Returns scheduled events with forecast/previous, **tier-ranked** by equity impact:

| Tier | Events | Release (ET) |
|---|---|---|
| 1 | FOMC decision, rate statement, presser | 14:00 |
| 2 | CPI, Core PCE | 08:30 |
| 3 | NFP, unemployment, average hourly earnings | 08:30 (1st Friday) |
| 4 | GDP, ISM, retail sales, PPI | 08:30 / 10:00 |
| 5 | Jobless claims, consumer confidence | 08:30 (Thursday) |

**Blackout windows** mark where desks stand down: T±15min for a High-impact print, T±30min
for central-bank decisions. `--check-blackout` exits **1** when inside a window, so it can
gate a workflow.

Blackouts fire on `impact == High` only. Routine "FOMC Member X Speaks" items are tagged
Low/Medium by the feed and are numerous — letting them trigger stand-downs would black out
much of the session.

**Always check the horizon before delivering a read.** A clean technical setup on Thursday
means much less with NFP on Friday morning: the gap risk dwarfs the edge. State the event,
its time, and the forecast, then widen the stop or flag the timing.

## Honest reporting

- **A dead feed is a finding.** If Reddit 429s and no cache exists, say the social read is
  unavailable rather than passing off news-only tone as complete.
- **Quote the asof.** Cached data has an age; the script prints it. Stale sentiment on a
  fast-moving name is worse than none.
- **Absence of news is information.** A large move with no catalyst is a different
  (and often more mean-reverting) setup than the same move on a headline.
- **Never manufacture social sentiment.** X is not wired up. If the user wants Twitter
  sentiment, tell them it needs a paid API key.
