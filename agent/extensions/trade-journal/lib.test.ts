/**
 * Tests for the trade-journal mode logic (`lib.ts`) — the day-file window, the
 * playback shape, and the four modes end to end against an in-memory corpus.
 *
 * These are the tests that could not exist while this was a top-level
 * `trade-journal.ts`: pi auto-loads every `agent/extensions/*.ts`, so a sibling
 * `*.test.ts` importing `bun:test` would break pi's startup. Hence the
 * subdirectory.
 *
 * Run from the repo root: `bun test agent/extensions/trade-journal/lib.test.ts`
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_READ_LIMIT,
  formatRead,
  journalDir,
  runJournal,
  selectDayFiles,
  type JournalFs,
} from "./lib.js";
import type { TickerBlock } from "../lib/trade-journal-store.js";

/**
 * In-memory filesystem over a `path → contents` map.
 *
 * Mirrors the real seam's failure behaviour: a missing directory or file throws,
 * because that is exactly the case the modes must degrade on rather than crash.
 */
function fakeFs(files: Record<string, string> = {}): JournalFs & { files: Record<string, string> } {
  const store = { ...files };
  return {
    files: store,
    async readdir(dir) {
      const prefix = `${dir}/`;
      const names = Object.keys(store)
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length));
      if (names.length === 0) throw new Error(`ENOENT: ${dir}`);
      return names;
    },
    async readFile(path) {
      const text = store[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    async writeFile(path, text) {
      store[path] = text;
    },
    async mkdir() {},
  };
}

const DIR = "/j";

// ---------------------------------------------------------------------------
// selectDayFiles
// ---------------------------------------------------------------------------

