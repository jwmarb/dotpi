# Reading the balance sheet

The balance sheet answers one question the income statement cannot: **can this company
survive a bad year without asking for money?** A business that must raise capital at the
wrong moment transfers value from existing owners to new ones, however good its margins
looked beforehand.

It is a **snapshot at an instant**, not a period. Every figure here carries a single date,
which is why `fundamentals.py` treats these concepts as instants and the income-statement
items as durations — mixing the two is how people compute nonsense ratios.

## The three questions, in order

### 1. Liquidity — can it pay what is due within the year?

| Ratio | Formula | Read |
|---|---|---|
| Current | current assets / current liabilities | >1.5 comfortable; <1 needs a reason |
| Quick | (current assets − inventory) / current liabilities | Strips the least liquid asset. A large gap from the current ratio means inventory is carrying the liquidity |
| Working capital | current assets − current liabilities | The absolute cushion in dollars |

A current ratio far above 3 is not automatically good — it can mean idle cash earning
nothing, or receivables nobody is collecting.

### 2. Solvency — can it carry its debt?

| Ratio | Read |
|---|---|
| **Net debt / OCF** | The best single leverage number: years of cash flow to clear the debt. Under ~3× is manageable for most industries |
| Debt / equity | Conventional but distorted by buybacks — repurchases shrink equity and inflate this ratio without changing the risk |
| Total debt − cash and investments = **net debt** | Negative net debt (net cash) is a genuine moat during a credit squeeze |

Prefer net debt against cash flow over debt against equity. Equity is an accounting
residual; cash flow is what actually services debt.

### 3. Asset quality — is the equity real?

Equity is assets minus liabilities, so it inherits every optimistic assumption on the asset
side.

- **Goodwill + intangibles as a share of equity.** Goodwill is the premium paid over book in
  past acquisitions. It is not cash, it cannot be sold separately, and a writedown erases
  equity overnight without any operational change. `fundamentals.py` reports this share and
  flags the case where soft assets *exceed* equity — tangible book is then negative.
- **Receivables growing faster than revenue** means sales are being booked ahead of
  collection. Cross-check against OCF/net income in [quality.md](quality.md).
- **Inventory growing faster than revenue** precedes markdowns.

## Unclassified balance sheets — the trap this skill exists to avoid

**Banks, insurers and REITs do not report current assets or current liabilities.** Their
balance sheets are ordered by liquidity, not by a one-year boundary, so the GAAP tags
`AssetsCurrent`, `LiabilitiesCurrent` and `InventoryNet` are simply absent.

Verified 2026-10: on JPM's and O's 10-Ks all three are untagged, while `Assets`,
`Liabilities` and `StockholdersEquity` are present and correct. `fundamentals.py` detects
this and emits:

```
! unclassified balance sheet: no current-asset/current-liability tags. Typical of banks,
  insurers and REITs — current ratio and working capital are undefined here, not zero.
```

**Report it as undefined.** A current ratio of 0.00 on a bank is a reporting artifact, and
presenting it as a liquidity warning is a false alarm that discredits the whole read.

### How to read a financial instead

| Industrial metric | Bank/insurer equivalent |
|---|---|
| Current ratio | Not applicable — look at capital ratios (CET1), deposit mix, loan-to-deposit |
| Free cash flow | Not meaningful — loan growth is an operating outflow |
| Debt / equity | Leverage is the business model; compare assets/equity to peers, not to industrials |
| ROA | Far lower by nature (~1%) — JPM's 1.35% is healthy, not weak |
| P/E, **P/B** | P/B is the primary valuation anchor for a bank; a sub-1.0 P/B says the market doubts the loan book |

**Negative operating cash flow is structural for a lender.** JPM's FY2025 OCF was
**−$147.8B** because originating loans consumes cash. The same number on a software company
would be an emergency. `fundamentals.py` prints the figure and the caveat; the read must
carry the distinction rather than grading a bank on an industrial's rules.

### REITs

Read on **FFO** (funds from operations: net income plus depreciation, minus property
gains), not on net income or FCF. Depreciation on buildings is a huge non-cash charge that
makes GAAP earnings understate the cash a REIT actually produces — which is why O's P/E of
~40 does not mean what a 40x P/E means for an industrial. P/B and net-debt/EBITDA are the
usable anchors from the standard block.

## XBRL hazards, measured

These are handled by `lib/facts.py`, but a read that bypasses the script must handle them
by hand:

1. **Axis-sliced rows are not totals.** 10 concepts returned **79 rows** on MSFT's FY2026
   10-K. `StockholdersEquity` appeared as the 442.387B total *and* as a 109.095B common-stock
   component. Only rows with an empty `axises` are the undifferentiated total; summing them
   double-counts badly.
2. **Concept names vary by filer.** AAPL does not tag `Revenues` at all — it uses
   `RevenueFromContractWithCustomerExcludingAssessedTax`. MSFT's D&A is
   `DepreciationAmortizationAndOther`, not `DepreciationDepletionAndAmortization`. A single
   hardcoded name reads as "missing" on perfectly normal companies, which is why every line
   item resolves through an ordered synonym chain.
3. **10-Qs carry overlapping durations.** PLTR's Q2 filing holds both the 3-month revenue
   (1,935,464,000) and the 6-month (3,568,047,000). Picking the wrong one nearly doubles the
   figure. Facts are selected by day-span, never by position.
4. **Precision varies within one filing.** `decimals` can be −6 on one row and −3 on
   another for the same concept. Do not assume uniform rounding when comparing raw values.
5. **Book value goes stale.** The 10-K alone put AAPL's P/B at **65.4x** against a true
   **44.9x**, and PLTR's at **61.8x** against **46.7x**. Always include the latest 10-Q when
   it is newer than the 10-K.
