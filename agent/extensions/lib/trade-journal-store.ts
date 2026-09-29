/**
 * Trading-journal storage — the pure half of the `trade_journal` tool.
 *
 * Parsing, rendering, dedup and validation live here so they are testable
 * without loading an extension; `../trade-journal/` keeps the pi wiring (`index.ts`)
 * and the mode logic (`lib.ts`). Same split as `lib/todo.ts` vs `todo.ts`.
 *
 * The format is plain markdown — one file per day, `## <TICKER>` headings, one
 * bullet per observation — because the `journal-observer` / `journal-reflector` /
 * `journal-curator` agents read and write the same files by hand. Tool and agent
 * must never disagree about the format, so the format stays something a human
 * (and a model with only `read`/`write`) can edit correctly.
 *
 * ## Two models, and why there are two
 *
 * {@link TickerBlock} is the *reducer* view: just tickers and bullets, which is
 * all `read`/`stats`/`dupes` ever need. {@link DayDocument} is the *fidelity*
 * view: it additionally carries every line the ticker grammar does not own.
 *
 * A write must go through the document view. The tool rewrites the whole day
 * file on every `record`, so anything the parser cannot see is anything the
 * writer will delete — and these files are hand-edited by the agents above,
 * which `journal.md` promises: "Both read and write the same markdown files, so
 * they interoperate freely: the tool can read what an agent wrote by hand, and
 * vice versa." A reducer-view write breaks that promise silently, which is the
 * worst way to break it: the loss shows up days later as history that a session
 * cannot explain.
 *
 * Pure module: `node:*` only, no pi import (the `lib/` rule).
 *
 * @module extensions/lib/trade-journal-store
 */

/** `YYYY-MM-DD.md` — the only filename shape the journal recognises. */
export const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * A ticker heading: `## NVDA`, `## BRK.B`.
 *
 * Deliberately uppercase-only: the reflector's own reports use prose headings
 * (`## PATTERNS`, `## Patterns`), and a lowercase-tolerant pattern would ingest
 * a pasted report as if `Patterns` were a ticker.
 *
 * The cost of that strictness is that `## nvda` is *not* a ticker, so it must be
 * preserved rather than silently absorbed — see {@link parseDayDocument}.
 */
export const TICKER_HEADING = /^##\s+([A-Z0-9][A-Z0-9.\-]*)\s*$/;

/**
 * Any markdown heading.
 *
 * Load-bearing for correctness, not just fidelity: a heading the ticker grammar
 * rejects has to *close* the open ticker block. Without this, bullets under
 * `## nvda` keep appending to whichever uppercase ticker came last and are
 * written back under that name — the observation is not lost but re-filed, and
 * misattributed history reads as true.
 */
const ANY_HEADING = /^#{1,6}\s+\S/;

/** The `# YYYY-MM-DD` title line the renderer owns and re-emits itself. */
const H1_DATE = /^#\s+(\d{4}-\d{2}-\d{2})\s*$/;

/** Cap on a single tool response so a large corpus cannot flood the context. */
export const MAX_RESPONSE_CHARS = 12_000;

/** One ticker's bullets within one day file — the reducer view. */
export interface TickerBlock {
  ticker: string;
  bullets: string[];
}

/** A ticker block as it sits in a day file, including lines around its bullets. */
export interface TickerSection {
  kind: "ticker";
  ticker: string;
  bullets: string[];
  /**
   * Non-bullet lines found inside this block, kept verbatim and re-emitted after
   * the bullets. Unindented prose under a ticker heading lands here; an indented
   * line is a wrapped bullet instead.
   */
  extra: string[];
}

/** A region the ticker grammar does not own, kept verbatim. */
export interface OtherSection {
  kind: "other";
  lines: string[];
}

export type DaySection = TickerSection | OtherSection;

/** A whole day file: its title date, and every section in file order. */
export interface DayDocument {
  date?: string;
  sections: DaySection[];
}

const isTicker = (s: DaySection): s is TickerSection => s.kind === "ticker";

/**
 * Parses a day file without discarding anything.
 *
 * Tolerant by design: nothing here rejects a file. A human or an agent editing
 * the journal by hand must not be able to make it unreadable, so unrecognised
 * input becomes an {@link OtherSection} rather than an error or a silent drop.
 *
 * Repeated headings for one ticker coalesce into a single section. Two `## NVDA`
 * blocks in one file would otherwise dedup independently, letting the same
 * observation be recorded twice on one day — which is precisely the count the
 * reflector reads.
 *
 * @param text - Raw day-file contents.
 * @returns The document, sections in file order.
 */
