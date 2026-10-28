/**
 * Tests for the pure parts of subagent-herdr: run ids, the child argv
 *
 * Run from the repo root: `bun test agent/extensions/subagent-herdr/`
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { discoverAgents, discoverSkillAgents, parseAgentFile, type AgentInfo } from "../lib/agents.js";
import { agentsDir, skillsDir } from "../lib/layout.js";
import { FALLBACK_MODEL_REF } from "../model-fallback/lib.js";
import {
  admitSpawn,
  appendSkillCatalogue,
  buildChildArgv,
  buildChildEnv,
  buildHealthCheckTask,
  agentNameRejection,
  childNameRejection,
  childFallbackChain,
  DONE_TOOL_NAME,
  extractRunResult,
  herdrAgentName,
  makeRunId,
  formatLineage,
  discoverSkills,
  lineageRejection,
  spawnableAgents,
  parseLineage,
  readReports,
  REPORT_TOOL_NAME,
  selectSkills,
  skillEntriesFromPi,
  SKILLS_WILDCARD,
  TODO_TOOL_NAME,
} from "./lib.js";
import { endedCleanly } from "./child-done.js";
import { classifyExecFailure, errorPayload, paneRectFrom, probeFromCall, splitArgs, waitArgs, type HerdrCall } from "./herdr.js";
import { createTerminalResultCache, interruptRun, launchAttempt, type Launcher } from "./index.js";
import type { RunObservation } from "./run-lifecycle.js";
import {
  exitPath,
  formatExitSidecar,
  formatNotice,
  formatReportLine,
  hasExitSidecar,
  isRunRecord,
  isSessionFileFor,
  metaPath,
  parseNotice,
  parseReportLine,
  reportsPath,
  runDir,
  runsDir,
  hasResultBlock,
  qualifiesAsAnswer,
  SUBSTANTIAL_ANSWER_CHARS,
  visibleTextOf,
  qualifiesAsSalvage,
  requiresResultBlock,
  systemPromptPath,
  type RunRecord,
} from "./rundir.js";

// ---------------------------------------------------------------------------
// makeRunId
// ---------------------------------------------------------------------------

describe("makeRunId", () => {
  test("matches the advertised sub-<4hex> shape", () => {
    expect(makeRunId()).toMatch(/^sub-[0-9a-f]{4}$/);
  });

  test("produces distinct ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => makeRunId()));
    expect(ids.size).toBeGreaterThan(400);
  });
});

// ---------------------------------------------------------------------------
// buildChildArgv
// ---------------------------------------------------------------------------

describe("buildChildArgv", () => {
  const base = {
    childDonePath: "/abs/child-done.ts",
    runDir: "/abs/runs/sub-0001",
    runId: "sub-0001",
  };

  test("always carries the done extension, session dir and session id", () => {
    const argv = buildChildArgv(base);
    expect(argv.slice(0, 6)).toEqual(["-e", base.childDonePath, "--session-dir", base.runDir, "--session-id", base.runId]);
  });

  test("appends the done, report and todo tools to a declared tool allowlist", () => {
    const argv = buildChildArgv({ ...base, tools: ["read", "grep"] });
    expect(argv).toContain("--tools");
    const tools = argv[argv.indexOf("--tools") + 1];
    expect(tools).toBe(`read,grep,${DONE_TOOL_NAME},${REPORT_TOOL_NAME},${TODO_TOOL_NAME}`);
  });

  test("does not duplicate the handshake or todo tools if an agent file already declares them", () => {
    const argv = buildChildArgv({ ...base, tools: [TODO_TOOL_NAME, DONE_TOOL_NAME, REPORT_TOOL_NAME] });
    expect(argv[argv.indexOf("--tools") + 1]).toBe(`${TODO_TOOL_NAME},${DONE_TOOL_NAME},${REPORT_TOOL_NAME}`);
  });

  test("every repository agent with an explicit allowlist gets todo", async () => {
    for (const agent of await discoverAgents(agentsDir())) {
      if (!agent.tools || agent.tools.length === 0) continue;
      const argv = buildChildArgv({ ...base, tools: agent.tools });
      expect(argv[argv.indexOf("--tools") + 1]!.split(",")).toContain(TODO_TOOL_NAME);
    }
  });

  test("omits --tools for an all-tools agent", () => {
    const argv = buildChildArgv(base);
    expect(argv).not.toContain("--tools");
  });

  test("always launches on the router, and never a positional task", () => {
    const argv = buildChildArgv({
      ...base,
      systemPromptPath: "/abs/runs/sub-0001/system-prompt.md",
    });
    expect(argv).toContain("--model");
    expect(argv).toContain(FALLBACK_MODEL_REF);
    expect(argv).toContain("--append-system-prompt");
    expect(argv[argv.length - 1]).toBe("/abs/runs/sub-0001/system-prompt.md");
  });
});

// ---------------------------------------------------------------------------
// extractRunResult
// ---------------------------------------------------------------------------

describe("extractRunResult", () => {
  test("extracts the last assistant text from a pi session JSONL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-herdr-test-"));
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0002", cwd: "/tmp" }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "do it" }] },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "first answer" }],
          stopReason: "toolUse",
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "\nfinal answer" }],
          stopReason: "stop",
        },
      }),
    ];
    // pi mints the timestamp prefix itself: <ts>_<sessionId>.jsonl
    writeFileSync(join(dir, "2026-09-20T12-00-00-000Z_sub-0002.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0002");
    expect(r.found).toBe(true);
    expect(r.answered).toBe(true);
    expect(r.text).toBe("final answer");
    expect(r.stopReason).toBe("stop");
    expect(r.sessionFile).toBe(join(dir, "2026-09-20T12-00-00-000Z_sub-0002.jsonl"));
  });

  test("reports found-but-unanswered when the session has no assistant text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-herdr-test-"));
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0003" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "only thinking" }], stopReason: "stop" },
      }),
    ];
    writeFileSync(join(dir, "2026-09-20T12-00-00-000Z_sub-0003.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0003");
    expect(r.found).toBe(true);
    expect(r.answered).toBe(false);
    expect(r.text).toBe("");
  });

  test("tolerates a partial final line (run still writing)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-herdr-test-"));
    const complete = JSON.stringify({
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    });
    writeFileSync(join(dir, "x_sub-0004.jsonl"), `${complete}\n{"type":"mess`);
    const r = await extractRunResult(dir, "sub-0004");
    expect(r.answered).toBe(true);
    expect(r.text).toBe("ok");
  });
  test("returns not-found for a missing dir and a foreign session id", async () => {
    expect((await extractRunResult(join(tmpdir(), "does-not-exist"), "sub-0005")).found).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "sub-herdr-test-"));
    writeFileSync(join(dir, "2026-09-20T12-00-00-000Z_sub-9999.jsonl"), "[]");
    expect((await extractRunResult(dir, "sub-0006")).found).toBe(false);
  });

  test("prefers the answer over the closing remark after subagent_done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-herdr-test-"));
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0007" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "task" }] } }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Here is my answer" },
            { type: "toolCall", id: "call_1", name: "subagent_done", arguments: {} },
          ],
          stopReason: "toolUse",
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolCallId: "call_1", toolName: "subagent_done", content: [{ type: "text", text: "ok" }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0007.jsonl"), lines.join("\n"));
    const r = await extractRunResult(dir, "sub-0007");
    expect(r.answered).toBe(true);
    expect(r.text).toBe("Here is my answer");
  });

  // -------------------------------------------------------------------------
  // Salvage: the three ways a real run has stranded its answer.
  // Fixtures are modelled on recorded transcripts in agent/subagent-runs/.
  // -------------------------------------------------------------------------

  /** A run dir carrying a `<result>`-contract system prompt, like every fleet agent. */
  function runDirWithResultPrompt(): string {
    const dir = mkdtempSync(join(tmpdir(), "sub-herdr-test-"));
    writeFileSync(systemPromptPath(dir), "You map codebases.\n\nOnly what is inside `<result>` reaches the orchestrator.");
    return dir;
  }

  test("salvages the report from a fabricated argument on the done call (sub-c459, sub-e987)", async () => {
    const dir = runDirWithResultPrompt();
    const report = "<result>\n## Map\n- `index.ts:826` — tool registration\n</result>";
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0101" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I have all the evidence I need. Compiling the recon report now." },
            // `subagent_done` takes no parameters, but typebox accepts extra
            // properties, so this call validated and the run was marked done.
            { type: "toolCall", id: "call_1", name: "subagent_done", arguments: { message: report } },
          ],
          stopReason: "toolUse",
        },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0101.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0101");
    expect(r.answered).toBe(true);
    expect(r.text).toBe(report);
    expect(r.salvagedFrom).toBe("done-arguments");
  });

  test("prefers a qualifying visible answer over a tool argument that also has one", async () => {
    const dir = runDirWithResultPrompt();
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0102" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "<result>the visible one</result>" },
            { type: "toolCall", id: "call_1", name: "subagent_done", arguments: { message: "<result>the argument one</result>" } },
          ],
          stopReason: "toolUse",
        },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0102.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0102");
    expect(r.text).toBe("<result>the visible one</result>");
    expect(r.salvagedFrom).toBeUndefined();
  });

  test("ignores a non-qualifying tool argument rather than reporting metadata as the answer", async () => {
    const dir = runDirWithResultPrompt();
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0103" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Writing the report." },
            { type: "toolCall", id: "call_1", name: "subagent_done", arguments: { reason: "finished", ok: true } },
          ],
          stopReason: "toolUse",
        },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0103.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0103");
    // Not the metadata argument: the only thing left is the short visible line,
    // which is forwarded as explicitly non-conforming rather than as an answer.
    expect(r.text).toBe("Writing the report.");
    expect(r.salvagedFrom).toBe("non-conforming");
  });

  test("recovers an earlier qualifying answer when the done message is only filler (sub-835d, sub-e0fe)", async () => {
    const dir = runDirWithResultPrompt();
    const report = "<result>\n## Map\n- `lib.ts:493` — extractRunResult\n</result>";
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0104" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: report }], stopReason: "stop" },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "anything else?" }] },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "<result>a second, better report</result>" },
            { type: "text", text: "All questions are answered. Compiling the final report." },
            { type: "toolCall", id: "call_1", name: "subagent_done", arguments: {} },
          ],
          stopReason: "toolUse",
        },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0104.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0104");
    expect(r.answered).toBe(true);
    expect(r.text).toBe(report);
    expect(r.salvagedFrom).toBe("earlier-message");
  });

  test("never surfaces a <result> that exists only in thinking (sub-835d)", async () => {
    const dir = runDirWithResultPrompt();
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0105" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "<result>\n## Map\n- only in reasoning\n</result>" },
            { type: "text", text: "All questions are answered with verified line numbers." },
            { type: "toolCall", id: "call_1", name: "subagent_done", arguments: {} },
          ],
          stopReason: "toolUse",
        },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0105.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0105");
    // The <result> in thinking is never surfaced. The visible filler is
    // forwarded only under the `non-conforming` label (see the dedicated test).
    expect(r.text).not.toContain("only in reasoning");
    expect(r.salvagedFrom).toBe("non-conforming");
  });

  test("a thinking-only clean turn end stays unanswered (sub-9bad)", async () => {
    const dir = runDirWithResultPrompt();
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0106" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Deletion test: delete → raw execFile resurfaces…" }],
          stopReason: "stop",
        },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0106.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0106");
    expect(r.answered).toBe(false);
  });

  // -------------------------------------------------------------------------
  // No `subagent_done` call at all: the dominant real shape, and the one an
  // earlier draft of this function lost 47678 chars across 20 runs by missing.
  // Every fixture above happens to have a done call, which is exactly why the
  // suite stayed green through that regression.
  // -------------------------------------------------------------------------

  test("a clean turn end with a truncated report keeps it (sub-1a09, sub-c62b, sub-db10)", async () => {
    const dir = runDirWithResultPrompt();
    // Real shape: no done call, final assistant message holds 8-15 KB of report
    // whose closing tag never arrived. Measured: sub-c62b 14838, sub-1a09 10122.
    const report = `<result>\n## Map\n${"- `a.ts:1` — a mapped file, described at length.\n".repeat(30)}`;
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0109" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: report }], stopReason: "stop" },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0109.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0109");
    expect(r.answered).toBe(true);
    expect(r.text).toBe(report.trim());
    expect(r.salvagedFrom).toBe("truncated-answer");
  });

  test("a trailing toolResult does not hide the final answer (sub-9ecd)", async () => {
    const dir = runDirWithResultPrompt();
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0110" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "<result>\nthe report\n</result>" }], stopReason: "stop" },
      }),
      // The last *entry* is not the last assistant message. Keying the search on
      // the final entry excluded the answer from every step.
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "file bytes" }] },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0110.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0110");
    expect(r.answered).toBe(true);
    expect(r.text).toBe("<result>\nthe report\n</result>");
    // A complete answer in the right place is not salvage, and must not be
    // labelled as suspect in the briefing.
    expect(r.salvagedFrom).toBeUndefined();
  });

  test("a complete later answer beats an earlier interim note (sub-7864)", async () => {
    const dir = runDirWithResultPrompt();
    const note = "Interim: ".padEnd(565, "x");
    const answer = `<result>\n## Findings\n${"- a verified fact.\n".repeat(40)}</result>`;
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0111" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: note }], stopReason: "stop" },
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "continue" }] } }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0111.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0111");
    expect(r.answered).toBe(true);
    // The real answer, not the 565-char note that precedes it.
    expect(r.text).toBe(answer);
    expect(r.text.length).toBeGreaterThan(note.length);
  });

  test("a strict answer anywhere beats a merely-substantial one nearer the end", async () => {
    const dir = runDirWithResultPrompt();
    const complete = "<result>\nthe real report\n</result>";
    const substantial = "y".repeat(900);
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0112" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: complete }], stopReason: "stop" },
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "and?" }] } }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: substantial }], stopReason: "stop" },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0112.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0112");
    expect(r.text).toBe(complete);
    expect(r.salvagedFrom).toBe("earlier-message");
  });

  test("a truncated visible report alongside a done call is still recovered", async () => {
    // The gate refuses this run twice and then lets it through, so the parent
    // must not then throw away the report the child did write.
    const dir = runDirWithResultPrompt();
    const report = `<result>\n## Map\n${"- `b.ts:2` — described at length.\n".repeat(30)}`;
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0113" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: report },
            { type: "toolCall", id: "call_1", name: "subagent_done", arguments: {} },
          ],
          stopReason: "toolUse",
        },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0113.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0113");
    expect(r.answered).toBe(true);
    expect(r.text).toBe(report.trim());
    expect(r.salvagedFrom).toBe("truncated-answer");
  });

  test("salvage prefers a qualifying argument over the filler that carried it", async () => {
    // Thickens the done-arguments path, which a mutation audit found was held
    // by a single test.
    const dir = runDirWithResultPrompt();
    const report = `## 1. OVERVIEW\n${"Something substantial and specific.\n".repeat(20)}`;
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0114" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Writing it up." },
            { type: "toolCall", id: "call_1", name: "subagent_done", arguments: { report, note: "short" } },
          ],
          stopReason: "toolUse",
        },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0114.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0114");
    expect(r.answered).toBe(true);
    // Not `message`, and not the short `note`: the substantial string wins.
    expect(r.text).toBe(report.trim());
    expect(r.salvagedFrom).toBe("done-arguments");
  });

  test("an unrelated tool call's arguments are never read as the answer", async () => {
    const dir = runDirWithResultPrompt();
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0115" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Reading." },
            // A big string argument on a DIFFERENT tool must not be salvaged.
            { type: "toolCall", id: "c1", name: "write", arguments: { content: "z".repeat(900) } },
          ],
          stopReason: "toolUse",
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolCallId: "c1", toolName: "write", content: [{ type: "text", text: "ok" }] },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0115.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0115");
    expect(r.text).not.toContain("z".repeat(900));
    expect(r.salvagedFrom).toBe("non-conforming");
  });

  test("a filler-only run is forwarded but labelled NOT AN ANSWER, never dropped", async () => {
    // 13 of the 164 recorded runs produced only a progress line (20-294 chars).
    // The old code showed those *as the answer*, which is the bug; refusing them
    // outright would lose the three that carry partial findings. So: forwarded
    // with an honest label, which index.ts renders as "NOT AN ANSWER".
    const dir = runDirWithResultPrompt();
    const filler = "All questions are answered with verified line numbers. Compiling the final report.";
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0116" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "<result>the report, invisible to the orchestrator</result>" },
            { type: "text", text: filler },
          ],
          stopReason: "stop",
        },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0116.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0116");
    expect(r.answered).toBe(true);
    expect(r.text).toBe(filler);
    expect(r.salvagedFrom).toBe("non-conforming");
    // The thinking content is still never surfaced.
    expect(r.text).not.toContain("invisible to the orchestrator");
  });

  test("a run with no visible text at all remains unanswered", async () => {
    const dir = runDirWithResultPrompt();
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0117" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "only reasoning" }], stopReason: "stop" },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0117.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0117");
    expect(r.answered).toBe(false);
    expect(r.text).toBe("");
    expect(r.salvagedFrom).toBeUndefined();
  });

  test("an agent with no <result> contract is still answered by plain prose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-herdr-test-"));
    writeFileSync(systemPromptPath(dir), "Record one journal observation and reply with its id.");
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0107" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Recorded obs-0007." }], stopReason: "stop" },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0107.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0107");
    expect(r.answered).toBe(true);
    expect(r.text).toBe("Recorded obs-0007.");
  });

  test("a run with no system-prompt.md keeps the pre-fix behaviour", async () => {
    // Historical runs predate the prompt file being required for extraction;
    // they must not regress to unanswered.
    const dir = mkdtempSync(join(tmpdir(), "sub-herdr-test-"));
    const lines = [
      JSON.stringify({ type: "session", version: 3, id: "sub-0108" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "plain answer" }], stopReason: "stop" },
      }),
    ];
    writeFileSync(join(dir, "x_sub-0108.jsonl"), lines.join("\n"));

    const r = await extractRunResult(dir, "sub-0108");
    expect(r.answered).toBe(true);
    expect(r.text).toBe("plain answer");
  });

});

