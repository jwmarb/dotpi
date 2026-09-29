# Gamma exposure (GEX)

Market makers hedge their option books by trading the underlying. That hedging flow is
mechanical and often larger than discretionary flow, which is why dealer gamma explains
*why* levels hold or break. GEX measures it.

## What the number means

```
dollar GEX per 1% move = gamma × OI × multiplier × spot² × 0.01 × sign
```

**Units: notional dollars of stock dealers must trade per 1% move in spot.** A second unit
(shares per $1 move) is also reported. The two differ by `spot² × 0.01` and are **not
comparable across sources** — always check which one a chart is quoting.

Verified against SpotGamma's published example: spot 200, gamma 0.02, OI 1,000, ×100
→ **$800,000 per 1% move**. `gex.py --self-test` asserts this.

## The sign convention (read this before trusting any GEX number)

Standard assumption: **dealers are long calls and short puts**, so calls contribute
positive gamma and puts negative.

This is an **ownership convention, not option mathematics.** Long calls and long puts both
have positive gamma; short calls and short puts both negative. Public open interest never
reveals which side the dealer holds, so the convention supplies the sign. It rests on the
premise that investors sell calls (overwriting) and buy puts (protection).

If the assumption is wrong for a given name, **every reading inverts** — what looks like
stabilizing positive gamma is actually amplifying negative gamma. `--dealer-convention
inverted` flips it. Providers differ here: SpotGamma models actual inventory rather than
assuming, so published numbers legitimately disagree.

## Reading the regime

| Total GEX | Dealer behavior | Expect |
|---|---|---|
| **Positive** | Long gamma — sell rallies, buy dips | Compressed ranges, mean reversion, pinning toward high-gamma strikes. Breakouts fail. |
| **Negative** | Short gamma — buy rallies, sell dips | Wider ranges, trend continuation, gamma-squeeze potential. Breakouts run; fading is dangerous. |
| **≈ Zero** | Minimal hedging pressure | Price moves on its own flow |

GEX says nothing about **direction** — only whether hedging will damp or amplify whatever
move initiates. A negative-gamma regime is not bearish; it is *volatile*.

## Key levels

- **Gamma flip (zero gamma):** where total dealer gamma crosses zero. Above it the regime is
  typically stabilizing, below it amplifying. Computed by rebuilding the profile across
  hypothetical spot prices with each strike's IV held fixed, then interpolating the
  crossing. Treat it as the regime boundary — the level that matters most.
- **Call wall:** the strike with the largest positive call-gamma concentration. Acts as
  resistance in positive-gamma regimes — dealers sell into approaches. Frequently the
  upside magnet into expiration.
- **Put wall:** the largest negative put-gamma concentration. Acts as support; a **close
  below it** is a genuine regime event, not a normal level break.

Walls are ranked by **gamma-weighted** exposure, not raw open interest. A huge-OI strike
with negligible gamma is not a wall.

## The bounded fetch recipe

A full chain is hundreds of contracts and will flood context. Stay inside these limits:

1. `get_equity_quotes` → spot.
2. `get_option_chains` → the expiration list. Pick the **nearest weekly plus the monthly
   OPEX** (near-term gamma dominates; per-contract gamma scales ~1/√T, so far-dated strikes
   contribute almost nothing).
3. `get_option_instruments` per expiration. **Filter by `strike_price` to ±5% of spot** —
   passing a single strike returns just the call/put pair (2 records instead of 100).
4. `get_option_quotes` in batches of ≤20 instrument ids (above 20 the `closes` block drops).
5. Write both payloads to disk **verbatim** — `gex.py` peels the MCP envelope itself — then:

```bash
python3 ~/.agentic-trading/scripts/gex.py \
  --instruments i.json --quotes q.json --spot 768.23 --band 15 --max-dte 30 --profile
```

Robinhood supplies `gamma`, `open_interest`, and `implied_volatility` per contract, so GEX
at spot uses **real broker greeks**. Black-Scholes is used only to extend gamma across the
hypothetical-spot grid for the flip level.

## Timing effects

- **0DTE** is the majority of SPX option volume. Its gamma is enormous and vanishes at
  expiry — the regime can flip intraday the moment those contracts expire.
- **OPEX roll-off:** when a monthly expiry clears, its gamma leaves the book. A wall that
  was pinning price disappears, which is why the days after OPEX often see released,
  trending price.
- **Pinning:** in positive-gamma regimes price gravitates toward the max-gamma strike as
  expiry approaches.
- **Vanna** (∂delta/∂IV) and **charm** (∂delta/∂time) matter into OPEX: a vol spike or the
  simple passage of time changes dealer delta, forcing hedges with no price move at all.

## Caveats to state in the read

- Open interest is a **prior-session snapshot** — static intraday, so late-day GEX is stale.
- `multiplier` comes from the contract, never hardcoded: it is 100 for equity/ETF options
  but **1 for SPX**. Getting this wrong scales the answer by 100×.
- GEX is a **model**, not an exchange statistic. Expiry filters, IV inputs, and the sign
  convention all move the number.
- **If the chain is too thin, say so.** A handful of contracts cannot resolve a flip level,
  and `gex.py` reports "none in range" rather than inventing one. Relay that honestly.
- **Earnings outrank gamma.** A pinning wall does not survive an overnight repricing; see
  [earnings.md](earnings.md) before trusting a gamma read across a report date.
