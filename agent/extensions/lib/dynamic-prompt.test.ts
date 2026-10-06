/**
 * The orchestrator system prompt.
 *
 * `dynamic-prompt.ts` replaces pi's default prompt entirely, so this builder's
 * output *is* what every session's model reads. It had no tests for a long time,
 * not because it was hard to test but because this repo's own AGENTS.md claimed
 * a top-level extension's logic could not be reached from a test at all. That was
 * wrong: the rule bars a `*.test.ts` from sitting in `agent/extensions/` (pi
 * auto-loads it and dies on `bun:test`), and says nothing about what a test in
 * `lib/` may import. `lib/sessions.test.ts` had been importing `../sessions.js`
 * all along.
 *
 * So these assertions cross the module's real seam: the single exported
 * `buildOrchestratorPrompt`. Its section builders stay private, and that is
 * deliberate — a test that reached them would pin the implementation and would
 * not be able to pin section *ordering*, which is the thing most likely to break
 * silently when a section is added.
 *
 * Assertions are semantic (is this section present, in this order, naming this
 * tool) rather than one whole-text snapshot: wording in a prompt changes for good
 * reasons, and a snapshot would make every such change look like a regression.
 *
 * Run: `bun test agent/extensions/lib/dynamic-prompt.test.ts`
 */
import { describe, expect, test } from "bun:test";

import { buildOrchestratorPrompt } from "../dynamic-prompt.js";

/** A minimal valid call; each test overrides only what it is about. */
function build(overrides: Partial<Parameters<typeof buildOrchestratorPrompt>[0]> = {}) {
  return buildOrchestratorPrompt({
    agentInventory: [],
    toolInventory: [],
    skillInventory: [],
    contextInventory: [],
    guidelines: [],
    hasQuestionnaire: false,
    // True by default: the agent sections are what most of these tests are about,
    // and a session without the spawn tool is the exception, not the baseline.
    hasSubagent: true,
    cwd: "/work/repo",
    skillsLibrary: "/home/u/.pi/agent/skills",
    // Fixed so the footer is assertable without freezing time globally.
    now: new Date(2026, 0, 5),
    ...overrides,
  });
}

describe("the prompt is always well-formed", () => {
  test("names itself and its core responsibilities even with every inventory empty", () => {
    // The degenerate case is the one a fresh install hits, and an empty
    // inventory must not produce a prompt with dangling headings.
    const p = build();
    expect(p).toContain("# Orchestrator Agent");
    expect(p).toContain("## Core Responsibilities");
    expect(p).toContain("## Decision Framework");
    expect(p).toContain("## Error Handling");
  });

  test("ends with the date and cwd footer", () => {
    const p = build();
    expect(p).toContain("Current date: 2026-01-05");
    expect(p.trimEnd().endsWith("Current working directory: /work/repo")).toBe(true);
  });

  test("pads single-digit months and days, so the footer is always ISO-shaped", () => {
    // `getMonth()` is 0-based and neither field is padded by default — the exact
    // shape a hand-rolled date formatter gets wrong.
    expect(build({ now: new Date(2026, 8, 9) })).toContain("Current date: 2026-09-09");
    expect(build({ now: new Date(2026, 11, 31) })).toContain("Current date: 2026-12-31");
  });

  test("emits no section heading for an inventory that is empty", () => {
    // A heading with nothing under it reads to the model as a capability it has
    // and cannot use.
    const p = build();
    expect(p).not.toContain("## Available Tools");
    expect(p).not.toContain("## Available Agents");
    expect(p).not.toContain("## Available Skills");
    expect(p).not.toContain("## Project Context");
  });
});

describe("the tool inventory", () => {
  test("renders a row per tool", () => {
    const p = build({
      toolInventory: [
        { name: "read", description: "Read a file" },
        { name: "bash", description: "Run a command" },
      ],
    });
    expect(p).toContain("## Available Tools");
    expect(p).toContain("read");
    expect(p).toContain("Read a file");
    expect(p).toContain("bash");
  });
});

