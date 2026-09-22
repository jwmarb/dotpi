/**
 * Tests for the pure parts of subagent-herdr: run ids, the child argv
 *
 * Run from the repo root: `bun test agent/extensions/subagent-herdr/`
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildChildArgv,
  buildChildEnv,
  DONE_TOOL_NAME,
  extractRunResult,
  makeRunId,
  readReports,
  REPORT_TOOL_NAME,
} from "./lib.js";
import { endedCleanly } from "./child-done.js";
import {
  exitPath,
  formatExitSidecar,
  formatReportLine,
  isRunRecord,
  isSessionFileFor,
  metaPath,
  parseReportLine,
  reportsPath,
  runDir,
  runsDir,
  systemPromptPath,
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

  test("appends the done and report tools to a declared tool allowlist", () => {
    const argv = buildChildArgv({ ...base, tools: ["read", "grep"] });
    expect(argv).toContain("--tools");
    const tools = argv[argv.indexOf("--tools") + 1];
    expect(tools).toBe(`read,grep,${DONE_TOOL_NAME},${REPORT_TOOL_NAME}`);
  });

  test("does not duplicate the handshake tools if an agent file already declares them", () => {
    const argv = buildChildArgv({ ...base, tools: [DONE_TOOL_NAME, REPORT_TOOL_NAME] });
    expect(argv[argv.indexOf("--tools") + 1]).toBe(`${DONE_TOOL_NAME},${REPORT_TOOL_NAME}`);
  });

  test("omits --tools for an all-tools agent", () => {
    const argv = buildChildArgv(base);
    expect(argv).not.toContain("--tools");
  });

  test("includes model and system prompt when given, and never a positional task", () => {
    const argv = buildChildArgv({
      ...base,
      model: "openai/gpt-5.6-sol",
      systemPromptPath: "/abs/runs/sub-0001/system-prompt.md",
    });
    expect(argv).toContain("--model");
    expect(argv).toContain("openai/gpt-5.6-sol");
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
});

describe("buildChildEnv", () => {
  test("carries the run identity and the parent pane when known", () => {
    const env = buildChildEnv({ runId: "sub-0008", agent: "worker" }, "w5:p1", "/runs/sub-0008");
    expect(env).toEqual({
      PI_SUBAGENT_RUN_ID: "sub-0008",
      PI_SUBAGENT_AGENT: "worker",
      PI_SUBAGENT_RUN_DIR: "/runs/sub-0008",
      PI_SUBAGENT_PARENT_PANE: "w5:p1",
    });
  });

  test("omits the parent pane when the orchestrator has none", () => {
    const env = buildChildEnv({ runId: "sub-0009", agent: "worker" }, undefined, "/runs/sub-0009");
    expect(env.PI_SUBAGENT_PARENT_PANE).toBeUndefined();
    expect(env.PI_SUBAGENT_RUN_ID).toBe("sub-0009");
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
});
