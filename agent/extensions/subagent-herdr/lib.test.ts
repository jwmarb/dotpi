/**
 * Tests for the pure parts of subagent-herdr: run ids, the child argv
 *
 * Run from the repo root: `bun test agent/extensions/subagent-herdr/`
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAgents, parseAgentFile } from "../lib/agents.js";
import { FALLBACK_MODEL_REF } from "../model-fallback/lib.js";
import {
  appendSkillCatalogue,
  buildChildArgv,
  buildChildEnv,
  agentNameRejection,
  childNameRejection,
  candidateModels,
  childFallbackChain,
  describeLaunchFailure,
  DONE_TOOL_NAME,
  extractRunResult,
  herdrAgentName,
  makeRunId,
  formatLineage,
  discoverSkills,
  lineageRejection,
  parseLineage,
  readReports,
  REPORT_TOOL_NAME,
  selectSkills,
  skillEntriesFromPi,
  SKILLS_WILDCARD,
} from "./lib.js";
import { endedCleanly } from "./child-done.js";
import { classifyExecFailure, errorPayload } from "./herdr.js";
import { launchAttempt, type Launcher } from "./index.js";
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

  test("omits the chain var entirely when there is nothing to hop between", () => {
    // An absent var must leave the child byte-identical to pre-feature: a
    // one-model "chain" would register a router that can only ever pick one
    // model, which is a selectable model that silently does nothing.
    const none = buildChildEnv({ runId: "sub-0011", agent: "worker" }, "w5:p1", "/runs");
    expect(none.PI_FALLBACK_CHAIN).toBeUndefined();
    const single = buildChildEnv({ runId: "sub-0012", agent: "worker" }, "w5:p1", "/runs", [
      "worker",
    ], ["qwen/qwen3.8-27b"]);
    expect(single.PI_FALLBACK_CHAIN).toBeUndefined();
    const empty = buildChildEnv({ runId: "sub-0013", agent: "worker" }, "w5:p1", "/runs", [
      "worker",
    ], []);
    expect(empty.PI_FALLBACK_CHAIN).toBeUndefined();
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

  test("an explicitly requested model suppresses the chain", () => {
    // Same rule candidateModels applies: the caller pinned a model, so hopping
    // off it mid-task would be a surprise rather than a recovery.
    expect(
      childFallbackChain("my/pinned", {
        model: "openai/gpt-5.6-sol",
        fallbackModels: ["qwen/qwen3.8-27b"],
      }),
    ).toBeUndefined();
  });

  test("an agent with no fallbacks gets no chain", () => {
    expect(childFallbackChain(undefined, { model: "qwen/qwen3.8-27b" })).toBeUndefined();
    expect(
      childFallbackChain(undefined, { model: "qwen/qwen3.8-27b", fallbackModels: [] }),
    ).toBeUndefined();
  });

  test("an agent with no declared model gets no chain", () => {
    // Without a primary there is no "original model" to come back to, and the
    // chain's first entry would silently become the first fallback.
    expect(childFallbackChain(undefined, { fallbackModels: ["qwen/qwen3.8-27b"] })).toBeUndefined();
  });

  test("drops a fallback that repeats the primary, leaving no chain", () => {
    // The dedupe collapses this to one model, which is the no-chain case.
    expect(
      childFallbackChain(undefined, {
        model: "qwen/qwen3.8-27b",
        fallbackModels: ["qwen/qwen3.8-27b"],
      }),
    ).toBeUndefined();
  });

  test("keeps declared order and drops later duplicates", () => {
    expect(childFallbackChain(undefined, { model: "a", fallbackModels: ["c", "b", "c"] })).toEqual([
      "a",
      "c",
      "b",
    ]);
  });

  test("agrees with candidateModels on which models are in play", () => {
    // The two functions read the same declaration for different jobs; if they
    // disagreed, a child could launch on a model its router cannot route to.
    const agent = {
      model: "openai/gpt-5.6-sol",
      fallbackModels: ["anthropic/claude-opus-5", "qwen/qwen3.8-27b"],
    };
    expect(childFallbackChain(undefined, agent)).toEqual(candidateModels(undefined, agent));
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
      const models = candidateModels(undefined, a);
      const env = buildChildEnv({ runId: "sub-0001", agent: a.name }, "w5:p1", "/runs", [a.name], chain);
      const argv = buildChildArgv({
        childDonePath: "/x/child-done.ts",
        runDir: "/runs",
        runId: "sub-0001",
        model: chain && chain.length > 1 ? FALLBACK_MODEL_REF : models[0],
        tools: a.tools,
      });
      const flagModel = argv[argv.indexOf("--model") + 1];

      if (chain) {
        // A chain means the router runs, and the env must describe it.
        expect(flagModel).toBe(FALLBACK_MODEL_REF);
        expect(env.PI_FALLBACK_CHAIN).toBe(chain.join(","));
        // The primary must be the model the agent declared, or the agent's
        // stated preference is silently not what runs first.
        expect(chain[0]).toBe(a.model);
        expect(chain).toEqual(models as string[]);
      } else {
        // No chain: launch exactly as before this feature existed.
        expect(flagModel).not.toBe(FALLBACK_MODEL_REF);
        expect(env.PI_FALLBACK_CHAIN).toBeUndefined();
      }

      // The handshake and the cycle check must survive either way.
      expect(env.PI_SUBAGENT_RUN_ID).toBe("sub-0001");
      expect(env.PI_SUBAGENT_AGENT).toBe(a.name);
      expect(env.PI_SUBAGENT_LINEAGE).toContain(a.name);

      // A pinned model suppresses the chain for every agent, with no exception.
      expect(childFallbackChain("some/pinned", a)).toBeUndefined();
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
  // for a structured refusal, or the fallback loop would stop on a genuine
  // problem it should have reported verbatim.
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
// launchAttempt — the fatal classification
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

describe("launchAttempt fatal classification", () => {
  // Regression: a name refusal is not model-specific, but it was retried
  // against all three candidate models in well under 100 ms, which read as a
  // dead fleet instead of one actionable error.
  test("a name collision is fatal, so the model loop stops", async () => {
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", true, stubLauncher("agent_name_taken"));
    expect(out.ok).toBe(false);
    expect(out.fatal).toBe(true);
  });

  test("a malformed name is fatal too", async () => {
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", true, stubLauncher("invalid_agent_name"));
    expect(out.fatal).toBe(true);
  });

  // The remedies must stay distinct: `herdr agent list` is a dead end for a
  // malformed name, and collapsing the two codes into one message would repeat
  // the flattening this change exists to undo.
  test("each code gets its own remedy, and names the code", async () => {
    const taken = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", true, stubLauncher("agent_name_taken"));
    const invalid = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", true, stubLauncher("invalid_agent_name"));
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
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", true, l);
    expect(asked).toBe("librarian-sub-9622");
    expect(out.error).toContain("librarian-sub-9622");
  });

  // A name refusal means herdr never ran pi, so the pane holds no scrollback
  // and must not be retained as "evidence" — not even on the last attempt.
  test("a name refusal always closes its pane, even when keepPaneOnFailure", async () => {
    const closed: string[] = [];
    await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", true, stubLauncher("agent_name_taken", closed));
    expect(closed).toEqual(["w9:p1"]);
  });

  // A refusal-closed pane must never be reported back, or a later cleanup path
  // could try to close it a second time.
  test("a fatal name refusal reports no pane id", async () => {
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", true, stubLauncher("agent_name_taken"));
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
  const chain = ["openai/gpt-5.6-sol", "qwen/qwen3.8-27b"];

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
      "openai/gpt-5.6-sol",
      true,
      r.launcher,
      chain,
    );
    expect(out.ok).toBe(true);
    expect(r.env()?.PI_FALLBACK_CHAIN).toBe("openai/gpt-5.6-sol,qwen/qwen3.8-27b");
    const argv = r.argv()!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("fallback/auto");
  });

  test("without a chain the model passes through unchanged", async () => {
    // The no-regression case: a pinned or fallback-less agent must launch
    // exactly as it did before this feature.
    const r = recordingLauncher();
    await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "openai/gpt-5.6-sol", true, r.launcher);
    expect(r.env()?.PI_FALLBACK_CHAIN).toBeUndefined();
    const argv = r.argv()!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("openai/gpt-5.6-sol");
  });

  test("a one-model chain is treated as no chain", async () => {
    const r = recordingLauncher();
    await launchAttempt(
      stubAgent,
      stubRec,
      "/tmp",
      "/tmp/p.md",
      "openai/gpt-5.6-sol",
      true,
      r.launcher,
      ["openai/gpt-5.6-sol"],
    );
    expect(r.env()?.PI_FALLBACK_CHAIN).toBeUndefined();
    const argv = r.argv()!;
    expect(argv[argv.indexOf("--model") + 1]).toBe("openai/gpt-5.6-sol");
  });

  test("the chain never displaces the run identity or lineage env", async () => {
    // Regression guard: the chain is an addition, and the vars the handshake
    // and the cycle check depend on must survive it.
    const r = recordingLauncher();
    await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", true, r.launcher, chain);
    const env = r.env()!;
    expect(env.PI_SUBAGENT_RUN_ID).toBe("sub-9622");
    expect(env.PI_SUBAGENT_AGENT).toBe("librarian");
    expect(env.PI_SUBAGENT_LINEAGE).toContain("librarian");
  });

  // The contrast that matters: a real launch failure IS model-specific, so it
  // must stay non-fatal and let the next candidate model be tried.
  test("a genuine launch failure is not fatal and keeps its pane for evidence", async () => {
    const closed: string[] = [];
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", true, stubLauncher("timeout", closed));
    expect(out.fatal).toBeUndefined();
    expect(out.paneId).toBe("w9:p1");
    expect(closed).toEqual([]);
    expect(out.error).toContain("did not become interactive");
    expect(out.error).toContain("timeout");
  });

  test("a non-last genuine failure reclaims its pane", async () => {
    const closed: string[] = [];
    await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", false, stubLauncher("timeout", closed));
    expect(closed).toEqual(["w9:p1"]);
  });

  test("no pane at all is fatal: another model cannot help", async () => {
    const l = stubLauncher(null);
    l.createChildPane = async () => null;
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", true, l);
    expect(out.fatal).toBe(true);
  });

  test("a successful start reports the pane and tab it got", async () => {
    const out = await launchAttempt(stubAgent, stubRec, "/tmp", "/tmp/p.md", "m", true, stubLauncher(null));
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
    expect(lineageRejection("librarian", undefined, ["worker"])).toBeUndefined();
    // librarian -> spiker (confirm external code really behaves as documented)
    expect(lineageRejection("spiker", undefined, ["worker", "librarian"])).toBeUndefined();
    // librarian -> summarizer (condense a huge page)
    expect(lineageRejection("summarizer", ["librarian"], ["worker", "librarian"])).toBeUndefined();
  });
});

describe("lineageRejection: callable_by", () => {
  test("an agent with no callable_by is public", () => {
    expect(lineageRejection("worker", undefined, ["oracle"])).toBeUndefined();
    expect(lineageRejection("worker", [], ["oracle"])).toBeUndefined();
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
    expect(lineageRejection("librarian", undefined, asChildSees)).toBeDefined();
    expect(lineageRejection("spiker", undefined, asChildSees)).toBeUndefined();
  });
});

describe("parseAgentFile callable_by key", () => {
  test("reads both spellings; absent means public", () => {
    const mk = (fm: string) => parseAgentFile(`---\nname: a\n${fm}\n---\nbody`, "a.md");
    expect(mk("callable_by: librarian")?.callableBy).toEqual(["librarian"]);
    expect(mk("callable_by: librarian, oracle")?.callableBy).toEqual(["librarian", "oracle"]);
    expect(mk("callable_by:\n  - librarian")?.callableBy).toEqual(["librarian"]);
    // Absent must stay undefined — that is what "public" means to the guard.
    expect(mk("model: x")?.callableBy).toBeUndefined();
  });

  test("a camelCase key does not match, as the frontmatter contract warns", () => {
    const a = parseAgentFile(`---\nname: a\ncallableBy: librarian\n---\nbody`, "a.md");
    expect(a?.callableBy).toBeUndefined();
  });
});
