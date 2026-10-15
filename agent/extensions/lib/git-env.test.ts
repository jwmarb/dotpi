/**
 * `gitEnv` — the one environment rule for git spawns that target a `cwd`.
 *
 * The incident this pins: a commit in a linked worktree ran the pre-commit hook
 * with `GIT_DIR`/`GIT_INDEX_FILE` exported, `bun test` inherited them, and
 * `lib/init.test.ts`'s fixture `git init`/`git config`/`git commit` ignored
 * their `cwd` and rewrote the REAL repository (`core.bare=true`, a test
 * `user.email`, junk commits). Every repo here is a scratch dir in `os.tmpdir()`;
 * the poisoned env is passed explicitly to each spawn, so nothing in this file
 * can reach the repository it lives in — except (c), which sets
 * `process.env.GIT_DIR` to a *scratch* repo and restores it in `finally`.
 *
 * Run: `bun test agent/extensions/lib/git-env.test.ts`
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planTiers } from "../init.js";
import { GIT_LOCATION_VARS, gitEnv } from "./git-env.js";

const made: string[] = [];

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "git-env-test-"));
  made.push(d);
  return d;
}

/** Same guard as `lib/init.test.ts`: skip, don't fail, where git can't be spawned. */
const gitOk = (() => {
  try {
    execFileSync("git", ["--version"], { env: gitEnv(), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Run git in `cwd` under exactly `env`, returning trimmed stdout. */
function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** A scratch repo with one commit, built under a clean env. Returns its root. */
function outerRepo(): string {
  const root = scratch();
  const env = gitEnv();
  writeFileSync(join(root, "outer.txt"), "outer\n");
  git(root, env, "init", "-q");
  // Identity via -c, so the outer repo's own config never gains a user.email.
  git(root, env, "add", "-A");
  git(root, env, "-c", "user.email=o@example.com", "-c", "user.name=O", "commit", "-qm", "outer");
  return root;
}

/** Read one key from a repo's own `.git/config` file; `undefined` when unset. */
function configKey(root: string, key: string): string | undefined {
  try {
    return execFileSync("git", ["config", "--file", join(root, ".git", "config"), "--get", key], {
      env: gitEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

describe("gitEnv strips exactly the repo-locating variables", () => {
  test("every listed key is removed", () => {
    const base = Object.fromEntries(GIT_LOCATION_VARS.map((k) => [k, `/poison/${k}`]));
    const env = gitEnv(base);
    for (const k of GIT_LOCATION_VARS) expect(env[k]).toBeUndefined();
  });

  test("the list is the documented nine", () => {
    expect([...GIT_LOCATION_VARS].sort()).toEqual(
      [
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_COMMON_DIR",
        "GIT_CONFIG",
        "GIT_DIR",
        "GIT_INDEX_FILE",
        "GIT_NAMESPACE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_PREFIX",
        "GIT_WORK_TREE",
      ],
    );
  });

  test("everything else is kept, and the input is not mutated", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      GIT_AUTHOR_NAME: "A",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_DIR: "/poison",
    };
    const env = gitEnv(base);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      GIT_AUTHOR_NAME: "A",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
    expect(base.GIT_DIR).toBe("/poison");
    expect(env).not.toBe(base);
  });

  test("defaults to process.env", () => {
    expect(gitEnv().PATH).toBe(process.env.PATH);
  });
});

describe("a poisoned GIT_DIR cannot redirect a fixture's git at the outer repo", () => {
  test.skipIf(!gitOk)("init/config/add/commit land in the fixture, not the outer repo", () => {
    const outer = outerRepo();
    const outerHead = git(outer, gitEnv(), "rev-parse", "HEAD");
    const outerBare = configKey(outer, "core.bare");

    // The hook's shape: GIT_DIR and GIT_INDEX_FILE point at the outer repo.
    const poisoned: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_DIR: join(outer, ".git"),
      GIT_INDEX_FILE: join(outer, ".git", "index"),
    };

    const fixture = scratch();
    writeFileSync(join(fixture, "f.txt"), "fixture\n");

    // Control: the poison is real — unstripped, git resolves the OUTER repo
    // from the fixture's cwd. (Read-only.)
    expect(git(fixture, poisoned, "rev-parse", "--absolute-git-dir")).toBe(
      git(outer, gitEnv(), "rev-parse", "--absolute-git-dir"),
    );

    const env = gitEnv(poisoned);
    git(fixture, env, "init", "-q");
    git(fixture, env, "config", "user.email", "t@example.com");
    git(fixture, env, "config", "user.name", "T");
    git(fixture, env, "add", "-A");
    git(fixture, env, "commit", "-qm", "init");

    // The outer repo is untouched.
    expect(configKey(outer, "user.email")).toBeUndefined();
    expect(configKey(outer, "user.name")).toBeUndefined();
    expect(configKey(outer, "core.bare")).toBe(outerBare);
    expect(git(outer, gitEnv(), "rev-parse", "HEAD")).toBe(outerHead);
    expect(git(outer, gitEnv(), "rev-list", "--count", "HEAD")).toBe("1");

    // The fixture got its own repo and its own commit.
    expect(readFileSync(join(fixture, ".git", "config"), "utf8")).toContain("t@example.com");
    expect(git(fixture, gitEnv(), "log", "--format=%s", "-1")).toBe("init");
    expect(git(fixture, gitEnv(), "ls-files")).toBe("f.txt");
  });
});

describe("init discovery reads the repo at cwd even under a poisoned process.env", () => {
  test.skipIf(!gitOk)("planTiers counts the fixture's files, not the outer index", () => {
    const outer = outerRepo();
    // Give the outer index many more files than the fixture so a leak shows.
    for (let i = 0; i < 12; i++) writeFileSync(join(outer, `o${i}.ts`), "export const o = 1;\n");
    git(outer, gitEnv(), "add", "-A");

    const fixture = scratch();
    mkdirSync(join(fixture, "src"));
    writeFileSync(join(fixture, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(fixture, "b.ts"), "export const b = 1;\n");
    const env = gitEnv();
    git(fixture, env, "init", "-q");
    git(fixture, env, "add", "-A");
    git(fixture, env, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "init");

    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    try {
      process.env.GIT_DIR = join(outer, ".git");
      process.env.GIT_INDEX_FILE = join(outer, ".git", "index");
      const plan = planTiers(fixture, undefined, 3);
      expect(plan.isGit).toBe(true);
      expect(plan.tiers[0]!.fileCount).toBe(2);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
