/**
 * Trade-journal mode logic — the pure, tested half of the `trade_journal` tool.
 *
 * `index.ts` keeps only the pi wiring (schema, `registerTool`, the guideline
 * text); everything that decides *what* a mode returns lives here, behind an
 * injected filesystem. That split is why this file exists at all: the mode logic
 * grew date-window filtering, a newest-first window, and three output shapes —
 * logic that deserves a test — and a `*.test.ts` cannot sit beside a top-level
 * extension, because pi auto-loads every `agent/extensions/*.ts` and the test
 * file's `bun:test` import would take pi's startup down with it.
 *
 * Same shape as `subagent-herdr/lib.ts` vs its `index.ts`.
 *
 * The markdown grammar itself is NOT here — `../lib/trade-journal-store.ts` owns
 * it, for the tool and the journal agents alike (one parser per format).
 *
 * Pure module: `node:*` only, no pi import.
 *
 * @module extensions/trade-journal/lib
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DAY_FILE,
  clipResponse,
  findDuplicates,
  normalizeTicker,
  parseDay,
  parseDayDocument,
  recordObservations,
  renderDayDocument,
  summarize,
  todayUtc,
  validDate,
  type TickerBlock,
} from "../lib/trade-journal-store.js";

/** Default cap on day files returned by one `read`, newest first. */
export const DEFAULT_READ_LIMIT = 30;

/**
 * The filesystem operations the journal needs.
 *
 * Injected so the mode logic is testable against an in-memory corpus: these
 * functions are the only impurity in this module, and a fake for them turns every
 * mode into a pure function of its inputs.
 */
export interface JournalFs {
  readdir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

/** The real filesystem. */
export const nodeJournalFs: JournalFs = {
  readdir: (dir) => readdir(dir),
  readFile: (path) => readFile(path, "utf-8"),
  writeFile: async (path, text) => {
    await writeFile(path, text, "utf-8");
  },
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
};

/**
 * Journal root. The env override exists so a test — or a second portfolio — can
 * point elsewhere without disturbing the default path a user already has.
 */
export function journalDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTIC_TRADING_JOURNAL;
  if (override) {
    return override.startsWith("~/") ? join(homedir(), override.slice(2)) : override;
  }
  return join(homedir(), ".agentic-trading", "journal");
}

export interface JournalDetails {
  mode: string;
  dir: string;
  date?: string;
  ticker?: string;
  added?: number;
  skipped?: number;
  files?: number;
  entries?: number;
}

export interface JournalResult {
  text: string;
  details: JournalDetails;
  isError?: boolean;
}

/** A journal request, already shape-checked by the tool schema. */
export interface JournalRequest {
  mode: "record" | "read" | "stats" | "dupes";
  ticker?: string;
  observations?: string[];
  date?: string;
  since?: string;
  until?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Disk access — every read degrades to empty rather than throwing, so a missing
// or unreadable journal reports "nothing recorded" instead of failing a session.
// ---------------------------------------------------------------------------

async function dayFiles(fs: JournalFs, dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => DAY_FILE.test(f)).sort();
  } catch {
    return [];
  }
}

async function readDay(fs: JournalFs, dir: string, file: string): Promise<string> {
  try {
    return await fs.readFile(join(dir, file));
  } catch {
    return "";
  }
}

async function loadDays(
  fs: JournalFs,
  dir: string,
  files: string[],
): Promise<Array<[string, TickerBlock[]]>> {
  const out: Array<[string, TickerBlock[]]> = [];
  for (const file of files) {
    out.push([file.slice(0, 10), parseDay(await readDay(fs, dir, file))]);
  }
  return out;
}

/**
 * Narrows a sorted day-file list to the requested window, newest first.
 *
 * Pure and separate because it is the fiddliest part of `read`: `date` pins one
 * day, `since`/`until` bound a range, and `limit` applies *after* the reversal —
 * so a limit returns the most recent N days, not the earliest N.
 *
 * @param files - Day filenames (`YYYY-MM-DD.md`), ascending.
 * @param opts - Window bounds; `limit` counts files, not observations.
 */
