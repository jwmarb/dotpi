---
name: fundamental-analysis
description: Fundamental and business-quality analysis on a company for long-term investing — business model and moat, balance-sheet strength, cash-flow quality, returns on capital, dilution, valuation multiples, peer comparison, and a written investment thesis with review triggers. Use when the user asks whether a company is a good long-term investment, for a fundamental read, business-model or moat analysis, balance-sheet health, debt or liquidity, free cash flow, ROIC, margins, revenue growth, earnings quality, whether a stock is cheap or expensive, P/E or P/B or EV/EBITDA, how it compares to peers, dividend safety, or to record and recall an investment thesis.
---

# Fundamental Analysis

Produce a **verdict on the business**: read the filings, compute the ratios, compare to
peers, then state whether this is a durable business, at what price it is worth owning, and
what would prove the thesis wrong.

This is the **investing** counterpart to `technical-analysis`. That skill asks *where price
is going over days*; this one asks *what the company earns over years*. They answer
different questions and use different data — filings and ratios, not candles and gamma.
A company can be a wonderful business and a terrible chart. Say so when it is.

Scripts live in `~/.agentic-trading/scripts/` (pure stdlib — no numpy/pandas/scipy). They
exist so bulk data never enters context: the XBRL facts for one 10-K are ~280 records and
`fundamentals.py` returns ~45 lines. Pass data in, read the aggregate out.

They are **machine state, not repo content** — outside the `.pi` git root, not installed by
this skill. The one the steps below call is `fundamentals.py` (with `lib/facts.py`). If it
is absent, say so and fall back to arithmetic on the MCP data directly rather than inventing
its output; a fabricated ratio is worse than a missing one.

## Steps

1. **Fix the company, and recall the existing thesis.**
   Exact ticker (resolve a name with `search`). Then establish *what the business is* —
   `get_equity_fundamentals` gives sector, industry, employee count, year founded, and a
   description. A read that never names how the company makes money is not an analysis.

   Then recall what is already written on the name — a file read, so do it every time:
   ```bash
   cat ~/.agentic-trading/theses/<TICKER>.md 2>/dev/null || echo "no thesis on file"
   ```
   A prior thesis changes the job: you are now testing whether it still holds, not starting
   fresh. See [thesis.md](thesis.md).
   *Done: ticker, sector/industry, a one-sentence description of how it earns money, and the
   thesis file consulted.*