// ---------------------------------------------------------------------------
// buildHealthCheckTask
// ---------------------------------------------------------------------------

describe("buildHealthCheckTask", () => {
  const target = { runId: "sub-aaaa", agent: "librarian", task: "Research the X API" };
  const dir = "/home/u/.pi/agent/subagent-runs/sub-aaaa";

  test("a stalled task carries the target's identity, the original task, and the watchdog detail", () => {
    const task = buildHealthCheckTask(target, dir, {
      kind: "stalled",
      detail: "phase=tool elapsedMs=600000 tool=bash",
    });
    expect(task).toContain("sub-aaaa");
    expect(task).toContain(dir);
    expect(task).toContain("librarian");
    expect(task).toContain("Research the X API");
    expect(task).toContain("stalled");
    expect(task).toContain("phase=tool elapsedMs=600000 tool=bash");
  });

  test("an ended-without-result task names the completion predicate and its verdict", () => {
    const task = buildHealthCheckTask(target, dir, { kind: "ended-without-result" });
    expect(task).toContain("sub-aaaa");
    expect(task).toContain(dir);
    expect(task).toContain("librarian");
    expect(task).toContain("Research the X API");
    expect(task).toContain("extractRunResult");
    expect(task).toContain("answered: false");
  });

  test("a multiline original task stays fully present, untruncated and un-reencoded", () => {
    const multi = "Line one\nLine two with a \"quoted\" word\n\tTabbed line";
    const task = buildHealthCheckTask({ ...target, task: multi }, dir, {
      kind: "stalled",
      detail: "phase=streaming elapsedMs=300000 charsGenerated=412",
    });
    expect(task).toContain(multi);
    expect(task).not.toContain("\\n");
    expect(task).toContain("phase=streaming elapsedMs=300000 charsGenerated=412");
  });
});

describe("buildChildEnv", () => {
  test("carries the run identity and the parent pane when known", () => {
    const env = buildChildEnv({ runId: "sub-0008", agent: "worker" }, "w5:p1", "/runs/sub-0008");
    expect(env).toEqual({
      PI_SUBAGENT_RUN_ID: "sub-0008",
      PI_SUBAGENT_AGENT: "worker",
      PI_SUBAGENT_RUN_DIR: "/runs/sub-0008",
      PI_SUBAGENT_PARENT_PANE: "w5:p1",
      // The delegation-tree bound travels with every child (see lineageRejection).
      PI_SUBAGENT_LINEAGE: "worker",
    });
  });

  test("omits the parent pane when the orchestrator has none", () => {
    const env = buildChildEnv({ runId: "sub-0009", agent: "worker" }, undefined, "/runs/sub-0009");
    expect(env.PI_SUBAGENT_PARENT_PANE).toBeUndefined();
    expect(env.PI_SUBAGENT_RUN_ID).toBe("sub-0009");
  });

  test("carries the runtime fallback chain when the child has one", () => {
    // The chain is what makes a running child hop on error rather than
    // re-asking the model that just failed.
    const env = buildChildEnv({ runId: "sub-0010", agent: "worker" }, "w5:p1", "/runs", ["worker"], [
      "qwen/qwen3.8-27b",
      "anthropic/claude-opus-5",
    ]);
    expect(env.PI_FALLBACK_CHAIN).toBe("qwen/qwen3.8-27b,anthropic/claude-opus-5");
  });

  test("emits the var for any non-empty chain, including a single unpinned entry", () => {
    // The child always launches on `fallback/auto`, so a one-model chain must
    // cross too: without the var the child's router registers nothing and
    // `fallback/auto` is unresolvable. Only an absent or empty chain omits it.
    const none = buildChildEnv({ runId: "sub-0011", agent: "worker" }, "w5:p1", "/runs");
    expect(none.PI_FALLBACK_CHAIN).toBeUndefined();
    const single = buildChildEnv({ runId: "sub-0012", agent: "worker" }, "w5:p1", "/runs", [
      "worker",
    ], ["qwen/qwen3.8-27b"]);
    expect(single.PI_FALLBACK_CHAIN).toBe("qwen/qwen3.8-27b");
    const empty = buildChildEnv({ runId: "sub-0013", agent: "worker" }, "w5:p1", "/runs", [
      "worker",
    ], []);
    expect(empty.PI_FALLBACK_CHAIN).toBeUndefined();
  });

  test("a one-entry pinned chain emits the var, because the router must apply the pin", () => {
    // The contrast with the unpinned case above: the pin is the reason the
    // router exists here, so the var must cross.
    const pinned = buildChildEnv(
      { runId: "sub-0014", agent: "worker" },
      "w5:p1",
      "/runs",
      ["worker"],
      ["qwen/qwen3.8-27b|high"],
    );
    expect(pinned.PI_FALLBACK_CHAIN).toBe("qwen/qwen3.8-27b|high");
  });
});

