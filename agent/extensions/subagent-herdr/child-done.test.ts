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
