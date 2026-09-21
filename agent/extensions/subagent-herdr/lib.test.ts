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
    const env = buildChildEnv({ runId: "sub-0008", agent: "worker", runDir: "/runs/sub-0008" }, "w5:p1");
    expect(env).toEqual({
      PI_SUBAGENT_RUN_ID: "sub-0008",
      PI_SUBAGENT_AGENT: "worker",
      PI_SUBAGENT_RUN_DIR: "/runs/sub-0008",
      PI_SUBAGENT_PARENT_PANE: "w5:p1",
    });
  });

  test("omits the parent pane when the orchestrator has none", () => {
    const env = buildChildEnv({ runId: "sub-0009", agent: "worker", runDir: "/runs/sub-0009" }, undefined);
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