describe("the questionnaire sections are gated on the tool existing", () => {
  // Three separate places mention the tool, and a prompt that instructs the
  // model to call a tool it was never offered is the failure being guarded.
  test("absent when the tool is not available", () => {
    const p = build({ hasQuestionnaire: false });
    expect(p).not.toContain("## Asking the User");
    expect(p).not.toContain("questionnaire");
  });

  test("present in all three places when it is", () => {
    const p = build({ hasQuestionnaire: true });
    expect(p).toContain("## Asking the User");
    // Decompose step and Error Handling both gain a clause.
    expect(p).toContain("ask using the `questionnaire` tool before planning");
    expect(p).toContain("ask via the `questionnaire` tool instead of assuming");
  });
});

describe("the quality pass is gated on the grading agents existing", () => {
  // Same failure mode as the questionnaire gate: a prompt ordering a delegation
  // to an agent this install does not have is an instruction the model cannot
  // obey. The orchestrator is the one agent with no parent to grade it, so this
  // section is what makes its own edits subject to the same gate a `worker`'s
  // diff already passes through.
  const agent = (name: string) =>
    ({ name, description: "d", model: "m", tools: [], source: "global" }) as never;

  test("absent when neither grader is in the inventory", () => {
    const p = build({ agentInventory: [agent("worker"), agent("explorer")] });
    expect(p).not.toContain("## Quality Pass");
  });

  test("absent on an empty inventory, which a fresh install hits", () => {
    expect(build()).not.toContain("## Quality Pass");
  });

  test("names both graders when both exist", () => {
    const p = build({ agentInventory: [agent("reviewer"), agent("verifier")] });
    expect(p).toContain("## Quality Pass");
    expect(p).toContain('subagent(agent: "reviewer"');
    expect(p).toContain('subagent(agent: "verifier"');
  });

  test("names only the grader that exists, and drops the verifier-only guidance", () => {
    // The image-tag caveat is meaningless without the verifier, and advertising
    // a container workflow for an agent that is absent is the same bug again.
    const p = build({ agentInventory: [agent("reviewer")] });
    expect(p).toContain("## Quality Pass");
    expect(p).toContain('subagent(agent: "reviewer"');
    expect(p).not.toContain('subagent(agent: "verifier"');
    expect(p).not.toContain("ralph-verify/*");
  });

  test("sits after the agent inventory it refers to", () => {
    // It names agents by name, so the table that introduces them must come first.
    const p = build({ agentInventory: [agent("reviewer"), agent("verifier")] });
    expect(p.indexOf("## Available Agents")).toBeLessThan(p.indexOf("## Quality Pass"));
    expect(p.indexOf("## Quality Pass")).toBeLessThan(p.indexOf("Current date:"));
  });

  test("leaves no unexpanded template expression", () => {
    // The section interpolates a mapped list and a nested conditional; an
    // escaping slip would ship literal `${...}` into every request.
    const p = build({ agentInventory: [agent("reviewer"), agent("verifier")] });
    const section = p.slice(p.indexOf("## Quality Pass"), p.indexOf("Current date:"));
    expect(section).not.toContain("${");
  });
});

