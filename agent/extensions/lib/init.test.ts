/**
 * `/init`'s tiering decision.
 *
 * `init.ts` scores every directory and hands the model a brief saying which ones
 * deserve an `AGENTS.md`. Those thresholds are the whole behaviour of the
 * command, and they were untested — not because they were unreachable (a test in
 * `lib/` may import a top-level extension; see `agent/extensions/AGENTS.md`) but
 * because this repo's own docs said they were.
 *
 * The seam is `planTiers` plus the two small functions either side of it
 * (`tierStatus`, `parseInitArgs`). The scoring helpers behind `planTiers` stay
 * private: asserting on `scoreDir`'s arithmetic would pin an implementation that
 * is meant to be tuned, while `planTiers` pins the decision that is actually
 * promised.
 *
 * Fixtures are real temp directories, with and without git, because the code
 * takes a different path for each (`git ls-files -z` vs a manual walk) and a
 * fixture that only exercised one would miss half the behaviour.
 *
 * Run: `bun test agent/extensions/lib/init.test.ts`
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseInitArgs, planTiers, tierStatus } from "../init.js";

const made: string[] = [];

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh scratch directory, cleaned up after the test. */
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "init-test-"));
  made.push(d);
  return d;
}

/** Write a file, creating parents. */
function file(root: string, rel: string, body = "export const x = 1;\n"): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

/** Make `root` a git repo with everything committed, so `ls-files` sees it. */
function gitInit(root: string): void {
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
  run("init", "-q");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "T");
  run("add", "-A");
  run("commit", "-qm", "init");
}

/**
 * A directory shaped to clear the "create" threshold: >20 files, >70% code,
 * a build config, a module boundary file, and enough exported symbols.
 */
function fatModule(root: string, dir: string, count = 30): void {
  for (let i = 0; i < count; i++) {
    file(
      root,
      `${dir}/mod${i}.ts`,
      Array.from({ length: 4 }, (_, k) => `export const s${i}_${k} = ${k};`).join("\n"),
    );
  }
  file(root, `${dir}/package.json`, "{}\n");
  file(root, `${dir}/index.ts`, "export * from './mod0.js';\n");
}

describe("tierStatus pins the two thresholds", () => {
  // CREATE_ABOVE = 15 (strictly greater), CANDIDATE_FROM = 8 (inclusive).
  // These decide what /init writes, so the boundaries are the contract.
  test("above 15 creates", () => {
    expect(tierStatus(16)).toBe("create");
    expect(tierStatus(100)).toBe("create");
  });

  test("exactly 15 is a candidate, not a create", () => {
    expect(tierStatus(15)).toBe("candidate");
  });

  test("exactly 8 is still a candidate", () => {
    expect(tierStatus(8)).toBe("candidate");
  });

  test("below 8 earns no tier at all", () => {
    expect(tierStatus(7)).toBeUndefined();
    expect(tierStatus(0)).toBeUndefined();
    expect(tierStatus(-1)).toBeUndefined();
  });
});

describe("parseInitArgs", () => {
  test("an empty string is all defaults", () => {
    expect(parseInitArgs("")).toEqual({
      scope: undefined,
      maxDepth: 3,
      createNew: false,
      unknown: [],
    });
  });

  test("a bare word is the scope", () => {
    expect(parseInitArgs("src").scope).toBe("src");
  });

  test("--create-new is a flag, not a scope", () => {
    const p = parseInitArgs("--create-new");
    expect(p.createNew).toBe(true);
    expect(p.scope).toBeUndefined();
  });

  test("--max-depth is parsed when in range", () => {
    expect(parseInitArgs("--max-depth=1").maxDepth).toBe(1);
    expect(parseInitArgs("--max-depth=10").maxDepth).toBe(10);
  });

  test("an out-of-range --max-depth is reported, not clamped silently", () => {
    // Clamping would make a typo look like it worked.
    for (const bad of ["--max-depth=0", "--max-depth=11", "--max-depth=abc"]) {
      const p = parseInitArgs(bad);
      expect(p.maxDepth).toBe(3);
      expect(p.unknown).toEqual([bad]);
    }
  });

  test("an unrecognized flag lands in unknown rather than being dropped", () => {
    expect(parseInitArgs("--nope").unknown).toEqual(["--nope"]);
  });

  test("flags and a scope combine, and extra whitespace is tolerated", () => {
    expect(parseInitArgs("  src   --max-depth=2   --create-new  ")).toEqual({
      scope: "src",
      maxDepth: 2,
      createNew: true,
      unknown: [],
    });
  });

  test("the last bare word wins as the scope", () => {
    expect(parseInitArgs("one two").scope).toBe("two");
  });
});

