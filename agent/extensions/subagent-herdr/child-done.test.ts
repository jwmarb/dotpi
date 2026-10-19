/**
 * Tests for the child-done handshake factory (`createChildDoneHandshake`) and
 * the child-side stall watchdog (`createChildWatchdog`).
 *
 * Uses recording effects stubs to verify the exact ordering of side effects:
 * sidecar write → notice → pane close → shutdown, the deduplication
 * invariant that the sidecar is written at most once, the answer gate and
 * one-shot nudge, the truncation continuation, and the watchdog's one-shot
 * stall notices — streaming and
 * tool phases, nested/parallel tool-call isolation, and the tick wiring.
 */
import { describe, expect, mock, test } from "bun:test";

import childDone, {
  type ChildDoneEffects,
  type ChildWatchdogEffects,
  type MessageLike,
  createChildDoneHandshake,
  createChildWatchdog,
  continuationMessage,
  MAX_CONTINUATIONS,
  STREAMING_STALL_MS,
  TOOL_STALL_MS,
  WATCHDOG_TICK_MS,
} from "./child-done.js";
import { formatNotice } from "./rundir.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Recording stub
// ---------------------------------------------------------------------------

interface EffectCall {
  name: string;
  args: unknown[];
}

function makeRecordingEffects(overrides: Partial<ChildDoneEffects> = {}) {
  const calls: EffectCall[] = [];

  const effects: ChildDoneEffects = {
    writeExitSidecar(path, content) {
      calls.push({ name: "writeExitSidecar", args: [path, content] });
      return overrides.writeExitSidecar?.(path, content) ?? true;
    },
    appendReport(path, line) {
      calls.push({ name: "appendReport", args: [path, line] });
      overrides.appendReport?.(path, line);
    },
    sendNotice(parentPane, notice) {
      calls.push({ name: "sendNotice", args: [parentPane, notice] });
      overrides.sendNotice?.(parentPane, notice);
    },
    closePane(paneId) {
      calls.push({ name: "closePane", args: [paneId] });
      overrides.closePane?.(paneId);
    },
    sendAnswerNudge(message) {
      calls.push({ name: "sendAnswerNudge", args: [message] });
      overrides.sendAnswerNudge?.(message);
    },
  };

  return { effects, calls };
}

const BASE_ENV: NodeJS.ProcessEnv = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "pane-123",
  PI_SUBAGENT_PARENT_PANE: "parent-pane-456",
  PI_SUBAGENT_RUN_ID: "run-789",
  PI_SUBAGENT_AGENT: "worker",
};

// ---------------------------------------------------------------------------
// createChildDoneHandshake — ordering and deduplication
// ---------------------------------------------------------------------------

describe("createChildDoneHandshake", () => {
  test("1. sidecar write precedes notice, pane close, and shutdown", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    const outcome = handshake.complete("/tmp/session.jsonl", () => {
      shutdownCalled = true;
    });

    expect(outcome.kind).toBe("completed");
    expect(shutdownCalled).toBe(true);

    const names = calls.map((c) => c.name);
    expect(names).toEqual(["writeExitSidecar", "sendNotice", "closePane"]);
  });

  test("2. write failure performs none of the latter three", () => {
    const { effects, calls } = makeRecordingEffects({
      writeExitSidecar: () => false,
    });
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    const outcome = handshake.complete("/tmp/session.jsonl", () => {
      shutdownCalled = true;
    });

    expect(outcome.kind).toBe("write-failed");
    expect(shutdownCalled).toBe(false);

    const names = calls.map((c) => c.name);
    expect(names).toEqual(["writeExitSidecar"]);
  });

  test("3. explicit completion followed by agent_end does not write or notify twice", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    handshake.complete("/tmp/session.jsonl", () => {});

    // agent_end after explicit completion: signalled is already true
    handshake.onAgentEnd(
      [{ role: "assistant", stopReason: "stop" }],
      "/tmp/session.jsonl",
      () => {},
    );

    const writes = calls.filter((c) => c.name === "writeExitSidecar");
    const notices = calls.filter((c) => c.name === "sendNotice");
    expect(writes.length).toBe(1);
    expect(notices.length).toBe(1);
  });

  test("4. aborted agent_end produces no sidecar", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    handshake.onAgentEnd(
      [{ role: "assistant", stopReason: "aborted" }],
      "/tmp/session.jsonl",
      () => {
        shutdownCalled = true;
      },
    );

    expect(calls.length).toBe(0);
    expect(shutdownCalled).toBe(false);
  });

  test("5. a report is appended before delivery", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    const outcome = handshake.report("status update", "/tmp/run-dir");
    expect(outcome.kind).toBe("delivered");

    const names = calls.map((c) => c.name);
    expect(names).toEqual(["appendReport", "sendNotice"]);
  });

  test("6. missing parent-pane information still records the report", () => {
    const { effects, calls } = makeRecordingEffects();
    const env = { ...BASE_ENV, PI_SUBAGENT_PARENT_PANE: undefined };
    const handshake = createChildDoneHandshake(effects, env);

    const outcome = handshake.report("still working", "/tmp/run-dir");
    expect(outcome.kind).toBe("recorded-no-parent");

    const names = calls.map((c) => c.name);
    expect(names).toEqual(["appendReport"]);
  });

  test("7. pane close requires both HERDR_ENV === '1' and a pane id", () => {
    // No HERDR_ENV
    const { effects: e1, calls: c1 } = makeRecordingEffects();
    const h1 = createChildDoneHandshake(e1, { ...BASE_ENV, HERDR_ENV: undefined });
    h1.complete("/tmp/s.jsonl", () => {});
    expect(c1.filter((c) => c.name === "closePane").length).toBe(0);

    // No pane id
    const { effects: e2, calls: c2 } = makeRecordingEffects();
    const h2 = createChildDoneHandshake(e2, { ...BASE_ENV, HERDR_PANE_ID: undefined });
    h2.complete("/tmp/s.jsonl", () => {});
    expect(c2.filter((c) => c.name === "closePane").length).toBe(0);

    // Both present
    const { effects: e3, calls: c3 } = makeRecordingEffects();
    const h3 = createChildDoneHandshake(e3, { ...BASE_ENV });
    h3.complete("/tmp/s.jsonl", () => {});
    expect(c3.filter((c) => c.name === "closePane").length).toBe(1);
  });

  test("8. shutdown occurs only after durable completion", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    handshake.complete("/tmp/session.jsonl", () => {
      shutdownCalled = true;
    });

    // shutdown must be called after writeExitSidecar
    const writeIdx = calls.findIndex((c) => c.name === "writeExitSidecar");
    expect(writeIdx).toBe(0);
    expect(shutdownCalled).toBe(true);
  });

  test("no-session-file outcome when sessionFile is undefined", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    const outcome = handshake.complete(undefined, () => {});
    expect(outcome.kind).toBe("no-session-file");
    expect(calls.length).toBe(0);
  });

  test("no-run-dir outcome when runDir is undefined", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    const outcome = handshake.report("msg", undefined);
    expect(outcome.kind).toBe("no-run-dir");
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The completion gate: a run may not finish without a visible answer
// ---------------------------------------------------------------------------

/** The prompt every agent in `agent/agents/` is launched with. */
const RESULT_PROMPT = "You map codebases.\n\nOnly what is inside `<result>` reaches the orchestrator.";
/** A skill agent (`skills/*​/agents/*.md`) with no `<result>` contract. */
const PLAIN_PROMPT = "Record one journal observation and reply with its id.";

/** An assistant message carrying only hidden reasoning, as sub-835d produced. */
const thinkingOnly = (thinking: string) => ({
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "thinking", thinking }],
});

