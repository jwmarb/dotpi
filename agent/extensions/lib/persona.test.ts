/**
 * The shared in-session profile switch: set/get/clear round-trip and the
 * `personaDenies` gate.
 *
 * The state lives on `globalThis` under a `Symbol.for` key, so every suite
 * that sets it must clear it — `afterEach` here keeps the switch from
 * leaking into other files in the same `bun test` process.
 *
 * Run: `bun test agent/extensions/lib/persona.test.ts`
 */
import { afterEach, describe, expect, test } from "bun:test";

import { personaDenies, personaOverride, setPersonaOverride, type PersonaOverride } from "./persona.js";

/** A switch to a quant-style profile that withholds one tool. */
const SWITCH: PersonaOverride = {
  name: "quant-trader",
  dir: "/tmp/quant-trader",
  deniedTools: new Set(["write"]),
};

afterEach(() => {
  setPersonaOverride(undefined);
});

describe("setPersonaOverride / personaOverride", () => {
  test("reads as undefined when never set", () => {
    expect(personaOverride()).toBeUndefined();
  });

  test("round-trips a set value verbatim", () => {
    setPersonaOverride(SWITCH);
    expect(personaOverride()).toEqual(SWITCH);
    // The same object, not a copy: readers must see the set the writer made.
    expect(personaOverride()!.deniedTools).toBe(SWITCH.deniedTools);
  });

  test("clears back to undefined", () => {
    setPersonaOverride(SWITCH);
    setPersonaOverride(undefined);
    expect(personaOverride()).toBeUndefined();
  });

  test("a malformed value reads as no switch, because a throw would kill startup", () => {
    const key = Symbol.for("pi.persona.override");
    (globalThis as Record<PropertyKey, unknown>)[key] = { name: "q" };
    expect(personaOverride()).toBeUndefined();
  });
});

describe("personaDenies", () => {
  test("is false for every tool when no switch is active", () => {
    expect(personaDenies("write")).toBe(false);
    expect(personaDenies("read")).toBe(false);
  });

  test("names exactly the tools the active switch withholds", () => {
    setPersonaOverride(SWITCH);
    expect(personaDenies("write")).toBe(true);
    expect(personaDenies("read")).toBe(false);
  });
});
