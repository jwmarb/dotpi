/**
 * The shared in-session profile switch.
 *
 * A `/agent <profile>` switch (owned by the `persona` extension) retargets a
 * running session to a different profile directory under the repo root: its
 * prompt, its agent fleet, its skills, and its tool set. Every module that
 * wants to follow the switch reads it through this module; no module keeps a
 * copy of the switch in its own scope, because a copy is a second answer to
 * one question — the drift this `lib/` layer exists to prevent.
 *
 * The value lives on `globalThis` under a `Symbol.for` key, not in a
 * module-level variable: the same `lib/` file can be loaded twice under
 * symlinked and real paths (a profile's `extensions/lib` is a symlink into
 * this directory), and a module-level value would differ between the two
 * loads while the `globalThis` one is shared by both.
 *
 * `process.env.PI_CODING_AGENT_DIR` is deliberately **not** changed during a
 * session: the process's own sessions, auth, `.env`, `subagent-runs/` and
 * caches keep using its real directory. Only what a switch retargets
 * (`agentsDir()`, `skillsDir()`, the child profile env) follows it.
 *
 * @module lib/persona
 */

/** The state a switch carries: where the target profile lives and what it withholds. */
export interface PersonaOverride {
  /** The profile's canonical name (the non-symlink entry name). */
  name: string;
  /** The profile directory, resolved to its realpath. */
  dir: string;
  /** The tools the target profile withholds, hard-blocked at `tool_call`. */
  deniedTools: ReadonlySet<string>;
}

/** The `globalThis` key the switch state lives under (see the module docs). */
const OVERRIDE_KEY = Symbol.for("pi.persona.override");

/**
 * The active switch, if any: `undefined` means the session runs its own
 * profile.
 *
 * Never throws: a missing key or a malformed value reads as "no switch",
 * because top-level extension code imports this module and a throw there is a
 * startup failure with no diagnostic.
 */
export function personaOverride(): PersonaOverride | undefined {
  const value: unknown = (globalThis as Record<PropertyKey, unknown>)[OVERRIDE_KEY];
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as PersonaOverride).name !== "string" ||
    typeof (value as PersonaOverride).dir !== "string" ||
    (value as PersonaOverride).deniedTools === null ||
    (value as PersonaOverride).deniedTools === undefined ||
    typeof (value as PersonaOverride).deniedTools.has !== "function"
  ) {
    return undefined;
  }
  return value as PersonaOverride;
}

/**
 * Sets — or, with `undefined`, clears — the active switch.
 *
 * The only writer. The `persona` extension calls it when a switch is applied
 * and again (with `undefined`) when the session switches back to its own
 * profile; every other module is a reader.
 */
export function setPersonaOverride(o: PersonaOverride | undefined): void {
  if (o === undefined) {
    delete (globalThis as Record<PropertyKey, unknown>)[OVERRIDE_KEY];
    return;
  }
  (globalThis as Record<PropertyKey, unknown>)[OVERRIDE_KEY] = o;
}

/**
 * Whether the active switch withholds a tool.
 *
 * False when no switch is active — a session on its own profile withholds
 * nothing here (a profile's own prompt extension applies its own rules).
 */
export function personaDenies(tool: string): boolean {
  return personaOverride()?.deniedTools.has(tool) ?? false;
}