describe("the planning section is gated on the planner agent existing", () => {
  // Same gate as the questionnaire and the quality pass: a prompt that orders a
  // delegation to an agent this install does not have is an instruction the
  // model cannot obey. The orchestrator's weakest moment is starting to edit
  // from a plan it holds only in its own head, so when `planner` *is* present
  // the prompt has to push toward it rather than merely mention it.
  const agent = (name: string) =>
    ({ name, description: "d", model: "m", tools: [], source: "global" }) as never;

  test("absent when the planner is not in the inventory", () => {
    const p = build({ agentInventory: [agent("reviewer"), agent("verifier")] });
    expect(p).not.toContain("## Plan Before You Implement");
  });

  test("absent on an empty inventory, which a fresh install hits", () => {
    expect(build()).not.toContain("## Plan Before You Implement");
  });

  test("leaves the two generic planning steps untouched when the planner is absent", () => {
    // Without the agent, step 3 must still read as a plain instruction rather
    // than a dangling reference to a section that was never emitted.
    const p = build();
    expect(p).toContain("3. Design a step-by-step plan");
    expect(p).toContain(
      "2. **Plan** \u2014 Consult the skills catalogue first, then determine",
    );
    expect(p).not.toContain("planner");
  });

  test("present, and pushed as the default, when the planner exists", () => {
    // "Encouraged" is the whole point: an advisory mention reads as a licence to
    // skip, which is the failure the skills catalogue already learned once.
    const p = build({ agentInventory: [agent("planner")] });
    expect(p).toContain("## Plan Before You Implement");
    expect(p).toContain("delegate the plan to `planner` before you");
    expect(p).toContain("Name any skip");
  });

  test("rewires both numbered planning steps to route through the planner", () => {
    // The section alone is not enough: Core Responsibilities and the Decision
    // Framework are what the model reads first, and a step 3 still saying
    // "design a plan" would contradict the section further down.
    const p = build({ agentInventory: [agent("planner")] });
    expect(p).toContain("delegate the plan to `planner` for anything beyond a trivial edit");
    expect(p).toContain("3. Delegate the plan to `planner`");
    expect(p).not.toContain("3. Design a step-by-step plan");
  });

  test("states the trigger scope as multi-file or multi-step, and exempts trivia", () => {
    // The scope is a deliberate choice: routing a typo through three agents is
    // as wrong as improvising a refactor.
    const p = build({ agentInventory: [agent("planner")] });
    expect(p).toContain("spans two or more files, or needs three or more steps");
    expect(p).toContain("a typo, a one-line fix");
  });

  test("binds the planner to both graders when they exist", () => {
    // The user-facing rule being pinned: calling `planner` obliges a review of
    // the implementation and a runtime check that it works.
    const p = build({
      agentInventory: [agent("planner"), agent("reviewer"), agent("verifier")],
    });
    expect(p).toContain("grading obligation");
    expect(p).toContain("graded by `reviewer` and `verifier`");
    expect(p).toContain("`reviewer` reads the implementation for correctness");
    expect(p).toContain("`verifier` proves it actually runs");
  });

  test("keeps the worker exemption, so a self-graded diff is not graded twice", () => {
    // A `worker` ends its own run by handing its diff to these same two agents.
    // Re-grading it buys a duplicate pass and nothing else, and the Quality Pass
    // section already says so — the two must not contradict each other.
    const p = build({
      agentInventory: [agent("planner"), agent("reviewer"), agent("verifier")],
    });
    expect(p).toContain("a `worker` has passed its own diff through these graders");
    expect(p).toContain("Grade what **you** implemented");
  });

  test("drops the grading obligation when no grader can be spawned", () => {
    // Naming a grader this install lacks is the bug the gate exists to prevent,
    // and here it would also promise a pass that can never run.
    const p = build({ agentInventory: [agent("planner")] });
    expect(p).toContain("## Plan Before You Implement");
    expect(p).not.toContain("grading obligation");
    expect(p).not.toContain("## Quality Pass");
  });

  test("agrees in number with a single grader, in both single-grader installs", () => {
    // Regression: the "Launch them in one turn so they run concurrently ... those
    // two tasks" wording was hardcoded outside the conditional, so a one-grader
    // install was told to launch two agents concurrently when only one existed.
    // `planner`+`verifier` is the combination that had no coverage at all.
    for (const other of ["reviewer", "verifier"]) {
      const p = build({ agentInventory: [agent("planner"), agent(other)] });
      const section = p.slice(
        p.indexOf("## Plan Before You Implement"),
        p.indexOf("## Quality Pass"),
      );
      expect(section).toContain("Launch it, then end your turn");
      expect(section).toContain("how to write that task");
      expect(section).toContain("through this grader");
      // The plural forms must be absent, not merely outnumbered.
      expect(section).not.toContain("Launch them");
      expect(section).not.toContain("they run concurrently");
      expect(section).not.toContain("those two tasks");
      expect(section).not.toContain("these graders");
    }
  });

  test("uses the plural only when both graders are present", () => {
    const p = build({
      agentInventory: [agent("planner"), agent("reviewer"), agent("verifier")],
    });
    const section = p.slice(
      p.indexOf("## Plan Before You Implement"),
      p.indexOf("## Quality Pass"),
    );
    expect(section).toContain("Launch them");
    expect(section).toContain("they run concurrently");
    expect(section).toContain("those two tasks");
    expect(section).toContain("these graders");
    expect(section).not.toContain("Launch it,");
    expect(section).not.toContain("this grader");
  });

  test("pairs each grader with its own role, never the other's", () => {
    // The roles are keyed off the roster; a mix-up would describe the verifier as
    // reading code, or the reviewer as proving it runs. Singular omits the
    // redundant second mention of the name — the list just named it — so the
    // assertion is on the role text, not on a repeated backticked name.
    const rev = build({ agentInventory: [agent("planner"), agent("reviewer")] });
    expect(rev).toContain("graded by `reviewer` before");
    expect(rev).toContain("it reads the implementation for correctness");
    expect(rev).not.toContain("proves it actually runs");

    const ver = build({ agentInventory: [agent("planner"), agent("verifier")] });
    expect(ver).toContain("graded by `verifier` before");
    expect(ver).toContain("it proves it actually runs");
    expect(ver).not.toContain("reads the implementation for correctness");

    // Only the both-graders case repeats the names, because there the roles
    // would otherwise be ambiguous about which agent does which.
    const both = build({
      agentInventory: [agent("planner"), agent("reviewer"), agent("verifier")],
    });
    expect(both).toContain("`reviewer` reads the implementation for correctness");
    expect(both).toContain("`verifier` proves it actually runs");
  });

  test("states the verifier's obligation as conditional, not absolute", () => {
    // Quality Pass and `agents/worker.md` both qualify the verifier on the change
    // being runtime-testable. The section that *introduces* the obligation must
    // agree, or the model launches a container run for a prose edit.
    const both = build({
      agentInventory: [agent("planner"), agent("reviewer"), agent("verifier")],
    });
    expect(both).toContain("`verifier` applies only when execution can settle the change");
    expect(both).toContain("`reviewer` always applies");

    // Verifier-only still carries the caveat; reviewer-only must not, since the
    // condition is the verifier's alone.
    const ver = build({ agentInventory: [agent("planner"), agent("verifier")] });
    expect(ver).toContain("`verifier` applies only when execution can settle the change");
    expect(ver).not.toContain("always applies");

    const rev = build({ agentInventory: [agent("planner"), agent("reviewer")] });
    expect(rev).not.toContain("applies when the change");
  });

  test("leaves no dangling comma or empty clause in the role list", () => {
    // The role list used to be two conditionals joined by a separate conditional
    // comma — three expressions that had to agree, and the shape most likely to
    // emit " — , and …" or a sentence starting with a comma.
    for (const inv of [
      [agent("planner"), agent("reviewer")],
      [agent("planner"), agent("verifier")],
      [agent("planner"), agent("reviewer"), agent("verifier")],
    ]) {
      const p = build({ agentInventory: inv });
      const section = p.slice(
        p.indexOf("## Plan Before You Implement"),
        p.indexOf("## Quality Pass"),
      );
      expect(section).not.toContain("\u2014 ,");
      expect(section).not.toContain(", and .");
      expect(section).not.toContain("done \u2014 .");
      expect(section).not.toMatch(/\n\n\n/);
    }
  });

  test("sits between the agent table and the quality pass it defers to", () => {
    // It names agents, so the table must precede it; it points at Quality Pass
    // for how to write the two tasks, so that section must follow it.
    const p = build({
      agentInventory: [agent("planner"), agent("reviewer"), agent("verifier")],
    });
    expect(p.indexOf("## Available Agents")).toBeLessThan(
      p.indexOf("## Plan Before You Implement"),
    );
    expect(p.indexOf("## Plan Before You Implement")).toBeLessThan(p.indexOf("## Quality Pass"));
  });

  test("leaves no unexpanded template expression", () => {
    // The section nests a conditional inside a conditional and interpolates the
    // grader list; an escaping slip would ship literal `${...}` into every request.
    for (const inv of [
      [agent("planner")],
      [agent("planner"), agent("reviewer")],
      [agent("planner"), agent("verifier")],
      [agent("planner"), agent("reviewer"), agent("verifier")],
    ]) {
      const p = build({ agentInventory: inv });
      const section = p.slice(p.indexOf("## Plan Before You Implement"), p.indexOf("Current date:"));
      expect(section).not.toContain("${");
    }
  });

  test("is withheld entirely when the subagent tool is absent", () => {
    // `agentInventory` is read off disk and says nothing about whether the
    // extension that can *spawn* those agents loaded. A strong default ordering a
    // delegation, with no tool to delegate with, is the house rule's exact
    // failure mode — one level up from a missing tool to a missing spawner.
    const p = build({
      hasSubagent: false,
      agentInventory: [agent("planner"), agent("reviewer"), agent("verifier")],
    });
    expect(p).not.toContain("## Plan Before You Implement");
    expect(p).not.toContain("## Quality Pass");
    expect(p).not.toContain("## Available Agents");
    expect(p).not.toContain("planner");
    // The generic fallbacks must be what is left behind.
    expect(p).toContain("3. Design a step-by-step plan");
  });
});