describe("childFallbackChain", () => {
  test("is the declared model followed by its fallbacks", () => {
    expect(
      childFallbackChain(undefined, {
        model: "openai/gpt-5.6-sol",
        fallbackModels: ["anthropic/claude-opus-5", "qwen/qwen3.8-27b"],
      }),
    ).toEqual(["openai/gpt-5.6-sol", "anthropic/claude-opus-5", "qwen/qwen3.8-27b"]);
  });

  test("an explicitly requested model is a one-entry chain, pin kept and no fallbacks appended", () => {
    // The caller named exactly this model for this run, so the chain is just
    // that model — hopping off it mid-run would be a surprise, not a recovery.
    expect(
      childFallbackChain("my/pinned|low", {
        model: "openai/gpt-5.6-sol",
        fallbackModels: ["qwen/qwen3.8-27b"],
      }),
    ).toEqual(["my/pinned|low"]);
  });
  test("an explicitly requested pinned model is a one-entry chain with its pin", () => {
    const agent = {
      model: "openai/gpt-5.6-sol",
      fallbackModels: ["anthropic/claude-opus-5", "qwen/qwen3.8-27b"],
    };
    expect(childFallbackChain("openai/x|high", agent)).toEqual(["openai/x|high"]);
  });

  test("naming the router itself yields no chain — it cannot route to itself", () => {
    // The chain is only ever served by the router, and the router resolves to
    // a physical model, never to `fallback/auto` again: such a child is dead
    // on its first request, so the launcher refuses up front.
    const agent = {
      model: "openai/gpt-5.6-sol",
      fallbackModels: ["qwen/qwen3.8-27b"],
    };
    expect(childFallbackChain("fallback/auto", agent)).toBeUndefined();
    // Case-insensitive, so `FALLBACK/AUTO` in a hand-edited call is refused too.
    expect(childFallbackChain("FALLBACK/AUTO", agent)).toBeUndefined();
    // Whitespace around the ref is normalised before the comparison.
    expect(childFallbackChain("  fallback/auto  ", agent)).toBeUndefined();
  });

  test("an explicit request with an invalid |level pin is refused, not silently dropped", () => {
    // The item grammar degrades `openai/x|ultra` to `openai/x`; an explicit
    // request names exactly this model for this run, so a pin it wrote must be
    // one the router applies. An invalid pin is a refusal, and the spawn then
    // reports it with the requested-model message.
    const agent = { model: "openai/gpt-5.6-sol", fallbackModels: ["qwen/qwen3.8-27b"] };
    expect(childFallbackChain("openai/x|ultra", agent)).toBeUndefined();
    // Levels are exact: case-sensitive, no trimming.
    expect(childFallbackChain("openai/x|HIGH", agent)).toBeUndefined();
    expect(childFallbackChain("openai/x|", agent)).toBeUndefined();
    // A valid pin is still accepted.
    expect(childFallbackChain("openai/x|high", agent)).toEqual(["openai/x|high"]);
  });

  test("a bare `auto` is the router's own model id and is refused in an explicit request", () => {
    // `auto` is `FALLBACK_MODEL_ID` — the router's model, not a physical model
    // the router can route to. A request for it is refused like `fallback/auto`.
    const agent = { model: "openai/gpt-5.6-sol", fallbackModels: ["qwen/qwen3.8-27b"] };
    expect(childFallbackChain("auto", agent)).toBeUndefined();
    expect(childFallbackChain("  AUTO  ", agent)).toBeUndefined();
  });

  test("a whitespace-only request is treated as no request", () => {
    const agent = {
      model: "openai/gpt-6.0-sol",
      fallbackModels: ["qwen/qwen3.8-27b"],
    };
    expect(childFallbackChain("   ", agent)).toEqual([
      "openai/gpt-6.0-sol",
      "qwen/qwen3.8-27b",
    ]);
  });

  test("a declared model naming the router itself is skipped, not a chain head", () => {
    // `fallback/auto` in a declaration names the router, not a model: it is
    // unusable, so the next valid entry becomes the head (or nothing, if none).
    expect(
      childFallbackChain(undefined, {
        model: "fallback/auto",
        fallbackModels: ["qwen/qwen3.8-27b"],
      }),
    ).toEqual(["qwen/qwen3.8-27b"]);
    expect(
      childFallbackChain(undefined, { model: "FALLBACK/AUTO", fallbackModels: [] }),
    ).toBeUndefined();
  });

  test("a pi-style `ref:level` request is converted to `ref|level`", () => {
    // pi's own `--model ref:level` form is translated on the way in, so a
    // request written the way pi writes it keeps working.
    const agent = { model: "openai/gpt-5.6-sol", fallbackModels: ["qwen/qwen3.8-27b"] };
    expect(childFallbackChain("openai/gpt-5.6-sol:high", agent)).toEqual([
      "openai/gpt-5.6-sol|high",
    ]);
    // Only a plain ref (no other colon) is converted: `openai:gpt:high` does
    // not parse at all and stays a refusal.
    expect(childFallbackChain("openai:gpt:high", agent)).toBeUndefined();
  });

  test("an agent with no fallbacks still gets a one-entry chain", () => {
    // A single unpinned model is a legal chain: the child launches on the
    // router, so there is no "no chain" case for a declared model.
    expect(childFallbackChain(undefined, { model: "qwen/qwen3.8-27b" })).toEqual([
      "qwen/qwen3.8-27b",
    ]);
    expect(
      childFallbackChain(undefined, { model: "qwen/qwen3.8-27b", fallbackModels: [] }),
    ).toEqual(["qwen/qwen3.8-27b"]);
  });

  test("an agent with no declared model uses its first valid fallback as the chain head", () => {
    // Without a primary the first fallback becomes the chain head; a single
    // valid fallback is still a one-entry chain.
    expect(childFallbackChain(undefined, { fallbackModels: ["qwen/qwen3.8-27b"] })).toEqual([
      "qwen/qwen3.8-27b",
    ]);
  });

  test("drops a fallback that repeats the primary, leaving a one-entry chain", () => {
    // The dedupe collapses this to one model, which is still a legal chain.
    expect(
      childFallbackChain(undefined, {
        model: "qwen/qwen3.8-27b",
        fallbackModels: ["qwen/qwen3.8-27b"],
      }),
    ).toEqual(["qwen/qwen3.8-27b"]);
  });

  test("keeps declared order and drops later duplicates", () => {
    expect(childFallbackChain(undefined, { model: "a", fallbackModels: ["c", "b", "c"] })).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  test("returns the declaration canonicalised, in priority order", () => {
    // The chain is the declaration itself, canonicalised through the item
    // grammar — the primary first, then the fallbacks, deduped by ref.
    const agent = {
      model: "openai/gpt-5.6-sol",
      fallbackModels: ["anthropic/claude-opus-5", "qwen/qwen3.8-27b"],
    };
    expect(childFallbackChain(undefined, agent)).toEqual([
      "openai/gpt-5.6-sol",
      "anthropic/claude-opus-5",
      "qwen/qwen3.8-27b",
    ]);
  });

  test("a grammar-rejected item is dropped from the chain, and the env carries the strict chain", () => {
    // `bad:ref` carries the legacy `:` separator, so the item grammar rejects
    // it. The chain drops it: the router must not advertise a model it cannot
    // resolve. With the valid entries the child launches on `fallback/auto`
    // with the strict chain in the env var.
    const agent = {
      model: "openai/gpt-5.6-sol",
      fallbackModels: ["bad:ref", "qwen/qwen3.8-27b|low"],
    };
    const chain = childFallbackChain(undefined, agent);
    expect(chain).toEqual(["openai/gpt-5.6-sol", "qwen/qwen3.8-27b|low"]);
    const env = buildChildEnv(
      { runId: "sub-0015", agent: "worker" },
      "w5:p1",
      "/runs",
      ["worker"],
      chain,
    );
    expect(env.PI_FALLBACK_CHAIN).toBe("openai/gpt-5.6-sol,qwen/qwen3.8-27b|low");
  });

  test("a single pinned primary is a chain: the router is the only place a pin applies", () => {
    expect(
      childFallbackChain(undefined, { model: "openai/gpt-5.6-sol|high", fallbackModels: [] }),
    ).toEqual(["openai/gpt-5.6-sol|high"]);
    expect(childFallbackChain(undefined, { model: "openai/gpt-5.6-sol|high" })).toEqual([
      "openai/gpt-5.6-sol|high",
    ]);
  });

  test("pins survive the handoff verbatim, in declaration order", () => {
    expect(
      childFallbackChain(undefined, {
        model: "openai/gpt-5.6-sol|high",
        fallbackModels: ["anthropic/claude-opus-5", "qwen/qwen3.8-27b|low"],
      }),
    ).toEqual([
      "openai/gpt-5.6-sol|high",
      "anthropic/claude-opus-5",
      "qwen/qwen3.8-27b|low",
    ]);
  });

  test("dedup is by ref, case-insensitively, first occurrence winning — pin or no pin", () => {
    expect(
      childFallbackChain(undefined, {
        model: "qwen/qwen3.8-27b",
        fallbackModels: ["QWEN/qwen3.8-27b|high", "openai/gpt-5.6-sol"],
      }),
    ).toEqual(["qwen/qwen3.8-27b", "openai/gpt-5.6-sol"]);
    expect(
      childFallbackChain(undefined, {
        model: "QWEN/qwen3.8-27b|high",
        fallbackModels: ["qwen/qwen3.8-27b"],
      }),
    ).toEqual(["QWEN/qwen3.8-27b|high"]);
  });

  test("an item the item grammar rejects is dropped, so the launcher and router agree", () => {
    // `qwen/qwen3.8-27b:high` carries a legacy `:level` suffix the router would
    // drop; keeping it here would advertise a chain the child does not serve.
    expect(
      childFallbackChain(undefined, {
        model: "openai/gpt-5.6-sol",
        fallbackModels: ["qwen/qwen3.8-27b:high", "anthropic/claude-opus-5"],
      }),
    ).toEqual(["openai/gpt-5.6-sol", "anthropic/claude-opus-5"]);
  });
  test("returns undefined only when no valid reference exists at all", () => {
    // Nothing requested and nothing declared that the item grammar accepts:
    // the caller must refuse the launch, because the router has nothing to serve.
    expect(childFallbackChain(undefined, {})).toBeUndefined();
    expect(
      childFallbackChain(undefined, { model: "bad:ref", fallbackModels: ["also:bad"] }),
    ).toBeUndefined();
    expect(childFallbackChain("bad:ref", { model: "openai/gpt-5.6-sol" })).toBeUndefined();
  });
});

describe("readReports", () => {
  test("parses the report log and tolerates a partial final line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-herdr-test-"));
    writeFileSync(
      join(dir, "reports.jsonl"),
      `${JSON.stringify({ at: 1, message: "first" })}\n${JSON.stringify({ at: 2, message: "second" })}\n{"at":3,"mes`,
    );
    expect(await readReports(dir)).toEqual([
      { at: 1, message: "first" },
      { at: 2, message: "second" },
    ]);
  });

  test("returns [] when the child never reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sub-herdr-test-"));
    expect(await readReports(dir)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// endedCleanly (identical in lib-adjacent child-done)
// ---------------------------------------------------------------------------

describe("endedCleanly", () => {
  test("true only for a clean assistant stop", () => {
    expect(endedCleanly([{ role: "assistant", stopReason: "stop" }])).toBe(true);
    expect(endedCleanly([{ role: "assistant", stopReason: "error" }])).toBe(false);
    expect(endedCleanly([{ role: "assistant", stopReason: "aborted" }])).toBe(false);
    expect(endedCleanly([{ role: "assistant", stopReason: "stop" }, { role: "user" }])).toBe(false);
    expect(endedCleanly([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rundir: the contract shared across the parent/child process seam
// ---------------------------------------------------------------------------

describe("rundir paths", () => {
  test("derives a run directory from the agent dir and run id", () => {
    expect(runsDir("/home/u/.pi/agent")).toBe("/home/u/.pi/agent/subagent-runs");
    expect(runDir("/home/u/.pi/agent", "sub-a3f1")).toBe(
      "/home/u/.pi/agent/subagent-runs/sub-a3f1",
    );
  });

  test("names the files inside a run directory", () => {
    const d = runDir("/agent", "sub-0001");
    expect(metaPath(d)).toBe("/agent/subagent-runs/sub-0001/meta.json");
    expect(reportsPath(d)).toBe("/agent/subagent-runs/sub-0001/reports.jsonl");
    expect(systemPromptPath(d)).toBe("/agent/subagent-runs/sub-0001/system-prompt.md");
  });

  test("hangs the sidecar off the session file, not the run directory", () => {
    // pi mints the timestamp prefix, so the sidecar can only be derived from
    // whatever the session file turned out to be called.
    expect(exitPath("/runs/sub-1/2026-01-01T00-00-00_sub-1.jsonl")).toBe(
      "/runs/sub-1/2026-01-01T00-00-00_sub-1.jsonl.exit",
    );
  });

  test("matches a session file by run id, not by prefix", () => {
    expect(isSessionFileFor("2026-01-01T00-00-00_sub-a3f1.jsonl", "sub-a3f1")).toBe(true);
    // A different run whose id merely contains ours must not match.
    expect(isSessionFileFor("2026-01-01T00-00-00_sub-a3f1x.jsonl", "sub-a3f1")).toBe(false);
    expect(isSessionFileFor("meta.json", "sub-a3f1")).toBe(false);
    expect(isSessionFileFor("2026_sub-a3f1.jsonl.exit", "sub-a3f1")).toBe(false);
  });
});

describe("hasExitSidecar", () => {
  const ID = "sub-5e1d";
  const fixture = (names: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-sidecar-"));
    for (const n of names) writeFileSync(join(dir, n), "");
    return dir;
  };

  test("a matching session file with its sidecar beside it", () => {
    expect(hasExitSidecar(fixture([`1750_${ID}.jsonl`, `1750_${ID}.jsonl.exit`]), ID)).toBe(true);
  });

  test("a session file without a sidecar", () => {
    expect(hasExitSidecar(fixture([`1750_${ID}.jsonl`, "meta.json"]), ID)).toBe(false);
  });

  test("a sidecar that belongs to another run", () => {
    expect(hasExitSidecar(fixture([`1750_${ID}.jsonl`, "1750_sub-0000.jsonl", "1750_sub-0000.jsonl.exit"]), ID)).toBe(false);
  });

  test("sidecar-like names with no valid session file", () => {
    expect(hasExitSidecar(fixture([`1750_${ID}.jsonl.exit`, `${ID}.exit`, `1750_${ID}x.jsonl`, `1750_${ID}x.jsonl.exit`]), ID)).toBe(false);
  });

  test("a missing or unreadable directory is false, never a throw", () => {
    expect(hasExitSidecar(join(tmpdir(), "herdr-sidecar-does-not-exist", "x"), ID)).toBe(false);
    // A regular file where the directory should be: readdirSync throws ENOTDIR.
    const dir = fixture(["not-a-dir"]);
    expect(hasExitSidecar(join(dir, "not-a-dir"), ID)).toBe(false);
  });
});

describe("rundir record shapes", () => {
  test("the child's report line is exactly what the parent's reader accepts", () => {
    // The drift this module exists to prevent: writer and reader are now the
    // same pair of functions, so this round-trip is the contract.
    const line = formatReportLine("found the bug", 1700);
    expect(line.endsWith("\n")).toBe(true);
    expect(parseReportLine(line)).toEqual({ at: 1700, message: "found the bug" });
  });

  test("a report line tolerates a truncated tail and junk", () => {
    expect(parseReportLine('{"at":1,"message":"half')).toBeUndefined();
    expect(parseReportLine("")).toBeUndefined();
    expect(parseReportLine("   ")).toBeUndefined();
    expect(parseReportLine('{"at":1}')).toBeUndefined(); // no message
    expect(parseReportLine('{"message":"x"}')).toEqual({ at: 0, message: "x" });
  });

  test("the sidecar records when a run finished, never what it concluded", () => {
    const parsed = JSON.parse(formatExitSidecar(4242));
    expect(parsed).toEqual({ type: "done", at: 4242 });
  });

  test("a meta record needs only a runId to be usable", () => {
    // loadRegistry reads every meta.json on disk, including ones truncated by a
    // parent that crashed mid-spawn.
    expect(isRunRecord({ runId: "sub-1" })).toBe(true);
    expect(isRunRecord({ agent: "worker" })).toBe(false);
    expect(isRunRecord(null)).toBe(false);
    expect(isRunRecord("sub-1")).toBe(false);
    expect(isRunRecord({ runId: 42 })).toBe(false);
  });

  test("a record carries no runDir, because the path is derived", () => {
    // Guards the decision: a stored path is a second source of truth that can
    // disagree with where the file was actually found.
    const rec = { runId: "sub-1", agent: "worker", task: "t", cwd: "/", status: "running" as const, startedAt: 1 };
    expect(isRunRecord(rec)).toBe(true);
    expect(Object.keys(rec)).not.toContain("runDir");
  });

  test("a present non-string healthCheckOf is accepted and treated as absent", () => {
    // Historical records carry no healthCheckOf and must stay valid.
    expect(isRunRecord({ runId: "sub-1" })).toBe(true);
    // A health-check record points back at the run it is diagnosing.
    const rec = {
      runId: "sub-aaaa",
      agent: "healthcheck",
      task: "t",
      cwd: "/",
      status: "running" as const,
      startedAt: 1,
      healthCheckOf: "sub-abcd",
    };
    expect(isRunRecord(rec)).toBe(true);
    // A present non-string healthCheckOf is now ACCEPTED (treated as absent):
    // runId is the only load-bearing requirement, and the reading sites guard
    // with typeof === "string" checks, so a corrupted value cannot key a bogus
    // registry entry — it must not make a live run invisible either.
    expect(isRunRecord({ ...rec, healthCheckOf: 42 })).toBe(true);
    expect(isRunRecord({ ...rec, healthCheckOf: { runId: "sub-abcd" } })).toBe(true);
    // A present null is a non-string too: JSON keeps the key, and it is treated
    // as absent, not record-fatal.
    expect(isRunRecord({ ...rec, healthCheckOf: null })).toBe(true);
    // runId remains the only load-bearing requirement.
    expect(isRunRecord({ runId: 42 })).toBe(false);
    expect(isRunRecord(null)).toBe(false);
  });

  test("a present non-string ownerPane is accepted and treated as absent", () => {
    // The run dir is global across pi processes; ownerPane names the spawning
    // parent's herdr pane. runId remains the only record-fatal requirement,
    // so ownership is loadable but not sweepable when missing or corrupted.
    const rec = {
      runId: "sub-aaaa",
      agent: "worker",
      task: "t",
      cwd: "/",
      status: "running" as const,
      startedAt: 1,
    };
    // Missing ownerPane (legacy) stays valid.
    expect(isRunRecord(rec)).toBe(true);
    // A string ownerPane is the stamped, sweepable case.
    expect(isRunRecord({ ...rec, ownerPane: "w9:p1" })).toBe(true);
    // A present non-string ownerPane is accepted (treated as absent at the
    // guarded read sites), not record-fatal.
    expect(isRunRecord({ ...rec, ownerPane: 42 })).toBe(true);
    expect(isRunRecord({ ...rec, ownerPane: { pane: "w9:p1" } })).toBe(true);
    // A present null is a non-string too: JSON keeps the key, and it is
    // treated as absent, not record-fatal.
    expect(isRunRecord({ ...rec, ownerPane: null })).toBe(true);
    // runId remains the only load-bearing requirement.
    expect(isRunRecord({ runId: 42, ownerPane: "w9:p1" })).toBe(false);
  });

});

describe("agentNameRejection", () => {
  test("accepts the names this repo's agents actually use", () => {
    for (const n of ["worker", "explorer", "librarian", "oracle", "planner", "reviewer", "spiker"]) {
      expect(agentNameRejection(n)).toBeUndefined();
    }
  });

  test("accepts digits, dashes and inner underscores", () => {
    for (const n of ["a", "n1", "mid_dle", "with-dash", "a1_b-c"]) {
      expect(agentNameRejection(n)).toBeUndefined();
    }
  });

  test("rejects exactly what herdr rejects", () => {
    // Verified against herdr 0.9.0, which answers `invalid_agent_name` for each
    // of these. A leading underscore cost a real diagnosis: it failed on every
    // candidate model and read as a broken fleet.
    for (const n of ["_lead", "-dash", "dot.name", "UPPER", "1digit", ""]) {
      expect(agentNameRejection(n)).toBeDefined();
    }
  });

  test("rejects a name longer than 32 characters", () => {
    expect(agentNameRejection("a".repeat(32))).toBeUndefined();
    expect(agentNameRejection("a".repeat(33))).toBeDefined();
  });

  test("names the offending agent and the rule", () => {
    const msg = agentNameRejection("_probe")!;
    expect(msg).toContain("_probe");
    expect(msg).toContain("lowercase letter");
  });
});

// ---------------------------------------------------------------------------
// herdrAgentName
// ---------------------------------------------------------------------------

describe("herdrAgentName", () => {
  // Regression: herdr agent names are unique server-wide. Registering children
  // under the bare definition name let one live `librarian` hold the name and
  // made five concurrent librarian delegations fail with `agent_name_taken` in
  // 4-11 ms each — burning every candidate model and reporting a dead fleet.
  test("is unique per run for the same agent", () => {
    const a = herdrAgentName("librarian", "sub-9622");
    const b = herdrAgentName("librarian", "sub-66bb");
    expect(a).not.toBe(b);
  });

  test("keeps the agent name readable as a prefix", () => {
    expect(herdrAgentName("librarian", "sub-9622")).toBe("librarian-sub-9622");
  });

  test("is deterministic for one run", () => {
    expect(herdrAgentName("worker", "sub-0d4e")).toBe(herdrAgentName("worker", "sub-0d4e"));
  });

  // The scoped name is what herdr actually receives, so it — not the bare
  // definition name — is what has to satisfy herdr's rule.
  test("stays a name herdr accepts for every agent in this repo", () => {
    for (const n of ["worker", "explorer", "librarian", "oracle", "planner", "reviewer", "spiker", "verifier"]) {
      const scoped = herdrAgentName(n, makeRunId());
      expect(agentNameRejection(scoped)).toBeUndefined();
      expect(scoped.length).toBeLessThanOrEqual(32);
    }
  });

});

// ---------------------------------------------------------------------------
// childNameRejection — the pre-spawn check, on the name herdr really gets
// ---------------------------------------------------------------------------

describe("childNameRejection", () => {
  test("accepts every agent definition in this repo", async () => {
    // The repo itself, not a hardcoded list: a ninth agent with a long name
    // must fail this test rather than slip past it.
    const agents = await discoverAgents(join(import.meta.dir, "..", "..", "agents"));
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) {
      expect(childNameRejection(a.name, makeRunId())).toBeUndefined();
    }
  });

  // The whole launch composition, against the real agent files rather than a
  // fixture: this is the invariant a delegated child's model actually depends
  // on, and it spans two modules, so neither unit test alone would catch a
  // drift between them.
  test("every agent in this repo composes a consistent launch", async () => {
    const agents = await discoverAgents(join(import.meta.dir, "..", "..", "agents"));
    expect(agents.length).toBeGreaterThan(0);
    for (const a of agents) {
      const chain = childFallbackChain(undefined, a);
      // Every agent declares a model, so every agent composes a non-empty
      // chain that the router serves.
      expect(chain).toBeDefined();
      const env = buildChildEnv({ runId: "sub-0001", agent: a.name }, "w5:p1", "/runs", [a.name], chain);
      const argv = buildChildArgv({
        childDonePath: "/x/child-done.ts",
        runDir: "/runs",
        runId: "sub-0001",
        tools: a.tools,
      });
      const flagModel = argv[argv.indexOf("--model") + 1];

      // The child always launches on the router, and the env must describe the
      // chain it serves.
      expect(flagModel).toBe(FALLBACK_MODEL_REF);
      expect(env.PI_FALLBACK_CHAIN).toBe(chain!.join(","));
      // The primary must be the model the agent declared, or the agent's
      // stated preference is silently not what runs first.
      expect(chain![0]).toBe(a.model);

      // The handshake and the cycle check must survive.
      expect(env.PI_SUBAGENT_RUN_ID).toBe("sub-0001");
      expect(env.PI_SUBAGENT_AGENT).toBe(a.name);
      expect(env.PI_SUBAGENT_LINEAGE).toContain(a.name);

      // An explicit model is a one-entry chain with its pin kept and no
      // fallbacks appended.
      expect(childFallbackChain("some/pinned|low", a)).toEqual(["some/pinned|low"]);
    }
  });

  // 32 is herdr's ceiling and the suffix costs 9, so a definition name has 23
  // to spend. This is the gap the bare-name check left open: legal alone,
  // illegal once scoped, and it used to fail only after a pane was opened.
  test("rejects a name that is legal alone but too long once scoped", () => {
    expect(agentNameRejection("a".repeat(24))).toBeUndefined();
    expect(childNameRejection("a".repeat(24), "sub-9622")).toBeDefined();
  });

  test("accepts the longest name that still fits scoped", () => {
    expect(childNameRejection("a".repeat(23), "sub-9622")).toBeUndefined();
  });

  test("still rejects a malformed definition name", () => {
    for (const n of ["_lead", "UPPER", "dot.name", ""]) {
      expect(childNameRejection(n, "sub-9622")).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The wake notice
// ---------------------------------------------------------------------------

describe("formatNotice / parseNotice", () => {
  test("round-trips a report with its message", () => {
    const line = formatNotice("sub-a3f1", "explorer", "report", "found the seam in lib.ts");
    expect(parseNotice(line)).toEqual({
      runId: "sub-a3f1",
      agent: "explorer",
      kind: "report",
      text: "found the seam in lib.ts",
    });
  });

  test("round-trips a bare done notice", () => {
    const line = formatNotice("sub-0b2c", "worker", "done");
    expect(parseNotice(line)).toEqual({
      runId: "sub-0b2c",
      agent: "worker",
      kind: "done",
      text: "",
    });
  });

  test("carries a multi-line report body", () => {
    // herdr delivers the notice as one prompt; a report with newlines in it must
    // survive rather than being truncated at the first line.
    const body = "line one\nline two\nline three";
    expect(parseNotice(formatNotice("sub-1234", "planner", "report", body))?.text).toBe(body);
  });

  test("accepts every agent name this repo actually uses", () => {
    for (const agent of ["explorer", "librarian", "oracle", "planner", "reviewer", "spiker", "verifier", "worker"]) {
      expect(parseNotice(formatNotice("sub-00ff", agent, "done"))?.agent).toBe(agent);
    }
  });

  // The parser decides what the orchestrator *swallows*, so a false positive
  // eats a human's message. These are the shapes that must never match.
  test("does not match a human message, however bracket-shaped", () => {
    for (const text of [
      "",
      "run the tests",
      "[subagent] what is the status?",
      "[subagent sub-a3f1] legacy prefix without a kind",
      "[subagent sub-a3f1 (explorer)] no kind either",
      "[subagent sub-a3f1 (explorer) chatter] unknown kind",
      "[subagent sub-zzzz (explorer) done] run id is not hex",
      "[subagent sub-a3f1 (Explorer) done] agent name is capitalised",
      "[subagent sub-a3f1 (explorer) done", // unterminated
      "please tell me about [subagent sub-a3f1 (explorer) done]", // not at the start
    ]) {
      expect(parseNotice(text)).toBeUndefined();
    }
  });

  test("tolerates the surrounding whitespace a TUI submission can add", () => {
    const notice = parseNotice(`\n  ${formatNotice("sub-abcd", "reviewer", "report", "two findings")}  \n`);
    expect(notice?.runId).toBe("sub-abcd");
    expect(notice?.text).toBe("two findings");
  });

  test("a notice body that is itself a notice does not confuse the parser", () => {
    // A subagent quoting a notice back at its parent must parse as one report
    // whose body is the quoted text, not as the inner notice.
    const inner = formatNotice("sub-1111", "worker", "done");
    const outer = formatNotice("sub-2222", "reviewer", "report", inner);
    const parsed = parseNotice(outer);
    expect(parsed?.runId).toBe("sub-2222");
    expect(parsed?.kind).toBe("report");
    expect(parsed?.text).toBe(inner);
  });

  test("ids in a notice match the ids makeRunId mints", () => {
    // The grammar constrains the run id, so a drift in makeRunId's shape would
    // silently stop every notice from being recognised.
    const runId = makeRunId();
    expect(parseNotice(formatNotice(runId, "worker", "done"))?.runId).toBe(runId);
  });
  test("round-trips a stalled notice for a streaming overrun", () => {
    // The watchdog's exact text shape: phase, elapsed ms, and the visible
    // character count it had accumulated when the stream went quiet.
    const line = formatNotice("sub-a3f1", "worker", "stalled", "phase=streaming elapsedMs=300000 charsGenerated=1287");
    expect(parseNotice(line)).toEqual({
      runId: "sub-a3f1",
      agent: "worker",
      kind: "stalled",
      text: "phase=streaming elapsedMs=300000 charsGenerated=1287",
    });
  });

  test("round-trips a stalled notice for a tool overrun", () => {
    const line = formatNotice("sub-0b2c", "librarian", "stalled", "phase=tool elapsedMs=600000 tool=bash");
    expect(parseNotice(line)).toEqual({
      runId: "sub-0b2c",
      agent: "librarian",
      kind: "stalled",
      text: "phase=tool elapsedMs=600000 tool=bash",
    });
  });

  test("a stalled notice keeps the strict id/agent grammar it shares with report and done", () => {
    // The kind is the only thing that widened; the run-id and agent constraints
    // are untouched, so a malformed stalled notice is still swallowed-safe.
    expect(
      parseNotice("[subagent sub-a3f1 (explorer) stalled] phase=tool elapsedMs=600000 tool=bash"),
    ).toEqual({
      runId: "sub-a3f1",
      agent: "explorer",
      kind: "stalled",
      text: "phase=tool elapsedMs=600000 tool=bash",
    });
    // Non-hex run id.
    expect(
      parseNotice("[subagent sub-zzzz (explorer) stalled] phase=tool elapsedMs=600000 tool=bash"),
    ).toBeUndefined();
    // Capitalised agent name.
    expect(
      parseNotice("[subagent sub-a3f1 (Explorer) stalled] phase=tool elapsedMs=600000 tool=bash"),
    ).toBeUndefined();
    // An unknown kind next to the new one is still rejected.
    expect(
      parseNotice("[subagent sub-a3f1 (explorer) chatter] phase=tool elapsedMs=600000 tool=bash"),
    ).toBeUndefined();
    // A human's bracketed line that merely mentions the run is not a notice.
    expect(parseNotice("the run is [subagent sub-a3f1 (explorer) stalled]")).toBeUndefined();
  });

});


// ---------------------------------------------------------------------------
// errorPayload — the failure-path parse
// ---------------------------------------------------------------------------

describe("errorPayload", () => {
  // Regression: herdr prints refusals on stderr with a non-zero exit, so the
  // catch branch used to discard the code and report only "herdr exited 1".
  // That flattening is what disguised agent_name_taken as a launch timeout.
  test("extracts the code from a herdr refusal document", () => {
    const raw = JSON.stringify({ id: "cli:agent:start", error: { code: "agent_name_taken", message: "in use" } });
    expect(errorPayload(raw)?.code).toBe("agent_name_taken");
  });

  test("keeps the whole document, not just the code", () => {
    const raw = JSON.stringify({ id: "x", error: { code: "invalid_agent_name" } });
    expect(errorPayload(raw)?.data.id).toBe("x");
  });

  // The contract that protects real failures: a crash must never be mistaken
  // for a structured refusal, or a genuine problem would stop the launch with
  // a code it should have reported verbatim.
  test("does not mistake a crash or non-herdr output for a refusal", () => {
    for (const raw of [
      undefined,
      "",
      "   ",
      "Killed",
      "error: out of memory",
      "herdr: command not found",
      "<html>502</html>",
      "null",
      "[]",
      '"a string"',
      "42",
      JSON.stringify({ id: "x", result: { ok: true } }), // a success document
      JSON.stringify({ id: "x" }), // no error key
      JSON.stringify({ error: "not an object" }),
      JSON.stringify({ error: null }),
      JSON.stringify({ error: [] }), // an array is not a refusal
    ]) {
      expect(errorPayload(raw)).toBeUndefined();
    }
  });

  test("falls back to message, then a placeholder, when code is absent", () => {
    expect(errorPayload(JSON.stringify({ error: { message: "boom" } }))?.code).toBe("boom");
    expect(errorPayload(JSON.stringify({ error: { detail: "?" } }))?.code).toBe("herdr_error");
  });
});

// ---------------------------------------------------------------------------
// launchAttempt — name refusals vs genuine failures
// ---------------------------------------------------------------------------

/** A launcher whose `startAgent` fails with one herdr code, recording cleanup. */
function stubLauncher(startError: string | null, closed: string[] = []): Launcher {
  return {
    createChildPane: async () => ({ paneId: "w9:p1", tabId: "w9:t1" }),
    renamePane: async () => true,
    startAgent: async () => ({ ok: startError === null, error: startError }),
    closePane: async (paneId: string) => {
      closed.push(paneId);
      return true;
    },
  };
}

const stubAgent = {
  name: "librarian",
  description: "d",
  promptBody: "b",
  filePath: "librarian.md",
} as Parameters<typeof launchAttempt>[0];

const stubRec = { runId: "sub-9622", agent: "librarian", task: "t", cwd: "/tmp", status: "running", startedAt: 0 } as Parameters<typeof launchAttempt>[1];

/** The chain every direct `launchAttempt` call in this suite hands the child. */
const stubChain = ["openai/gpt-5.6-sol", "qwen/qwen3.8-27b"];
describe("launchAttempt name refusals vs genuine failures", () => {
  // Regression: a name refusal is not model-specific, so it must not be read
  // as a dead fleet; it is one actionable error, not a broken model.
  test("a name collision is a clean rejection, so it is not read as a dead model", async () => {
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", stubLauncher("agent_name_taken"), stubChain);
    expect(out.ok).toBe(false);
    expect(out.paneId).toBeUndefined();
  });

  test("a malformed name is a clean rejection too", async () => {
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", stubLauncher("invalid_agent_name"), stubChain);
    expect(out.ok).toBe(false);
    expect(out.paneId).toBeUndefined();
  });

  // The remedies must stay distinct: `herdr agent list` is a dead end for a
  // malformed name, and collapsing the two codes into one message would repeat
  // the flattening this change exists to undo.
  test("each code gets its own remedy, and names the code", async () => {
    const taken = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", stubLauncher("agent_name_taken"), stubChain);
    const invalid = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", stubLauncher("invalid_agent_name"), stubChain);
    expect(taken.error).toContain("agent_name_taken");
    expect(taken.error).toContain("herdr agent list");
    expect(invalid.error).toContain("invalid_agent_name");
    expect(invalid.error).not.toContain("herdr agent list");
  });

  test("the scoped name is what herdr was asked for, and what the error names", async () => {
    let asked: string | undefined;
    const l = stubLauncher("agent_name_taken");
    l.startAgent = async (name: string) => {
      asked = name;
      return { ok: false, error: "agent_name_taken" };
    };
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", l, stubChain);
    expect(asked).toBe("librarian-sub-9622");
    expect(out.error).toContain("librarian-sub-9622");
  });

  // A name refusal means herdr never ran pi, so the pane holds no scrollback
  // and must not be retained as "evidence".
  test("a name refusal always closes its pane", async () => {
    const closed: string[] = [];
    await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", stubLauncher("agent_name_taken", closed), stubChain);
    expect(closed).toEqual(["w9:p1"]);
  });

  // A refusal-closed pane must never be reported back, or a later cleanup path
  // could try to close it a second time.
  test("a name refusal reports no pane id", async () => {
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", stubLauncher("agent_name_taken"), stubChain);
    expect(out.paneId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// launchAttempt — the runtime fallback chain handoff
// ---------------------------------------------------------------------------

/** A launcher that succeeds, recording the env and argv it was handed. */
function recordingLauncher(): {
  launcher: Launcher;
  env: () => Record<string, string> | undefined;
  argv: () => string[] | undefined;
} {
  let seenEnv: Record<string, string> | undefined;
  let seenArgv: string[] | undefined;
  const launcher: Launcher = {
    createChildPane: async (_cwd: string, _label: string, env?: Record<string, string>) => {
      seenEnv = env;
      return { paneId: "w9:p1", tabId: "w9:t1" };
    },
    renamePane: async () => true,
    startAgent: async (_name: string, _paneId: string, argv: string[]) => {
      seenArgv = argv;
      return { ok: true, error: null };
    },
    closePane: async () => true,
  };
  return { launcher, env: () => seenEnv, argv: () => seenArgv };
}

describe("launchAttempt fallback chain handoff", () => {
  const chain = stubChain;
  test("a child with a chain launches on the router, with the chain in its env", async () => {
    // The two halves must agree: launching on `fallback/auto` without the chain
    // would register a router with nothing to route between, and the chain
    // without the router would never be consulted.
    const r = recordingLauncher();
    const out = await launchAttempt(
      stubAgent,
      stubRec,
      "/tmp",
      "/tmp/p.md",
      r.launcher,
      chain,
    );
    expect(out.ok).toBe(true);
    expect(r.env()?.PI_FALLBACK_CHAIN).toBe("openai/gpt-5.6-sol,qwen/qwen3.8-27b");
    const argv = r.argv()!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("fallback/auto");
  });

  test("preparePane runs after renamePane and before startAgent", async () => {
    // The Pi-Bolt shim must be on the pane shell's PATH before herdr types `pi`.
    const calls: string[] = [];
    const r = recordingLauncher();
    const launcher: Launcher = {
      ...r.launcher,
      renamePane: async () => (calls.push("rename"), true),
      preparePane: async () => void calls.push("prepare"),
      startAgent: async (...a) => (calls.push("start"), r.launcher.startAgent(...a)),
    };
    await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", launcher, chain);
    expect(calls).toEqual(["rename", "prepare", "start"]);
  });

  test("with no chain the child still launches on the router, and no chain var crosses", async () => {
    // `spawnRun` refuses a chain-less agent before any pane, so this is the
    // degenerate direct call: the model is always the router, and only a
    // non-empty chain sets the env var.
    const r = recordingLauncher();
    await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", r.launcher, []);
    expect(r.env()?.PI_FALLBACK_CHAIN).toBeUndefined();
    const argv = r.argv()!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("fallback/auto");
  });

  test("a single unpinned chain sets the env var and launches on the router", async () => {
    // A one-model chain is a legal chain: the child launches on the router and
    // the chain crosses, because a child without the router cannot resolve
    // `fallback/auto`.
    const r = recordingLauncher();
    await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", r.launcher, ["openai/gpt-5.6-sol"]);
    expect(r.env()?.PI_FALLBACK_CHAIN).toBe("openai/gpt-5.6-sol");
    const argv = r.argv()!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("fallback/auto");
  });

  test("a one-entry pinned chain launches on the router, with the pin in its env", async () => {
    // The pin can only be applied at route time, so the single pinned model
    // gets the same treatment as a multi-model chain.
    const r = recordingLauncher();
    await launchAttempt(
      stubAgent,
      stubRec,
      "/tmp",
      "/tmp/p.md",
      r.launcher,
      ["openai/gpt-5.6-sol|high"],
    );
    expect(r.env()?.PI_FALLBACK_CHAIN).toBe("openai/gpt-5.6-sol|high");
    const argv = r.argv()!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("fallback/auto");
  });

  test("the chain never displaces the run identity or lineage env", async () => {
    // Regression guard: the chain is an addition, and the vars the handshake
    // and the cycle check depend on must survive it.
    const r = recordingLauncher();
    await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", r.launcher, chain);
    const env = r.env()!;
    expect(env.PI_SUBAGENT_RUN_ID).toBe("sub-9622");
    expect(env.PI_SUBAGENT_AGENT).toBe("librarian");
    expect(env.PI_SUBAGENT_LINEAGE).toContain("librarian");
  });

  // A genuine launch failure keeps its pane for a human to read: with one
  // launch attempt, the pane *is* the evidence.
  test("a genuine launch failure keeps its pane for evidence", async () => {
    const closed: string[] = [];
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", stubLauncher("timeout", closed), stubChain);
    expect(out.ok).toBe(false);
    expect(out.paneId).toBe("w9:p1");
    expect(closed).toEqual([]);
    expect(out.error).toContain("did not become interactive");
    expect(out.error).toContain("timeout");
  });

  test("no pane at all reports no pane id: there is nothing to keep", async () => {
    const l = stubLauncher(null);
    l.createChildPane = async () => null;
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", l, stubChain);
    expect(out.ok).toBe(false);
    expect(out.paneId).toBeUndefined();
  });

  test("a successful start reports the pane and tab it got", async () => {
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", stubLauncher(null), stubChain);
    expect(out).toMatchObject({ ok: true, paneId: "w9:p1", tabId: "w9:t1" });
  });
});

// ---------------------------------------------------------------------------
// classifyExecFailure — recovering a code from a non-zero exit
// ---------------------------------------------------------------------------

describe("classifyExecFailure", () => {
  // THE regression, at the seam where it actually lived: the bug was not a bad
  // parse, it was not *looking* on stderr. herdr prints refusals there with a
  // non-zero exit, and reporting "herdr exited 1" instead of the code is what
  // let agent_name_taken masquerade as a launch timeout across five runs.
  test("recovers the code from a refusal printed on stderr", () => {
    const r = classifyExecFailure({
      code: 1,
      stdout: "",
      stderr: JSON.stringify({ id: "cli:agent:start", error: { code: "agent_name_taken" } }),
    });
    expect(r.error).toBe("agent_name_taken");
    expect(r.ok).toBe(false);
  });

  test("still recovers a code from stdout, should herdr ever put it there", () => {
    const r = classifyExecFailure({
      code: 1,
      stdout: JSON.stringify({ error: { code: "invalid_agent_name" } }),
      stderr: "",
    });
    expect(r.error).toBe("invalid_agent_name");
  });

  test("exposes the parsed document so callers can read its detail", () => {
    const r = classifyExecFailure({
      code: 1,
      stderr: JSON.stringify({ id: "cli:agent:start", error: { code: "agent_name_taken" } }),
    });
    expect(r.data).not.toBeNull();
  });

  // A crash must NOT be dressed up as a structured refusal: those are reported
  // verbatim so a real problem stays visible.
  test("reports a genuine crash by its exit status, not a fake code", () => {
    expect(classifyExecFailure({ code: 137, stderr: "Killed" }).error).toBe("herdr exited 137");
    expect(classifyExecFailure({ code: "ENOENT", message: "spawn failed" }).error).toBe("herdr exited ENOENT");
    expect(classifyExecFailure({ message: "socket hang up" }).error).toBe("socket hang up");
  });

  test("always preserves raw stderr for diagnosis", () => {
    expect(classifyExecFailure({ code: 1, stderr: "boom" }).stderr).toBe("boom");
    expect(classifyExecFailure({ code: 1 }).stderr).toBe("");
  });
});

// ---------------------------------------------------------------------------
// probeFromCall — only `agent_not_found` proves a pane is gone
// ---------------------------------------------------------------------------

describe("probeFromCall", () => {
  const failed = (error: string | null, data: Record<string, unknown> | null = null): HerdrCall => ({
    ok: false,
    data,
    error,
    stderr: "",
  });
  const reply = (agent: unknown): HerdrCall => ({ ok: true, data: { id: "cli:agent:get", result: { agent } }, error: null, stderr: "" });

  // Measured, herdr 0.9.1: the exact refusal for a missing pane.
  test("agent_not_found is the one proof of absence", () => {
    const call = classifyExecFailure({
      code: 1,
      stderr: JSON.stringify({ error: { code: "agent_not_found", message: "agent target w99:p99 not found" }, id: "cli:agent:get" }),
    });
    expect(probeFromCall(call)).toEqual({ kind: "gone" });
  });

  test("timeouts, crashes, ENOENT, malformed replies and other codes are unreachable, carrying the error", () => {
    expect(probeFromCall(failed("herdr exited 1"))).toEqual({ kind: "unreachable", error: "herdr exited 1" });
    expect(probeFromCall(classifyExecFailure({ code: "ENOENT", message: "spawn herdr ENOENT" }))).toEqual({
      kind: "unreachable",
      error: "herdr exited ENOENT",
    });
    expect(probeFromCall(classifyExecFailure({ message: "Command failed: timed out" }))).toEqual({
      kind: "unreachable",
      error: "Command failed: timed out",
    });
    expect(probeFromCall(failed("server_unavailable", { error: { code: "server_unavailable" } }))).toEqual({
      kind: "unreachable",
      error: "server_unavailable",
    });
    // Successful exit, but no usable document.
    expect(probeFromCall({ ok: true, data: null, error: null, stderr: "" }).kind).toBe("unreachable");
    expect(probeFromCall({ ok: true, data: { result: {} }, error: null, stderr: "" }).kind).toBe("unreachable");
    expect(probeFromCall({ ok: true, data: { result: "x" }, error: null, stderr: "" }).kind).toBe("unreachable");
    expect(probeFromCall(reply(null)).kind).toBe("unreachable");
  });

  test("a live reply preserves its status and optional name", () => {
    for (const status of ["idle", "working", "blocked", "done"] as const) {
      expect(probeFromCall(reply({ agent_status: status, name: "worker-sub-ab12" }))).toEqual({
        kind: "state",
        status,
        name: "worker-sub-ab12",
      });
    }
    expect(probeFromCall(reply({ agent_status: "working" }))).toEqual({ kind: "state", status: "working", name: undefined });
  });

  test("an unrecognised status on a successful reply normalises to unknown", () => {
    expect(probeFromCall(reply({ agent_status: "hibernating" }))).toEqual({ kind: "state", status: "unknown", name: undefined });
    expect(probeFromCall(reply({}))).toEqual({ kind: "state", status: "unknown", name: undefined });
  });
});

// ---------------------------------------------------------------------------
// Skill catalogue for subagents
//
// A subagent's system prompt is its definition body VERBATIM — pi builds
// `## Available Skills` for the orchestrator only, so without this an agent
// cannot know a skill exists. The catalogue is opt-in per agent.
// ---------------------------------------------------------------------------

/** Writes `<dir>/<name>/SKILL.md` with the given frontmatter body. */
function writeSkill(root: string, name: string, frontmatter: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), `---\n${frontmatter}\n---\n\nbody\n`);
}

describe("discoverSkills", () => {
  test("reads name and description, and unwraps a quoted description", async () => {
    const root = mkdtempSync(join(tmpdir(), "sub-herdr-skills-"));
    writeSkill(root, "firecrawl", 'name: firecrawl\ndescription: "Scrape the web, politely."');

    const found = await discoverSkills(root);
    expect(found).toHaveLength(1);
    expect(found[0].dir).toBe("firecrawl");
    expect(found[0].name).toBe("firecrawl");
    // The quotes are the YAML's, not part of the description.
    expect(found[0].description).toBe("Scrape the web, politely.");
    expect(found[0].path).toBe(join(root, "firecrawl", "SKILL.md"));
  });

  test("folds a block-scalar description onto one line", async () => {
    const root = mkdtempSync(join(tmpdir(), "sub-herdr-skills-"));
    writeSkill(root, "multi", "name: multi\ndescription: |\n  First line.\n  Second line.");

    const found = await discoverSkills(root);
    // The catalogue renders one line per skill, so a folded value must collapse
    // rather than inject newlines into the middle of the section.
    expect(found[0].description).toBe("First line. Second line.");
  });

  test("falls back to the directory name when frontmatter omits one", async () => {
    const root = mkdtempSync(join(tmpdir(), "sub-herdr-skills-"));
    writeSkill(root, "unnamed", "description: no name key");
    const found = await discoverSkills(root);
    expect(found[0].name).toBe("unnamed");
  });

  test("one unreadable skill costs only itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "sub-herdr-skills-"));
    writeSkill(root, "good", "name: good\ndescription: fine");
    mkdirSync(join(root, "no-skill-md"), { recursive: true }); // no SKILL.md
    writeFileSync(join(root, "stray.txt"), "not a skill");

    const found = await discoverSkills(root);
    expect(found.map((s) => s.dir)).toEqual(["good"]);
  });

  test("reads a CRLF-encoded SKILL.md", async () => {
    // Four SKILL.md files in this repo are CRLF. A \n-only frontmatter pattern
    // read them as having NO frontmatter, so they silently vanished from every
    // consumer — the agent asked for five skills and got two, with no error.
    const root = mkdtempSync(join(tmpdir(), "sub-herdr-skills-"));
    mkdirSync(join(root, "crlf"), { recursive: true });
    writeFileSync(
      join(root, "crlf", "SKILL.md"),
      '---\r\nname: crlf\r\ndescription: "Windows line endings"\r\n---\r\n\r\nbody\r\n',
    );

    const found = await discoverSkills(root);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("crlf");
    expect(found[0].description).toBe("Windows line endings");
    // And no carriage return leaks into the rendered catalogue line.
    expect(found[0].description).not.toContain("\r");
  });

  test("a missing skills directory is empty, not a throw", async () => {
    // Discovery runs on the launch path: it must never cost a delegation.
    expect(await discoverSkills(join(tmpdir(), "definitely-not-here-xyz"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// skillEntriesFromPi
// ---------------------------------------------------------------------------

/** One entry shaped like pi's `Skill`, as `systemPromptOptions.skills` carries it. */
function piSkill(dir: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: dir,
    description: `desc of ${dir}`,
    filePath: `/root/${dir}/SKILL.md`,
    baseDir: `/root/${dir}`,
    disableModelInvocation: false,
    ...over,
  };
}

describe("skillEntriesFromPi", () => {
  test("maps pi's resolved list into catalogue entries", () => {
    const got = skillEntriesFromPi([piSkill("firecrawl")]);
    expect(got).toEqual([
      {
        dir: "firecrawl",
        name: "firecrawl",
        description: "desc of firecrawl",
        path: "/root/firecrawl/SKILL.md",
      },
    ]);
  });

  test("keys on the DIRECTORY, not the frontmatter name", () => {
    // `selectSkills` matches `SkillEntry.dir`, and the two are free to drift. A
    // name-keyed version passes for every skill where they agree and breaks on
    // the first package where they do not.
    const got = skillEntriesFromPi([
      piSkill("test-driven-development", { name: "Test-Driven Development (TDD)" }),
    ]);
    expect(got[0].dir).toBe("test-driven-development");
    expect(got[0].name).toBe("Test-Driven Development (TDD)");
    expect(selectSkills(["test-driven-development"], got)).toHaveLength(1);
  });

  test("a package skill is selectable, which is the bug this fixes", () => {
    // Before this, a child's catalogue came from `agent/skills/` alone, so
    // `skills: test-driven-development` resolved to nothing and selectSkills
    // dropped it silently.
    const entries = skillEntriesFromPi([
      piSkill("tdd-local"),
      piSkill("test-driven-development", {
        filePath: "/home/u/.pi/agent/git/github.com/obra/superpowers/skills/test-driven-development/SKILL.md",
        baseDir: "/home/u/.pi/agent/git/github.com/obra/superpowers/skills/test-driven-development",
      }),
    ]);
    const sel = selectSkills(["test-driven-development"], entries);
    expect(sel).toHaveLength(1);
    expect(sel[0].path).toContain("superpowers");
  });

  test("keeps disable-model-invocation skills", () => {
    // pi filters those only when *rendering* the orchestrator's prompt. An agent
    // that explicitly declares one should still get it.
    const got = skillEntriesFromPi([piSkill("handoff", { disableModelInvocation: true })]);
    expect(got.map((s) => s.dir)).toEqual(["handoff"]);
  });

  test("falls back to the SKILL.md's parent when baseDir is absent", () => {
    const got = skillEntriesFromPi([piSkill("x", { baseDir: undefined })]);
    expect(got[0].dir).toBe("x");
  });

  test("falls back to the directory when the name is empty", () => {
    expect(skillEntriesFromPi([piSkill("y", { name: "" })])[0].name).toBe("y");
    expect(skillEntriesFromPi([piSkill("z", { description: 42 })])[0].description).toBe("");
  });

  test("skips malformed entries rather than throwing", () => {
    // This runs on the launch path: a bad entry must cost itself, never the spawn.
    const got = skillEntriesFromPi([
      null,
      undefined,
      "nonsense",
      42,
      {},
      { filePath: "" },
      piSkill("good"),
    ] as unknown[]);
    expect(got.map((s) => s.dir)).toEqual(["good"]);
  });

  test("an empty or absent list is empty, not a throw", () => {
    expect(skillEntriesFromPi([])).toEqual([]);
    expect(skillEntriesFromPi(undefined as unknown as unknown[])).toEqual([]);
  });

  test("dedups by directory, keeping the first", () => {
    const got = skillEntriesFromPi([
      piSkill("dup", { description: "first" }),
      piSkill("dup", { description: "second" }),
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].description).toBe("first");
  });

  test("sorts by directory, so the catalogue order is stable", () => {
    const got = skillEntriesFromPi([piSkill("zebra"), piSkill("alpha"), piSkill("middle")]);
    expect(got.map((s) => s.dir)).toEqual(["alpha", "middle", "zebra"]);
  });
});

describe("selectSkills", () => {
  const available = [
    { dir: "a", name: "a", description: "A", path: "/s/a/SKILL.md" },
    { dir: "b", name: "b", description: "B", path: "/s/b/SKILL.md" },
    { dir: "c", name: "c", description: "C", path: "/s/c/SKILL.md" },
  ];

  test("no declaration selects nothing, which is the pre-feature behaviour", () => {
    expect(selectSkills(undefined, available)).toEqual([]);
    expect(selectSkills([], available)).toEqual([]);
  });

  test("the wildcard selects every skill", () => {
    expect(selectSkills([SKILLS_WILDCARD], available)).toHaveLength(3);
  });

  test("named skills come back in the order the agent declared them", () => {
    // Declaration order is the agent's priority order; alphabetising would bury
    // the skill it listed first.
    expect(selectSkills(["c", "a"], available).map((s) => s.dir)).toEqual(["c", "a"]);
  });

  test("an unknown name is dropped rather than failing the launch", () => {
    // A renamed or deleted skill must not break every delegation to an agent
    // whose frontmatter still mentions it.
    expect(selectSkills(["a", "ghost"], available).map((s) => s.dir)).toEqual(["a"]);
  });

  test("a duplicate declaration is listed once", () => {
    expect(selectSkills(["a", "a"], available).map((s) => s.dir)).toEqual(["a"]);
  });
});

describe("appendSkillCatalogue", () => {
  const skills = [{ dir: "firecrawl", name: "firecrawl", description: "Scrape", path: "/s/f/SKILL.md" }];

  test("an agent with no skills gets a byte-identical prompt", () => {
    // The whole feature has to be invisible to the seven agents that do not
    // opt in, or it is a silent rewrite of every existing subagent prompt.
    const body = "You are a worker.\n";
    expect(appendSkillCatalogue(body, [], true)).toBe(body);
  });

  test("the catalogue carries each skill's description and path", () => {
    const out = appendSkillCatalogue("Body.", skills, true);
    expect(out).toContain("## Available Skills");
    expect(out).toContain("**firecrawl**");
    expect(out).toContain("Scrape");
    expect(out).toContain("/s/f/SKILL.md");
    expect(out.startsWith("Body.")).toBe(true);
  });

  test("a reader-less agent is told to delegate instead of to read", () => {
    const withRead = appendSkillCatalogue("B.", skills, true);
    const without = appendSkillCatalogue("B.", skills, false);
    expect(withRead).toContain("Read a skill's file");
    expect(without).toContain("no file-reading tool");
    expect(without).toContain("delegate");
  });

  test("an empty description still renders a usable line", () => {
    const out = appendSkillCatalogue("B.", [{ dir: "x", name: "x", description: "", path: "/p" }], true);
    expect(out).toContain("(no description)");
  });

  test("tells the child a declared skill is the expected method, not a reference", () => {
    // Matches the orchestrator's stance (`dynamic-prompt.ts`). The earlier
    // wording — "read the file only when its description matches what you are
    // doing" — made an opt-in declaration sound optional, which is the one thing
    // it is not: somebody wrote that `skills:` key on purpose.
    const out = appendSkillCatalogue("B.", skills, true);
    expect(out).toContain("Check this list before you start");
    expect(out).toContain("rather than improvising");
    expect(out).not.toContain("only when its description matches");
  });
});

describe("parseAgentFile skills key", () => {
  test("reads inline and block spellings, and absent means undefined", () => {
    const mk = (fm: string) => parseAgentFile(`---\nname: a\n${fm}\n---\nbody`, "a.md");
    expect(mk("skills: firecrawl, tdd")?.skills).toEqual(["firecrawl", "tdd"]);
    expect(mk("skills:\n  - firecrawl\n  - tdd")?.skills).toEqual(["firecrawl", "tdd"]);
    expect(mk("skills: *")?.skills).toEqual(["*"]);
    // Absent must stay undefined, not [], so the spawn path's guard is honest.
    expect(mk("model: x")?.skills).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Delegation lineage: cycles and callable_by
//
// Nothing else bounds the delegation tree, and `lib/dotenv.ts` records a fork
// bomb in this repo's history. The bound is the agent's own ancestry, carried
// in an env var its PARENT stamped: no agent may appear twice in its lineage,
// so every generation must introduce a new agent and a finite roster ends the
// chain by itself. This replaced a numeric depth cap, which had to be tuned and
// was wrong once (a cap of 1 silently refused the orchestrator's own child).
// ---------------------------------------------------------------------------

describe("parseLineage / formatLineage", () => {
  test("an unset or empty value is the human's orchestrator", () => {
    expect(parseLineage(undefined)).toEqual([]);
    expect(parseLineage("")).toEqual([]);
  });

  test("round-trips a chain", () => {
    expect(parseLineage("worker,librarian")).toEqual(["worker", "librarian"]);
    expect(formatLineage(["worker", "librarian"])).toBe("worker,librarian");
  });

  test("tolerates padding and empty segments", () => {
    // A hand-edited or shell-mangled value must not invent a nameless ancestor,
    // which would make `lineage.at(-1)` an empty-string caller.
    expect(parseLineage(" worker , librarian ")).toEqual(["worker", "librarian"]);
    expect(parseLineage("worker,,librarian,")).toEqual(["worker", "librarian"]);
  });
});

describe("lineageRejection: cycles", () => {
  test("the orchestrator may spawn anything", () => {
    expect(lineageRejection("librarian", undefined, [])).toBeUndefined();
    expect(lineageRejection("worker", undefined, [])).toBeUndefined();
  });

  test("librarian -> librarian is refused", () => {
    // The case that motivated this design: a librarian spawning librarians is
    // the fork-bomb shape, and it is now impossible rather than discouraged.
    expect(lineageRejection("librarian", undefined, ["librarian"])).toBeDefined();
  });

  test("an agent anywhere in the ancestry is refused, not just the direct parent", () => {
    // worker -> librarian -> spiker -> librarian must fail at the last hop.
    expect(
      lineageRejection("librarian", undefined, ["worker", "librarian", "spiker"]),
    ).toBeDefined();
  });

  test("the refusal shows the chain and names the way out", () => {
    const msg = lineageRejection("librarian", undefined, ["worker", "librarian"]) ?? "";
    expect(msg).toContain("worker → librarian → librarian");
    expect(msg).toMatch(/your own tools|report what you need/);
  });

  test("the intended chains are allowed", () => {
    // worker -> librarian (ask a research question)
    expect(lineageRejection("librarian", ["worker"], ["worker"])).toBeUndefined();
    // librarian -> spiker (confirm external code really behaves as documented)
    expect(lineageRejection("spiker", ["librarian"], ["worker", "librarian"])).toBeUndefined();
    // librarian -> summarizer (condense a huge page)
    expect(lineageRejection("summarizer", ["librarian"], ["worker", "librarian"])).toBeUndefined();
  });
});

describe("lineageRejection: callable_by", () => {
  test("an agent with no callable_by is orchestrator-only, never implicitly public", () => {
    expect(lineageRejection("worker", undefined, ["oracle"])).toBeDefined();
    expect(lineageRejection("worker", [], ["oracle"])).toBeDefined();
    expect(lineageRejection("worker", undefined, [])).toBeUndefined();
    expect(lineageRejection("worker", undefined, ["oracle"])).toContain("orchestrator");
  });

  test("`any` is the explicit public declaration", () => {
    expect(lineageRejection("x", ["any"], ["oracle"])).toBeUndefined();
    expect(lineageRejection("x", ["any"], ["worker", "librarian"])).toBeUndefined();
    // `any` does not override the cycle rule.
    expect(lineageRejection("x", ["any"], ["x"])).toBeDefined();
  });

  test("`orchestrator` names the human's orchestrator, not a caller agents can claim", () => {
    expect(lineageRejection("x", ["orchestrator"], [])).toBeUndefined();
    expect(lineageRejection("x", ["orchestrator"], ["worker"])).toBeDefined();
  });

  test("a private helper refuses a caller not on its list", () => {
    expect(lineageRejection("summarizer", ["librarian"], ["worker"])).toBeDefined();
    expect(lineageRejection("summarizer", ["librarian"], ["reviewer", "spiker"])).toBeDefined();
  });

  test("a private helper accepts its declared caller", () => {
    expect(lineageRejection("summarizer", ["librarian"], ["librarian"])).toBeUndefined();
  });

  test("only the DIRECT caller counts, not a distant ancestor", () => {
    // A librarian high in the chain must not let an unrelated agent below it
    // borrow its private helper.
    expect(lineageRejection("summarizer", ["librarian"], ["librarian", "spiker"])).toBeDefined();
  });

  test("the human's orchestrator may spawn a private helper directly", () => {
    // Empty lineage is the human, which an agent cannot forge: the value is
    // written by the parent process. Being able to run a helper by hand is how
    // you debug one.
    expect(lineageRejection("summarizer", ["librarian"], [])).toBeUndefined();
  });

  test("the refusal names the permitted callers and the caller it saw", () => {
    const msg = lineageRejection("summarizer", ["librarian"], ["worker"]) ?? "";
    expect(msg).toContain("librarian");
    expect(msg).toContain("worker");
  });

  test("a cycle is reported ahead of callable_by", () => {
    // Both rules fire; the cycle is the more fundamental fact, and reporting
    // "you may not call yourself" is more useful than a permissions list.
    const msg = lineageRejection("librarian", ["librarian"], ["librarian"]) ?? "";
    expect(msg).toContain("ancestry");
  });
});

describe("admitSpawn", () => {
  const mk = (name: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({
    name,
    description: `${name} agent`,
    promptBody: `Body for ${name}.`,
    filePath: `${name}.md`,
    model: "openai/gpt-5.6-sol",
    ...extra,
  });
  // An in-memory roster shaped like the fleet: worker → reviewer, a private
  // librarian helper, an orchestrator-only healthcheck, and a skill agent.
  const roster: AgentInfo[] = [
    // Sorted by name, as `delegationRoster(...).all` is.
    mk("healthcheck", { callableBy: ["orchestrator"], fallbackModels: ["qwen/qwen3.8-27b"] }),
    mk("modelless", { callableBy: ["any"], model: undefined }),
    mk("observer", { callableBy: ["any"], skill: "technical-analysis" }),
    mk("reviewer", { callableBy: ["worker"] }),
    mk("summarizer", { callableBy: ["librarian"] }),
    mk("worker", { callableBy: ["orchestrator"] }),
  ];
  const tool = { kind: "tool-delegation" } as const;
  const health = { kind: "system-health-check", targetRunId: "sub-1a2b" } as const;
  const req = (agent: string, origin: typeof tool | typeof health = tool, model?: string) => ({
    agent,
    task: "do the thing",
    cwd: "/work",
    ...(model !== undefined ? { model } : {}),
    origin,
  });

  test("an unknown agent lists exactly what this lineage may spawn", () => {
    expect(admitSpawn(req("nobody"), roster, ["worker"])).toEqual({
      ok: false,
      error:
        'Unknown agent "nobody". Available agents: modelless, observer (skill: technical-analysis), reviewer.',
    });
  });

  test("the unknown-agent list uses normal lineage rules even for a health check", () => {
    // healthcheck is orchestrator-only; a system origin must not advertise it.
    expect(admitSpawn(req("nobody", health), roster, ["worker"])).toEqual({
      ok: false,
      error:
        'Unknown agent "nobody". Available agents: modelless, observer (skill: technical-analysis), reviewer.',
    });
  });

  test("an unknown agent with nothing spawnable says none", () => {
    expect(admitSpawn(req("nobody"), [mk("worker")], ["worker"])).toEqual({
      ok: false,
      error: 'Unknown agent "nobody". Available agents: none.',
    });
  });

  test("a cycle is refused", () => {
    expect(admitSpawn(req("reviewer"), roster, ["worker", "reviewer"])).toEqual({
      ok: false,
      error:
        '"reviewer" is already in this delegation\'s ancestry (worker → reviewer → reviewer), so spawning it ' +
        "again would be a cycle. Do this part with your own tools, or report what you " +
        "need so the agent above you can take it from here.",
    });
  });

  test("callable_by refuses a tool delegation from a caller it does not name", () => {
    expect(admitSpawn(req("summarizer"), roster, ["worker"])).toEqual({
      ok: false,
      error:
        '"summarizer" can only be spawned by: librarian. ' +
        'You are "worker", so this delegation was refused. Do this part with your own ' +
        "tools, or report what you need so the agent above you can delegate it.",
    });
  });

  test("an unusable explicit model is the caller's to fix", () => {
    expect(admitSpawn(req("reviewer", tool, "fallback/auto"), roster, ["worker"])).toEqual({
      ok: false,
      error:
        'Requested model "fallback/auto" is not usable. The accepted grammar is `provider/id` or `provider/id|level` (level: off|minimal|low|medium|high|xhigh|max); a pi-style `ref:level` is translated only when the ref is itself a plain `provider/id`, and `fallback/auto` is not accepted — the router cannot route to itself. Pass a valid model, or omit `model` to use the agent\'s declaration.',
    });
  });

  test("a declaration with no usable chain is the agent file's to fix", () => {
    expect(admitSpawn(req("modelless"), roster, [])).toEqual({
      ok: false,
      error:
        'Agent "modelless" declares no usable model: its model/fallback_models contains no reference the router can serve. Fix the agent definition — children launch on fallback/auto, which needs at least one entry.',
    });
  });

  test("a tool delegation is admitted with its chain and no healthCheckOf", () => {
    const out = admitSpawn(req("reviewer"), roster, ["worker"]);
    expect(out).toEqual({
      ok: true,
      agent: roster.find((a) => a.name === "reviewer")!,
      chain: ["openai/gpt-5.6-sol"],
      task: "do the thing",
      cwd: "/work",
    });
    expect("healthCheckOf" in out).toBe(false);
  });

  test("a health check bypasses callable_by", () => {
    // The same lineage is refused for a tool delegation of healthcheck.
    expect(admitSpawn(req("healthcheck"), roster, ["worker"]).ok).toBe(false);
    expect(admitSpawn(req("healthcheck", health), roster, ["worker"]).ok).toBe(true);
  });

  test("a health check is still refused for a cycle", () => {
    expect(admitSpawn(req("healthcheck", health), roster, ["healthcheck"])).toEqual({
      ok: false,
      error:
        '"healthcheck" is already in this delegation\'s ancestry (healthcheck → healthcheck), so spawning it ' +
        "again would be a cycle. Do this part with your own tools, or report what you " +
        "need so the agent above you can take it from here.",
    });
  });

  test("an admitted health check carries targetRunId as healthCheckOf", () => {
    expect(admitSpawn(req("healthcheck", health), roster, ["worker", "reviewer"])).toEqual({
      ok: true,
      agent: roster.find((a) => a.name === "healthcheck")!,
      chain: ["openai/gpt-5.6-sol", "qwen/qwen3.8-27b"],
      task: "do the thing",
      cwd: "/work",
      healthCheckOf: "sub-1a2b",
    });
  });
});

describe("the fleet delegation graph (agents/*.md callable_by)", () => {
  // The designed graph, written out once. Every edge here is backed by a
  // `subagent(agent: ...)` instruction in the caller's prompt body; an edge
  // that is not here is refused at spawn and absent from the caller's roster.
  // Changing an agent's callers is a deliberate edit to BOTH this table and the
  // agent file.
  const EXPECTED: Record<string, string[]> = {
    explorer: ["orchestrator", "librarian"],
    healthcheck: ["orchestrator"],
    librarian: ["orchestrator", "oracle", "reviewer", "spiker", "verifier", "worker"],
    oracle: ["orchestrator"],
    planner: ["orchestrator"],
    reviewer: ["orchestrator", "worker"],
    spiker: ["orchestrator", "librarian"],
    summarizer: ["librarian"],
    verifier: ["orchestrator", "worker"],
    worker: ["orchestrator"],
  };

  test("a system spawn (health check) skips callable_by but not the cycle rule", () => {
    expect(lineageRejection("healthcheck", ["orchestrator"], ["worker"])).toBeDefined();
    expect(
      lineageRejection("healthcheck", ["orchestrator"], ["worker"], { system: true }),
    ).toBeUndefined();
    expect(
      lineageRejection("healthcheck", ["orchestrator"], ["healthcheck"], { system: true }),
    ).toBeDefined();
  });

  test("every skill-shipped agent declares callable_by too", async () => {
    const skillAgents = await discoverSkillAgents(skillsDir());
    expect(skillAgents.length).toBeGreaterThan(0);
    for (const a of skillAgents) expect(a.callableBy?.length ?? 0).toBeGreaterThan(0);
  });

  test("every agent file declares callable_by, matching the designed graph", async () => {
    const agents = await discoverAgents(agentsDir());
    const actual = Object.fromEntries(agents.map((a) => [a.name, a.callableBy]));
    expect(actual).toEqual(EXPECTED);
  });

  // The fleet is the user's agent dir, and a container with HOME=/tmp has none of it. A silent
  // `return` inside the body prints a pass for an assertion that ran nothing, so the skip is
  // declared where the report can show it.
  const fleetOnDisk = (() => {
    try {
      return readdirSync(agentsDir()).some((f) => f.endsWith(".md"));
    } catch {
      return false;
    }
  })();

  test.skipIf(!fleetOnDisk)("only worker declares a self-grading pass — the premise of the prompt's worker gate", async () => {
    // `dynamic-prompt.ts` grants the "do not re-grade a child's diff" exemption to `worker`
    // alone, and withholds the whole exemption in a roster without it, because `worker.md`
    // is the only body that ends its own run with a grading pass. Agent bodies are prose a
    // human edits, so the premise is pinned, not assumed: an agent that starts self-grading
    // has to be added to that gate, and one that stops has to be taken back out of it.
    // Fence-stripped: worker.md's report template quotes a "## Quality Pass" heading, and a
    // heading inside a code fence is not that agent's contract. A loose predicate here would
    // certify any agent whose body merely shows such a heading, so the gate it protects
    // ("only worker self-grades") would rest on a match that means nothing.
    const selfGrades = (body: string) => {
      const prose = body.replace(/```[\s\S]*?```/g, "");
      return /^## Quality Pass$/m.test(prose) || /run the quality pass/i.test(prose);
    };
    const fleet = await discoverAgents(agentsDir());
    // Guarded by `test.skipIf` above: with no fleet on disk there is no body to read.
    const all = [...fleet, ...(await discoverSkillAgents(skillsDir()))];
    const graded = all.filter((a) => selfGrades((a as { promptBody?: string }).promptBody ?? "")).map((a) => a.name);
    expect(graded).toEqual(["worker"]);
  });

  test("every named caller is a real agent, `orchestrator`, or `any`", async () => {
    const agents = await discoverAgents(agentsDir());
    const names = new Set([...agents.map((a) => a.name), "orchestrator", "any"]);
    for (const a of [...agents, ...(await discoverSkillAgents(skillsDir()))]) for (const c of a.callableBy ?? []) expect(names.has(c)).toBe(true);
  });

  test("a caller only ever names callees it has the `subagent` tool to reach", async () => {
    const agents = await discoverAgents(agentsDir());
    const byName = new Map(agents.map((a) => [a.name, a]));
    for (const a of agents)
      for (const c of a.callableBy ?? []) {
        const caller = byName.get(c);
        if (caller) expect(caller.tools ?? ["subagent"]).toContain("subagent");
      }
  });

  test("the effective rosters, as each lineage sees them", async () => {
    const agents = await discoverAgents(agentsDir());
    const roster = (lineage: string[]) => spawnableAgents(agents, lineage).map((a) => a.name).sort();
    expect(roster([])).toEqual(Object.keys(EXPECTED).sort());
    expect(roster(["worker"])).toEqual(["librarian", "reviewer", "verifier"]);
    expect(roster(["worker", "reviewer"])).toEqual(["librarian"]);
    expect(roster(["worker", "reviewer", "librarian"])).toEqual(["explorer", "spiker", "summarizer"]);
    expect(roster(["librarian", "spiker"])).toEqual([]);
    expect(roster(["oracle"])).toEqual(["librarian"]);
    expect(roster(["explorer"])).toEqual([]);
  });
});

describe("buildChildEnv lineage stamping", () => {
  const rec = { runId: "sub-1234", agent: "librarian" };

  test("defaults to just the child, so a direct spawn is depth-1 ancestry", () => {
    expect(buildChildEnv(rec, undefined, "/run")["PI_SUBAGENT_LINEAGE"]).toBe("librarian");
  });

  test("accumulates the chain the parent passes", () => {
    expect(buildChildEnv(rec, undefined, "/run", ["worker", "librarian"])["PI_SUBAGENT_LINEAGE"]).toBe(
      "worker,librarian",
    );
  });

  test("the stamped chain is what terminates the tree one process later", () => {
    // The round trip that matters: a parent stamps, a child reads it back, and
    // the guard refuses the repeat. No arithmetic, no tuning.
    const stamped = buildChildEnv(rec, undefined, "/run", ["worker", "librarian"]);
    const asChildSees = parseLineage(stamped["PI_SUBAGENT_LINEAGE"]);
    expect(lineageRejection("librarian", ["any"], asChildSees)).toBeDefined();
    expect(lineageRejection("spiker", ["librarian"], asChildSees)).toBeUndefined();
  });
});

describe("parseAgentFile callable_by key", () => {
  test("reads both spellings; absent means orchestrator-only", () => {
    const mk = (fm: string) => parseAgentFile(`---\nname: a\n${fm}\n---\nbody`, "a.md");
    expect(mk("callable_by: librarian")?.callableBy).toEqual(["librarian"]);
    expect(mk("callable_by: librarian, oracle")?.callableBy).toEqual(["librarian", "oracle"]);
    expect(mk("callable_by:\n  - librarian")?.callableBy).toEqual(["librarian"]);
    // Absent must stay undefined — the guard reads that as orchestrator-only.
    expect(mk("model: x")?.callableBy).toBeUndefined();
  });

  test("a camelCase key does not match, as the frontmatter contract warns", () => {
    const a = parseAgentFile(`---\nname: a\ncallableBy: librarian\n---\nbody`, "a.md");
    expect(a?.callableBy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The answer contract (rundir.ts) — shared by both halves of the handshake
// ---------------------------------------------------------------------------

describe("qualifiesAsAnswer", () => {
  // Every agent in agent/agents/ ends its prompt with this sentence.
  const RESULT_PROMPT = "You map codebases.\n\nOnly what is inside `<result>` reaches the orchestrator.";
  const PLAIN_PROMPT = "Record one journal observation. Reply with the id you wrote.";

  test("a complete <result> element qualifies under a <result> prompt", () => {
    expect(qualifiesAsAnswer("<result>\n## Map\n- a.ts:1 — here\n</result>", RESULT_PROMPT)).toBe(true);
  });

  test("filler prose does not qualify under a <result> prompt", () => {
    // The exact text sub-c459 and sub-e987 left behind as their "answer".
    expect(qualifiesAsAnswer("I have all the evidence I need. Compiling the recon report now.", RESULT_PROMPT)).toBe(false);
  });

  test("an unclosed <result> does not qualify: a truncated report is not a report", () => {
    expect(qualifiesAsAnswer("<result>\n## Map\n- a.ts:1", RESULT_PROMPT)).toBe(false);
    expect(qualifiesAsAnswer("</result> first, then <result>", RESULT_PROMPT)).toBe(false);
  });

  test("an agent whose prompt never mentions <result> may answer in plain prose", () => {
    expect(qualifiesAsAnswer("Recorded observation obs-0007.", PLAIN_PROMPT)).toBe(true);
    expect(qualifiesAsAnswer("<result>also fine</result>", PLAIN_PROMPT)).toBe(true);
  });

  test("whitespace is never an answer, under either contract", () => {
    expect(qualifiesAsAnswer("   \n\t ", RESULT_PROMPT)).toBe(false);
    expect(qualifiesAsAnswer("   \n\t ", PLAIN_PROMPT)).toBe(false);
    expect(qualifiesAsAnswer("", undefined)).toBe(false);
  });

  test("an unreadable prompt falls back to the weaker rule rather than trapping the child", () => {
    // A historical or corrupt run has no system-prompt.md. Refusing every answer
    // there would make such a run unfinishable; accepting visible text still
    // beats the filler-line status quo.
    expect(qualifiesAsAnswer("some answer", undefined)).toBe(true);
  });

  test("requiresResultBlock reads the contract off the prompt, not off a hardcoded roster", () => {
    expect(requiresResultBlock(RESULT_PROMPT)).toBe(true);
    expect(requiresResultBlock(PLAIN_PROMPT)).toBe(false);
    expect(requiresResultBlock(undefined)).toBe(false);
  });

  test("qualifiesAsSalvage keeps a truncated report that the gate would reject", () => {
    // Every real done-arguments case was cut off mid-document: the model spent
    // its output budget on an argument it should not have been writing. Lengths
    // measured from sub-2ea3 (17419), sub-e987 (9199) and sub-c459 (7496).
    const truncated = `<result>\n## Map\n${"- `a.ts:1` — a mapped file, described at length.\n".repeat(20)}`;
    expect(truncated.length).toBeGreaterThan(400);
    // The gate refuses it, so the child is still told to write a real answer...
    expect(qualifiesAsAnswer(truncated, RESULT_PROMPT)).toBe(false);
    // ...but once the run is over, 17 KB of map beats "(no final answer)".
    expect(qualifiesAsSalvage(truncated, RESULT_PROMPT)).toBe(true);
  });

  test("qualifiesAsSalvage keeps a substantial untagged report", () => {
    // sub-c459 and sub-e987 passed 7.5 KB and 9.2 KB with no tags at all.
    const untagged = "## 1. OVERVIEW\n".padEnd(500, "x");
    expect(qualifiesAsSalvage(untagged, RESULT_PROMPT)).toBe(true);
  });

  test("qualifiesAsSalvage still rejects the filler lines this fix exists to stop", () => {
    // The actual visible "answers" of the three cases: 62, 63 and 48 chars.
    for (const filler of [
      "I have all the evidence I need. Here is the recon report.",
      "I have all the evidence I need. Compiling the recon report now.",
      "All evidence gathered. Writing the recon report.",
    ]) {
      expect(filler.length).toBeLessThan(400);
      expect(qualifiesAsSalvage(filler, RESULT_PROMPT)).toBe(false);
    }
  });

  test("qualifiesAsSalvage uses length alone, because the real cases had no tags", () => {
    // Requiring even an opening <result> was tried and would have discarded
    // sub-c459 (7.5 KB) and sub-e987 (9.2 KB), which carried no tags at all.
    expect(qualifiesAsSalvage("x".repeat(500), RESULT_PROMPT)).toBe(true);
    expect(qualifiesAsSalvage("short", RESULT_PROMPT)).toBe(false);
    expect(qualifiesAsSalvage("", RESULT_PROMPT)).toBe(false);
    // The boundary is pinned so a future tweak has to come past these tests.
    expect(qualifiesAsSalvage("y".repeat(399), RESULT_PROMPT)).toBe(false);
    expect(qualifiesAsSalvage("y".repeat(400), RESULT_PROMPT)).toBe(true);
  });

  test("both halves of the handshake share ONE visible-text extractor", async () => {
    // The gate and the parent must agree on what text they are judging, or a
    // child can pass its own gate on a message the parent reads as unanswered.
    // These two were briefly separate implementations that had already diverged
    // on string `content`; this pins them to the same function.
    const { visibleTextOf: childSide } = await import("./child-done.js");
    expect(childSide).toBe(visibleTextOf);

    const msg = {
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "visible" },
      ],
    };
    expect(visibleTextOf(msg)).toBe("visible");
    // String content: the shape the two copies disagreed about.
    expect(visibleTextOf({ content: "  plain  " })).toBe("plain");
    expect(visibleTextOf({ content: undefined })).toBe("");
    expect(visibleTextOf({ content: 42 })).toBe("");
    expect(visibleTextOf({ content: [{ type: "text" }] })).toBe("");
  });

  test("the documented salvage bar is the exported constant", () => {
    // subagent-herdr/AGENTS.md cites SUBSTANTIAL_ANSWER_CHARS by name.
    expect(SUBSTANTIAL_ANSWER_CHARS).toBe(400);
    expect(qualifiesAsSalvage("z".repeat(SUBSTANTIAL_ANSWER_CHARS), RESULT_PROMPT)).toBe(true);
    expect(qualifiesAsSalvage("z".repeat(SUBSTANTIAL_ANSWER_CHARS - 1), RESULT_PROMPT)).toBe(false);
  });

  test("hasResultBlock accepts a multi-line body and a trailing remark", () => {
    expect(hasResultBlock("noise\n<result>\nbody\nmore\n</result>\ntrailing")).toBe(true);
    expect(hasResultBlock("no tags at all")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// herdr pane primitives (kanban side pane)
// ---------------------------------------------------------------------------

describe("splitArgs", () => {
  test("anchors an explicit pane, never --current, and never steals focus", () => {
    const args = splitArgs("w9:p1", "right", 0.7, "/repo");
    expect(args).toEqual(["pane", "split", "--pane", "w9:p1", "--direction", "right", "--ratio", "0.7", "--cwd", "/repo", "--no-focus"]);
    expect(args).not.toContain("--current");
  });
});

describe("paneRectFrom", () => {
  // The reply shape measured from `herdr pane layout --pane w9:p1` (herdr 0.9.0).
  const reply = {
    id: "cli:pane:layout",
    result: {
      layout: {
        area: { height: 69, width: 251, x: 0, y: 0 },
        panes: [
          { focused: true, pane_id: "w9:p2B", rect: { height: 69, width: 75, x: 0, y: 0 } },
          { focused: false, pane_id: "w9:p2C", rect: { height: 69, width: 176, x: 75, y: 0 } },
        ],
      },
      type: "pane_layout",
    },
  };

  test("selects the rect of the named pane", () => {
    expect(paneRectFrom(reply, "w9:p2C")).toEqual({ width: 176, height: 69 });
    expect(paneRectFrom(reply, "w9:p2B")).toEqual({ width: 75, height: 69 });
  });

  test("an absent pane or a malformed reply is null", () => {
    expect(paneRectFrom(reply, "w9:p9")).toBeNull();
    expect(paneRectFrom({ result: {} }, "w9:p2C")).toBeNull();
    expect(paneRectFrom(null, "w9:p2C")).toBeNull();
    expect(paneRectFrom({ result: { layout: { panes: [{ pane_id: "w9:p1", rect: { width: "x", height: 3 } }] } } }, "w9:p1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// interruptRun — the subagent_tasks "interrupt" seam
// ---------------------------------------------------------------------------

describe("interruptRun", () => {
  const runningRec = (): RunRecord => ({
    runId: "sub-ab12",
    agent: "explorer",
    task: "map the repo",
    cwd: "/repo",
    paneId: "w9:p1",
    status: "running",
    startedAt: 1_000,
  });

  /** Recording effects: every herdr call is logged as [name, ...args]. */
  function makeEffects(opts?: {
    sendKeysOk?: boolean;
    idle?: boolean;
    promptOk?: boolean;
    promptError?: string | null;
    onRead?: (rec: RunRecord, callNumber: number) => void;
  }) {
    const calls: Array<[string, ...unknown[]]> = [];
    let readCalls = 0;
    const effects = {
      sendKeys: async (paneId: string, ...keys: string[]) => {
        calls.push(["sendKeys", paneId, ...keys]);
        return opts?.sendKeysOk ?? true;
      },
      waitAgentIdle: async (paneId: string, timeoutMs: number) => {
        calls.push(["waitAgentIdle", paneId, timeoutMs]);
        return opts?.idle ?? true;
      },
      sendPrompt: async (paneId: string, text: string) => {
        calls.push(["sendPrompt", paneId, text]);
        const ok = opts?.promptOk ?? true;
        return { ok, error: ok ? null : (opts?.promptError ?? "agent_blocked") };
      },
      read: async (rec: RunRecord): Promise<RunObservation> => {
        readCalls += 1;
        calls.push(["read", rec.runId, readCalls]);
        opts?.onRead?.(rec, readCalls);
        return { run: rec, pane: { kind: "none" }, result: async () => ({ found: false, answered: false, text: "" }) };
      },
    };
    return { calls, effects };
  }

  const names = (calls: Array<[string, ...unknown[]]>) => calls.map((c) => c[0]);

  test("a running run gets read → esc → bounded idle wait → replacement prompt → post-prompt read, in that exact order", async () => {
    const { calls, effects } = makeEffects();
    const r = await interruptRun(runningRec(), "new direction", 30_000, effects);
    expect(names(calls)).toEqual(["read", "sendKeys", "waitAgentIdle", "sendPrompt", "read"]);
    expect(calls[1]).toEqual(["sendKeys", "w9:p1", "esc"]);
    expect(calls[2]).toEqual(["waitAgentIdle", "w9:p1", 30_000]);
    expect(calls[3]).toEqual(["sendPrompt", "w9:p1", "new direction"]);
    expect(r).toEqual({ interrupted: true, delivered: true, status: "running" });
  });

  test("a run that finishes between the idle wait and the prompt is reported done, not running", async () => {
    const { calls, effects } = makeEffects({
      // The second read is the post-prompt one: the child finished while
      // the prompt was in flight, so the reported status must be the fresh one.
      onRead: (rec, n) => {
        if (n === 2) rec.status = "done";
      },
    });
    const r = await interruptRun(runningRec(), "new direction", 30_000, effects);
    expect(names(calls)).toEqual(["read", "sendKeys", "waitAgentIdle", "sendPrompt", "read"]);
    expect(r).toEqual({ interrupted: true, delivered: true, status: "done" });
  });

  test("a post-prompt read that throws keeps the pre-prompt status", async () => {
    const { effects } = makeEffects();
    const originalRead = effects.read;
    let n = 0;
    effects.read = async (rec) => {
      n += 1;
      if (n === 2) throw new Error("probe failed");
      return originalRead(rec);
    };
    const r = await interruptRun(runningRec(), "new direction", 30_000, effects);
    expect(r).toEqual({ interrupted: true, delivered: true, status: "running" });
  });

  test("a non-running run is rejected after read, with no key delivery and no prompt", async () => {
    const rec: RunRecord = { ...runningRec(), status: "done" };
    const { calls, effects } = makeEffects();
    const r = await interruptRun(rec, "new direction", 30_000, effects);
    expect(names(calls)).toEqual(["read"]);
    expect(r).toEqual({ interrupted: false, delivered: false, status: "done" });
  });

  test("a running run with no pane is rejected after read, with no key delivery", async () => {
    const rec: RunRecord = { ...runningRec(), paneId: undefined };
    const { calls, effects } = makeEffects();
    const r = await interruptRun(rec, "new direction", 30_000, effects);
    expect(names(calls)).toEqual(["read"]);
    expect(r).toEqual({ interrupted: false, delivered: false, status: "running" });
  });

  test("a failed Escape is an interrupt failure and never prompts", async () => {
    const { calls, effects } = makeEffects({ sendKeysOk: false });
    const r = await interruptRun(runningRec(), "new direction", 30_000, effects);
    expect(names(calls)).toEqual(["read", "sendKeys"]);
    expect(r.interrupted).toBe(false);
    expect(r.delivered).toBe(false);
    expect(r.status).toBe("running");
    expect(r.error).toBeDefined();
  });

  test("an idle timeout never sends the replacement prompt, and reads once more", async () => {
    const { calls, effects } = makeEffects({ idle: false });
    const r = await interruptRun(runningRec(), "new direction", 30_000, effects);
    expect(names(calls)).toEqual(["read", "sendKeys", "waitAgentIdle", "read"]);
    expect(r.interrupted).toBe(true);
    expect(r.delivered).toBe(false);
    expect(r.status).toBe("running");
    expect(r.error).toContain("idle");
  });

  test("a run that transitions to done while waiting reports done, with no prompt", async () => {
    const rec = runningRec();
    const { calls, effects } = makeEffects({
      idle: false,
      onRead: (r, n) => {
        if (n === 2) r.status = "done";
      },
    });
    const out = await interruptRun(rec, "new direction", 30_000, effects);
    expect(names(calls)).toEqual(["read", "sendKeys", "waitAgentIdle", "read"]);
    expect(out).toEqual({ interrupted: true, delivered: false, status: "done" });
  });

  test("a failed replacement prompt reports interrupted but not delivered, with the herdr error", async () => {
    const { calls, effects } = makeEffects({ promptOk: false, promptError: "agent_blocked" });
    const r = await interruptRun(runningRec(), "new direction", 30_000, effects);
    expect(names(calls)).toEqual(["read", "sendKeys", "waitAgentIdle", "sendPrompt"]);
    expect(r).toEqual({ interrupted: true, delivered: false, status: "running", error: "agent_blocked" });
  });

  test("an empty replacement prompt is rejected before any effect", async () => {
    const { calls, effects } = makeEffects();
    const r = await interruptRun(runningRec(), "   ", 30_000, effects);
    expect(calls).toHaveLength(0);
    expect(r.interrupted).toBe(false);
    expect(r.delivered).toBe(false);
    expect(r.status).toBe("running");
    expect(r.error).toBeDefined();
  });

  // Regression pin: the cancel arm owns no transition of its own. It routes
  // through the lifecycle, which persists the cancellation BEFORE closing the
  // pane (the ordering itself is pinned behaviourally in run-lifecycle.test.ts:
  // "cancel: mutation → saveMeta → best-effort close"). There is no
  // dispatchTasks-level seam to inject a record through, so the routing is
  // pinned in source.
  test("the cancel branch routes through lifecycle.cancel and writes nothing itself (regression)", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf-8");
    const start = src.indexOf('case "cancel":');
    expect(start).toBeGreaterThan(-1);
    // `cancel` is the case right before `interrupt`; bound the branch at
    // `interrupt`'s start, so this pin only ever sees the cancel branch.
    const end = src.indexOf('case "interrupt":', start);
    expect(end).toBeGreaterThan(start);
    const branch = src.slice(start, end);
    expect(branch).toContain("lifecycle.cancel(rec)");
    for (const needle of ["closePane(", "rec.status =", "rec.finishedAt =", "saveMeta("]) {
      expect(branch.includes(needle), `cancel branch must not contain ${needle}`).toBe(false);
    }
    // The health-check release fires only on a real transition, so a repeated
    // cancel enqueues nothing.
    expect(branch).toContain('observation.transition?.to === "cancelled"');
  });
});

describe("waitArgs", () => {
  // The `--until <state>` argv is what both state-waits share; a regression
  // here would break the launch recovery path with every test still green.
  test("pins the argv for the idle and working forms", () => {
    expect(waitArgs("w9:p1", "idle", 30_000)).toEqual(["agent", "wait", "w9:p1", "--until", "idle", "--timeout", "30000"]);
    expect(waitArgs("w9:p1", "working", 15_000)).toEqual(["agent", "wait", "w9:p1", "--until", "working", "--timeout", "15000"]);
  });
});

describe("createTerminalResultCache", () => {
  const answer = { found: true, answered: true, text: "<result>ok</result>" };
  const record = (finishedAt: number | undefined) =>
    ({ runId: "sub-0c01", agent: "worker", task: "t", cwd: "/", status: "done", startedAt: 1, finishedAt }) as RunRecord;

  test("serves a result for the same transition", () => {
    const cache = createTerminalResultCache();
    const rec = record(100);
    cache.set(rec, answer);
    expect(cache.get(rec)).toBe(answer);
  });

  test("never serves a result cached before a later transition (a revival stamps a new finishedAt)", () => {
    const cache = createTerminalResultCache();
    const failed = record(100);
    cache.set(failed, { found: true, answered: false, text: "" });
    // The same run, revived failed → done by a late <result>: the lifecycle
    // stamped a fresh finishedAt, so the stale unanswered result is not served.
    const revived = { ...failed, status: "done", finishedAt: 200 } as RunRecord;
    expect(cache.get(revived)).toBeUndefined();
  });

  test("delete retires the entry; size tracks live entries", () => {
    const cache = createTerminalResultCache();
    cache.set(record(100), answer);
    expect(cache.size).toBe(1);
    cache.delete("sub-0c01");
    expect(cache.size).toBe(0);
    expect(cache.get(record(100))).toBeUndefined();
  });
});