describe("planTiers always returns a usable root tier", () => {
  test("an empty directory still yields the root, so /init never no-ops", () => {
    const root = scratch();
    const plan = planTiers(root, undefined, 3);
    expect(plan.tiers.length).toBeGreaterThanOrEqual(1);
    expect(plan.tiers[0]!.rel).toBe("");
    expect(plan.tiers[0]!.status).toBe("create");
    expect(plan.isGit).toBe(false);
  });

  test("the root tier is scored -1 so it never competes with real tiers", () => {
    // Nested tiers sort by score; the root is prepended, not ranked.
    const root = scratch();
    fatModule(root, "core");
    const plan = planTiers(root, undefined, 3);
    expect(plan.tiers[0]!.rel).toBe("");
    expect(plan.tiers[0]!.score).toBe(-1);
  });

  test("the root tier counts every discovered file", () => {
    const root = scratch();
    file(root, "a.ts");
    file(root, "b.ts");
    file(root, "sub/c.ts");
    expect(planTiers(root, undefined, 3).tiers[0]!.fileCount).toBe(3);
  });

  test("reports an existing context file at the root instead of proposing a fresh one", () => {
    const root = scratch();
    file(root, "AGENTS.md", "# existing\n");
    file(root, "a.ts");
    expect(planTiers(root, undefined, 3).tiers[0]!.existing).toContain("AGENTS.md");
  });
});

describe("discovery works with and without git", () => {
  test("a non-git directory is walked directly", () => {
    const root = scratch();
    fatModule(root, "core");
    const plan = planTiers(root, undefined, 3);
    expect(plan.isGit).toBe(false);
    expect(plan.tiers.some((t) => t.rel === "core")).toBe(true);
  });

  test("a git repository is read through ls-files and reports isGit", () => {
    const root = scratch();
    fatModule(root, "core");
    gitInit(root);
    const plan = planTiers(root, undefined, 3);
    expect(plan.isGit).toBe(true);
    expect(plan.tiers.some((t) => t.rel === "core")).toBe(true);
  });

  test("an untracked file is invisible in a git repo, which is the point of ls-files", () => {
    // A build artifact must not pull a directory over the threshold.
    const root = scratch();
    fatModule(root, "core");
    gitInit(root);
    const tracked = planTiers(root, undefined, 3).tiers[0]!.fileCount;
    for (let i = 0; i < 50; i++) file(root, `junk/gen${i}.ts`);
    expect(planTiers(root, undefined, 3).tiers[0]!.fileCount).toBe(tracked);
  });
});

describe("scoring and selection", () => {
  test("a substantial module earns a tier; a trivial one does not", () => {
    const root = scratch();
    fatModule(root, "core");
    file(root, "tiny/one.ts");
    const rels = planTiers(root, undefined, 3).tiers.map((t) => t.rel);
    expect(rels).toContain("core");
    expect(rels).not.toContain("tiny");
  });

  test("every selected tier carries a reason, so the brief can justify it", () => {
    const root = scratch();
    fatModule(root, "core");
    for (const t of planTiers(root, undefined, 3).tiers) {
      expect(t.reasons.length).toBeGreaterThan(0);
    }
  });

  test("nested tiers are ordered by descending score", () => {
    const root = scratch();
    fatModule(root, "big", 40);
    fatModule(root, "small", 22);
    const nested = planTiers(root, undefined, 3).tiers.slice(1);
    for (let i = 1; i < nested.length; i++) {
      expect(nested[i]!.score).toBeLessThanOrEqual(nested[i - 1]!.score);
    }
  });

  test("no tier is ever below the candidate threshold", () => {
    // The selection loop and tierStatus must not disagree.
    const root = scratch();
    fatModule(root, "core");
    file(root, "tiny/one.ts");
    for (const t of planTiers(root, undefined, 3).tiers.slice(1)) {
      expect(tierStatus(t.score)).toBeDefined();
    }
  });

  test("at most ten nested tiers are kept", () => {
    const root = scratch();
    for (let i = 0; i < 14; i++) fatModule(root, `mod${i}`, 24);
    expect(planTiers(root, undefined, 3).tiers.slice(1).length).toBeLessThanOrEqual(10);
  });
});

describe("maxDepth and scope", () => {
  test("maxDepth excludes directories deeper than it", () => {
    const root = scratch();
    fatModule(root, "a/b/c/deep");
    const shallow = planTiers(root, undefined, 1).tiers.map((t) => t.rel);
    expect(shallow).not.toContain("a/b/c/deep");
  });

  test("a scope restricts the scan to that subtree", () => {
    const root = scratch();
    fatModule(root, "keep/core");
    fatModule(root, "ignore/other");
    const plan = planTiers(root, "keep", 3);
    expect(plan.root.endsWith("keep")).toBe(true);
    for (const t of plan.tiers) {
      expect(t.rel.startsWith("ignore")).toBe(false);
    }
  });

  test("a scope inside a git repo still resolves", () => {
    const root = scratch();
    fatModule(root, "keep/core");
    gitInit(root);
    const plan = planTiers(root, "keep", 3);
    expect(plan.isGit).toBe(true);
    expect(plan.tiers[0]!.fileCount).toBeGreaterThan(0);
  });

  test("a missing scope throws, naming the scope it was given", () => {
    // Silently scanning the whole repo instead would be worse than failing.
    const root = scratch();
    expect(() => planTiers(root, "nope", 3)).toThrow(/nope/);
  });
});
