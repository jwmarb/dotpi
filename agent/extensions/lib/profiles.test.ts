/**
 * Live-tree invariants for this repo's profiles.
 *
 * Like `skill-catalogue.test.ts`, this file reads the tree as it actually is on
 * disk, on purpose: what it guards is how the profiles are *laid out*, and a
 * fixture would only prove the fixture. Each rule is one the top-level
 * `AGENTS.md` "Profiles" section states and nothing else enforced:
 *
 *   - A non-home profile never carries `dynamic-prompt.ts`, by name or by
 *     symlink under another name. That extension replaces the whole prompt
 *     with the orchestrator's, so a quant desk that loaded it would silently
 *     become a code orchestrator.
 *   - Every entry in a non-home profile's `extensions/` is a per-item symlink
 *     into `agent/`, the profile's own `.ts`, or one of a short pinned list of
 *     non-extension files. A real copy of a shared extension drifts from the
 *     original the first time either is edited, so an own `.ts` whose name
 *     also exists in `agent/extensions/` is a copy, not the profile's own.
 *   - A profile's `.env` and `sessions/` are gitignored. A new profile must not
 *     be one `git add` away from committing its credentials or transcripts.
 *
 * The repo root is taken from this file's own location rather than
 * `repoRoot()`: that accessor reads `PI_CODING_AGENT_DIR`, which other suites
 * point at temp dirs, and a live-tree test must not be redirected by a leak.
 *
 * Run from the repo root: `bun test agent/extensions/lib/profiles.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { discoverProfiles } from "../persona/lib.js";
import { gitEnv } from "./git-env.js";

/** `<repo>/agent/extensions/lib` → `<repo>`. */
const ROOT = realpathSync(dirname(dirname(dirname(import.meta.dir))));
/** The home profile: the one every other profile symlinks into. */
const HOME = realpathSync(join(ROOT, "agent"));
/** The home profile's extensions dir, where every shared extension lives. */
const HOME_EXT = join(HOME, "extensions");
/** The one extension no non-home profile may load, under any name. */
const DYNAMIC_PROMPT = realpathSync(join(HOME_EXT, "dynamic-prompt.ts"));

/**
 * The non-extension entries a profile's `extensions/` may hold as real files
 * or directories. Pinned from `ls -la quant-trader/extensions/` (2026-10-31):
 * every other entry there is a symlink or the profile's own `quant-prompt.ts`.
 * `AGENTS.md` is not here because it is a symlink. Widening this list is a
 * design decision, not a test fix — a real directory here is a copy that drifts.
 */
const ALLOWED_OWN = new Set(["test", "tsconfig.json"]);

const others = (await discoverProfiles(ROOT)).filter((p) => p.dir !== HOME);

describe("the profiles on disk", () => {
  test("there is at least one non-home profile, so nothing below is vacuous", () => {
    // Without this, a wrong ROOT would make every per-profile assertion pass
    // against zero profiles — the failure this file exists to catch.
    expect(others.length).toBeGreaterThan(0);
  });

  for (const p of others) {
    const extDir = join(p.dir, "extensions");

    test(`${p.name} never loads dynamic-prompt.ts`, () => {
      const entries = readdirSync(extDir);
      expect(entries).not.toContain("dynamic-prompt.ts");
      // By identity too: a symlink under another name still loads it. A broken
      // symlink is the next test's failure, not this one's.
      const aliases = entries.filter((e) => {
        try {
          return realpathSync(join(extDir, e)) === DYNAMIC_PROMPT;
        } catch {
          return false;
        }
      });
      expect(aliases).toEqual([]);
    });

    test(`${p.name}/extensions holds only symlinks into agent/, its own .ts, or pinned files`, () => {
      const bad: string[] = [];
      for (const e of readdirSync(extDir)) {
        const path = join(extDir, e);
        if (lstatSync(path).isSymbolicLink()) {
          // A broken symlink throws here, which is a failure worth its own message.
          let real: string;
          try {
            real = realpathSync(path);
          } catch {
            bad.push(`${p.name}/extensions/${e} (broken symlink)`);
            continue;
          }
          if (!real.startsWith(HOME + "/")) bad.push(`${p.name}/extensions/${e} -> ${real} (outside agent/)`);
          continue;
        }
        if (e.endsWith(".ts") && statSync(path).isFile()) {
          // The profile's own, unless agent/extensions has a file of the same
          // name: then this is a real copy of a shared extension, and it drifts.
          if (existsSync(join(HOME_EXT, e))) bad.push(`${p.name}/extensions/${e} (real copy of agent/extensions/${e})`);
          continue;
        }
        if (!ALLOWED_OWN.has(e)) bad.push(`${p.name}/extensions/${e} (real entry, not allowlisted)`);
      }
      expect(bad).toEqual([]);
    });

    // The trailing slash on `sessions/` matters: a directory-only pattern does
    // not match a bare path. One spawn per path, because `check-ignore -q` with
    // several paths exits 0 when ANY of them is ignored.
    for (const rel of [`${p.name}/.env`, `${p.name}/sessions/`]) {
      test(`${rel} is gitignored`, () => {
        const r = spawnSync("git", ["check-ignore", "-q", rel], { cwd: ROOT, env: gitEnv() });
        expect(r.status).toBe(0);
      });
    }
  }
});
