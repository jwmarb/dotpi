# Peer comparison

A multiple on its own is not information. 28x earnings is cheap for a business compounding
at 25% with a moat, and expensive for a cyclical industrial at the top of its cycle. The
reference set is what converts a number into a judgment.

## Choosing a peer set

A real peer **competes for the same customer with a similar business model**. Share a sector
label is not enough.

| Trap | Why it breaks the comparison |
|---|---|
| Same sector, different model | JPM and O are both "Finance" to the data provider. A bank and a net-lease REIT share nothing — different balance sheets, different drivers |
| Same product, different mix | AAPL is classified Electronic Technology, MSFT Technology Services. Hardware margins and software margins are not comparable |
| Wildly different scale | A $4T company and a $5B company face different growth ceilings and capital access |
| Different capital intensity | A company spending 63% of OCF on capex is not comparable on P/FCF to one spending 2% |

The provider's `sector` and `industry` fields from `get_equity_fundamentals` are the
starting point, not the answer. **State why each peer belongs**, in one clause. If a good
peer set does not exist — a genuinely unusual business — say so; that is itself a finding
about the moat.

## The cheap call

`get_equity_fundamentals` accepts up to **10 symbols** and `get_financials` up to **20**, so
the whole comparison is two calls:

```
get_equity_fundamentals --symbols ["MSFT","GOOGL","AMZN","ORCL"]
get_financials --symbols ["MSFT","GOOGL","AMZN","ORCL"] --period annual --limit 4
```

That gives market cap, PE, PB, dividend yield and the 52-week range, plus revenue, gross
profit, net income and net margin per year for each name — enough for valuation, margin and
growth side by side.

**Results are positional**, aligned to the symbols you requested, and a `null` entry means
the symbol did not resolve. `get_equity_fundamentals` returns unresolved symbols in a
separate `not_found` array instead of nulling them in place. Surface a missing peer as "no
data for X" rather than dropping it silently and presenting a smaller set as complete.

Reach for the full `fundamentals.py` block on a peer **only when the comparison turns on
balance-sheet quality or cash conversion** — that costs ~6 more MCP calls per name. For
valuation and margin, the two calls above are enough.

## Building the table

Compare on what the business actually is:

| Axis | Metric | Note |
|---|---|---|
| Size | market cap | Context for the growth rate |
| Valuation | PE, PB | From the provider — already TTM |
| Profitability | net margin, gross margin | From `get_financials`, per year |
| Growth | revenue CAGR over the available years | Compute it; the provider does not |
| Quality | ROIC or ROE | Needs the facts call — add only when it decides the question |

Then read the **dispersion**, not just the rank. A company at 28x among peers at 25–30x is
unremarkable. The same company at 28x among peers at 10–12x demands an explanation: either
the market sees something better here, or it is mispriced. Name which you think it is and
why.

## Interpreting the result

| Pattern | Likely read |
|---|---|
| Premium multiple, best margins and growth | Paying up for quality — ask whether the premium is proportionate |
| Premium multiple, middling fundamentals | The hard case. Either an expectation you cannot see in the numbers, or overvaluation |
| Discount multiple, comparable fundamentals | Worth real work — this is where mispricing lives |
| Discount multiple, deteriorating fundamentals | Cheap for a reason. The classic value trap |

**A discount is a question, not an answer.** The work is explaining *why* the market applies
it. If you cannot find the reason, the honest statement is "the discount is unexplained by
the figures available", not "it is undervalued".

## Comparing across the sector boundary

When a company has no clean peer, compare it to **its own history** instead — the same
multiple over five years, and the margin trend behind it. `get_financials --period annual
--limit 6` makes this a single call, and a company against its own record is often a more
honest comparison than a forced peer.

For financials and REITs, the peer set must come from the same structure: compare banks to
banks on P/B and ROA, REITs to REITs on FFO and book. Dropping a bank into an industrial
peer table produces a table where every row is wrong. See
[balance-sheet.md](balance-sheet.md).
