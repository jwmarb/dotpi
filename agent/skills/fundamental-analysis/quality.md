# Business quality and valuation

Two separate questions, and conflating them is the most expensive error in fundamental
analysis:

1. **Is this a good business?** — returns on capital, margins, cash conversion, moat.
2. **Is this a good price?** — what the multiple already assumes about the future.

A wonderful business at a demanding price and a mediocre business at a cheap price are
different investments, and both can lose money. Answer them in that order, and keep them
visibly apart in the read.

## Is it a good business?

### Returns on capital — the single most informative metric

A business creating value earns more on each dollar invested than that dollar costs.

- **ROIC** = operating income after tax / (debt + equity). The version to lead with: it is
  comparable across capital structures, which ROE is not. `fundamentals.py` computes it with
  the filing's effective tax rate when derivable, falling back to 21%, and reports
  `roic_tax_rate_used` so the assumption is visible.
- **ROE** = net income / average equity. Useful but inflatable three ways: leverage,
  buybacks (shrinking the denominator), and writedowns. High ROE with high debt is a
  leveraged bet, not quality.
- **ROA** = net income / average assets. The sector-relative one. ~1% is healthy for a bank
  and alarming for a software company.

ROIC durably above ~10–15% suggests something is protecting those returns — competition
normally drives them toward the cost of capital. **ROIC below the cost of capital means
growth destroys value**: every incremental dollar invested returns less than it cost, so
growing faster makes the owner poorer.

### Margins — direction matters more than level

Gross margin is the cleanest read on pricing power, because it sits above every
discretionary expense. Rising gross margin means the company can charge more or produce
cheaper; falling gross margin in a growing business means it is buying revenue with price.

Compare operating margin to gross margin over time. If revenue grows and operating margin
does not, operating leverage is not materializing — the cost base is growing with the
business, which caps what scale is worth.

Margin levels are only meaningful within an industry. A 4% net margin is excellent for a
grocer and a catastrophe for a software company.

### Cash conversion — does the profit exist?

| Signal | Threshold | Meaning |
|---|---|---|
| **OCF / net income** | ≥1.0 healthy | Earnings arrive as cash. Depreciation normally pushes this above 1 |
| | <0.8 persistently | Accruals outrunning collections. Check receivables and revenue recognition |
| **FCF margin** | — | FCF / revenue. What the business actually keeps |
| **Capex % of OCF** | — | How much of the cash flow is consumed just to stay in business |

Free cash flow = OCF − capex. This is the number that funds dividends, buybacks and debt
repayment, and it is harder to manipulate than earnings.

**Beware separating growth capex from maintenance capex casually.** MSFT's FY2026 capex was
$115.9B against $182.9B of OCF — 63% of operating cash flow. Whether that is an investment
in a durable asset base or a new structural cost is the central question on that name, and
the ratio alone does not settle it.

### The owner's real costs

- **Share-based compensation.** OCF adds SBC back as non-cash, which flatters FCF. It is a
  real transfer from existing shareholders. Above ~10% of revenue it materially changes the
  picture — PLTR's FY2025 SBC was **15.3% of revenue**, and `fundamentals.py` flags it.
- **Dilution.** Diluted share-count CAGR is growth read backwards. Shrinking means buybacks
  are accreting per-share value; growing at 3%+ means headline growth overstates what
  reaches the owner. MSFT: −0.11%/yr. PLTR: **+5.66%/yr** — meaningful against its growth.
- **Buybacks above free cash flow.** Returning more than the business earns is funded by
  cash reserves or debt, and is not indefinitely repeatable. The script flags payout >100%
  of FCF; AAPL trips this.

### Moat — name it or declare it absent

The durable source of those returns. Acceptable answers are specific:

| Moat | Test |
|---|---|
| Switching costs | What breaks for the customer if they leave? |
| Network effects | Does each new user make it better for existing ones? |
| Scale economics | Does unit cost fall with volume in a way rivals cannot match? |
| Brand / pricing power | Can it raise prices without losing volume? |
| Regulatory / IP | Is there a legal barrier, and when does it expire? |

"Strong brand" with no demonstrated pricing power is not a moat. If none applies, say the
business has no identifiable moat — that is a finding, and it caps how much of the current
multiple is defensible.

## Is it a good price?

### The multiples, and what each is for

| Multiple | Use | Breaks when |
|---|---|---|
| **P/E** | Profitable, stable businesses | Earnings are negative, or one-off items distort them |
| **P/S** | Pre-profit or margin-recovery cases | Ignores whether revenue can ever convert to profit |
| **P/B** | Banks, insurers, asset-heavy balance sheets | Asset-light businesses — the denominator is mostly meaningless |
| **P/FCF, FCF yield** | The best general-purpose owner's-return anchor | Capex is lumpy, or a build-out year distorts it |
| **EV/EBITDA** | Comparing across capital structures | EBITDA ignores real capex and SBC — never treat it as cash flow |

**Always state the basis.** A 10-K can be nine months stale. Measured 2026-10 on PLTR:
FY2025 net income gives a P/E of **281x**, while the trailing four quarters give **151x**
(the broker independently showed 159x). The script prints `earnings_basis` as `TTM` or
`latest annual filing` — relay it.

### A multiple is a forecast — state what it assumes

A 40x earnings multiple is not "expensive" in the abstract; it is a claim about growth and
durability. Make the claim explicit: what growth rate, for how long, does the current price
require? Then ask whether the company's own record supports it.

This is more honest and more useful than a target price, because it exposes the assumption
instead of hiding it inside one.

### Three comparisons, all required

1. **Against its own history** — is this multiple high or low for this company?
2. **Against peers** — see [peers.md](peers.md).
3. **Against the growth it needs** — the forecast embedded in the price.

A multiple cheaper than peers and cheaper than its own history is only interesting if the
business has not deteriorated. Cheap for a reason is the most common value trap.

## Quality checklist

Before any verdict, each of these has an answer or an explicit "not available":

- [ ] ROIC, and whether it exceeds a plausible cost of capital
- [ ] Gross margin direction over the available years
- [ ] OCF / net income over 1, or a reason why not
- [ ] Net debt / OCF, and whether a bad year is survivable
- [ ] Diluted share-count trend
- [ ] SBC as a share of revenue
- [ ] A named moat, or its explicit absence
- [ ] The multiple, its basis (TTM vs annual), and what growth it assumes
- [ ] Two or three specific things that would break the thesis
