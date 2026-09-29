/**
 * Tests for the trading-journal store (lib/trade-journal-store.ts) — the parse/render
 * round trip, the dedup boundary, and the duplicate/summary reducers. These are
 * the parts a corrupted or double-counted journal would come from.
 *
 * Run from the repo root: `bun test agent/extensions/lib/trade-journal-store.test.ts`
 */
import { describe, expect, test } from "bun:test";

import {
  clipResponse,
  parseDayDocument,
  recordObservations,
  renderDayDocument,
  findDuplicates,
  mergeObservations,
  normalizeTicker,
  parseDay,
  renderDay,
  summarize,
  todayUtc,
  validDate,
  type TickerBlock,
} from "./trade-journal-store.js";

// ---------------------------------------------------------------------------
// parseDay
// ---------------------------------------------------------------------------

describe("parseDay", () => {
  test("reads ticker blocks and their bullets", () => {
    expect(
      parseDay(
        `# 2026-09-25\n\n## NVDA\n- held 221.71 on 2.8x volume\n- gamma positive\n\n## SPY\n- pinned at 770\n`,
      ),
    ).toEqual([
      { ticker: "NVDA", bullets: ["held 221.71 on 2.8x volume", "gamma positive"] },
      { ticker: "SPY", bullets: ["pinned at 770"] },
    ]);
  });

  test("ignores the H1 and any prose before the first ticker heading", () => {
    expect(parseDay(`# 2026-09-25\n\nsome stray note\n\n## NVDA\n- a fact\n`)).toEqual([
      { ticker: "NVDA", bullets: ["a fact"] },
    ]);
  });

  test("joins a wrapped bullet into one observation", () => {
    // The agents wrap long observations; a wrapped bullet is one fact, not two.
    expect(
      parseDay(`## NVDA\n- gapped +6.3% to 222.86,\n  then gave back -4.6%\n`)[0].bullets,
    ).toEqual(["gapped +6.3% to 222.86, then gave back -4.6%"]);
  });

  test("an empty or headingless file yields no blocks", () => {
    expect(parseDay("")).toEqual([]);
    expect(parseDay("# 2026-09-25\n\nnothing here\n")).toEqual([]);
  });

  test("only uppercase headings are tickers, so a pasted report is not ingested", () => {
    // journal-reflector's own output uses headings like "## PATTERNS" / "## Patterns".
    expect(parseDay(`## Patterns\n- not a ticker\n`)).toEqual([]);
    expect(parseDay(`## BRK.B\n- dotted tickers are real\n`)).toEqual([
      { ticker: "BRK.B", bullets: ["dotted tickers are real"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// renderDay
// ---------------------------------------------------------------------------

describe("renderDay", () => {
  test("sorts tickers but preserves bullet order within one", () => {
    expect(
      renderDay("2026-09-25", [
        { ticker: "SPY", bullets: ["later alphabetically"] },
        { ticker: "NVDA", bullets: ["first bullet", "second bullet"] },
      ]),
    ).toBe(
      `# 2026-09-25\n\n## NVDA\n- first bullet\n- second bullet\n\n## SPY\n- later alphabetically\n`,
    );
  });

  test("drops a ticker left with no bullets", () => {
    // The curator empties stale bullets; a bare heading must not linger.
    const out = renderDay("2026-09-25", [
      { ticker: "NVDA", bullets: [] },
      { ticker: "SPY", bullets: ["kept"] },
    ]);
    expect(out).not.toContain("NVDA");
    expect(out).toContain("SPY");
  });

  test("round trips through parseDay", () => {
    const blocks: TickerBlock[] = [
      { ticker: "NVDA", bullets: ["a", "b"] },
      { ticker: "AAPL", bullets: ["c"] },
    ];
    expect(parseDay(renderDay("2026-09-25", blocks))).toEqual([
      { ticker: "AAPL", bullets: ["c"] },
      { ticker: "NVDA", bullets: ["a", "b"] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// mergeObservations
// ---------------------------------------------------------------------------

describe("mergeObservations", () => {
  test("appends to an existing ticker", () => {
    const r = mergeObservations([{ ticker: "NVDA", bullets: ["old"] }], "NVDA", ["new"]);
    expect(r.blocks).toEqual([{ ticker: "NVDA", bullets: ["old", "new"] }]);
    expect(r.added).toEqual(["new"]);
  });

  test("creates the ticker when absent, leaving others untouched", () => {
    expect(mergeObservations([{ ticker: "SPY", bullets: ["x"] }], "NVDA", ["y"]).blocks).toEqual([
      { ticker: "SPY", bullets: ["x"] },
      { ticker: "NVDA", bullets: ["y"] },
    ]);
  });

  test("skips an exact duplicate already recorded that day", () => {
    // A retried tool call must not inflate how often a fact appears — that count
    // is exactly what journal-reflector reads.
    const r = mergeObservations([{ ticker: "NVDA", bullets: ["held 221.71"] }], "NVDA", [
      "held 221.71",
      "gamma positive",
    ]);
    expect(r.added).toEqual(["gamma positive"]);
    expect(r.skipped).toEqual(["held 221.71"]);
    expect(r.blocks[0].bullets).toEqual(["held 221.71", "gamma positive"]);
  });

  test("dedups within one call and drops whitespace-only entries", () => {
    const r = mergeObservations([], "NVDA", ["same", "  same  ", "   ", "other"]);
    expect(r.added).toEqual(["same", "other"]);
    expect(r.skipped).toEqual(["same"]);
  });

  test("near-duplicate wording is kept — that judgment belongs to the curator", () => {
    const r = mergeObservations([{ ticker: "NVDA", bullets: ["held 221.71"] }], "NVDA", [
      "held 221.71 again",
    ]);
    expect(r.added).toEqual(["held 221.71 again"]);
    expect(r.skipped).toEqual([]);
  });

  test("does not mutate the input blocks", () => {
    const input: TickerBlock[] = [{ ticker: "NVDA", bullets: ["old"] }];
    mergeObservations(input, "NVDA", ["new"]);
    expect(input).toEqual([{ ticker: "NVDA", bullets: ["old"] }]);
  });
});

// ---------------------------------------------------------------------------
// findDuplicates
// ---------------------------------------------------------------------------

describe("findDuplicates", () => {
  const days: Array<[string, TickerBlock[]]> = [
    ["2026-09-24", [{ ticker: "NVDA", bullets: ["held 221.71", "unique to the 24th"] }]],
    ["2026-09-25", [{ ticker: "NVDA", bullets: ["held 221.71"] }, { ticker: "SPY", bullets: ["pinned"] }]],
    ["2026-09-23", [{ ticker: "NVDA", bullets: ["held 221.71"] }]],
  ];

  test("reports a bullet repeated across days, with every date sorted", () => {
    const dupes = findDuplicates(days);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].ticker).toBe("NVDA");
    expect(dupes[0].bullet).toBe("held 221.71");
    expect(dupes[0].dates).toEqual(["2026-09-23", "2026-09-24", "2026-09-25"]);
  });

  test("a bullet on only one day is not a duplicate", () => {
    expect(findDuplicates([["2026-09-25", [{ ticker: "NVDA", bullets: ["once"] }]]])).toEqual([]);
  });

  test("the same text under different tickers is not a duplicate", () => {
    expect(
      findDuplicates([
        ["2026-09-24", [{ ticker: "NVDA", bullets: ["gamma positive"] }]],
        ["2026-09-25", [{ ticker: "SPY", bullets: ["gamma positive"] }]],
      ]),
    ).toEqual([]);
  });

  test("filters to one ticker", () => {
    const all = findDuplicates([
      ["2026-09-24", [{ ticker: "NVDA", bullets: ["a"] }, { ticker: "SPY", bullets: ["b"] }]],
      ["2026-09-25", [{ ticker: "NVDA", bullets: ["a"] }, { ticker: "SPY", bullets: ["b"] }]],
    ]);
    expect(all).toHaveLength(2);
    expect(
      findDuplicates(
        [
          ["2026-09-24", [{ ticker: "NVDA", bullets: ["a"] }, { ticker: "SPY", bullets: ["b"] }]],
          ["2026-09-25", [{ ticker: "NVDA", bullets: ["a"] }, { ticker: "SPY", bullets: ["b"] }]],
        ],
        "SPY",
      ).map((d) => d.ticker),
    ).toEqual(["SPY"]);
  });
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

describe("summarize", () => {
  test("counts observations and distinct days per ticker, busiest first", () => {
    const { entries, perTicker } = summarize([
      ["2026-09-24", [{ ticker: "NVDA", bullets: ["a", "b"] }, { ticker: "SPY", bullets: ["c"] }]],
      ["2026-09-25", [{ ticker: "NVDA", bullets: ["d"] }]],
    ]);
    expect(entries).toBe(4);
    expect(perTicker).toEqual([
      { ticker: "NVDA", entries: 3, days: 2 },
      { ticker: "SPY", entries: 1, days: 1 },
    ]);
  });

  test("an empty corpus summarizes to zero", () => {
    expect(summarize([])).toEqual({ entries: 0, perTicker: [] });
  });
});

// ---------------------------------------------------------------------------
// validDate / todayUtc / normalizeTicker / clipResponse
// ---------------------------------------------------------------------------

describe("validDate", () => {
  test("accepts real days, including a leap day", () => {
    expect(validDate("2026-09-25")).toBe(true);
    expect(validDate("2024-02-29")).toBe(true);
  });

  test("rejects malformed and impossible days", () => {
    // 2026-02-30 is the important one: Date would roll it into March, filing an
    // observation under a day it did not happen.
    for (const bad of [
      "2026-9-25",
      "26-09-25",
      "2026/09/25",
      "",
      "today",
      "2026-02-30",
      "2026-13-01",
      "2025-02-29",
    ]) {
      expect(validDate(bad)).toBe(false);
    }
  });
});

describe("todayUtc", () => {
  test("formats as YYYY-MM-DD in UTC", () => {
    expect(todayUtc(new Date("2026-09-25T23:59:59Z"))).toBe("2026-09-25");
    expect(todayUtc(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });
});

describe("normalizeTicker", () => {
  test("uppercases and trims", () => {
    expect(normalizeTicker(" nvda ")).toBe("NVDA");
    expect(normalizeTicker("brk.b")).toBe("BRK.B");
  });
});

describe("clipResponse", () => {
  test("passes short text through untouched", () => {
    expect(clipResponse("short", 100)).toBe("short");
  });

  test("clips long text, says so, and names the escape hatch", () => {
    const out = clipResponse("x".repeat(50), 20);
    expect(out.startsWith("x".repeat(20))).toBe(true);
    expect(out).toContain("clipped");
    expect(out).toContain("journal-reflector");
  });
});

// ---------------------------------------------------------------------------
// parseDayDocument / renderDayDocument / recordObservations — fidelity
//
// The write path. `parseDay`/`renderDay` are the reducer view and are allowed to
// drop non-ticker content; the DOCUMENT round trip is not, because `record`
// rewrites the whole file and these files are hand-edited by the journal agents.
// ---------------------------------------------------------------------------

describe("parseDayDocument", () => {
  test("captures the title date and the ticker blocks", () => {
    const doc = parseDayDocument(`# 2026-09-25\n\n## NVDA\n- a fact\n`);
    expect(doc.date).toBe("2026-09-25");
    expect(doc.sections).toEqual([
      { kind: "ticker", ticker: "NVDA", bullets: ["a fact"], extra: [] },
    ]);
  });

  test("keeps a non-ticker heading and its prose as an other-section", () => {
    const doc = parseDayDocument(`# 2026-09-25\n\n## Patterns\nCurator prose.\n`);
    expect(doc.sections).toHaveLength(1);
    const other = doc.sections[0] as { kind: string; lines: string[] };
    expect(other.kind).toBe("other");
    // Trailing blank lines are captured verbatim and trimmed on render, so assert
    // the content rather than the exact line count.
    expect(other.lines.slice(0, 2)).toEqual(["## Patterns", "Curator prose."]);
    expect(renderDayDocument("2026-09-25", doc)).toBe(
      `# 2026-09-25\n\n## Patterns\nCurator prose.\n`,
    );
  });

  test("a foreign heading CLOSES the open ticker, so bullets are not misattributed", () => {
    // The corruption this guards is worse than loss: without the close, the
    // lowercase block's bullet appends to NVDA and is written back under that
    // name, so misattributed history reads as true.
    const doc = parseDayDocument(
      `# 2026-09-25\n\n## NVDA\n- really nvda\n\n## nvda\n- hand-edited lowercase\n`,
    );
    const nvda = doc.sections.find(
      (s): s is Extract<typeof s, { kind: "ticker" }> => s.kind === "ticker",
    );
    expect(nvda?.bullets).toEqual(["really nvda"]);
    expect(doc.sections.some((s) => s.kind === "other")).toBe(true);
  });

  test("two headings for one ticker coalesce, so a duplicate cannot slip in twice", () => {
    const doc = parseDayDocument(`## NVDA\n- first\n\n## NVDA\n- second\n`);
    const tickers = doc.sections.filter((s) => s.kind === "ticker");
    expect(tickers).toHaveLength(1);
    expect(recordObservations(doc, "NVDA", ["first"]).skipped).toEqual(["first"]);
  });

  test("still joins a wrapped bullet, and keeps unindented prose as extra", () => {
    const doc = parseDayDocument(`## NVDA\n- gapped +6.3%,\n  then faded\nloose note\n`);
    const t = doc.sections[0] as { bullets: string[]; extra: string[] };
    expect(t.bullets).toEqual(["gapped +6.3%, then faded"]);
    expect(t.extra).toEqual(["loose note"]);
  });
});

describe("renderDayDocument", () => {
  test("round trips a hand-edited file without losing anything", () => {
    const original = [
      "# 2026-09-25",
      "",
      "## Notes",
      "Curator pass: watch the gamma flip.",
      "",
      "## NVDA",
      "- reclaimed the 50MA",
      "",
      "<!-- before -->",
      "",
      "## SPY",
      "- rejected at the FVG",
      "",
    ].join("\n");
    const out = renderDayDocument("2026-09-25", parseDayDocument(original));
    for (const kept of [
      "## Notes",
      "Curator pass: watch the gamma flip.",
      "<!-- before -->",
      "reclaimed the 50MA",
      "rejected at the FVG",
    ]) {
      expect(out).toContain(kept);
    }
  });

  test("is byte-stable: re-parsing and re-rendering its own output changes nothing", () => {
    const once = renderDayDocument(
      "2026-09-25",
      parseDayDocument(`# 2026-09-25\n\n## Notes\nprose\n\n## NVDA\n- a\n`),
    );
    expect(renderDayDocument("2026-09-25", parseDayDocument(once))).toBe(once);
  });

  test("emits exactly one title line even though the source had one", () => {
    const out = renderDayDocument("2026-09-25", parseDayDocument(`# 2026-09-25\n\n## NVDA\n- a\n`));
    expect(out.match(/^# 2026-09-25$/gm)).toHaveLength(1);
  });
});

describe("recordObservations", () => {
  test("adds to the right ticker while preserving foreign sections", () => {
    const doc = parseDayDocument(`# 2026-09-25\n\n## Patterns\nprose\n\n## NVDA\n- old\n`);
    const { doc: next, added } = recordObservations(doc, "NVDA", ["new"]);
    expect(added).toEqual(["new"]);
    const out = renderDayDocument("2026-09-25", next);
    expect(out).toContain("- old");
    expect(out).toContain("- new");
    expect(out).toContain("## Patterns");
    expect(out).toContain("prose");
  });

  test("creates the ticker when the day file holds only prose", () => {
    const { doc, added } = recordObservations(
      parseDayDocument(`# 2026-09-25\n\nloose prose\n`),
      "NVDA",
      ["first fact"],
    );
    expect(added).toEqual(["first fact"]);
    const out = renderDayDocument("2026-09-25", doc);
    expect(out).toContain("## NVDA");
    expect(out).toContain("loose prose");
  });

  test("does not mutate the input document", () => {
    const doc = parseDayDocument(`## NVDA\n- old\n`);
    const before = JSON.stringify(doc);
    recordObservations(doc, "NVDA", ["new"]);
    expect(JSON.stringify(doc)).toBe(before);
  });

  test("dedup matches mergeObservations, so the two paths cannot disagree", () => {
    const observations = ["dup", "dup", "fresh"];
    const viaDoc = recordObservations(parseDayDocument(`## NVDA\n- dup\n`), "NVDA", observations);
    const viaBlocks = mergeObservations([{ ticker: "NVDA", bullets: ["dup"] }], "NVDA", observations);
    expect(viaDoc.added).toEqual(viaBlocks.added);
    expect(viaDoc.skipped).toEqual(viaBlocks.skipped);
  });
});

describe("document round trip: hostile inputs", () => {
  const rt = (s: string) => renderDayDocument("2026-09-28", parseDayDocument(s));

  test("an empty or whitespace-only file still accepts a write", () => {
    for (const src of ["", "\n\n\n", "   ", "# 2026-09-28\n"]) {
      const { doc, added } = recordObservations(parseDayDocument(src), "NVDA", ["fact"]);
      expect(added).toEqual(["fact"]);
      expect(renderDayDocument("2026-09-28", doc)).toContain("- fact");
    }
  });

  test("deeper headings are preserved and never read as tickers", () => {
    // `### NVDA` is not a ticker heading (## only), but throwing it away would
    // delete a reflector report pasted into the day file.
    const out = rt("# 2026-09-28\n\n### NVDA\n- looks like one\n\n###### Deep\nmore\n");
    expect(out).toContain("### NVDA");
    expect(out).toContain("###### Deep");
    expect(out).toContain("looks like one");
  });

  test("a fenced code block containing ## survives verbatim", () => {
    const out = rt("# 2026-09-28\n\n## NVDA\n- a\n\n```\n## NOTATICKER\n```\n");
    expect(out).toContain("```");
    expect(out).toContain("## NOTATICKER");
  });

  test("bullets before any heading are not dropped", () => {
    expect(rt("# 2026-09-28\n\n- orphan\n\n## NVDA\n- real\n")).toContain("orphan");
  });

  test("repeated round trips converge instead of drifting or growing", () => {
    const once = rt("# 2026-09-28\n\n## Notes\nprose\n\n## NVDA\n- a\n\n<!-- c -->\n");
    expect(rt(once)).toBe(once);
    expect(rt(rt(once))).toBe(once);
  });

  test("CRLF endings and non-ASCII content are preserved", () => {
    expect(rt("# 2026-09-28\r\n\r\n## NVDA\r\n- windows\r\n")).toContain("windows");
    expect(rt("# 2026-09-28\n\n## NVDA\n- held \u00a5221.71 \u2014 \u4ee5\u4e0a\n")).toContain("\u4ee5\u4e0a");
  });
});
