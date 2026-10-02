# Strategies

Five playbooks: moving averages, MACD+RSI, sessions, fair value gaps, order blocks.
The first two read the indicator stack in `SKILL.md`; the last three come from
`structure.py` and `sessions.py`.

## 1. Moving averages

**Stack:** EMA 20 (reaction), EMA 50 (trend), SMA 200 (regime).

| Configuration | Read |
|---|---|
| Price > 20 > 50 > 200, all rising | Clean uptrend. Pullbacks to the 20 are continuation entries. |
| Price > 200 but 20 < 50 | Uptrend, momentum stalled. Wait for the 20 to reclaim the 50. |
| Price < 20 < 50 < 200, all falling | Clean downtrend. Rallies to the 20 are continuation shorts. |
| Price oscillating across all three | No trend. MA strategies are worthless here — trade levels instead. |

**Crosses.** The 50/200 cross (golden/death) is a *regime* marker, not a trade signal — it
lags badly. The 20/50 cross is tradeable on pullback entries. What matters more than any
cross: **MA slope** (a flat 200 means no regime) and **spacing** (widening = trend
strengthening, compressing = trend tiring).

**Dynamic support.** In an established trend the 20 EMA acts as support in an uptrend and
resistance in a downtrend. Confluence with an FVG or order block at the same price is the
strongest configuration in this document.

## 2. MACD + RSI

The pair works because they measure different things: MACD reads trend momentum,
RSI reads overbought/oversold. Their **disagreement** is the signal.

| MACD | RSI | Read |
|---|---|---|
| Line > signal, histogram rising | 50–70 | Healthy momentum, trend intact — highest-conviction long |
| Line > signal | >70 | Extended. Trend is real but chasing is poor entry; wait for a pullback |
| Line > signal, histogram shrinking | Falling from >70 | Momentum decaying — first warning, tighten stops |
| Line < signal, histogram falling | 30–50 | Healthy downward momentum |
| Line < signal | <30 | Oversold in a downtrend — do not catch it; wait for divergence |

**Divergence is the high-value signal.** Price makes a higher high while RSI makes a lower
high = bearish divergence (and the mirror for bullish). Confirm with a MACD histogram that
is shrinking on the new extreme. Divergence at a **call wall** or inside a **bearish FVG**
is the highest-conviction reversal setup here.

**Zero-line crosses.** MACD crossing zero (not just the signal line) marks a genuine trend
change; a cross of only the signal line is a momentum wobble.

## 3. Sessions

`sessions.py` reports live session state and volume distribution. Windows are anchored per
IANA zone, so DST desyncs (the UK and US switch on different dates) resolve correctly.

| Session | UTC | Character |
|---|---|---|
| Tokyo / Asia | 00:00–09:00 (fixed, no DST) | Thin for US equities; sets overnight range |
| London | 08:00–17:00 local (07:00–16:00 under BST) | Real volume arrives; overnight fakeouts get resolved |
| New York | 13:00–22:00 | The trend session for US names |
| London–NY overlap | ~13:00–16:00 | Highest liquidity of the day; most decisive moves |
| US pre-market | 04:00–09:30 ET | Gaps form; thin, wide spreads, unreliable levels |
| US regular | 09:30–16:00 ET | Reference session — levels that matter |
| US post-market | 16:00–20:00 ET | Earnings reactions; low liquidity |

**How to use it.** Levels set during the regular session carry more weight than
pre/post-market prints. A breakout on Asia-session volume is suspect; the same breakout
during the London–NY overlap is credible. The first 30 minutes of the US open generates the
day's widest range — session-opening ranges commonly get swept before the real move.
Check `volume_share_pct` from the script: if a move happened on 5% of the day's volume,
say so rather than treating it as confirmed.

## 4. Fair value gaps (FVG)

A three-candle imbalance where price moved so fast it left an unfilled gap. Price tends to
return and "rebalance" it.

- **Bullish FVG:** `c3.low > c1.high` → zone `[c1.high, c3.low]` (support below price)
- **Bearish FVG:** `c3.high < c1.low` → zone `[c3.high, c1.low]` (resistance above price)
- **CE (consequent encroachment):** the zone midpoint. Many models treat a touch of CE as
  "filled enough" — it is the realistic target, not the far edge.

**States reported by `structure.py`:**

| State | Meaning | Tradeable |
|---|---|---|
| `fresh` | Never touched | Yes — highest quality |
| `partial` | Price entered, has not reached CE | Yes |
| `mid` | Reached the midpoint | Weakening |
| `full` | Traversed the whole zone | No — spent |
| `invalidated` | **Closed** through the far edge | No — and it may now act as an inversion zone in the opposite direction |

A wick through the zone is *mitigation*; only a **close** beyond the far edge invalidates.
Filter by size: `--atr-mult 0.25` drops gaps too small to matter. Zones ≥1.5× ATR are
the ones worth naming in a read.

## 5. Order blocks (OB)

The last opposing candle before an impulsive move — where institutional orders are presumed
to sit.

- **Bullish OB:** last down-close candle before an impulsive up move (support)
- **Bearish OB:** last up-close candle before an impulsive down move (resistance)

**Validation** (`structure.py` requires all of these, per ICT):
1. The impulse candle **sweeps** the OB extreme (takes out its low/high)
2. The impulse **closes through** the opposite side of the OB candle (engulfs it)
3. **Market structure shifts** — the close breaks the prior swing high/low

Condition 3 needs history: on a short intraday sample it will legitimately find nothing.
`--no-mss` relaxes it, at the cost of more false positives.

**Zone boundary** — sources disagree, so it is a flag. `--zone body` (default) uses
open→close, which is narrower and more common in ICT practice. `--zone range` uses
low→high, which catches more retests but gives looser stops.

**Freshness is everything.** An OB is an *unfilled* order pocket; once price returns and
reacts, the orders are consumed and the level is `mitigated`. Only fresh blocks carry
weight, and the first retest is the trade.

## Confluence ranking

When several strategies point at one price, conviction compounds. Strongest first:

1. Fresh FVG **and** fresh order block overlapping, with the 20 EMA at the same level
2. FVG or OB coinciding with a gamma wall (see `gamma.md`)
3. RSI divergence into a fresh zone
4. MA pullback entry with MACD confirming
5. A single indicator alone — weakest; state it as such
