# Investment thesis log

Accumulated judgment about a company. `fundamentals.py` recomputes every ratio on demand;
the thesis file holds what no script can derive — *why* you concluded this is or is not a
business worth owning, what price would change the answer, and what you are waiting to see.

Lives in `~/.agentic-trading/theses/`, one markdown file per ticker (`MSFT.md`), newest
entry appended at the bottom under a dated heading.

## Why this is not the trading journal

The `technical-analysis` skill has `~/.agentic-trading/journal/` and a `trade_journal` tool:
one file per **day**, holding how a name *behaved* — a level that held, a gap that
round-tripped. The unit is a session.

An investment thesis has a different shape. It is one file per **company**, it changes a few
times a year rather than daily, and it is a standing claim with review triggers rather than
an observation. Forcing it into day files would scatter one argument across dozens of dates.

**Do not declare `tools: trade_journal` in this skill's frontmatter.** Tool ownership is
resolved by scanning skill directories in sorted order, first-wins
(`extensions/lib/skill-activation.ts`). `fundamental-analysis` sorts *before*
`technical-analysis`, so claiming that tool would silently take ownership of it and gate the
journal away from the skill that actually implements it. Verified against the live loader.
These are plain file operations instead — `cat`, `read` and `write`.

## The file shape

```markdown
# MSFT — Microsoft

**Business:** Cloud infrastructure (Azure), software licensing, productivity suites.
**Sector:** Technology Services / Packaged Software

## 2026-10-02 — initial thesis

**Verdict:** Good business, demanding price.

**Why it is a good business**
- ROIC 25.9% on a 19% effective tax rate — durably above any plausible cost of capital.
- Gross margin 67.9%, net margin 40.3%; OCF/NI 1.37 — earnings arrive as cash.
- Net debt only $19.4B against $182.9B OCF (0.22x debt/OCF). Survives anything.
- Moat: switching costs on enterprise Azure + Office contracts; distribution scale.

**Why the price is demanding**
- 28.5x TTM earnings, 56.9x FCF, 1.76% FCF yield.
- FCF is only $67.0B of $182.9B OCF because capex is $115.9B — 63% of operating cash flow.

**What I am watching (review triggers)**
- Capex as a share of OCF: if it stays above 60% without Azure revenue acceleration, the
  FCF yield thesis weakens. Re-read after the next 10-Q.
- Any quarter where gross margin falls below ~66%.

**What would break the thesis**
- AI capex becoming a permanent structural cost rather than a one-cycle build-out.
- Azure growth decelerating below ~20% while capex stays elevated.
```

Keep **Business** and **Sector** at the top, stable. Everything else is dated and appended,
never rewritten.

## Reading before a read

Step 1 of the skill, every time — it is a file read, so it is cheap:

```bash
cat ~/.agentic-trading/theses/MSFT.md 2>/dev/null || echo "no thesis on file"
```

A prior thesis changes the job. You are no longer forming a first opinion; you are testing
a standing claim against new filings. Say explicitly which parts still hold, which the
numbers have now contradicted, and which review triggers have fired.

To scan what exists across the whole corpus:

```bash
ls ~/.agentic-trading/theses/
grep -l "Verdict" ~/.agentic-trading/theses/*.md | head -20
grep -A1 "^\*\*Verdict:" ~/.agentic-trading/theses/*.md    # every verdict at a glance
```

## Writing after a read

Create the directory on first use, then append — never overwrite a prior entry:

```bash
mkdir -p ~/.agentic-trading/theses
```

Append a new dated section with `read` then `edit`, or `cat >>` for a fresh block. The
history is the value: a thesis you can watch being wrong over time teaches more than one
silently corrected.

**Record the thesis held at the time, with the numbers behind it.** When it turns out wrong,
append a new dated entry saying so. **Never edit an old entry to look correct** — that
destroys the only honest record of your judgment.

## What belongs, and what does not

| Worthless | Usable |
|---|---|
| "MSFT looks strong" | "ROIC 25.9% with net debt 0.22x OCF — survives a bad year without raising capital" |
| "Expensive" | "56.9x FCF because capex is 63% of OCF; needs the build-out to end or Azure to accelerate" |
| "Good moat" | "Switching costs: enterprise Azure + Office contracts; renewal friction is the moat, not the brand" |
| "ROE was 34%" | (drop — the script recomputes this) |
| "Will beat next quarter" | (drop — a prediction, not a thesis) |

State the **observation** and your **interpretation** separately, so a later session can
re-interpret the same fact without inheriting today's conclusion.

A **review trigger** is the most valuable line in the file, because it converts a static
opinion into something falsifiable. Make it a number and a date, not a feeling: "re-read if
gross margin falls below 66%" beats "watch margins".

## Rules

- **One file per ticker, append-only.** Dated headings, newest at the bottom.
- **Never record a recomputable ratio as the thesis.** The ratio is the evidence; the thesis
  is what you concluded from it and why. The script regenerates evidence in seconds.
- **Never revise a past entry to look right.** Append the correction with its date.
- **An empty thesis file is a valid answer.** If nothing is on file, say so and proceed on
  the filings. Never let an absent thesis become invented history.
- **Separate the business verdict from the price verdict**, in the file as in the read. A
  thesis that says "great company" without naming a price is not actionable, and one that
  says "cheap" without naming the business quality is a value trap waiting to happen.