describe("the quality pass agrees in number with its own roster", () => {
  // The planning section was fixed for this and the comment then claimed the
  // whole module was safe — but `## Quality Pass` consumes the same roster and
  // had the identical hardcoded plural, so a single-grader install was told to
  // launch "the graders" "concurrently" beside a code block holding one call.
  const agent = (name: string) =>
    ({ name, description: "d", model: "m", tools: [], source: "global" }) as never;

  const qualityPass = (names: string[]) => {
    const p = build({ agentInventory: names.map(agent) });
    return p.slice(p.indexOf("## Quality Pass"), p.indexOf("Current date:"));
  };

  test("uses the singular for a one-grader install, in both directions", () => {
    for (const only of ["reviewer", "verifier"]) {
      const section = qualityPass([only]);
      expect(section).toContain("- Launch it, then end your turn.");
      expect(section).toContain("passed through this agent");
      expect(section).not.toContain("Launch the graders");
      expect(section).not.toContain("they run concurrently");
      expect(section).not.toContain("through these agents");
    }
  });

  test("uses the plural only when both graders exist", () => {
    const section = qualityPass(["reviewer", "verifier"]);
    expect(section).toContain("Launch the graders in one turn so they run concurrently");
    expect(section).toContain("passed through these agents");
    expect(section).not.toContain("Launch it, then end your turn.");
    expect(section).not.toContain("through this agent");
  });

  test("emits one subagent call per grader, matching the number it describes", () => {
    // The code block and the prose around it are built from the same roster;
    // they must not disagree on how many calls the model should make.
    for (const names of [["reviewer"], ["verifier"], ["reviewer", "verifier"]]) {
      const section = qualityPass(names);
      const calls = section.split("subagent(agent:").length - 1;
      expect(calls).toBe(names.length);
      expect(section.includes("Launch the graders")).toBe(names.length > 1);
    }
  });
});

