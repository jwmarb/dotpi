/**
 * Live-tree invariants for the categorized skills library.
 *
 * Every other skill test uses a tmpdir fixture, which is the right default: a
 * unit test that depends on the real `agent/skills/` is a test that breaks when
 * you add a skill. This file deliberately does the opposite, because the failure
 * mode that motivated it is invisible to fixtures.
 *
 * `agent/skills/` was flat — `skills/<skill>/SKILL.md` — and three readers
 * hardcoded that shape as a one-level `readdir`:
 *
 *   - `loadSkillToolOwners` (skill-activation.ts): tool gating
 *   - `discoverSkillAgents` (agents.ts): the 24 skills shipping `agents/`
 *   - `discoverSkills` (subagent-herdr/lib.ts): the `skills:` frontmatter key
 *
 * Nesting into `skills/<category>/<skill>/` breaks all three *silently*: pi's
 * own loader recurses (`dist/core/skills.js`), so the skill still appears in the
 * catalogue and still loads by hand. What disappears is its tooling — a
 * `trade_journal` that is never offered, an `agents/` directory that is never
 * found. Nothing throws. The skill simply stops working, and the first symptom
 * is a model that cannot explain why its tool is missing.
 *
 * So these tests assert reachability against the tree as it actually is on
 * disk. They are intentionally count-free where a count would rot: the
 * assertions are "every SKILL.md on disk is reachable by every reader" and
 * "every skill shipping agents/ still yields them", not "there are 37 skills".
 *
 * Run from the repo root: `bun test agent/extensions/lib/skill-catalogue.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { discoverSkillAgents } from "./agents.js";
import { skillsDir } from "./layout.js";
import { loadSkillToolOwners, skillDirFromPath } from "./skill-activation.js";

const SKILLS = skillsDir();

/**
 * Every `SKILL.md` under `agent/skills/`, at any depth.
 *
 * Mirrors pi's own rule (`loadSkillsFromDirInternal`): a directory holding a
 * `SKILL.md` is a skill root and is not descended into, so a reference doc that
 * happens to be named `SKILL.md` inside a skill cannot register as a second
 * skill. Walking the real tree rather than globbing a fixed depth is what lets
 * these tests outlive another reorganization.
 */
function findSkillRoots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.name === "SKILL.md" && !e.isDirectory())) {
    return [join(dir, "SKILL.md")];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) out.push(...findSkillRoots(full));
  }
  return out;
}

const skillFiles = findSkillRoots(SKILLS);
/** Skill directory names — the identity `skills:` and the gate both match on. */
const skillNames = skillFiles.map((f) => basename(dirname(f)));

describe("the skills library on disk", () => {
  test("is non-empty, so a broken path cannot make every assertion below vacuous", () => {
    // Without this, a typo'd skillsDir() would make the whole file pass green
    // against zero skills — the exact failure these tests exist to catch.
    expect(skillFiles.length).toBeGreaterThan(20);
  });

  test("gives every skill a unique directory name", () => {
    // The directory name is the identity, so two skills sharing one means the
    // `skills:` key and the tool gate silently address only whichever wins.
    const dupes = skillNames.filter((n, i) => skillNames.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  test("keeps every skill directory name a valid pi skill name", () => {
    // pi validates with /^[a-z0-9-]+$/ (dist/core/skills.js) and warns rather
    // than failing, so an underscore or capital degrades to a diagnostic nobody
    // reads. A rename pass is exactly when this slips.
    const bad = skillNames.filter((n) => !/^[a-z0-9-]+$/.test(n));
    expect(bad).toEqual([]);
  });
});

describe("reader reachability (the silent-loss guard)", () => {
  test("the tool-owner gate sees every skill that declares a tool", async () => {
    // loadSkillToolOwners must reach the same SKILL.md set pi does. If it only
    // scans one level, a nested skill's `tools:` is never registered and its
    // tool is offered unconditionally (or never gated) with no error at all.
    const owners = await loadSkillToolOwners(SKILLS);

    // Read frontmatter directly to find who *should* be in the map.
    const expected = new Set<string>();
    for (const f of skillFiles) {
      const text = await Bun.file(f).text();
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
      if (fm && /^tools:\s*\S/m.test(fm)) expected.add(basename(dirname(f)));
    }

    const reached = new Set(owners.values());
    for (const skill of expected) {
      expect(reached.has(skill)).toBe(true);
    }
  });

  test("the trade_journal gate still resolves to its owning skill", async () => {
    // The one concrete tool-owning skill in the repo, and the only one whose
    // breakage is user-visible as "my journal tool vanished".
    const owners = await loadSkillToolOwners(SKILLS);
    const owner = owners.get("trade_journal");
    expect(owner).toBeDefined();
    expect(skillNames).toContain(owner!);
  });

  test("every skill shipping agent definitions still yields them", async () => {
    // Gate on `agents/*.md`, not on the existence of `agents/`: 23 of the 24
    // agents/ directories here hold only `openai.yaml` (optional presentation
    // metadata) and define no agent at all. Asserting on the directory would
    // demand agents from skills that ship none — the test would fail on a
    // perfectly healthy tree, which is how a guard gets deleted instead of
    // fixed. Today `technical-analysis` is the only real provider.
    const withAgents = skillFiles
      .map((f) => dirname(f))
      .filter((d) => {
        const dir = join(d, "agents");
        if (!existsSync(dir)) return false;
        return readdirSync(dir).some((e) => e.endsWith(".md"));
      })
      .map((d) => basename(d));
    expect(withAgents.length).toBeGreaterThan(0);

    const discovered = await discoverSkillAgents(SKILLS);
    const covered = new Set(discovered.map((a) => a.skill));
    for (const skill of withAgents) {
      expect(covered.has(skill)).toBe(true);
    }
  });

  test("restricting discovery to one skill still works when it is nested", async () => {
    // The `only` filter matches on the directory name, not the path. If nesting
    // ever changed that identity, `skills: technical-analysis` would resolve to
    // nothing while looking perfectly correct in the agent file.
    const target = skillFiles
      .map((f) => dirname(f))
      .filter((d) => {
        const dir = join(d, "agents");
        return existsSync(dir) && readdirSync(dir).some((e) => e.endsWith(".md"));
      })
      .map((d) => basename(d))[0];
    expect(target).toBeDefined();

    const agents = await discoverSkillAgents(SKILLS, [target]);
    expect(agents.length).toBeGreaterThan(0);
    expect(new Set(agents.map((a) => a.skill))).toEqual(new Set([target]));
  });

  test("activation keys a nested SKILL.md path to its directory, not its category", async () => {
    // A `/skill:x` invocation and a read_skill both route through
    // skillDirFromPath. Returning the category would activate the wrong thing
    // for every skill at once.
    for (const f of skillFiles) {
      expect(skillDirFromPath(f)).toBe(basename(dirname(f)));
    }
  });
});

describe("category layout", () => {
  test("no skill sits loose at the top level of the library", () => {
    // The point of the reorganization: every skill lives under a category. A
    // skill added flat still works, so only a test keeps the tree tidy.
    const loose = skillFiles.filter((f) => relative(SKILLS, f).split("/").length < 3);
    expect(loose).toEqual([]);
  });
});
