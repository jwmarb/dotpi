# Earnings event risk

The single largest scheduled risk on a single name. An earnings gap routinely moves a stock
**10× a normal session's range**, so it does not respect support, resistance, order blocks,
or gamma walls — it prices through all of them overnight. Any technical read on a stock
inside its earnings window has to say so.

Measured on NVDA's 2026-08-26 report: the average earnings move was **13.6× ATR**. A
1.5×ATR stop is meaningless against that.

## The two questions

1. **When does it report, and is that inside the trade horizon?**
2. **How big a move is priced in, versus how big they usually are?**

Robinhood answers the timing; the options chain answers the size. The earnings tools state
outright that they do **not** return an expected move — `earnings.py` computes it.

## Fetching

```
get_earnings_results --symbol NVDA          # trailing 8 quarters + the upcoming one
get_earnings_calendar --days 7 [--filter high_market_cap]   # market-wide window
```

Read the response carefully:

| Field | Meaning |
|---|---|
| `eps.actual: null` | **Not yet reported** — this is the upcoming quarter |
| `report.timing` | `pm` = after the close (gap lands **next** session); `am` = before the open (gap lands **that** morning) |
| `report.verified: false` | Date is **tentative** — present it as estimated, never confirmed |
| `eps.estimate` vs `actual` | Surprise history: a consistent beater that still sells off signals expectations, not results |

`timing` is the field that matters most and the easiest to get wrong. A `pm` report on
Tuesday produces Wednesday's gap.

## Running the numbers

```bash
# historical reactions: pass past report dates + daily bars spanning them
python3 ~/.agentic-trading/scripts/earnings.py \
  --bars daily.json --report-dates 2026-08-26:pm 2026-05-20:pm 2026-02-25:pm \
  --next 2026-11-17:pm --spot 225.08 --atr 1.45

# add the options-implied move: ATM straddle on the first expiry AFTER the report
python3 ~/.agentic-trading/scripts/earnings.py --bars daily.json \
  --report-dates 2026-08-26:pm --straddle-call 12.40 --straddle-put 11.80 --spot 225.08
```

Bars must cover each report date **plus the following session**, and ~20 sessions before it
for the volume baseline. Get the straddle marks from `get_option_instruments` +
`get_option_quotes` at the strike nearest spot, on the first expiration dated after the
report.

## Reading the output

**Historical reactions** — per event: the overnight `gap`, the full `close_to_close` move,
`intraday` drift, `range`, volume multiple, and the next session's follow-through.

`behavior` classifies the session, and it is the tell for how to trade the reaction:

| Behavior | Meaning | Implication |
|---|---|---|
| `gap and go` | Gapped and continued in the same direction | Momentum is real; fading it is expensive |
| `gap faded` | Gapped, drifted back part-way | The open was the extreme |
| `gap reversed` | Gapped, then closed through the open the other way | Trap — the initial print misled |
| `no gap` | Under 0.25% | Earnings were a non-event for this name |

NVDA's 8/26 print went `gap and go` (+6.3% gap, +8.7% close), then **gave back −4.6% the
next day** — which is why `next_day_pct` is reported. A held gap and a round-tripped gap are
different trades.

**Implied move** — the ATM straddle as a percentage of spot, roughly a 1-standard-deviation
move (~68% of outcomes inside it). The comparison is the edge:

- **Implied > historical** → premium is rich; the market is paying up for the event
- **Implied < historical** → premium is cheap relative to how this name actually moves
- **Roughly equal** → no volatility edge either way

## How earnings enters a read

Apply in this order:

1. **Days away.** Inside 5 sessions, the script raises an event-risk warning and the read
   must carry it. Inside 1 session, the technical setup is subordinate to the binary.
2. **Compare the expected move to the levels.** If the implied move is ±10% and the nearest
   resistance is 2% away, that level is noise — the gap clears it without pausing. Say so
   rather than presenting it as a target.
3. **Widen or stand aside.** An ATR stop cannot contain an earnings gap. Either size down
   so the gap is survivable, or wait for the print and trade the reaction against the levels
   that remain.
4. **After the report, re-read.** A gap invalidates prior structure and creates new FVGs
   (an earnings gap is often the largest FVG on the chart). Re-run `structure.py` on
   post-earnings bars rather than reusing stale zones.
5. **Note the IV crush.** Implied volatility collapses after the print. A long option that
   is directionally right can still lose money — mention this when the user holds premium
   into earnings.

## Interaction with gamma

Earnings and dealer gamma compound. Positive gamma pins price *until* the event, then the
gap jumps straight through the wall because hedging cannot contain an overnight repricing.
Post-report, the expiration that absorbed the event rolls off and the gamma picture is
rebuilt — a pre-earnings gamma read expires with the print.

## Honest reporting

- **A tentative date is tentative.** `verified: false` means the company has not confirmed;
  say "estimated" and let the user check.
- **Small samples are small.** Four quarters is four data points; state the count alongside
  the average so the user weighs it appropriately.
- **Past reactions are not a forecast.** A name that gapped up seven straight quarters can
  gap down on the eighth. Report the distribution, never a predicted direction.
- **If bars do not cover a report date, say so.** The script warns rather than silently
  dropping the event — relay that the history is partial.