describe("the retired plan tool leaves no trace", () => {
  // The `plan` extension was deleted in 7a54a3b, but this builder kept a
  // 44-line Planning Discipline section gated on a tool that could no longer
  // exist. It described ops (seed/attach/archive) that nothing implements, and a
  // future unrelated tool named `plan` would have silently inherited it.
  test("no Planning Discipline section", () => {
    expect(build()).not.toContain("Planning Discipline");
  });

  test("no plan-tool vocabulary anywhere in the prompt", () => {
    const p = build();
    for (const op of ["op \"seed\"", "op \"attach\"", "op \"archive\"", "Starter Plan"]) {
      expect(p).not.toContain(op);
    }
  });

  test("a tool merely *named* plan no longer re-arms the section", () => {
    // The old gate matched on the tool name, so this call used to resurrect it.
    const p = build({ toolInventory: [{ name: "plan", description: "unrelated" }] });
    expect(p).not.toContain("Planning Discipline");
  });
});

describe("the skill catalogue", () => {
  const lib = "/home/u/.pi/agent/skills";

  test("groups library skills by their path category, one line each", () => {
    const p = build({
      skillInventory: [
        {
          name: "rust-style",
          description: "Idiomatic Rust",
          filePath: `${lib}/language-style/rust-style/SKILL.md`,
          pathCategory: "language-style",
        },
        {
          name: "cpp-style",
          description: "Idiomatic C++",
          filePath: `${lib}/language-style/cpp-style/SKILL.md`,
          pathCategory: "language-style",
        },
      ],
      skillsLibrary: lib,
    });
    expect(p).toContain("**language-style**");
    expect(p).toContain("- **cpp-style** — Idiomatic C++");
    expect(p).toContain("- **rust-style** — Idiomatic Rust");
    // Names sort alphabetically within a category (`groupByCategory`), not in
    // discovery order, so the prompt is byte-stable across runs — asserted here
    // against insertion order deliberately, which was the reverse.
    expect(p.indexOf("cpp-style")).toBeLessThan(p.indexOf("rust-style"));
    // A library skill's path is implied by the root, so it must not be repeated.
    expect(p).not.toContain(`${lib}/language-style/rust-style/SKILL.md`);
  });

  test("carries every skill's description, which is the whole routing signal", () => {
    // The catalogue was names-only for several revisions and the model mostly
    // did not open anything: a bare name is not enough to justify a read_skill,
    // so a description going missing silently de-fangs the section.
    const p = build({
      skillInventory: [
        {
          name: "wayfinder",
          description: "Find your way around an unfamiliar repo",
          filePath: `${lib}/planning-and-tickets/wayfinder/SKILL.md`,
          pathCategory: "planning-and-tickets",
        },
      ],
      skillsLibrary: lib,
    });
    expect(p).toContain("Find your way around an unfamiliar repo");
  });

  test("a description-less skill still renders a line that says to open it", () => {
    // Dropping the dash would be cosmetic; dropping the skill would hide a
    // capability, so the degenerate case points at the file instead.
    const p = build({
      skillInventory: [
        {
          name: "mute",
          description: "   ",
          filePath: `${lib}/other/mute/SKILL.md`,
          pathCategory: "other",
        },
      ],
      skillsLibrary: lib,
    });
    expect(p).toContain("- **mute** — (no description — open it to find out)");
  });

  test("frames the catalogue as the opening move, not as advisory", () => {
    // The stance is the feature: this section used to say "Skills are advisory —
    // you decide when they apply", which read as a licence to skip and was.
    const p = build({
      skillInventory: [
        {
          name: "rust-style",
          description: "d",
          filePath: `${lib}/language-style/rust-style/SKILL.md`,
          pathCategory: "language-style",
        },
      ],
      skillsLibrary: lib,
    });
    expect(p).toContain("default opening move");
    expect(p).toContain("Name any skip");
    expect(p).not.toContain("Skills are advisory");
    // A push toward skills must not become a mandate that outranks the task.
    expect(p).toContain("the task wins");
  });

  test("declares a shared non-library root once instead of per skill", () => {
    const pkg = "/home/u/.pi/agent/git/github.com/obra/superpowers/skills";
    const p = build({
      skillInventory: [
        { name: "brainstorming", description: "d", filePath: `${pkg}/brainstorming/SKILL.md` },
        { name: "writing-plans", description: "d", filePath: `${pkg}/writing-plans/SKILL.md` },
      ],
      skillsLibrary: lib,
    });
    expect(p).toContain(`↳ also at \`${pkg}/<name>/SKILL.md\``);
    // Declared once, not twice.
    expect(p.split(pkg).length - 1).toBe(1);
  });

  test("prints a full path inline for a skill whose root is shared by nobody", () => {
    // A name the model cannot resolve to a file is a skill it cannot open, so
    // silence here is the one failure this format must not have.
    const odd = "/opt/elsewhere/solo/SKILL.md";
    const p = build({
      skillInventory: [{ name: "solo", description: "d", filePath: odd }],
      skillsLibrary: lib,
    });
    expect(p).toContain(`- **solo** (\`${odd}\`) — d`);
  });

  test("falls back to the uncategorized bucket rather than dropping a skill", () => {
    const p = build({
      skillInventory: [
        { name: "mystery", description: "d", filePath: "/x/mystery/SKILL.md" },
      ],
      skillsLibrary: lib,
    });
    expect(p).toContain("**other**");
    expect(p).toContain("mystery");
  });

  test("orders categories by CATEGORY_ORDER, not alphabetically", () => {
    // language-style sorts after architecture-and-design alphabetically but
    // comes first by design; the ordering carries meaning.
    const p = build({
      skillInventory: [
        {
          name: "brainstorm-x",
          description: "d",
          filePath: `${lib}/architecture-and-design/brainstorm-x/SKILL.md`,
          pathCategory: "architecture-and-design",
        },
        {
          name: "rust-style",
          description: "d",
          filePath: `${lib}/language-style/rust-style/SKILL.md`,
          pathCategory: "language-style",
        },
      ],
      skillsLibrary: lib,
    });
    expect(p.indexOf("**language-style**")).toBeLessThan(
      p.indexOf("**architecture-and-design**"),
    );
  });
});