export function selectDayFiles(
  files: readonly string[],
  opts: { date?: string; since?: string; until?: string; limit?: number },
): string[] {
  let out = [...files];
  if (opts.date) out = out.filter((f) => f.slice(0, 10) === opts.date);
  if (opts.since) out = out.filter((f) => f.slice(0, 10) >= opts.since!);
  if (opts.until) out = out.filter((f) => f.slice(0, 10) <= opts.until!);
  out.reverse(); // Newest first: a read is usually about recent history.
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_READ_LIMIT;
  return out.slice(0, limit);
}

/**
 * Formats loaded days as the `read` playback body.
 *
 * @returns The body lines plus the counts the caller reports and records.
 */
export function formatRead(
  days: ReadonlyArray<[string, TickerBlock[]]>,
  ticker?: string,
): { lines: string[]; entries: number; dayCount: number } {
  const lines: string[] = [];
  let entries = 0;
  let dayCount = 0;
  for (const [date, blocks] of days) {
    const kept = blocks.filter((b) => !ticker || b.ticker === ticker);
    if (kept.length === 0) continue;
    dayCount += 1;
    lines.push(`## ${date}`);
    for (const b of kept) {
      lines.push(`### ${b.ticker}`, ...b.bullets.map((x) => `- ${x}`));
      entries += b.bullets.length;
    }
    lines.push("");
  }
  return { lines, entries, dayCount };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function doRecord(
  fs: JournalFs,
  dir: string,
  date: string,
  ticker: string,
  observations: string[],
): Promise<JournalResult> {
  const file = `${date}.md`;
  const existing = await readDay(fs, dir, file);
  // The document parse, not the block parse: this path REWRITES the whole file,
  // so anything the block view omits (curator prose, a `## Patterns` heading, the
  // `<!-- before/after -->` comments) would be deleted on write.
  const { doc, added, skipped } = recordObservations(
    parseDayDocument(existing),
    ticker,
    observations,
  );
  await fs.mkdir(dir);
  await fs.writeFile(join(dir, file), renderDayDocument(date, doc));

  const lines = [
    `Recorded ${added.length} observation${added.length === 1 ? "" : "s"} for ${ticker} in ${file}${existing ? "" : " (new file)"}.`,
    ...added.map((a) => `  + ${a}`),
  ];
  if (skipped.length > 0) {
    lines.push(
      `Skipped ${skipped.length} exact duplicate${skipped.length === 1 ? "" : "s"} already recorded that day:`,
      ...skipped.map((s) => `  = ${s}`),
    );
  }
  return {
    text: lines.join("\n"),
    details: { mode: "record", dir, date, ticker, added: added.length, skipped: skipped.length },
  };
}

async function doRead(
  fs: JournalFs,
  dir: string,
  opts: { ticker?: string; date?: string; since?: string; until?: string; limit?: number },
): Promise<JournalResult> {
  const files = selectDayFiles(await dayFiles(fs, dir), opts);
  const scope = opts.ticker ? ` for ${opts.ticker}` : "";

  if (files.length === 0) {
    return {
      text: `No journal entries${scope} in ${dir}. An empty journal is a valid finding — proceed on live data rather than inferring history.`,
      details: { mode: "read", dir, ticker: opts.ticker, files: 0, entries: 0 },
    };
  }

  const { lines, entries, dayCount } = formatRead(
    await loadDays(fs, dir, files),
    opts.ticker,
  );

  if (entries === 0) {
    return {
      text: `No entries${scope} in the ${files.length} day file(s) searched. Nothing recorded on that name yet.`,
      details: { mode: "read", dir, ticker: opts.ticker, files: files.length, entries: 0 },
    };
  }

  const header = `${entries} observation${entries === 1 ? "" : "s"} across ${dayCount} day(s)${scope}, newest first.`;
  return {
    text: clipResponse([header, "", ...lines].join("\n")),
    details: { mode: "read", dir, ticker: opts.ticker, files: files.length, entries },
  };
}

async function doStats(fs: JournalFs, dir: string): Promise<JournalResult> {
  const files = await dayFiles(fs, dir);
  if (files.length === 0) {
    return {
      text: `Journal is empty (${dir}).`,
      details: { mode: "stats", dir, files: 0, entries: 0 },
    };
  }
  const { entries, perTicker } = summarize(await loadDays(fs, dir, files));
  return {
    text: clipResponse(
      [
        `Journal: ${files.length} day file(s), ${entries} observation(s), ${perTicker.length} ticker(s).`,
        `Span: ${files[0].slice(0, 10)} .. ${files[files.length - 1].slice(0, 10)}`,
        "",
        ...perTicker.map(
          (r) => `  ${r.ticker.padEnd(8)} ${String(r.entries).padStart(4)} obs over ${r.days} day(s)`,
        ),
      ].join("\n"),
    ),
    details: { mode: "stats", dir, files: files.length, entries },
  };
}

async function doDupes(fs: JournalFs, dir: string, ticker?: string): Promise<JournalResult> {
  const files = await dayFiles(fs, dir);
  const dupes = findDuplicates(await loadDays(fs, dir, files), ticker);
  const scope = ticker ? ` for ${ticker}` : "";
  if (dupes.length === 0) {
    return {
      text: `No byte-identical observations across days${scope}. Near-duplicate wording is a judgment call — delegate journal-curator to assess it.`,
      details: { mode: "dupes", dir, ticker, files: files.length, entries: 0 },
    };
  }
  return {
    text: clipResponse(
      [
        `${dupes.length} observation(s) recorded identically on more than one day${scope}.`,
        "Safe consolidation candidates: delegate journal-curator to merge them with the counts preserved.",
        "",
        ...dupes.map((d) => `  ${d.ticker} \u00d7${d.dates.length} (${d.dates.join(", ")})\n    ${d.bullet}`),
      ].join("\n"),
    ),
    details: { mode: "dupes", dir, ticker, files: files.length, entries: dupes.length },
  };
}

function fail(message: string, details: JournalDetails): JournalResult {
  return { text: message, details, isError: true };
}

/**
 * Runs one journal request: validates it, dispatches the mode, returns the
 * response the tool reports.
 *
 * The whole tool behaviour behind one pure-ish entry point, so `index.ts` adds no
 * branching of its own and a test can exercise every mode without pi.
 *
 * A journal failure never throws: an unreadable corpus or a failed write comes
 * back as an error *result*, because losing a session over a journal mishap costs
 * more than the journal entry is worth.
 *
 * @param req - The request, already shape-checked by the tool schema.
 * @param fs - Filesystem seam (tests pass a fake).
 * @param dir - Journal root.
 * @param now - Injectable clock, for the `record` default date.
 */
export async function runJournal(
  req: JournalRequest,
  fs: JournalFs = nodeJournalFs,
  dir: string = journalDir(),
  now: Date = new Date(),
): Promise<JournalResult> {
  const ticker = req.ticker ? normalizeTicker(req.ticker) : undefined;

  try {
    switch (req.mode) {
      case "record": {
        if (!ticker) return fail("mode:record needs a ticker.", { mode: req.mode, dir });
        const observations = (req.observations ?? []).filter((o) => o.trim());
        if (observations.length === 0) {
          return fail(
            "mode:record needs at least one non-empty observation. An empty journal day is honest — record nothing rather than a placeholder.",
            { mode: req.mode, dir, ticker },
          );
        }
        const date = req.date ?? todayUtc(now);
        if (!validDate(date)) {
          return fail(`date must be a real YYYY-MM-DD day, got "${date}".`, {
            mode: req.mode,
            dir,
            ticker,
          });
        }
        return await doRecord(fs, dir, date, ticker, observations);
      }
      case "read": {
        for (const [key, val] of [
          ["date", req.date],
          ["since", req.since],
          ["until", req.until],
        ] as const) {
          if (val && !validDate(val)) {
            return fail(`${key} must be a real YYYY-MM-DD day, got "${val}".`, {
              mode: req.mode,
              dir,
            });
          }
        }
        return await doRead(fs, dir, {
          ticker,
          date: req.date,
          since: req.since,
          until: req.until,
          limit: req.limit,
        });
      }
      case "stats":
        return await doStats(fs, dir);
      case "dupes":
        return await doDupes(fs, dir, ticker);
    }
  } catch (err) {
    // A journal failure must never take the session down.
    return fail(
      `trade_journal ${req.mode} failed: ${err instanceof Error ? err.message : String(err)}`,
      { mode: req.mode, dir },
    );
  }
}
