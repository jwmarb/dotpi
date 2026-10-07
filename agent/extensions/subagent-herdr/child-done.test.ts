/**
 * Tests for the child-done handshake factory (`createChildDoneHandshake`).
 *
 * Uses a recording effects stub to verify the exact ordering of side effects:
 * sidecar write → notice → pane close → shutdown, and the deduplication
 * invariant that the sidecar is written at most once.
 */
import { describe, expect, test } from "bun:test";

import {
  type ChildDoneEffects,
  createChildDoneHandshake,
} from "./child-done.js";
import { formatNotice } from "./rundir.js";

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
    // Critically: no sidecar. The parent must not classify this run as done.
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