const withText = (text: string, stopReason = "stop") => ({
  role: "assistant",
  stopReason,
  content: [{ type: "text", text }],
});

describe("completion gate", () => {
  test("refuses a done call whose run produced only filler, and performs no side effects", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    const outcome = handshake.complete("/tmp/s.jsonl", () => {
      shutdownCalled = true;
    }, {
      messages: [withText("I have all the evidence I need. Compiling the report now.", "toolUse")],
      systemPrompt: RESULT_PROMPT,
    });

    expect(outcome.kind).toBe("no-answer");
    expect(shutdownCalled).toBe(false);
    // Critically: no sidecar. This supplies no sidecar completion signal — filler
    // remains non-qualifying, so the parent will not treat this run as finished.
    // (The parent may still finish it on its own if a qualifying transcript
    // result exists; that is the parent's completion predicate, not this gate's.)
    expect(calls.length).toBe(0);
  });

  test("refuses twice, then accepts, so a stubborn model cannot loop forever", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    const ctx = { messages: [withText("Compiling.", "toolUse")], systemPrompt: RESULT_PROMPT };

    expect(handshake.complete("/tmp/s.jsonl", () => {}, ctx).kind).toBe("no-answer");
    expect(handshake.complete("/tmp/s.jsonl", () => {}, ctx).kind).toBe("no-answer");
    expect(calls.length).toBe(0);

    // Third attempt: let it through. A child that cannot finish is worse than
    // one that finishes badly — the parent still has the pane and the transcript.
    let shutdownCalled = false;
    const third = handshake.complete("/tmp/s.jsonl", () => {
      shutdownCalled = true;
    }, ctx);
    expect(third.kind).toBe("completed");
    expect(shutdownCalled).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["writeExitSidecar", "sendNotice", "closePane"]);
  });

  test("the refusal names what to do and does not count a qualifying attempt", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    handshake.complete("/tmp/s.jsonl", () => {}, {
      messages: [withText("Compiling.", "toolUse")],
      systemPrompt: RESULT_PROMPT,
    });
    // The model complies: a real answer now completes on the very next call.
    const outcome = handshake.complete("/tmp/s.jsonl", () => {}, {
      messages: [withText("<result>\n## Map\n- a.ts:1\n</result>", "toolUse")],
      systemPrompt: RESULT_PROMPT,
    });

    expect(outcome.kind).toBe("completed");
    expect(calls.map((c) => c.name)).toEqual(["writeExitSidecar", "sendNotice", "closePane"]);
  });

  test("a <result> written only in thinking does not satisfy the gate", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    const outcome = handshake.complete("/tmp/s.jsonl", () => {}, {
      messages: [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: "<result>\nthe whole report\n</result>" },
            { type: "text", text: "All questions are answered. Compiling." },
          ],
        },
      ],
      systemPrompt: RESULT_PROMPT,
    });

    expect(outcome.kind).toBe("no-answer");
    expect(calls.length).toBe(0);
  });

  test("an agent with no <result> contract completes on plain visible text", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    const outcome = handshake.complete("/tmp/s.jsonl", () => {}, {
      messages: [withText("Recorded obs-0007.", "toolUse")],
      systemPrompt: PLAIN_PROMPT,
    });

    expect(outcome.kind).toBe("completed");
    expect(calls.map((c) => c.name)).toEqual(["writeExitSidecar", "sendNotice", "closePane"]);
  });

  test("an answer in an earlier message satisfies the gate", () => {
    // The model answered properly, then took another turn to tidy up. That is
    // the handshake honoured, just not in the final message.
    const { effects } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    const outcome = handshake.complete("/tmp/s.jsonl", () => {}, {
      messages: [
        withText("<result>\nthe report\n</result>"),
        { role: "toolResult", content: [{ type: "text", text: "ok" }] },
        withText("Everything is confirmed.", "toolUse"),
      ],
      systemPrompt: RESULT_PROMPT,
    });

    expect(outcome.kind).toBe("completed");
  });

  test("no gate context at all completes, so an unknown caller is never trapped", () => {
    const { effects } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    expect(handshake.complete("/tmp/s.jsonl", () => {}).kind).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// agent_end: one nudge before a silent run is allowed to finish
// ---------------------------------------------------------------------------

describe("agent_end answer nudge", () => {
  test("a clean end with no visible answer is nudged once, not completed (sub-9bad)", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    handshake.onAgentEnd(
      [thinkingOnly("Deletion test: delete → raw execFile resurfaces…")],
      "/tmp/s.jsonl",
      () => {
        shutdownCalled = true;
      },
      RESULT_PROMPT,
    );

    expect(calls.map((c) => c.name)).toEqual(["sendAnswerNudge"]);
    expect(shutdownCalled).toBe(false);
    expect(String(calls[0].args[0])).toContain("<result>");
  });

  test("the nudge is sent at most once; a still-silent second end completes", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    const messages = [thinkingOnly("still only reasoning")];
    handshake.onAgentEnd(messages, "/tmp/s.jsonl", () => {}, RESULT_PROMPT);
    handshake.onAgentEnd(messages, "/tmp/s.jsonl", () => {
      shutdownCalled = true;
    }, RESULT_PROMPT);

    expect(calls.filter((c) => c.name === "sendAnswerNudge").length).toBe(1);
    // Bounded: the run finishes rather than wedging the session forever.
    expect(calls.map((c) => c.name)).toEqual([
      "sendAnswerNudge",
      "writeExitSidecar",
      "sendNotice",
      "closePane",
    ]);
    expect(shutdownCalled).toBe(true);
  });

  test("a clean end that already answered completes immediately, with no nudge", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    handshake.onAgentEnd(
      [withText("<result>\nthe report\n</result>")],
      "/tmp/s.jsonl",
      () => {},
      RESULT_PROMPT,
    );

    expect(calls.map((c) => c.name)).toEqual(["writeExitSidecar", "sendNotice", "closePane"]);
  });

  test("an aborted end is never nudged: Esc is not a forgotten answer", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    handshake.onAgentEnd(
      [{ role: "assistant", stopReason: "aborted", content: [] }],
      "/tmp/s.jsonl",
      () => {},
      RESULT_PROMPT,
    );

    expect(calls.length).toBe(0);
  });

  test("explicit completion suppresses any later nudge", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    handshake.complete("/tmp/s.jsonl", () => {}, {
      messages: [withText("<result>done</result>", "toolUse")],
      systemPrompt: RESULT_PROMPT,
    });
    handshake.onAgentEnd([thinkingOnly("tidying up")], "/tmp/s.jsonl", () => {}, RESULT_PROMPT);

    expect(calls.filter((c) => c.name === "sendAnswerNudge").length).toBe(0);
    expect(calls.filter((c) => c.name === "writeExitSidecar").length).toBe(1);
  });

  test("a plain-contract agent that ended with prose is not nudged", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    handshake.onAgentEnd([withText("Recorded obs-0007.")], "/tmp/s.jsonl", () => {}, PLAIN_PROMPT);

    expect(calls.map((c) => c.name)).toEqual(["writeExitSidecar", "sendNotice", "closePane"]);
  });

  test("the done notice the parent wakes on is unchanged by the gate", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    handshake.complete("/tmp/s.jsonl", () => {}, {
      messages: [withText("<result>r</result>", "toolUse")],
      systemPrompt: RESULT_PROMPT,
    });

    const notice = calls.find((c) => c.name === "sendNotice");
    expect(notice?.args[1]).toBe(formatNotice("run-789", "worker", "done", ""));
  });
});

