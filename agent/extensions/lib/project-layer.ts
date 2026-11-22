/**
 * The project layer — where a repo's own `.pi/` narrows the global profile.
 *
 * Pi core loads project resources from `join(cwd, ".pi")` ONLY (no ancestor
 * walk) and gates them on project trust. It has no `.pi/agents/` concept — the
 * subagent fleet is this repo's invention, and pi's own precedence for skills
 * is project-before-user, first name loaded wins. This module extends exactly
 * that order to the fleet: it decides which agent dirs and skills dirs get
 * scanned, and in what order, for a cwd. It does not read them — that is
 * `agents.ts`' and `skill-tree.ts`' job.
 *
 * "profile" here means the global agent dir (`layout.ts` `agentDir()`); it is
 * unrelated to the profiles feature removed in 2026-11.
 *
 * ## The trust-bypass trap
 *
 * A repo containing ONLY `.pi/agents/` resolves `isProjectTrusted() === true`
 * with NO prompt ever, because `hasTrustRequiringProjectResources(cwd)`
 * (exported from pi's public index) returns false for an agents-only `.pi`:
 * `agents` is not in pi's `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`. Measured
 * against pi 1.4.0, not assumed. So "trusted" alone is not a safe load gate —
 * an agents-only repo would load project agents the human never approved.
 *
 * The trust rule is the conjunction
 * `isProjectTrusted() && hasTrustRequiringProjectResources(cwd)`, spelled
 * once in {@link projectRoots}: extensions pass pi's two facts in as data,
 * because this pure module cannot import pi, and the two halves are one
 * decision that must not be re-derived in two places.
 *
 * ## Why the second half is a session snapshot
 *
 * pi decides `isProjectTrusted()` ONCE per runtime (startup, and again on
 * reload/new/resume), but `hasTrustRequiringProjectResources` is a live disk
 * walk. Re-reading it every turn reopened the trap mid-session: in an
 * agents-only repo, anything that creates `.pi/settings.json` (the model, a
 * script, a `git pull`) flipped the gate to true && true on the next turn and
 * loaded `.pi/agents/*.md` with no prompt — proven live. So callers read it
 * through a {@link TrustRequiringSnapshot}, reset at every `session_start`,
 * so both halves are judged at the same moment pi judged trust.
 *
 * ## Why the dedupe
 *
 * Running inside a project whose `.pi` dir IS the profile (the profile
 * directory sitting directly under the cwd as `.pi`) would otherwise list the
 * same tree twice: the project layer and the profile layer are the same
 * files, and scanning them as two layers invents a "shadow" that does not
 * exist. The collapse is by realpath identity (falling back to
 * `path.resolve` when a side cannot be resolved), so relative, redundant, and
 * symlinked spellings of the same dir all collapse.
 *
 * Pure module: `node:path` plus `realpathSync` from `node:fs` for identity,
 * no pi import (the `lib/` rule), so extension top-level code can import it.
 *
 * @module extensions/lib/project-layer
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The ordered roots for the fleet and the skills library, highest precedence
 * first.
 */
export interface ResourceRoots {
  /** Agent-definition dirs, highest precedence first. */
  readonly agentsDirs: readonly string[];
  /** Skills-library dirs, highest precedence first. */
  readonly skillsDirs: readonly string[];
  /** The project `.pi` dir when the layer is active; undefined = profile-only. */
  readonly projectDir?: string;
}

/**
 * `join(cwd, ".pi")` — the project config dir.
 *
 * No ancestor walk: pi's trust decision covers exactly this dir, so a project
 * layer discovered anywhere else would be a second answer to "where does this
 * repo configure pi" — the drift the one-owner-per-format rule exists to keep
 * out.
 */
export function projectConfigDir(cwd: string): string {
  return join(cwd, ".pi");
}

/**
 * The ordered roots for a cwd.
 *
 * Trusted (the caller's already-computed boolean — see the trust-bypass trap
 * in the module header) → `[cwd/.pi/agents, profile/agents]` and
 * `[cwd/.pi/skills, profile/skills]`, project first; otherwise profile-only.
 * Paths are `path.resolve`d, so a relative cwd is normalized and the dedupe
 * below compares real locations.
 *
 * @param o.profileDir - The profile's agent directory (`layout.ts`'s
 *   `agentDir()`), the layer the project layer narrows.
 * @param o.cwd - The process working directory.
 * @param o.projectTrusted - `isProjectTrusted() &&
 *   hasTrustRequiringProjectResources(cwd)`, computed by the caller.
 * @returns The ordered roots, or a profile-only root set with
 *   `projectDir` undefined.
 */
