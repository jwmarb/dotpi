/**
 * Trade-journal tool — session wiring for the trading journal.
 *
 * The three journal agents shipped by the `technical-analysis` skill
 * (`journal-observer`, `journal-reflector`, `journal-curator`) own *judgment*:
 * what earns an entry, which pattern is real, what is safe to prune. This tool
 * owns the mechanics they would otherwise spend a whole subagent spawn on.
 *
 * The split is the point. Delegating a subagent to append one observed line
 * costs a process, a model call and a wake-up; `trade_journal record` is a file
 * append. So the orchestrator records inline and delegates only for a verdict:
 *
 *   record  → append observations under a day file      (mechanical)
 *   read    → one day, or one ticker across days        (mechanical)
 *   stats   → corpus shape: files, tickers, date span   (mechanical)
 *   dupes   → byte-identical bullets across days        (mechanical; curator judges)
 *
 * Deliberately NOT here: pattern synthesis and pruning decisions. Those need a
 * model reading the corpus, which is exactly what `journal-reflector` and
 * `journal-curator` are. A `mode: "reflect"` returning patterns would be
 * re-implementing an agent prompt in TypeScript, badly.
 *
 * This file is wiring only — schema, registration, guideline text. Mode logic is
 * `lib.ts` (tested; see its docstring for why the split is structural), and the
 * markdown grammar is `../lib/trade-journal-store.ts`.
 *
 * @module trade-journal
 */
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_READ_LIMIT,
  type JournalDetails,
  type JournalRequest,
  runJournal,
} from "./lib.js";

const TOOL_NAME = "trade_journal";

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const JournalParams = Type.Object({
  mode: StringEnum(["record", "read", "stats", "dupes"] as const, {
    description:
      "record = append observations to a day file; read = play back a day or a ticker's history; stats = corpus shape; dupes = byte-identical bullets across days.",
  }),
  ticker: Type.Optional(
    Type.String({
      description:
        "Ticker symbol. Required for record. Optional filter for read and dupes; omit on read to get whole days.",
    }),
  ),
  observations: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "record only: one string per observation, each carrying the numbers behind it. Exact duplicates already recorded that day are skipped.",
    }),
  ),
  date: Type.Optional(
    Type.String({
      description:
        "YYYY-MM-DD. For record, the date the observation is ABOUT (default today UTC) — recording Friday's session on Saturday still belongs to Friday. For read, a single day.",
    }),
  ),
  since: Type.Optional(Type.String({ description: "read only: earliest day, YYYY-MM-DD." })),
  until: Type.Optional(Type.String({ description: "read only: latest day, YYYY-MM-DD." })),
  limit: Type.Optional(
    Type.Number({
      description: `read only: max day files to return, newest first. Default ${DEFAULT_READ_LIMIT}.`,
    }),
  ),
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Registers the `trade_journal` tool.
 *
 * @param pi - The pi extension API.
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool<typeof JournalParams, JournalDetails>({
    name: TOOL_NAME,
    label: "Trade journal",
    description:
      "Trading journal in ~/.agentic-trading/journal/ (one markdown file per day, ## TICKER headings). " +
      "Modes: record (append observations), read (a day, or one ticker across days), stats (corpus shape), dupes (identical bullets across days). " +
      "Mechanics only — pattern synthesis is the journal-reflector agent, pruning is journal-curator.",
    promptSnippet:
      "Trading journal: record observations, read a ticker's history, stats, dupes. Mechanics only — delegate journal-reflector for patterns.",
    promptGuidelines: [
      "Use trade_journal mode:read with a ticker before a technical read, to recall what is already recorded on that name. It is a file read — cheap enough to do every time, unlike delegating journal-reflector.",
      "Use trade_journal mode:record after a read that produced something a future session could not recompute: a level tested, an event reaction, a regime that did or did not behave, an executed trade. Give every observation its numbers, and skip anything a script regenerates such as a current indicator value.",
      "Set date on mode:record to the day the observation is ABOUT, not the day you are writing. Recording Friday's session on Saturday uses Friday's date.",
      "Delegate the journal-reflector subagent instead of this tool when the question is what REPEATS across many entries — patterns, level reliability with counts, what stopped working. This tool returns raw entries; the reflector judges them.",
      "Delegate the journal-curator subagent to prune or consolidate, and run trade_journal mode:dupes first to hand it the candidates. The tool finds identical lines; the curator decides what merging is safe.",
    ],
    parameters: JournalParams,
    async execute(_toolCallId, params) {
      const result = await runJournal(params as JournalRequest);
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: result.details,
        ...(result.isError ? { isError: true } : {}),
      };
    },
  });
}