// ---------------------------------------------------------------------------
// agent_end: a response truncated by the output token limit is continued
// ---------------------------------------------------------------------------

/** An assistant message cut off by the output token limit. */
const truncatedText = (text: string) => withText(text, "length");

describe("agent_end truncation continuation", () => {
  test("a truncated end with no answer is continued, not completed", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    handshake.onAgentEnd(
      [truncatedText("## Map\n- a.ts:1 — the first finding, cut off mid-sent")],
      "/tmp/s.jsonl",
      () => {
        shutdownCalled = true;
      },
      RESULT_PROMPT,
    );

    expect(calls.map((c) => c.name)).toEqual(["sendAnswerNudge"]);
    expect(shutdownCalled).toBe(false);
    const message = String(calls[0].args[0]);
    expect(message).toContain("truncated before completion");
    expect(message).toContain("token limit");
    // The continuation must point at the answer contract, not repeat the
    // forgotten-answer nudge.
    expect(message).toContain("<result>");
  });

  test("the continuation is bounded: after MAX_CONTINUATIONS the run completes", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    const truncated = [truncatedText("still writing the report…")];
    for (let i = 0; i < MAX_CONTINUATIONS; i++) {
      handshake.onAgentEnd(truncated, "/tmp/s.jsonl", () => {}, RESULT_PROMPT);
    }
    expect(calls.filter((c) => c.name === "sendAnswerNudge")).toHaveLength(MAX_CONTINUATIONS);
    expect(calls.filter((c) => c.name === "writeExitSidecar")).toHaveLength(0);
    expect(shutdownCalled).toBe(false);

    // One more truncated end: the bound is spent, so the run finishes with
    // whatever the transcript carries — the parent reads it as salvage.
    handshake.onAgentEnd(truncated, "/tmp/s.jsonl", () => {
      shutdownCalled = true;
    }, RESULT_PROMPT);
    expect(calls.map((c) => c.name)).toEqual([
      "sendAnswerNudge",
      "sendAnswerNudge",
      "sendAnswerNudge",
      "writeExitSidecar",
      "sendNotice",
      "closePane",
    ]);
    expect(shutdownCalled).toBe(true);
  });

  test("a truncated end that already carries a qualifying answer completes without continuing", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    // The report finished in an earlier turn; the model then truncated while
    // adding commentary. The answer exists, so the run finishes.
    handshake.onAgentEnd(
      [
        withText("<result>\nthe report\n</result>"),
        truncatedText("Some closing commentary that ran out of room."),
      ],
      "/tmp/s.jsonl",
      () => {},
      RESULT_PROMPT,
    );

    expect(calls.map((c) => c.name)).toEqual(["writeExitSidecar", "sendNotice", "closePane"]);
  });

  test("a continuation turn that ends cleanly with the answer completes the run", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    // First turn: truncated mid-report, no complete <result>.
    handshake.onAgentEnd(
      [truncatedText("## Map\n- a.ts:1 — cut off inside the report")],
      "/tmp/s.jsonl",
      () => {},
      RESULT_PROMPT,
    );
    expect(calls.map((c) => c.name)).toEqual(["sendAnswerNudge"]);

    // Second turn (the continuation): the model finishes the report.
    handshake.onAgentEnd(
      [withText("<result>\n## Map\n- a.ts:1 — the complete report\n</result>")],
      "/tmp/s.jsonl",
      () => {
        shutdownCalled = true;
      },
      RESULT_PROMPT,
    );

    expect(calls.map((c) => c.name)).toEqual([
      "sendAnswerNudge",
      "writeExitSidecar",
      "sendNotice",
      "closePane",
    ]);
    expect(shutdownCalled).toBe(true);
  });

  test("a truncated end for a plain-contract agent completes: visible text already qualifies", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    handshake.onAgentEnd(
      [truncatedText("part of the observation…")],
      "/tmp/s.jsonl",
      () => {},
      PLAIN_PROMPT,
    );

    // Plain contract: any visible text qualifies as an answer, so the run
    // finishes now rather than spending a continuation on it.
    expect(calls.map((c) => c.name)).toEqual(["writeExitSidecar", "sendNotice", "closePane"]);
  });

  test("a truncated end with no visible text at all is still continued", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    // The whole output budget went to thinking: nothing visible, no answer.
    handshake.onAgentEnd(
      [{ role: "assistant", stopReason: "length", content: [{ type: "thinking", thinking: "…" }] }],
      "/tmp/s.jsonl",
      () => {},
      RESULT_PROMPT,
    );

    expect(calls.map((c) => c.name)).toEqual(["sendAnswerNudge"]);
  });

  test("a truncated end after explicit completion performs nothing", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });

    handshake.complete("/tmp/s.jsonl", () => {}, {
      messages: [withText("<result>done</result>", "toolUse")],
      systemPrompt: RESULT_PROMPT,
    });
    handshake.onAgentEnd([truncatedText("more")], "/tmp/s.jsonl", () => {}, RESULT_PROMPT);

    expect(calls.filter((c) => c.name === "writeExitSidecar").length).toBe(1);
    expect(calls.filter((c) => c.name === "sendAnswerNudge").length).toBe(0);
  });

  test("the continuation prompt names the contract for a result agent and not for a plain one", () => {
    expect(continuationMessage(true)).toContain("<result>");
    expect(continuationMessage(true)).toContain("subagent_done");
    expect(continuationMessage(false)).not.toContain("<result>");
    expect(continuationMessage(false)).toContain("subagent_done");
  });
  test("a bound-spent finish whose sidecar write fails performs no terminal effects, and the next end retries", () => {
    const { effects, calls } = makeRecordingEffects({ writeExitSidecar: () => false });
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    const truncated = [truncatedText("still writing the report…")];
    for (let i = 0; i < MAX_CONTINUATIONS; i++) {
      handshake.onAgentEnd(truncated, "/tmp/s.jsonl", () => {}, RESULT_PROMPT);
    }
    // Bound spent: the run tries to finish, but the write fails.
    handshake.onAgentEnd(truncated, "/tmp/s.jsonl", () => {
      shutdownCalled = true;
    }, RESULT_PROMPT);

    expect(calls.filter((c) => c.name === "sendAnswerNudge")).toHaveLength(MAX_CONTINUATIONS);
    expect(calls.filter((c) => c.name === "writeExitSidecar")).toHaveLength(1);
    // signalled stayed false: no terminal effects at all.
    expect(calls.filter((c) => c.name === "sendNotice")).toHaveLength(0);
    expect(calls.filter((c) => c.name === "closePane")).toHaveLength(0);
    expect(shutdownCalled).toBe(false);

    // The next truncated end retries the write through the same shared path.
    handshake.onAgentEnd(truncated, "/tmp/s.jsonl", () => {}, RESULT_PROMPT);
    expect(calls.filter((c) => c.name === "writeExitSidecar")).toHaveLength(2);
    expect(calls.filter((c) => c.name === "sendNotice")).toHaveLength(0);
  });

  test("continuations and the one-shot answer nudge are independent counters across ends", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    // End 1: truncated, no answer → continuation nudge.
    handshake.onAgentEnd(
      [truncatedText("## Map\n- a.ts:1 — cut off")],
      "/tmp/s.jsonl",
      () => {},
      RESULT_PROMPT,
    );
    // End 2: clean, still no visible answer → the one-shot answer nudge.
    handshake.onAgentEnd(
      [thinkingOnly("more reasoning, no visible text")],
      "/tmp/s.jsonl",
      () => {},
      RESULT_PROMPT,
    );
    // End 3: clean, with the answer → the run finishes.
    handshake.onAgentEnd(
      [withText("<result>\n## Map\n- a.ts:1 — the complete report\n</result>")],
      "/tmp/s.jsonl",
      () => {
        shutdownCalled = true;
      },
      RESULT_PROMPT,
    );

    const nudges = calls.filter((c) => c.name === "sendAnswerNudge");
    expect(nudges).toHaveLength(2);
    expect(String(nudges[0].args[0])).toContain("truncated before completion");
    expect(String(nudges[1].args[0])).toContain("stopped without leaving an answer");
    expect(calls.map((c) => c.name)).toEqual([
      "sendAnswerNudge",
      "sendAnswerNudge",
      "writeExitSidecar",
      "sendNotice",
      "closePane",
    ]);
    expect(shutdownCalled).toBe(true);
  });

  test("a bound-spent run still gets the one-shot answer nudge on a later clean end without an answer", () => {
    const { effects, calls } = makeRecordingEffects();
    const handshake = createChildDoneHandshake(effects, { ...BASE_ENV });
    let shutdownCalled = false;

    const truncated = [truncatedText("still writing the report…")];
    for (let i = 0; i < MAX_CONTINUATIONS; i++) {
      handshake.onAgentEnd(truncated, "/tmp/s.jsonl", () => {}, RESULT_PROMPT);
    }
    // The bound is spent, but the model recovered with a clean turn that has
    // no visible answer. The one-shot answer nudge is independent of the
    // spent continuation bound.
    handshake.onAgentEnd(
      [thinkingOnly("recovered, but only reasoning")],
      "/tmp/s.jsonl",
      () => {},
      RESULT_PROMPT,
    );
    expect(calls.map((c) => c.name)).toEqual([
      "sendAnswerNudge",
      "sendAnswerNudge",
      "sendAnswerNudge",
      "sendAnswerNudge",
    ]);

    // The next clean end completes as before.
    handshake.onAgentEnd(
      [thinkingOnly("still only reasoning")],
      "/tmp/s.jsonl",
      () => {
        shutdownCalled = true;
      },
      RESULT_PROMPT,
    );
    expect(calls.map((c) => c.name)).toEqual([
      "sendAnswerNudge",
      "sendAnswerNudge",
      "sendAnswerNudge",
      "sendAnswerNudge",
      "writeExitSidecar",
      "sendNotice",
      "closePane",
    ]);
    expect(shutdownCalled).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// createChildWatchdog: one-shot stall detection
// ---------------------------------------------------------------------------

/** An assistant message carrying a given amount of visible text. */
function assistantText(text: string): MessageLike {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("createChildWatchdog", () => {
  const ENV: NodeJS.ProcessEnv = {
    PI_SUBAGENT_RUN_ID: "sub-a3f1",
    PI_SUBAGENT_AGENT: "worker",
    PI_SUBAGENT_PARENT_PANE: "parent-pane-456",
  };

  /** A recording watchdog with a driven clock; `set` moves the clock to an absolute time. */
  function harness(env: NodeJS.ProcessEnv = ENV) {
    let time = 0;
    const notices: string[] = [];
    const effects: ChildWatchdogEffects = {
      now: () => time,
      sendNotice(_parentPane: string, notice: string) {
        notices.push(notice);
      },
    };
    return {
      notices,
      set: (t: number) => {
        time = t;
      },
      watchdog: createChildWatchdog(effects, env),
    };
  }

  test("streaming emits nothing below the threshold", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart(assistantText(""));
    set(STREAMING_STALL_MS - 1); // 5 minutes minus 1 ms — the real boundary, one tick under
    watchdog.check();
    expect(notices).toHaveLength(0);
  });

  test("streaming emits exactly one notice at the threshold, with elapsedMs and charsGenerated", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart(assistantText(""));
    watchdog.onMessageUpdate(assistantText("hello world")); // 11 visible chars
    set(STREAMING_STALL_MS);
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(
      formatNotice("sub-a3f1", "worker", "stalled", "phase=streaming elapsedMs=300000 charsGenerated=11"),
    );
  });

  test("a start with content seeds the char count when no update ever arrives", () => {
    const { watchdog, set, notices } = harness();
    // The start snapshot alone must carry the chars: without the
    // `latestMessage = message` assignment in onMessageStart the notice
    // would read charsGenerated=0.
    watchdog.onMessageStart({ role: "assistant", content: [{ type: "text", text: "hello world" }] });
    set(STREAMING_STALL_MS);
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("charsGenerated=11");
  });
  test("a continued stream does not re-warn after the one-shot notice", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart(assistantText(""));
    set(STREAMING_STALL_MS);
    watchdog.check();
    set(STREAMING_STALL_MS + 10 * 60_000);
    watchdog.check();
    set(2 * STREAMING_STALL_MS);
    watchdog.check();
    expect(notices).toHaveLength(1);
  });

  test("charsGenerated is computed lazily at check time, from the latest snapshot", () => {
    const { watchdog, set, notices } = harness();
    const body = "a longer visible body";
    const msg = assistantText("abc");
    watchdog.onMessageStart(assistantText(""));
    watchdog.onMessageUpdate(msg);
    // pi reuses the content array and emits a fresh shallow copy per update,
    // so a count frozen at update time would read "abc". Mutate the message
    // after the update: the notice must carry the mutated length, proving the
    // count is derived from the stored reference at check time.
    msg.content = [{ type: "text", text: body }];
    set(STREAMING_STALL_MS);
    watchdog.check();
    expect(notices[0]).toBe(
      formatNotice(
        "sub-a3f1",
        "worker",
        "stalled",
        `phase=streaming elapsedMs=${STREAMING_STALL_MS} charsGenerated=${body.length}`,
      ),
    );
  });

  test("a new assistant message_start resets the one-shot allowance", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart(assistantText(""));
    set(STREAMING_STALL_MS);
    watchdog.check();
    // A brand-new assistant stream starts over: fresh phase, fresh allowance.
    set(STREAMING_STALL_MS + 10_000);
    watchdog.onMessageStart(assistantText(""));
    set(2 * STREAMING_STALL_MS + 10_000);
    watchdog.check();
    expect(notices).toHaveLength(2);
  });

  test("message_end prevents later notices", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart(assistantText("hello"));
    set(60_000);
    watchdog.onMessageEnd(assistantText("hello"));
    set(STREAMING_STALL_MS + 10 * 60_000);
    watchdog.check();
    expect(notices).toHaveLength(0);
  });

  test("a cleared phase does not count a stale start snapshot", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart(assistantText("hello world")); // 11 chars
    set(60_000);
    watchdog.onMessageEnd(assistantText("hello world")); // clears phase + snapshot
    set(120_000);
    watchdog.onMessageStart(assistantText("")); // fresh start, no content
    set(120_000 + STREAMING_STALL_MS);
    watchdog.check();
    expect(notices).toHaveLength(1);
    // Without the `latestMessage = null` clear in onMessageEnd the stale
    // 11-char snapshot would still be counted.
    expect(notices[0]).toContain("charsGenerated=0");
  });

  test("tool execution emits nothing below the threshold, then one notice with the tool name", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onToolExecutionStart("call-1", "bash");
    set(9 * 60_000);
    watchdog.check();
    expect(notices).toHaveLength(0);
    set(TOOL_STALL_MS);
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(
      formatNotice("sub-a3f1", "worker", "stalled", "phase=tool elapsedMs=600000 tool=bash"),
    );
  });

  test("a nested tool start (parentToolCallId set) does not open its own entry and refreshes the parent", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onToolExecutionStart("call-outer", "bash");
    set(5 * 60_000);
    // A codemode sub-call starts: it must NOT get an entry of its own, so the
    // outer bash remains the only warnable entry. Its start refreshes the
    // outer clock, because nested activity is outer activity.
    watchdog.onToolExecutionStart("call-inner", "bash", "call-outer");
    set(10 * 60_000); // 5 min after the refresh: not stalled
    watchdog.check();
    expect(notices).toHaveLength(0);
    set(15 * 60_000); // 10 min after the refresh: the outer stalls
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("tool=bash");
    expect(notices[0]).toContain("elapsedMs=900000");
    // Extend to 20 min and tick again: exactly ONE notice total — the nested
    // entry (had one been opened) must never become warnable, and the outer
    // is one-shot.
    set(20 * 60_000);
    watchdog.check();
    expect(notices).toHaveLength(1);
  });

  test("tool_execution_end clears the matching entry; a later tool starts a separately warnable entry", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onToolExecutionStart("call-1", "read");
    set(TOOL_STALL_MS);
    watchdog.check();
    expect(notices).toHaveLength(1);
    // The first tool ends; its entry is deleted.
    watchdog.onToolExecutionEnd("call-1");
    set(TOOL_STALL_MS + 60_000);
    watchdog.check(); // idle now: nothing
    expect(notices).toHaveLength(1);
    // A new tool starts its own, independently warnable entry.
    watchdog.onToolExecutionStart("call-2", "grep");
    set(2 * TOOL_STALL_MS + 60_000);
    watchdog.check();
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain("tool=grep");
  });

  test("a non-assistant message_start is ignored", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart({ role: "user", content: [{ type: "text", text: "hi" }] });
    set(STREAMING_STALL_MS);
    watchdog.check();
    expect(notices).toHaveLength(0);
  });

  test("a missing parent pane makes a stall a no-op, not a throw", () => {
    const env: NodeJS.ProcessEnv = {
      PI_SUBAGENT_RUN_ID: "sub-a3f1",
      PI_SUBAGENT_AGENT: "worker",
      // PI_SUBAGENT_PARENT_PANE absent
    };
    const { watchdog, set, notices } = harness(env);
    watchdog.onMessageStart(assistantText(""));
    set(STREAMING_STALL_MS);
    expect(() => watchdog.check()).not.toThrow();
    expect(notices).toHaveLength(0);
  });

  // Pins the unparseable env shape: launcher-spawned children never reach it,
  // because buildChildEnv always sets PI_SUBAGENT_RUN_ID and PI_SUBAGENT_AGENT
  // — the fallback exists for a hand-launched child with no run identity.
  test("a missing run id and agent fall back to the defaults in the notice", () => {
    const env: NodeJS.ProcessEnv = { PI_SUBAGENT_PARENT_PANE: "parent-pane-456" };
    const { watchdog, set, notices } = harness(env);
    watchdog.onToolExecutionStart("call-1", "bash");
    set(TOOL_STALL_MS);
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBe(
      formatNotice("unknown", "subagent", "stalled", "phase=tool elapsedMs=600000 tool=bash"),
    );
  });

  test("a slow-but-alive stream is not flagged: every update resets the stall clock", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart(assistantText(""));
    // Updates 4 minutes apart: well under the 5-minute threshold between
    // updates, 17 minutes of stream age in total. xhigh thinking does this.
    for (let i = 1; i <= 4; i++) {
      set(i * 4 * 60_000);
      watchdog.onMessageUpdate(assistantText(`chunk ${i}`));
    }
    set(17 * 60_000); // 3 minutes after the last update
    watchdog.check();
    expect(notices).toHaveLength(0);
    set(17 * 60_000 + STREAMING_STALL_MS + 1); // now past the threshold from the last update
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("phase=streaming");
  });

  test("charsGenerated counts thinking and partial tool-call arguments, not visible text only", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart(assistantText(""));
    watchdog.onMessageUpdate({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "pondering" }, // 9
        { type: "text", text: "abc" }, // 3
        { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }, // 16
      ],
    });
    set(STREAMING_STALL_MS);
    watchdog.check();
    // 9 + 3 + JSON.stringify({ command: "ls" }).length (16) = 28 — a
    // thinking-heavy stall notice must not read as "produced nothing".
    expect(notices[0]).toBe(
      formatNotice("sub-a3f1", "worker", "stalled", "phase=streaming elapsedMs=300000 charsGenerated=28"),
    );
  });

  test("a nested tool end (parentToolCallId set) does not clear the outer entry and refreshes its clock", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onToolExecutionStart("call-outer", "bash");
    set(5 * 60_000);
    // A codemode sub-call finishes; its end carries the OUTER call's id. The
    // outer entry must survive (not be deleted) and its clock refreshes —
    // nested activity is outer activity.
    watchdog.onToolExecutionEnd("call-outer/1", "call-outer");
    set(10 * 60_000); // 5 min after the refresh: not stalled
    watchdog.check();
    expect(notices).toHaveLength(0);
    set(15 * 60_000); // 10 min after the refresh: the outer stalls
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("tool=bash");
    expect(notices[0]).toContain("elapsedMs=900000");
  });

  test("in a parallel batch, one sibling's end leaves the wedged sibling warnable", () => {
    const { watchdog, set, notices } = harness();
    // pi emits every start of a parallel batch before any of them executes.
    watchdog.onToolExecutionStart("call-a", "read");
    watchdog.onToolExecutionStart("call-b", "bash");
    watchdog.onToolExecutionEnd("call-a"); // first sibling finishes
    set(TOOL_STALL_MS);
    watchdog.check();
    // The wedged sibling still warns — its entry survived call-a's end.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("tool=bash");
    expect(notices[0]).toContain("elapsedMs=600000");
    // One notice per tool call: no re-warn.
    set(2 * TOOL_STALL_MS);
    watchdog.check();
    expect(notices).toHaveLength(1);
  });

  test("a top-level tool start while a stream is active keeps both tracked", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart(assistantText("")); // t=0
    set(60_000);
    watchdog.onToolExecutionStart("call-1", "bash"); // t=60s
    set(STREAMING_STALL_MS);
    watchdog.check();
    // The stream owns its one-shot notice; the tool (4 min in) is not stalled.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("phase=streaming");
    watchdog.onMessageEnd(assistantText(""));
    set(11 * 60_000); // t=660s: 10 min past the tool's start
    watchdog.check();
    expect(notices).toHaveLength(2);
    expect(notices[1]).toBe(
      formatNotice("sub-a3f1", "worker", "stalled", "phase=tool elapsedMs=600000 tool=bash"),
    );
  });

  test("a tool update refreshes its own entry; a nested update refreshes the parent's", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onToolExecutionStart("call-outer", "bash");
    set(9 * 60_000);
    // A nested sub-call reports progress: its update carries the outer id.
    watchdog.onToolExecutionUpdate("call-inner", "call-outer");
    set(9 * 60_000 + 60_000); // 1 min after the refresh
    watchdog.check();
    expect(notices).toHaveLength(0); // 9 min since the outer start, but only 1 min since activity
    set(9 * 60_000 + 11 * 60_000 + 1); // 10 min + 1 ms past the refresh
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("tool=bash");
  });

  test("a depth-2 nested update walks ancestors to refresh the top-level entry", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onToolExecutionStart("call-outer", "bash");
    set(9 * 60_000);
    // The sub-call's id and its parent are both below the top-level entry, so
    // only an unbounded ancestor walk reaches `call-outer`; a direct lookup or
    // a single trim misses it, and the outer entry would false-stall.
    watchdog.onToolExecutionUpdate("call-outer/1/2", "call-outer/1");
    set(9 * 60_000 + 60_000); // 1 min after the refresh
    watchdog.check();
    expect(notices).toHaveLength(0);
    set(9 * 60_000 + 11 * 60_000 + 1); // 10 min + 1 ms past the refresh
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("tool=bash");
  });

  test("a depth-3 nested update walks ancestors to the top-level entry", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onToolExecutionStart("a", "bash");
    set(9 * 60_000);
    watchdog.onToolExecutionUpdate("a/1/2/3", "a/1/2");
    set(9 * 60_000 + 60_000); // 1 min after the refresh
    watchdog.check();
    expect(notices).toHaveLength(0);
    set(9 * 60_000 + 11 * 60_000 + 1); // 10 min + 1 ms past the refresh
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("tool=bash");
  });

  test("a top-level tool update refreshes its own entry", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onToolExecutionStart("call-1", "bash");
    set(9 * 60_000);
    watchdog.onToolExecutionUpdate("call-1");
    set(19 * 60_000 - 1); // 9 min 59.999 s since the update
    watchdog.check();
    expect(notices).toHaveLength(0);
    set(19 * 60_000 + 1);
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("tool=bash");
  });

  test("a message_update while idle is ignored", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageUpdate(assistantText("hello"));
    set(STREAMING_STALL_MS);
    watchdog.check();
    expect(notices).toHaveLength(0);
  });

  test("check while idle emits nothing, even long after the thresholds", () => {
    const { watchdog, set, notices } = harness();
    set(10 * 60_000);
    watchdog.check();
    set(20 * 60_000);
    watchdog.check();
    expect(notices).toHaveLength(0);
  });

  test("a message_end during a tool phase does not clear the tool entry", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onToolExecutionStart("call-1", "bash");
    set(60_000);
    watchdog.onMessageEnd(assistantText(""));
    set(11 * 60_000);
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("tool=bash");
  });

  test("agent_end clears an orphaned tool entry and the streaming phase", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart(assistantText(""));
    watchdog.onToolExecutionStart("call-1", "bash"); // a start whose end never came
    watchdog.onAgentEnd();
    set(30 * 60_000);
    watchdog.check();
    expect(notices).toHaveLength(0);
  });

  test("the tick runs on WATCHDOG_TICK_MS, is unref'd, and is cleared on session_shutdown", () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    let unrefCalled = false;
    let intervalMs: number | undefined;
    let cleared = false;
    (globalThis as Record<string, unknown>).setInterval = (cb: () => void, ms: number) => {
      intervalMs = ms;
      return { unref: () => { unrefCalled = true; } };
    };
    (globalThis as Record<string, unknown>).clearInterval = () => {
      cleared = true;
    };
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const pi = {
      registerTool: () => {},
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    } as unknown as ExtensionAPI;
    try {
      childDone(pi);
      expect(intervalMs).toBe(WATCHDOG_TICK_MS);
      expect(unrefCalled).toBe(true);
      expect(handlers.has("session_shutdown")).toBe(true);
      handlers.get("session_shutdown")![0]({});
      expect(cleared).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>).setInterval = realSetInterval;
      (globalThis as Record<string, unknown>).clearInterval = realClearInterval;
    }
  });
  test("oldest-first selection: two wedged siblings warn in start order, one per tick", () => {
    const { watchdog, set, notices } = harness();
    // pi emits every start of a parallel batch before any of them executes.
    watchdog.onToolExecutionStart("call-a", "read");
    set(1000); // +1 s
    watchdog.onToolExecutionStart("call-b", "grep");
    set(TOOL_STALL_MS + 1000); // both siblings past the threshold
    watchdog.check();
    // The first notice names the OLDEST sibling (a), not the newest.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("tool=read");
    expect(notices[0]).not.toContain("tool=grep");
    // The next tick names the other wedged sibling (b), and only it.
    set(TOOL_STALL_MS + 2000);
    watchdog.check();
    expect(notices).toHaveLength(2);
    expect(notices[1]).toContain("tool=grep");
  });

  test("a non-assistant message_end does not close an active assistant streaming phase", () => {
    const { watchdog, set, notices } = harness();
    watchdog.onMessageStart(assistantText("hello"));
    set(60_000);
    // A toolResult message_end arrives while the assistant stream is active:
    // it says nothing about the assistant's phase, which must survive and
    // still stall on its own threshold.
    watchdog.onMessageEnd({ role: "toolResult", content: [{ type: "text", text: "ok" }] });
    set(STREAMING_STALL_MS + 10_000);
    watchdog.check();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("phase=streaming");
  });

  test("a throw inside the tick callback is swallowed (the 30 s tick is throw-safe)", () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const realNow = Date.now;
    let capturedCb: (() => void) | undefined;
    (globalThis as Record<string, unknown>).setInterval = (cb: () => void, _ms: number) => {
      capturedCb = cb;
      return { unref: () => {} };
    };
    (globalThis as Record<string, unknown>).clearInterval = () => {};
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const pi = {
      registerTool: () => {},
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    } as unknown as ExtensionAPI;
    try {
      childDone(pi);
      expect(capturedCb).toBeDefined();
      // Point the watchdog's clock at a throwing now(): check() reads
      // effects.now() first, so without the try/catch the timer callback
      // would throw, and a synchronous throw in a timer callback is uncaught
      // and would kill the child.
      Date.now = () => {
        throw new Error("clock on fire");
      };
      expect(() => capturedCb!()).not.toThrow();
    } finally {
      (globalThis as Record<string, unknown>).setInterval = realSetInterval;
      (globalThis as Record<string, unknown>).clearInterval = realClearInterval;
      Date.now = realNow;
    }
  });

  test("default-export wiring: all events registered; nested tool_execution_end forwards parentToolCallId", () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const realNow = Date.now;
    let currentTime = 0;
    let tickCb: (() => void) | undefined;
    (globalThis as Record<string, unknown>).setInterval = (cb: () => void, _ms: number) => {
      tickCb = cb;
      return { unref: () => {} };
    };
    (globalThis as Record<string, unknown>).clearInterval = () => {};
    Date.now = () => currentTime;

    // Record every spawn so stall notices sent through the real node effects
    // are observable. mock.module is retroactive: child-done.js's `spawn`
    // binding picks this up even though the module is already imported.
    const spawnedArgs: unknown[][] = [];
    mock.module("node:child_process", () => ({
      spawn: (...args: unknown[]) => {
        spawnedArgs.push(args);
        return { on: () => {}, unref: () => {} };
      },
      execFile: (..._args: unknown[]) => {},
    }));

    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const pi = {
      registerTool: () => {},
      on(event: string, handler: (...args: unknown[]) => void) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
    } as unknown as ExtensionAPI;

    const savedPane = process.env.PI_SUBAGENT_PARENT_PANE;
    process.env.PI_SUBAGENT_PARENT_PANE = "test-parent-pane";
    try {
      childDone(pi);

      // Every registered event must be present: dropping any registration
      // (message_update, agent_end, ...) leaves the watchdog blind to that
      // phase.
      for (const evt of [
        "message_start",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
        "tool_execution_update",
        "agent_end",
        "session_shutdown",
      ]) {
        expect(handlers.has(evt), `pi.on("${evt}") not registered`).toBe(true);
      }
      // agent_end is registered twice (handshake + watchdog); deleting either
      // one leaves the other, so check the count specifically.
      expect(handlers.get("agent_end")!.length).toBe(2);

      // Drive one nested tool_execution_end through the captured handler.
      // If the wiring forwards parentToolCallId, the nested end refreshes the
      // parent's clock and nothing stalls at t=10 min; if the argument is
      // dropped, the nested end becomes a no-op top-level delete of an id that
      // was never in the map, and the parent false-stalls.
      const startHandler = handlers.get("tool_execution_start")![0];
      const endHandler = handlers.get("tool_execution_end")![0];
      currentTime = 0;
      startHandler({ toolCallId: "call-outer", toolName: "bash" });
      currentTime = 5 * 60_000;
      endHandler({ toolCallId: "call-outer/1", parentToolCallId: "call-outer" });
      currentTime = 10 * 60_000;
      tickCb!();

      const stalled = spawnedArgs.filter((args) => {
        const argv = args[1] as unknown[] | undefined;
        return typeof argv?.[3] === "string" && argv[3].includes("stalled");
      });
      expect(stalled).toHaveLength(0);
    } finally {
      mock.restore();
      (globalThis as Record<string, unknown>).setInterval = realSetInterval;
      (globalThis as Record<string, unknown>).clearInterval = realClearInterval;
      Date.now = realNow;
      if (savedPane === undefined) delete process.env.PI_SUBAGENT_PARENT_PANE;
      else process.env.PI_SUBAGENT_PARENT_PANE = savedPane;
    }
  });
});