export function resourceRoots(o: {
  profileDir: string;
  cwd: string;
  projectTrusted: boolean;
}): ResourceRoots {
  const profileAgents = resolve(join(o.profileDir, "agents"));
  const profileSkills = resolve(join(o.profileDir, "skills"));

  if (!o.projectTrusted) {
    return { agentsDirs: [profileAgents], skillsDirs: [profileSkills] };
  }
  const projectDir = resolve(projectConfigDir(o.cwd));
  if (realIdentity(projectConfigDir(o.cwd)) === realIdentity(o.profileDir)) {
    // The project layer is the profile itself: listing it as two layers
    // would scan the same files twice and report a shadow that does not exist.
    return { agentsDirs: [profileAgents], skillsDirs: [profileSkills] };
  }

  // Dedupe entry by entry, not just the whole `.pi`: a `.pi/agents` or
  // `.pi/skills` symlinked into the profile would otherwise list the fleet
  // twice and tag every profile agent as a project shadow of itself.
  const projectAgents = resolve(join(projectDir, "agents"));
  const projectSkills = resolve(join(projectDir, "skills"));
  const sameAs = (a: string, b: string) => realIdentity(a) === realIdentity(b);
  return {
    agentsDirs: sameAs(projectAgents, profileAgents) ? [profileAgents] : [projectAgents, profileAgents],
    skillsDirs: sameAs(projectSkills, profileSkills) ? [profileSkills] : [projectSkills, profileSkills],
    projectDir,
  };
}

/**
 * `realpath` with a `resolve` fallback: the same dir spelled through a symlink
 * must compare equal, and a dir that does not exist yet has no realpath, so
 * it degrades to plain path identity.
 */
function realIdentity(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The trust gate, spelled once: the project layer loads only when the project
 * is trusted AND it carries trust-requiring resources (the trust-bypass trap
 * in the module header). Extensions pass pi's two facts as data — the pi
 * import stays at the edge, and this is the one place the conjunction lives,
 * so no call site can inline it and drift.
 *
 * @param opts.profileDir - The profile's agent directory (`layout.ts`'s
 *   `agentDir()`).
 * @param opts.cwd - The process working directory.
 * @param opts.isProjectTrusted - pi's `isProjectTrusted()`.
 * @param opts.hasTrustRequiringResources - pi's
 *   `hasTrustRequiringProjectResources(cwd)`.
 */
export function projectRoots(opts: {
  profileDir: string;
  cwd: string;
  isProjectTrusted: boolean;
  hasTrustRequiringResources: boolean;
}): ResourceRoots {
  return resourceRoots({
    profileDir: opts.profileDir,
    cwd: opts.cwd,
    projectTrusted: opts.isProjectTrusted && opts.hasTrustRequiringResources,
  });
}

/**
 * `hasTrustRequiringProjectResources(cwd)` frozen per cwd for one session.
 *
 * The first read for a cwd probes disk and is kept until {@link reset}; call
 * `reset()` from EVERY `session_start` (any reason — that is when pi
 * re-decides trust), so a resource created mid-session cannot open the gate
 * pi never prompted for. The probe is injected: this module stays pi-free.
 */
export class TrustRequiringSnapshot {
  private readonly seen = new Map<string, boolean>();

  /** @param probe - pi's `hasTrustRequiringProjectResources`. */
  constructor(private readonly probe: (cwd: string) => boolean) {}

  /** The frozen answer for `cwd` (probed on first read this session). */
  get(cwd: string): boolean {
    const key = resolve(cwd);
    let v = this.seen.get(key);
    if (v === undefined) {
      v = this.probe(cwd);
      this.seen.set(key, v);
    }
    return v;
  }

  /** Forget every snapshot: the next read re-probes. */
  reset(): void {
    this.seen.clear();
  }
}
