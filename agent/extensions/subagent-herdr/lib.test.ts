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
  agentNameRejection,
  candidateModels,
  describeLaunchFailure,
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
  formatNotice,
  formatReportLine,
  isRunRecord,
  isSessionFileFor,
  metaPath,
  parseNotice,
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

// ---------------------------------------------------------------------------
// Model fallback
// ---------------------------------------------------------------------------

describe("candidateModels", () => {
  test("tries the agent's model first, then its fallbacks in order", () => {
    expect(
      candidateModels(undefined, {
        model: "openai/gpt-5.6-sol",
        fallbackModels: ["anthropic/claude-opus-5", "qwen/qwen3.8-27b"],
      }),
    ).toEqual(["openai/gpt-5.6-sol", "anthropic/claude-opus-5", "qwen/qwen3.8-27b"]);
  });

  test("an explicitly requested model suppresses the fallbacks", () => {
    // The caller named a model; silently running a different one would be a
    // surprise, not a recovery.
    expect(
      candidateModels("my/pinned-model", {
        model: "openai/gpt-5.6-sol",
        fallbackModels: ["qwen/qwen3.8-27b"],
      }),
    ).toEqual(["my/pinned-model"]);
  });

  test("an agent with no fallbacks yields exactly one attempt", () => {
    expect(candidateModels(undefined, { model: "qwen/qwen3.8-27b" })).toEqual([
      "qwen/qwen3.8-27b",
    ]);
  });

  test("an agent with no model at all still yields one attempt: pi's default", () => {
    // `[undefined]` means "launch without --model", not "launch nothing".
    expect(candidateModels(undefined, {})).toEqual([undefined]);
  });

  test("drops a fallback that repeats the primary", () => {
    // A duplicate would buy a second identical attempt against the same dead
    // provider.
    expect(
      candidateModels(undefined, {
        model: "qwen/qwen3.8-27b",
        fallbackModels: ["qwen/qwen3.8-27b", "openai/gpt-5.6-sol"],
      }),
    ).toEqual(["qwen/qwen3.8-27b", "openai/gpt-5.6-sol"]);
  });

  test("keeps the declared order rather than sorting or deduping globally", () => {
    expect(
      candidateModels(undefined, { model: "a", fallbackModels: ["c", "b", "c"] }),
    ).toEqual(["a", "c", "b"]);
  });
});

describe("describeLaunchFailure", () => {
  test("a single failure reports its own error verbatim", () => {
    expect(
      describeLaunchFailure([{ model: "qwen/q", error: "pane w5:p1 did not become interactive" }]),
    ).toBe("pane w5:p1 did not become interactive");
  });

  test("several failures name every model tried", () => {
    // Otherwise "did not become interactive" sends a reader to the pane when
    // the real cause is that no declared model is reachable.
    const text = describeLaunchFailure([
      { model: "openai/gpt-5.6-sol", error: "exited 1" },
      { model: "qwen/qwen3.8-27b", error: "exited 1" },
    ]);
    expect(text).toContain("All 2 candidate models failed");
    expect(text).toContain("openai/gpt-5.6-sol");
    expect(text).toContain("qwen/qwen3.8-27b");
  });

  test("names the default model when no model was declared", () => {
    const text = describeLaunchFailure([
      { model: undefined, error: "a" },
      { model: "x", error: "b" },
    ]);
    expect(text).toContain("(default model)");
  });

  test("an empty list still produces a usable message", () => {
    expect(describeLaunchFailure([])).toBe("The child could not be launched.");
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
});