export function parseDayDocument(text: string): DayDocument {
  const sections: DaySection[] = [];
  const byTicker = new Map<string, TickerSection>();
  let date: string | undefined;
  let current: TickerSection | null = null;
  let other: OtherSection | null = null;

  for (const line of text.split("\n")) {
    // The title line is the renderer's to emit, so it is consumed, not preserved
    // — keeping it would duplicate it on the next write.
    if (date === undefined && sections.length === 0) {
      const h1 = line.match(H1_DATE);
      if (h1) {
        date = h1[1];
        continue;
      }
    }

    const heading = line.match(TICKER_HEADING);
    if (heading) {
      other = null;
      const existing = byTicker.get(heading[1]);
      if (existing) {
        current = existing;
      } else {
        current = { kind: "ticker", ticker: heading[1], bullets: [], extra: [] };
        byTicker.set(heading[1], current);
        sections.push(current);
      }
      continue;
    }

    if (ANY_HEADING.test(line)) {
      current = null;
      other = { kind: "other", lines: [line] };
      sections.push(other);
      continue;
    }

    if (current) {
      if (line.trimStart().startsWith("- ")) {
        current.bullets.push(line.trim().slice(2).trim());
      } else if (current.bullets.length > 0 && /^\s+\S/.test(line)) {
        // An indented continuation line: the agents wrap long observations, and a
        // wrapped bullet is one observation, not two.
        current.bullets[current.bullets.length - 1] += ` ${line.trim()}`;
      } else if (line.trim()) {
        current.extra.push(line);
      }
      continue;
    }

    if (other) {
      other.lines.push(line);
      continue;
    }
    if (line.trim()) {
      other = { kind: "other", lines: [line] };
      sections.push(other);
    }
  }

  return { date, sections };
}

/**
 * Splits a day file into its ticker blocks — the reducer view.
 *
 * Use this for `read`, `stats` and `dupes`, which only ever consume tickers and
 * bullets. A *write* must use {@link parseDayDocument}, or everything this view
 * omits is deleted on the next render.
 *
 * @param text - Raw day-file contents.
 * @returns Blocks in file order (not sorted — {@link renderDay} sorts on write).
 */
export function parseDay(text: string): TickerBlock[] {
  return parseDayDocument(text)
    .sections.filter(isTicker)
    .map((s) => ({ ticker: s.ticker, bullets: s.bullets }));
}

/**
 * Renders a whole document back to a day file, losing nothing.
 *
 * Tickers are sorted so a growing file stays scannable; bullet order *within* a
 * ticker is preserved because it is chronological within the day, which is
 * information the reflector reads. Empty blocks are dropped so a curator that
 * clears stale bullets does not leave a bare heading behind.
 *
 * Preserved non-ticker sections follow the tickers, in their original relative
 * order. Content is kept; absolute position is not, because sorting tickers and
 * pinning prose between them are contradictory goals. A file the tool itself
 * wrote has no such sections, so its output is byte-identical to before.
 */
export function renderDayDocument(date: string, doc: DayDocument): string {
  const parts: string[] = [];

  for (const s of doc.sections
    .filter(isTicker)
    .filter((s) => s.bullets.length > 0 || s.extra.length > 0)
    .sort((a, b) => a.ticker.localeCompare(b.ticker))) {
    parts.push([`## ${s.ticker}`, ...s.bullets.map((x) => `- ${x}`), ...s.extra].join("\n"));
  }

  for (const s of doc.sections) {
    if (isTicker(s)) continue;
    const text = s.lines.join("\n").trim();
    if (text) parts.push(text);
  }

  return `# ${date}\n\n${parts.join("\n\n")}\n`;
}

/**
 * Renders ticker blocks to a day file.
 *
 * The reducer-view render: correct only when the blocks are the whole file.
 * Prefer {@link renderDayDocument} on any path that rewrites a file that already
 * exists.
 */
export function renderDay(date: string, blocks: TickerBlock[]): string {
  return renderDayDocument(date, {
    sections: blocks.map((b) => ({
      kind: "ticker" as const,
      ticker: b.ticker,
      bullets: b.bullets,
      extra: [],
    })),
  });
}

/**
 * Appends observations to a bullet list, skipping exact duplicates.
 *
 * The one dedup rule, shared by the block and document merges so the two cannot
 * drift into disagreeing about what counts as a duplicate.
 *
 * Dedup is byte-exact after trimming, and that boundary is the whole design:
 * re-recording an *identical* line is always an accident (a retried tool call, a
 * re-run read) and silently inflates how often a fact appears, which is exactly
 * what the reflector counts. Near-duplicate wording is a judgment call and is
 * left alone — that belongs to `journal-curator`.
 */
function appendUnique(
  bullets: readonly string[],
  observations: readonly string[],
): { bullets: string[]; added: string[]; skipped: string[] } {
  const next = [...bullets];
  const seen = new Set(next.map((b) => b.trim()));
  const added: string[] = [];
  const skipped: string[] = [];
  for (const raw of observations) {
    const obs = raw.trim();
    if (!obs) continue;
    if (seen.has(obs)) {
      skipped.push(obs);
      continue;
    }
    seen.add(obs);
    next.push(obs);
    added.push(obs);
  }
  return { bullets: next, added, skipped };
}