describe("caller-supplied text", () => {
  test("a custom prompt and an appended prompt both land", () => {
    const p = build({ customPrompt: "CUSTOM-MARK", appendSystemPrompt: "APPEND-MARK" });
    expect(p).toContain("CUSTOM-MARK");
    expect(p).toContain("APPEND-MARK");
  });

  test("the append lands after the custom prompt, and both before the footer", () => {
    // Ordering is the contract: an append that preceded the custom prompt would
    // let a user override be silently overridden.
    const p = build({ customPrompt: "CUSTOM-MARK", appendSystemPrompt: "APPEND-MARK" });
    expect(p.indexOf("CUSTOM-MARK")).toBeLessThan(p.indexOf("APPEND-MARK"));
    expect(p.indexOf("APPEND-MARK")).toBeLessThan(p.indexOf("Current date:"));
  });

  test("guidelines render when present", () => {
    const p = build({ guidelines: ["GUIDE-ONE", "GUIDE-TWO"] });
    expect(p).toContain("GUIDE-ONE");
    expect(p).toContain("GUIDE-TWO");
  });
});

describe("section ordering", () => {
  test("inventories precede caller text, which precedes the footer", () => {
    // The whole prompt in one call, so the order assertion is meaningful.
    const lib = "/home/u/.pi/agent/skills";
    const p = build({
      hasQuestionnaire: true,
      toolInventory: [{ name: "read", description: "d" }],
      agentInventory: [
        {
          name: "worker",
          description: "d",
          model: "m",
          tools: [],
          source: "global",
        } as never,
      ],
      skillInventory: [
        {
          name: "rust-style",
          description: "d",
          filePath: `${lib}/language-style/rust-style/SKILL.md`,
          pathCategory: "language-style",
        },
      ],
      contextInventory: [{ path: "/work/repo/AGENTS.md" }],
      guidelines: ["GUIDE-ONE"],
      customPrompt: "CUSTOM-MARK",
      appendSystemPrompt: "APPEND-MARK",
      skillsLibrary: lib,
    });

    const order = [
      "## Asking the User",
      "## Available Tools",
      "## Available Agents",
      "## Available Skills",
      "## Project Context",
      "CUSTOM-MARK",
      "APPEND-MARK",
      "Current date:",
    ].map((marker) => {
      const at = p.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      return at;
    });

    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]!);
    }
  });
});

describe("the context inventory", () => {
  test("lists each discovered context file", () => {
    const p = build({
      contextInventory: [{ path: "/work/repo/AGENTS.md" }, { path: "/work/repo/sub/AGENTS.md" }],
    });
    expect(p).toContain("## Project Context");
    expect(p).toContain("/work/repo/AGENTS.md");
    expect(p).toContain("/work/repo/sub/AGENTS.md");
  });
});
