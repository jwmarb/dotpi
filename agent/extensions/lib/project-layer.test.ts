/**
 * Tests for the project-layer root ordering (lib/project-layer.ts) — the pure
 * half of the repo-`.pi`-narrowing-the-profile pattern.
 *
 * The fixture discipline matches the other lib tests: no real tree is read
 * here at all, because this module computes paths, not listings. The trust
 * boolean is the caller's (see the trust-bypass trap in the module header),
 * so the tests feed it directly.
 *
 * Run from the repo root: `bun test agent/extensions/lib/project-layer.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectConfigDir,
  projectRoots,
  resourceRoots,
  TrustRequiringSnapshot,
} from "./project-layer.js";

describe("projectConfigDir", () => {
  test("joins .pi onto the cwd, with no ancestor walk", () => {
    expect(projectConfigDir("/work/repo")).toBe(join("/work/repo", ".pi"));
    // No parent, no grandparent: pi's trust decision covers exactly this dir.
    expect(projectConfigDir("/work")).toBe(join("/work", ".pi"));
  });
});

describe("resourceRoots", () => {
  const profile = "/home/u/.pi/agent";

  test("trusted: project dirs first, projectDir set", () => {
    const r = resourceRoots({ profileDir: profile, cwd: "/work/repo", projectTrusted: true });
    expect(r.projectDir).toBe(join("/work/repo", ".pi"));
    expect(r.agentsDirs).toEqual([join("/work/repo", ".pi", "agents"), join(profile, "agents")]);
    expect(r.skillsDirs).toEqual([join("/work/repo", ".pi", "skills"), join(profile, "skills")]);
  });

  test("untrusted: profile only, projectDir undefined", () => {
    const r = resourceRoots({ profileDir: profile, cwd: "/work/repo", projectTrusted: false });
    expect(r.projectDir).toBeUndefined();
    expect(r.agentsDirs).toEqual([join(profile, "agents")]);
    expect(r.skillsDirs).toEqual([join(profile, "skills")]);
  });

  test("dedupes when the project dir resolves to the profile dir", () => {
    // Running inside a project whose `.pi` IS the profile (the profile dir
    // sits directly under the cwd as `.pi`) must not list the profile twice:
    // the project layer and the profile layer would be the same files.
    const r = resourceRoots({ profileDir: "/work/.pi", cwd: "/work", projectTrusted: true });
    expect(r.projectDir).toBeUndefined();
    expect(r.agentsDirs).toEqual([join("/work/.pi", "agents")]);
    expect(r.skillsDirs).toEqual([join("/work/.pi", "skills")]);
  });

  test("dedupes when the project dir is a symlink to the profile dir", () => {
    // The realpath-then-fallback collapse: a `.pi` that is an alias spelling
    // of the profile dir is the same dir, and must not list the profile twice.
    const tmp = mkdtempSync(join(tmpdir(), "project-layer-symlink-"));
    const realProfile = join(tmp, "profile");
    mkdirSync(realProfile, { recursive: true });
    const cwd = join(tmp, "work");
    mkdirSync(cwd, { recursive: true });
    symlinkSync(realProfile, join(cwd, ".pi"));
    const r = resourceRoots({ profileDir: realProfile, cwd, projectTrusted: true });
    expect(r.projectDir).toBeUndefined();
    expect(r.agentsDirs).toEqual([join(realProfile, "agents")]);
    expect(r.skillsDirs).toEqual([join(realProfile, "skills")]);
  });

  test("dedupes entry by entry: a symlinked .pi/agents into the profile is listed once", () => {
    // A real `.pi` whose `agents` (only) aliases the profile's: the agents
    // layer collapses to the profile entry while `skills` stays a real layer,
    // so the fleet is neither listed twice nor tagged as shadowing itself.
    const tmp = mkdtempSync(join(tmpdir(), "project-layer-entry-"));
    const realProfile = join(tmp, "profile");
    mkdirSync(join(realProfile, "agents"), { recursive: true });
    const cwd = join(tmp, "work");
    mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
    symlinkSync(join(realProfile, "agents"), join(cwd, ".pi", "agents"));
    const r = resourceRoots({ profileDir: realProfile, cwd, projectTrusted: true });
    expect(r.projectDir).toBe(join(cwd, ".pi"));
    expect(r.agentsDirs).toEqual([join(realProfile, "agents")]);
    expect(r.skillsDirs).toEqual([join(cwd, ".pi", "skills"), join(realProfile, "skills")]);
  });

  test("a distinct project dir beside the profile is kept, not deduped", () => {
    // Only identity dedupes; a `.pi` in a different place is a real layer.
    const r = resourceRoots({ profileDir: profile, cwd: "/home/u/other", projectTrusted: true });
    expect(r.projectDir).toBe(join("/home/u/other", ".pi"));
    expect(r.agentsDirs).toHaveLength(2);
    expect(r.skillsDirs).toHaveLength(2);
  });

  test("normalizes a relative cwd", () => {
    // A relative cwd is not a failure: it resolves against the process cwd,
    // the same way the trust gate would see it.
    const r = resourceRoots({ profileDir: profile, cwd: "work/repo", projectTrusted: true });
    expect(r.projectDir).toBe(join(process.cwd(), "work/repo", ".pi"));
    expect(r.agentsDirs).toEqual([
      join(process.cwd(), "work/repo", ".pi", "agents"),
      join(profile, "agents"),
    ]);
    expect(r.skillsDirs).toEqual([
      join(process.cwd(), "work/repo", ".pi", "skills"),
      join(profile, "skills"),
    ]);
  });
});
describe("projectRoots", () => {
  const profile = "/home/u/.pi/agent";

  test("the conjunction loads the layer only when both halves hold", () => {
    // Trusted AND carrying trust-requiring resources: the layer is active.
    const on = projectRoots({
      profileDir: profile,
      cwd: "/work/repo",
      isProjectTrusted: true,
      hasTrustRequiringResources: true,
    });
    expect(on.projectDir).toBe(join("/work/repo", ".pi"));

    // Trusted with no trust-requiring resource (the agents-only shape): the
    // layer stays off — trust alone is not a load gate.
    const agentsOnly = projectRoots({
      profileDir: profile,
      cwd: "/work/repo",
      isProjectTrusted: true,
      hasTrustRequiringResources: false,
    });
    expect(agentsOnly.projectDir).toBeUndefined();
    expect(agentsOnly.agentsDirs).toEqual([join(profile, "agents")]);

    // Not trusted, with resources: the layer stays off too.
    const untrusted = projectRoots({
      profileDir: profile,
      cwd: "/work/repo",
      isProjectTrusted: false,
      hasTrustRequiringResources: true,
    });
    expect(untrusted.projectDir).toBeUndefined();
    expect(untrusted.skillsDirs).toEqual([join(profile, "skills")]);
  });
});

describe("TrustRequiringSnapshot", () => {
  test("freezes the first answer per cwd until reset", () => {
    // The mid-session flip this exists to stop: a repo that gains a
    // trust-requiring file (`.pi/settings.json` written by the model, a
    // script, a `git pull`) must NOT reopen a gate pi never prompted for.
    let disk = false;
    const snaps = new TrustRequiringSnapshot(() => disk);
    expect(snaps.get("/work/repo")).toBe(false);
    disk = true; // the file appears mid-session
    expect(snaps.get("/work/repo")).toBe(false);
    snaps.reset(); // a new session: pi re-decides trust, so re-probe
    expect(snaps.get("/work/repo")).toBe(true);
  });

  test("snapshots per cwd, and normalizes the key", () => {
    const probed: string[] = [];
    const snaps = new TrustRequiringSnapshot((cwd) => {
      probed.push(cwd);
      return cwd.endsWith("repo");
    });
    expect(snaps.get("/work/repo")).toBe(true);
    expect(snaps.get("/work/other")).toBe(false);
    // Same dir, second spelling: one probe, the frozen answer.
    expect(snaps.get(join("/work", "repo"))).toBe(true);
    expect(probed).toEqual(["/work/repo", "/work/other"]);
  });

  test("the conjunction keeps the layer off for a mid-session resource", () => {
    // The regression as the caller sees it: trusted repo (agents-only shape),
    // snapshot taken before the file existed.
    const snaps = new TrustRequiringSnapshot(() => false);
    const r = projectRoots({
      profileDir: "/home/u/.pi/agent",
      cwd: "/work/repo",
      isProjectTrusted: true,
      hasTrustRequiringResources: snaps.get("/work/repo"),
    });
    expect(r.projectDir).toBeUndefined();
  });
});