/**
 * Merges new observations into existing blocks, skipping exact duplicates.
 *
 * Never mutates its input: a rewind or a failed write must not leave a
 * half-merged array behind.
 *
 * @returns The merged blocks plus which observations were added vs skipped.
 */
export function mergeObservations(
  blocks: TickerBlock[],
  ticker: string,
  observations: string[],
): { blocks: TickerBlock[]; added: string[]; skipped: string[] } {
  const next = blocks.map((b) => ({ ticker: b.ticker, bullets: [...b.bullets] }));
  let block = next.find((b) => b.ticker === ticker);
  if (!block) {
    block = { ticker, bullets: [] };
    next.push(block);
  }
  const merged = appendUnique(block.bullets, observations);
  block.bullets = merged.bullets;
  return { blocks: next, added: merged.added, skipped: merged.skipped };
}

/**
 * Merges new observations into a whole document, preserving every other section.
 *
 * The write path for `mode:record`. Never mutates its input.
 *
 * @returns The merged document plus which observations were added vs skipped.
 */
export function recordObservations(
  doc: DayDocument,
  ticker: string,
  observations: string[],
): { doc: DayDocument; added: string[]; skipped: string[] } {
  const sections: DaySection[] = doc.sections.map((s) =>
    isTicker(s)
      ? { kind: "ticker", ticker: s.ticker, bullets: [...s.bullets], extra: [...s.extra] }
      : { kind: "other", lines: [...s.lines] },
  );

  let block = sections.filter(isTicker).find((s) => s.ticker === ticker);
  if (!block) {
    block = { kind: "ticker", ticker, bullets: [], extra: [] };
    sections.push(block);
  }
  const merged = appendUnique(block.bullets, observations);
  block.bullets = merged.bullets;

  return {
    doc: { date: doc.date, sections },
    added: merged.added,
    skipped: merged.skipped,
  };
}

/**
 * True when `date` is a well-formed *and real* `YYYY-MM-DD` day.
 *
 * The round-trip check rejects `2026-02-30`, which `Date` would silently roll
 * forward into March — a rolled date would file an observation under a day it
 * did not happen.
 */
export function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** Today in UTC, `YYYY-MM-DD`. Injectable clock for tests. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Normalises a ticker for storage and lookup. */
export function normalizeTicker(t: string): string {
  return t.trim().toUpperCase();
}

/**
 * Clips a response, naming what was dropped and how to get it.
 *
 * Silent truncation would let a model conclude a ticker has no further history
 * when the corpus simply overflowed the budget.
 */
export function clipResponse(text: string, max = MAX_RESPONSE_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… response clipped at ${max} chars. Narrow with ticker/since/until, or delegate journal-reflector to read the full corpus.`;
}

/**
 * Finds observations recorded byte-identically on more than one day.
 *
 * Reported for `journal-curator` to judge, never merged automatically:
 * consolidation has to preserve the count ("held 3 of 3 retests"), and deciding
 * what a merged line should say is the curator's job.
 *
 * @param days - `[date, blocks]` pairs, any order.
 * @param ticker - Optional filter.
 * @returns One entry per duplicated bullet, with every date it appears on.
 */
export function findDuplicates(
  days: Array<[string, TickerBlock[]]>,
  ticker?: string,
): Array<{ ticker: string; bullet: string; dates: string[] }> {
  const seen = new Map<string, { ticker: string; bullet: string; dates: string[] }>();
  for (const [date, blocks] of days) {
    for (const b of blocks) {
      if (ticker && b.ticker !== ticker) continue;
      for (const bullet of b.bullets) {
        const key = `${b.ticker}\u0000${bullet}`;
        const rec = seen.get(key) ?? { ticker: b.ticker, bullet, dates: [] };
        rec.dates.push(date);
        seen.set(key, rec);
      }
    }
  }
  return [...seen.values()]
    .filter((r) => r.dates.length > 1)
    .map((r) => ({ ...r, dates: [...r.dates].sort() }));
}

/** Per-ticker corpus shape, for `mode:stats`. */
export function summarize(
  days: Array<[string, TickerBlock[]]>,
): { entries: number; perTicker: Array<{ ticker: string; entries: number; days: number }> } {
  const acc = new Map<string, { entries: number; days: Set<string> }>();
  let entries = 0;
  for (const [date, blocks] of days) {
    for (const b of blocks) {
      const rec = acc.get(b.ticker) ?? { entries: 0, days: new Set<string>() };
      rec.entries += b.bullets.length;
      rec.days.add(date);
      acc.set(b.ticker, rec);
      entries += b.bullets.length;
    }
  }
  const perTicker = [...acc.entries()]
    .map(([ticker, r]) => ({ ticker, entries: r.entries, days: r.days.size }))
    .sort((a, b) => b.entries - a.entries || a.ticker.localeCompare(b.ticker));
  return { entries, perTicker };
}