describe("selectDayFiles", () => {
  const files = ["2026-09-20.md", "2026-09-21.md", "2026-09-22.md", "2026-09-23.md"];

  test("returns newest first", () => {
    expect(selectDayFiles(files, {})).toEqual([
      "2026-09-23.md",
      "2026-09-22.md",
      "2026-09-21.md",
      "2026-09-20.md",
    ]);
  });

  test("date pins exactly one day", () => {
    expect(selectDayFiles(files, { date: "2026-09-21" })).toEqual(["2026-09-21.md"]);
  });

  test("since and until bound the range inclusively", () => {
    expect(selectDayFiles(files, { since: "2026-09-21", until: "2026-09-22" })).toEqual([
      "2026-09-22.md",
      "2026-09-21.md",
    ]);
  });

  test("limit keeps the most recent N, not the earliest", () => {
    // The ordering bug this guards: slicing before reversing would return the
    // OLDEST days, so a default-limit read on a long corpus would show history
    // from months ago and silently omit this week.
    expect(selectDayFiles(files, { limit: 2 })).toEqual(["2026-09-23.md", "2026-09-22.md"]);
  });

  test("a non-positive or fractional limit falls back to the default", () => {
    const many = Array.from(
      { length: 40 },
      (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}.md`,
    );
    expect(selectDayFiles(many, { limit: 0 })).toHaveLength(DEFAULT_READ_LIMIT);
    expect(selectDayFiles(many, { limit: -5 })).toHaveLength(DEFAULT_READ_LIMIT);
    expect(selectDayFiles(many, { limit: 2.7 })).toHaveLength(2);
  });

  test("does not mutate its input", () => {
    const input = [...files];
    selectDayFiles(input, { limit: 1 });
    expect(input).toEqual(files);
  });
});

// ---------------------------------------------------------------------------
// formatRead
// ---------------------------------------------------------------------------

describe("formatRead", () => {
  const days: Array<[string, TickerBlock[]]> = [
    [
      "2026-09-23",
      [
        { ticker: "NVDA", bullets: ["held 221.71", "gamma positive"] },
        { ticker: "SPY", bullets: ["pinned at 770"] },
      ],
    ],
    ["2026-09-22", [{ ticker: "SPY", bullets: ["gap filled"] }]],
  ];

  test("counts observations and days across the corpus", () => {
    const { entries, dayCount } = formatRead(days);
    expect(entries).toBe(4);
    expect(dayCount).toBe(2);
  });

  test("a ticker filter excludes other names and the days that only hold them", () => {
    const { lines, entries, dayCount } = formatRead(days, "NVDA");
    expect(entries).toBe(2);
    expect(dayCount).toBe(1); // 2026-09-22 has no NVDA, so it is not a day
    expect(lines.join("\n")).not.toContain("SPY");
  });

  test("a filter matching nothing yields no lines", () => {
    expect(formatRead(days, "TSLA")).toEqual({ lines: [], entries: 0, dayCount: 0 });
  });
});

// ---------------------------------------------------------------------------
// journalDir
// ---------------------------------------------------------------------------

describe("journalDir", () => {
  test("honours AGENTIC_TRADING_JOURNAL", () => {
    expect(journalDir({ AGENTIC_TRADING_JOURNAL: "/tmp/j" })).toBe("/tmp/j");
  });

  test("expands a leading ~/ in the override", () => {
    const out = journalDir({ AGENTIC_TRADING_JOURNAL: "~/alt/journal" });
    expect(out.endsWith("/alt/journal")).toBe(true);
    expect(out).not.toContain("~");
  });

  test("defaults under the home directory", () => {
    expect(journalDir({}).endsWith("/.agentic-trading/journal")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runJournal — validation
// ---------------------------------------------------------------------------

describe("runJournal validation", () => {
  test("record without a ticker is an error, not a write", async () => {
    const fs = fakeFs();
    const r = await runJournal({ mode: "record", observations: ["x"] }, fs, DIR);
    expect(r.isError).toBe(true);
    expect(Object.keys(fs.files)).toEqual([]);
  });

  test("record with no usable observation is refused", async () => {
    const r = await runJournal(
      { mode: "record", ticker: "NVDA", observations: ["  ", ""] },
      fakeFs(),
      DIR,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("at least one non-empty observation");
  });

  test("an impossible date is rejected rather than rolled forward", async () => {
    // 2026-02-30 would roll into March, filing an observation under a day it
    // did not happen.
    const r = await runJournal(
      { mode: "record", ticker: "NVDA", observations: ["x"], date: "2026-02-30" },
      fakeFs(),
      DIR,
    );
    expect(r.isError).toBe(true);
  });

  test("read rejects each malformed window bound by name", async () => {
    for (const key of ["date", "since", "until"] as const) {
      const r = await runJournal({ mode: "read", [key]: "yesterday" }, fakeFs(), DIR);
      expect(r.isError).toBe(true);
      expect(r.text).toContain(key);
    }
  });

  test("a filesystem failure is reported, never thrown", async () => {
    const exploding: JournalFs = {
      readdir: async () => ["2026-09-23.md"],
      readFile: async () => "",
      writeFile: async () => {
        throw new Error("disk full");
      },
      mkdir: async () => {},
    };
    const r = await runJournal(
      { mode: "record", ticker: "NVDA", observations: ["x"], date: "2026-09-23" },
      exploding,
      DIR,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("disk full");
  });
});

// ---------------------------------------------------------------------------
// runJournal — modes
// ---------------------------------------------------------------------------

describe("runJournal modes", () => {
  test("record writes a new day file and reports what was added", async () => {
    const fs = fakeFs();
    const r = await runJournal(
      { mode: "record", ticker: "nvda", observations: ["held 221.71"], date: "2026-09-23" },
      fs,
      DIR,
    );
    expect(r.isError).toBeUndefined();
    expect(r.details.added).toBe(1);
    expect(fs.files["/j/2026-09-23.md"]).toContain("## NVDA"); // ticker normalized
    expect(r.text).toContain("(new file)");
  });

  test("record defaults to today from the injected clock", async () => {
    const fs = fakeFs();
    await runJournal(
      { mode: "record", ticker: "NVDA", observations: ["x"] },
      fs,
      DIR,
      new Date("2026-09-23T12:00:00Z"),
    );
    expect(Object.keys(fs.files)).toEqual(["/j/2026-09-23.md"]);
  });

  test("record preserves hand-written content already in the day file", async () => {
    // The interoperability guarantee in journal.md: the tool must not delete what
    // an agent wrote by hand.
    const fs = fakeFs({
      "/j/2026-09-23.md": "# 2026-09-23\n\n## Patterns\nCurator note: watch the gamma flip.\n",
    });
    await runJournal(
      { mode: "record", ticker: "NVDA", observations: ["held 221.71"], date: "2026-09-23" },
      fs,
      DIR,
    );
    const out = fs.files["/j/2026-09-23.md"];
    expect(out).toContain("## Patterns");
    expect(out).toContain("Curator note: watch the gamma flip.");
    expect(out).toContain("held 221.71");
  });

  test("record skips an exact duplicate instead of inflating the count", async () => {
    const fs = fakeFs({ "/j/2026-09-23.md": "# 2026-09-23\n\n## NVDA\n- held 221.71\n" });
    const r = await runJournal(
      {
        mode: "record",
        ticker: "NVDA",
        observations: ["held 221.71", "gamma positive"],
        date: "2026-09-23",
      },
      fs,
      DIR,
    );
    expect(r.details.added).toBe(1);
    expect(r.details.skipped).toBe(1);
  });

  test("read plays back a ticker across days, newest first", async () => {
    const fs = fakeFs({
      "/j/2026-09-22.md": "# 2026-09-22\n\n## NVDA\n- older\n",
      "/j/2026-09-23.md": "# 2026-09-23\n\n## NVDA\n- newer\n",
    });
    const r = await runJournal({ mode: "read", ticker: "NVDA" }, fs, DIR);
    expect(r.details.entries).toBe(2);
    expect(r.text.indexOf("2026-09-23")).toBeLessThan(r.text.indexOf("2026-09-22"));
  });

  test("an empty journal is reported as a valid finding", async () => {
    const r = await runJournal({ mode: "read", ticker: "NVDA" }, fakeFs(), DIR);
    expect(r.isError).toBeUndefined();
    expect(r.details.entries).toBe(0);
    expect(r.text).toContain("valid finding");
  });

  test("read distinguishes an empty corpus from a ticker with no entries", async () => {
    const fs = fakeFs({ "/j/2026-09-23.md": "# 2026-09-23\n\n## SPY\n- pinned\n" });
    const r = await runJournal({ mode: "read", ticker: "NVDA" }, fs, DIR);
    expect(r.details.files).toBe(1);
    expect(r.details.entries).toBe(0);
    expect(r.text).toContain("Nothing recorded on that name yet");
  });

  test("non-day files in the directory are ignored", async () => {
    const fs = fakeFs({
      "/j/2026-09-23.md": "# 2026-09-23\n\n## NVDA\n- kept\n",
      "/j/README.md": "not a day file",
      "/j/notes.txt": "nor this",
    });
    const r = await runJournal({ mode: "read" }, fs, DIR);
    expect(r.details.files).toBe(1);
  });

  test("stats reports the corpus shape and span", async () => {
    const fs = fakeFs({
      "/j/2026-09-22.md": "# 2026-09-22\n\n## NVDA\n- a\n- b\n",
      "/j/2026-09-23.md": "# 2026-09-23\n\n## SPY\n- c\n",
    });
    const r = await runJournal({ mode: "stats" }, fs, DIR);
    expect(r.details.entries).toBe(3);
    expect(r.text).toContain("2026-09-22 .. 2026-09-23");
    expect(r.text).toContain("NVDA");
  });

  test("stats on an empty journal says so", async () => {
    const r = await runJournal({ mode: "stats" }, fakeFs(), DIR);
    expect(r.details.files).toBe(0);
    expect(r.text).toContain("empty");
  });

  test("dupes finds a bullet repeated across days", async () => {
    const fs = fakeFs({
      "/j/2026-09-22.md": "# 2026-09-22\n\n## NVDA\n- held 221.71\n",
      "/j/2026-09-23.md": "# 2026-09-23\n\n## NVDA\n- held 221.71\n",
    });
    const r = await runJournal({ mode: "dupes" }, fs, DIR);
    expect(r.details.entries).toBe(1);
    expect(r.text).toContain("journal-curator");
  });

  test("dupes reports none when nothing repeats, and points at the curator", async () => {
    const fs = fakeFs({ "/j/2026-09-23.md": "# 2026-09-23\n\n## NVDA\n- once\n" });
    const r = await runJournal({ mode: "dupes" }, fs, DIR);
    expect(r.details.entries).toBe(0);
    expect(r.text).toContain("judgment call");
  });

  test("a record then a read round-trips through the real grammar", async () => {
    const fs = fakeFs();
    await runJournal(
      { mode: "record", ticker: "NVDA", observations: ["held 221.71"], date: "2026-09-23" },
      fs,
      DIR,
    );
    const r = await runJournal({ mode: "read", ticker: "NVDA" }, fs, DIR);
    expect(r.details.entries).toBe(1);
    expect(r.text).toContain("held 221.71");
  });
});