2. **Pull the filings and the market snapshot.**
   In one parallel batch:
   - `get_sec_filing_index --symbol <T> --form_type ["10-K","10-Q"]` → filing ids
   - `get_equity_fundamentals` → market cap, shares, PE/PB, dividend, 52-week range
   - `get_financials --period quarterly --limit 4` → the TTM figures
   - `get_financials --period annual --limit 6` → the long revenue/margin trend

   **Pass the latest 10-Q *and* the latest 10-K to the facts call when the 10-Q is newer.**
   This is not optional polish: book value goes stale between annual reports. Measured
   2026-10 — AAPL's P/B from the 10-K alone was **65.4x against a true 44.9x**, and PLTR's
   **61.8x against 46.7x**. Adding the 10-Q brought every name tested to within 2% of the
   broker's independently-sourced P/B.

   **Do not assume a 10-K exists.** XOM returned only a 10-Q (2026-10) — no annual report on
   any page. When the payload has no year-long periods the income statement comes back empty
   on the default annual basis; the script detects this and tells you to re-run with
   `--duration quarter`. Handle a missing filing by saying so, never by reporting the gap as
   zeros.

   Then fetch the facts in batches of ≤10 concepts (the tool's cap). The concept list comes
   from the script, so it never drifts from what the math expects:
   ```bash
   python3 -c "import sys;sys.path.insert(0,'$HOME/.agentic-trading');
   from lib.facts import all_concepts;c=all_concepts()
   print([c[i:i+10] for i in range(0,len(c),10)])"
   ```
   Write every `get_sec_filing_facts` response to disk **verbatim** (merged into one
   `{"data":{"facts":[...]}}`, or several files — the script accepts `--facts` repeatedly).
   *Done: facts on disk with the filing dates they came from, market cap, and TTM net income
   and revenue summed from four quarters.*

3. **Run the ratio block.**
   ```bash
   python3 ~/.agentic-trading/scripts/fundamentals.py --facts facts.json --symbol <T> \
     --market-cap <mcap> --ttm-net-income <sum4q> --ttm-revenue <sum4q>
   ```
   Returns balance sheet, profitability, cash flow, valuation and growth, plus a `FLAGS`
   block and an explicit `NOT TAGGED` list. What each number means, and the thresholds that
   separate a good business from a cheap one, is in [quality.md](quality.md); the
   balance-sheet-specific reading is in [balance-sheet.md](balance-sheet.md).

   **Read the `NOT TAGGED` list before interpreting anything.** A missing `AssetsCurrent` is
   not a liquidity problem — it means the company files an unclassified balance sheet, which
   is normal for banks, insurers and REITs. The script flags this; do not quietly report a
   current ratio of zero.
   *Done: every block has values; the flags are read; absent items identified as absent.*

4. **Compare to peers.**
   "Expensive" is meaningless without a reference set. Name 2–4 genuine competitors in the
   same industry and pull them in one call — `get_equity_fundamentals` takes up to 10
   symbols, `get_financials` up to 20:
   ```
   get_equity_fundamentals --symbols ["<T>","<peer1>","<peer2>","<peer3>"]
   get_financials --symbols [...] --period annual --limit 4
   ```
   That gives PE, PB, margin and growth side by side cheaply. Run the full
   `fundamentals.py` block on a peer only when the comparison turns on balance-sheet
   quality or cash conversion. Method and the trap of fake peers in [peers.md](peers.md).
   *Done: a table of the company against named peers on valuation, margin and growth, with
   the peer set justified.*

5. **Check what the numbers cannot show.**
   Ratios are backward-looking. Before a verdict:
   - `get_equity_analyst_ratings` — consensus and the price-target range. Treat as a
     sentiment datapoint, never as a valuation.
   - `get_earnings_results` — the next report date, and the surprise history. A thesis
     tested in two weeks is not the same risk as one tested in three months.
   - **Dividend safety**, if it pays one: compare `dividend_yield` and the payout against
     free cash flow from step 3. A payout above 100% of FCF is funded from somewhere else.
   - **Concentration and disclosure risk.** For the qualitative narrative, fetch a text
     block deliberately — `get_sec_filing_facts_catalog --axis_name_in
     ["MajorCustomersAxis","SubsequentEventTypeAxis"]` surfaces customer concentration and
     post-period events. These run to thousands of tokens; fetch one on purpose, never in a
     speculative batch.
   *Done: next earnings date, analyst range, dividend sustainability if relevant, and any
   concentration risk named.*

6. **Synthesize into a verdict.**
   Separate the two questions that fundamental analysis always conflates:
   - **Is it a good business?** Returns on capital above the cost of capital, durable
     margins, cash conversion, a moat you can name. See [quality.md](quality.md).
   - **Is it a good price?** Multiples against its own history and its peers, and what
     growth rate the current price already assumes.

   A great business at a demanding price and a mediocre business at a cheap price are
   different investments; both can be wrong. Then:
   - **Moat** — named explicitly (switching costs, network effects, scale, brand,
     regulation) or declared absent. "Strong brand" with no pricing power is not a moat.
   - **Balance sheet** — can it survive a bad year without raising capital? Net debt against
     operating cash flow answers this better than debt-to-equity.
   - **What the price assumes** — a 40x multiple is a forecast. State the growth it implies
     and whether the record supports it.
   - **Risks, stated plainly.** The two or three things that would actually break the
     thesis, not a generic list. Dilution, customer concentration, a single regulatory
     decision, debt maturing into higher rates.
   *Done: a business verdict and a price verdict, held separately, each with its numbers.*

7. **Deliver, then record the thesis.**
   A compact table (metric → value → peer/history comparison), then the synthesis. End with
   offers, not actions: an alert on a price level (`create_alert`), a watchlist add, a
   re-read after the next report.

   If the work produced a view a future session could not recompute — why this is or is not
   a business worth owning, what price would change the answer, what to watch — write it to
   the thesis file with the numbers behind it. Recomputable ratios never belong there; the
   script regenerates those in seconds. See [thesis.md](thesis.md).
   *Done: the read is in front of the user; offers are explicit, nothing executed; the
   thesis and its review triggers are on disk.*

## The metric stack

| Row | Metric | Good sign | Warning sign |
|-----|--------|-----------|--------------|
| Returns | ROIC, ROE | ROIC durably above ~10–15%; ROE not driven by leverage | ROIC below the cost of capital — growth destroys value |
| Margins | gross, operating, net | Stable or rising gross margin — pricing power | Compressing gross margin; operating leverage running backwards |
| Cash | OCF/net income, FCF margin | ≥1.0 — earnings arrive as cash | <0.8 persistently — accruals outrunning collections |
| Leverage | net debt / OCF, debt/equity | Net cash, or under ~3× OCF | Rising debt funding buybacks or the dividend |
| Liquidity | current, quick ratio | >1.5 | <1 with debt maturing soon (n/a for banks/REITs) |
| Dilution | diluted share CAGR | Shrinking — buybacks accrete | Growing >2–3%/yr — per-share growth lags the headline |
| Owner cost | SBC % of revenue | <5% | >10% — a real cost that OCF adds back |
| Growth | revenue, FCF CAGR | Consistent, cash-backed | Revenue growth with flat or negative FCF |
| Valuation | PE, P/FCF, EV/EBITDA, FCF yield | Reasonable vs own history and peers | A multiple that needs flawless execution |

**Financials and REITs break this table.** Banks have no current ratio and negative
operating cash flow by construction; REITs are read on FFO and book, not FCF and P/E. See
[balance-sheet.md](balance-sheet.md) before applying industrial rules to either.

## Accuracy baseline

The pipeline was validated 2026-10 by computing P/E and P/B from filings alone and comparing
against Robinhood's independently-sourced values across seven structurally different names
(megacap software, bank, high-growth software, net-lease REIT, hardware, utility, consumer
staple):

| | P/B deviation | P/E deviation |
|---|---|---|
| MSFT, KO | **0.0%** | 0.2–0.3% |
| AAPL, NEE | 0.8–0.9% | 0.8–2.0% |
| JPM, PLTR, O | 1.4–1.7% | 4.1–8.1% |

P/B lands within **1.7% on every name**. The wider P/E gaps are the expected ones: the REIT
(O, 8.1%) because GAAP earnings understate a REIT's cash generation, and the bank and the
fast grower because provider TTM windows differ slightly from four summed quarters. **A
deviation beyond ~10% means something is wrong with the inputs** — a stale filing, a missed
10-Q, or a concept resolving to the wrong scope. Investigate rather than reporting it.

## Honesty rules

These carry the read's credibility, so they are not optional:

- **Separate the business from the price.** "Good company" is not "good investment", and
  conflating them is the most expensive error in this skill.
- **Say when a line item is absent.** The script prints `NOT TAGGED`; relay it. An untagged
  concept is missing data, never zero.
- **Quote the period and the filing.** Every figure carries a fiscal period end. A ratio
  from a 10-K filed nine months ago is stale, and for a fast grower it is misleading —
  state the basis (`annual filing` vs `TTM`).
- **Ratios are backward-looking.** They describe what the business *has* earned. Never
  present a projection as a measurement, and never present a target price as a fact.
- **No verdict without the downside.** If you cannot name what would break the thesis, the
  analysis is incomplete, not bullish.
- **This is analysis, not advice.** State conditions, numbers and risks; the position size
  and the decision belong to the user.
