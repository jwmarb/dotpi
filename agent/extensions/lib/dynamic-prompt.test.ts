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
 * So these assertions cross the module's real seams: `buildOrchestratorPrompt`,
 * and `promptInputs`, the pure assembly that turns the handler's loaded inputs
 * into the builder's parameter object. Its section builders stay private, and that is
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
import { describe, expect, test, afterAll, beforeAll } from "bun:test";

import { buildOrchestratorPrompt, promptInputs, type PromptInputsOptions } from "../dynamic-prompt.js";
import { agentsDir } from "./layout.js";
import { discoverAgents, type AgentInfo } from "./agents.js";
import { fileURLToPath } from "node:url";
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
    // The board is a per-install capability like the questionnaire. Every absence
    // assertion below leans on this default being false — an omitted field would make
    // them pass vacuously, and tests are outside the tsc scope that would catch it.
    hasKanban: false,
    cwd: "/work/repo",
    skillsLibrary: "/home/u/.pi/agent/skills",
    // Fixed so the footer is assertable without freezing time globally.
    now: new Date(2026, 0, 5),
    ...overrides,
  });
}

/**
 * One section's own text, from its heading to the next `##` heading. Gating tests
 * have to assert *inside* a section: `not.toContain("worker")` over the whole prompt
 * fails on the `## Available Agents` table, which legitimately lists agents, and
 * `toContain` over the whole prompt cannot tell a rule from a passing mention.
 */
function section(prompt: string, heading: string): string {
  const from = prompt.indexOf(heading);
  if (from < 0) return "";
  const next = prompt.indexOf("\n## ", from + heading.length);
  const footer = prompt.indexOf("Current date:");
  // A section that runs to the end of the prompt (no next heading, no footer) must not
  // become `slice(from, -1)`, which silently drops the section's last character.
  const end = next >= 0 ? next : footer < 0 ? prompt.length : footer;
  return prompt.slice(from, end);
}

/** The Core Responsibilities Execute step, which is where the board/delegation clauses land. */
function executeStep(prompt: string): string {
  return prompt.split("\n").find((l) => l.startsWith("3. **Execute**")) ?? "";
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

  test("a pipe in a tool name or description cannot split the row", () => {
    // The agent table's escaping is pinned above; the tool table shares `cell()`, and
    // dropping it there ships a malformed table with no test to notice.
    const p = build({
      toolInventory: [{ name: "read", description: "Read a file | with a pipe in it" }],
    });
    const row = p.split("\n").find((l) => l.startsWith("| read "));
    expect(row).toBeTruthy();
    expect(row!).toContain("Read a file \\| with a pipe in it");
    // Three unescaped pipes: the row's own delimiters. A fourth would make four cells.
    expect(row!.match(/(?<!\\)\|/g)?.length ?? 0).toBe(3);
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

  test("withheld from a subagent, whose own body carries its grading contract", () => {
    const inv = [agent("reviewer"), agent("verifier"), agent("planner")];
    const p = build({ agentInventory: inv, isSubagent: true });
    expect(p).not.toContain("## Quality Pass");
    expect(p).not.toContain("## Plan Before You Implement");
    expect(p).toContain("## Available Agents");
    expect(build({ agentInventory: inv })).toContain("## Quality Pass");
  });

  test("the Quality Pass opener keeps its own antecedent in both branches", () => {
    // "that standard" needs the graded-child sentence in front of it. With the worker clause
    // gated off, a bare "that standard" pointed at *being the worst judge* — it told the model
    // to meet the standard of the worst judge. The no-worker branch states the standard itself.
    const withWorker = build({
      agentInventory: [agent("worker"), agent("reviewer"), agent("verifier")],
    });
    expect(section(withWorker, "## Quality Pass")).toContain(
      "Hold yourself to that standard: finish your own implementation work the same way.",
    );
    expect(section(withWorker, "## Quality Pass")).toContain(
      "not a second grader launch over a diff a child already had graded",
    );
    const noWorker = build({
      agentInventory: [agent("planner"), agent("reviewer"), agent("verifier")],
    });
    const s = section(noWorker, "## Quality Pass");
    // Two phrases: the source wraps between them, so one long assertion would straddle a newline.
    expect(s).toContain("Hold yourself to the standard a grader would apply: finish your own implementation work");
    expect(s).toContain("as an agent that did not write it would.");
    expect(s).not.toContain("that standard");
    expect(s).not.toContain("the same way");
    // The "diff a child already had graded" tail presumes a self-grading child too.
    expect(s).toContain("not a second grader launch over work you have already checked yourself");
  });

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
      agentInventory: [agent("planner"), agent("worker"), agent("reviewer"), agent("verifier")],
    });
    expect(p).toContain("a `worker` has passed its own diff through these graders");
    expect(p).toContain("Grade what **you** implemented");
  });

  test("grants the worker exemption only where a worker exists", () => {
    // The exemption is a licence to skip a pass. In a roster with graders and no
    // self-grading implementer, granting it cites an agent the session cannot spawn and
    // cancels the only pass that exists — and the delegation section tells that install
    // the opposite, so the prompt would contradict itself between its sections.
    const noWorker = build({ agentInventory: [agent("planner"), agent("reviewer"), agent("verifier")] });
    expect(noWorker).not.toContain("worker");
    expect(noWorker).toContain("Grade what **you** implemented");
    expect(noWorker).not.toContain("has passed its own diff through");
    expect(noWorker).not.toContain("passed through these agents");
    // The obligation, not the absence, is the lead: a bold "no child's diff comes graded"
    // read alone is a licence to do nothing.
    expect(noWorker).toContain("The pass on what comes back is yours");
    expect(noWorker).toContain("No agent in this roster ends its own run with a grading pass");
    // Same gate, single grader: the carve-out's singular form ("through this agent") is a
    // distinct template branch, so its absence needs its own proof.
    const single = build({ agentInventory: [agent("planner"), agent("reviewer")] });
    expect(single).not.toContain("worker");
    expect(single).not.toContain("passed through this agent");
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
      const p = build({ agentInventory: [agent("planner"), agent("worker"), agent(other)] });
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
      agentInventory: [agent("planner"), agent("worker"), agent("reviewer"), agent("verifier")],
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
      // Both board states: the planner→board clause is a sibling of the grader block, so
      // its whitespace is only covered by the shape that has the tool.
      for (const hasKanban of [false, true]) {
        const p = build({ agentInventory: inv, hasKanban });
        const section = p.slice(
          p.indexOf("## Plan Before You Implement"),
          p.indexOf("## Quality Pass"),
        );
        expect(section).not.toContain("\u2014 ,");
        expect(section).not.toContain(", and .");
        expect(section).not.toContain("done \u2014 .");
        expect(section).not.toMatch(/\n\n\n/);
      }
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

describe("the kanban board section is gated on the tool existing", () => {
  // The same rule as the questionnaire, the planner and the graders: the board is a
  // per-install capability, and a section telling the model to run work on it is only
  // obeyable with the tool. `hasKanban` reads the *gated* list, so the absence case is
  // a real session shape (print/json runs strip the tool), not a hypothetical.
  const agent = (name: string) =>
    ({ name, description: "d", model: "m", tools: [], source: "global" }) as never;
  // Partial, like `build()`: tests pass a fragment. The full-parameter form typechecks
  // only because tsconfig excludes lib/*.test.ts, so a real call site would break.
  const board = (ovs: Partial<Parameters<typeof buildOrchestratorPrompt>[0]> = {}) =>
    section(build(ovs), "## Kanban Board");

  test("absent when the tool is not available", () => {
    const p = build();
    expect(p).not.toContain("## Kanban Board");
    expect(p).not.toContain("kanban");
  });

  test("present, and stating the settle guard's accounting rule", () => {
    // The dispositions and the prohibition mirror `kanban/lib.ts`'s `nudgeFor`, which
    // enforces them at end-of-turn: the rule read up front and the rule enforced later
    // must not drift apart, and the section must not phrase it as a way to get past
    // the guard.
    const s = board({ hasKanban: true });
    expect(s).toContain("one card per step");
    expect(s).toContain("genuinely verified, with that evidence in the note");
    expect(s).toContain("what it waits on (including the user)");
    expect(s).toContain("`clear_done`");
    expect(s).toContain("Never move a card to silence the guard");
  });
  test("skips itself for trivial work, and names the cap the model will hit", () => {
    // Every sibling section carries an explicit escape ("Go direct when", "Stay direct
    // when", "Name any skip"), and this section's only threshold was a step count — so a
    // three-trivial-step request became a board the user has to look at. The per-call cap
    // is the one a planner's plan runs into: the tool refuses and says so, and the prose
    // names the number the model can actually hit rather than the 200-card one it cannot.
    const s = board({ hasKanban: true });
    expect(s).toContain("Skip the board for a single step, or for trivial work");
    expect(s).toContain("up to 20 titles per call");
    // The board stores no edges and reorders a card to the end on every move, so it
    // cannot keep a dependency order; the planner's own order is the one to copy.
    expect(s).toContain("in the order you intend to do them");
    expect(s).not.toContain("in dependency order");
  });

  test("does not count `review` as an accounted card", () => {
    // `actionableCards` in kanban/lib.ts keeps a `review` card actionable while nothing
    // else is waiting, so `review` may not join the accounted list: a prompt that offered
    // it as a disposition would teach the shuffle its own last sentence forbids. The
    // guard's end-of-turn text does list it, which is why this is pinned to the source.
    const s = board({ hasKanban: true });
    expect(s).toContain("`review` is not one of them");
    expect(s).toContain("Never move a card to silence the guard");
  });

  test("names no agent, because it is gated on the tool alone", () => {
    // The section is emitted for the tool, so it may not lean on the roster: a session
    // with the board and no spawn tool would get an instruction naming agents it has.
    const s = board({ hasKanban: true });
    expect(s).not.toContain("planner");
    expect(s).not.toContain("worker");
    // Positive anchor: `section()` returns "" for a heading that is absent, so the two
    // negatives above would pass vacuously if the board gate ever broke.
    expect(s).toContain("Never move a card to silence the guard");
  });

  test("drops the run-link line and the linked disposition without the spawn tool", () => {
    const noSpawn = board({ hasKanban: true, hasSubagent: false });
    expect(noSpawn).toContain("## Kanban Board");
    expect(noSpawn).not.toContain("subagent");
    expect(noSpawn).not.toContain("linked to a run that is still running");
    // The sentence has to close cleanly with the run clause gone: no dangling comma.
    expect(noSpawn).toContain("a note, dropped.");

    const withRuns = board({ hasKanban: true, agentInventory: [agent("worker")] });
    expect(withRuns).toContain("- `link` a card to the run id `subagent` returned");
    expect(withRuns).toContain("a note, dropped, or linked to a run that is still running.");
  });

  test("defers the planner pairing to the planning section, gated on both halves", () => {
    // The pairing is the user's ask, and it is a conjunction: the board alone has no
    // plan to land, and a planner alone has no board to land it on. Neither half may
    // reference the other.
    expect(build({ hasKanban: true })).not.toContain("Put the plan on the board");
    const both = build({ hasKanban: true, agentInventory: [agent("planner")] });
    expect(both).toContain("Put the plan on the board");
    expect(both).toContain("## Kanban Board");

    const plannerNoBoard = build({ agentInventory: [agent("planner")] });
    expect(plannerNoBoard).not.toContain("Put the plan on the board");
    expect(plannerNoBoard).not.toContain("Kanban");
  });

  test("keeps the board clause a sibling of the grader block, not inside it", () => {
    // A planner-without-graders install is a supported shape (pinned by the planning
    // block's own test). Nesting the board clause inside the grader block would make it
    // vanish there, so this shape is the one that pins the nesting.
    const p = build({ hasKanban: true, agentInventory: [agent("planner")] });
    expect(p).not.toContain("## Quality Pass");
    expect(p).toContain("## Plan Before You Implement");
    expect(p).toContain("Put the plan on the board");
  });

  test("adds the header clause only with the capability, and leaves the shipped line byte-identical", () => {
    expect(build()).toContain(
      "3. **Execute** — Call tools and skills in the correct order, handling errors gracefully",
    );
    expect(build({ hasKanban: true })).toContain(
      "3. **Execute** — Call tools and skills in the correct order with each step tracked on the `kanban` board (see **Kanban Board**), handling errors gracefully",
    );
    expect(build({ agentInventory: [agent("worker")] })).toContain(
      "3. **Execute** — Call tools and skills in the correct order, delegating implementation to `worker` (see **Delegate the Implementation**), handling errors gracefully",
    );
    expect(build({ hasKanban: true, agentInventory: [agent("worker")] })).toContain(
      "with each step tracked on the `kanban` board, delegating implementation to `worker` (see **Kanban Board** and **Delegate the Implementation**)",
    );
  });

  test("the no-worker Execute clause carries the joint role-and-capability test", () => {
    // The Execute step is line 12 of the prompt, far above the delegation section's own
    // qualifier. A role-only test there denotes `planner` ("Writes no code") in the real
    // fleet minus `worker`; a capability-only one denotes `spiker`'s sandbox. Both halves
    // must be stated where the instruction is.
    const step = executeStep(
      build({ hasKanban: true, agentInventory: [agent("planner"), agent("spiker")] }),
    );
    expect(step).toContain(
      "delegating implementation to the roster agent whose role fits the step and whose Tools column shows write and edit (or all)",
    );
    expect(step).not.toContain("`worker`");
  });

  test("the no-worker writer count is derived from the roster, not asserted", () => {
    const row = (name: string, tools: string[]) =>
      ({ name, description: "d", model: "m", tools, source: "global" }) as never;
    const ro = ["read", "grep"];
    const rw = ["read", "write", "edit"];
    const s = (inv: never[]) =>
      section(build({ agentInventory: inv }), "## Delegate the Implementation");
    expect(s([row("planner", ro), row("spiker", rw), row("reviewer", ro)])).toContain(
      "1 of 3 rows shows write and edit (or all)",
    );
    // An install where most rows can write: the old hardcoded "most rows show neither" lied here.
    expect(s([row("a", rw), row("b", rw), row("c", ro)])).toContain("2 of 3 rows show write and edit (or all)");
    // `tools: []` is unrestricted — the table prints "all" — so it counts as a writer.
    expect(s([row("a", []), row("b", ro)])).toContain("1 of 2 rows shows write and edit (or all)");
    expect(s([row("a", ro)])).toContain("0 of 1 row show write and edit (or all)");
    // `write` without `edit` is not a writer: dropping the edit half must fail this.
    expect(s([row("x", ["read", "write"])])).toContain("0 of 1 row show write and edit (or all)");
  });

  test("the no-worker opener and step bullets carry the same condition", () => {
    const s = section(
      build({ agentInventory: [agent("spiker"), agent("reviewer")] }),
      "## Delegate the Implementation",
    );
    expect(s).toContain("Executing a whole plan inline when a row does both is work no child graded");
    expect(s).toContain("how it will be checked — and a row does both");
    expect(s).toContain("do line by line — and a row does both");
    expect(s).toContain("never a row that edits files");
    const w = section(build({ agentInventory: [agent("worker")] }), "## Delegate the Implementation");
    expect(w).toContain("Executing a whole plan inline is work no child graded and no one can see.");
    expect(w).not.toContain("a row does both");
  });

  test("the header names only sections this prompt actually emits", () => {
    // The clause points at section headings inside "(see **X**)"; each branch is gated
    // on a different capability, so every heading named must exist in the same prompt.
    // The step's own `**Execute**` label is deliberately out of scope — it is a list
    // marker, not a section reference.
    const named: string[] = [];
    for (const p of [
      build(),
      build({ hasKanban: true }),
      build({ agentInventory: [agent("worker")] }),
      build({ hasKanban: true, agentInventory: [agent("worker")] }),
    ]) {
      const clause = executeStep(p).match(/\(see ([^)]+)\)/)?.[1] ?? "";
      for (const ref of clause.split(" and ").filter((r) => r.length > 0)) {
        const heading = ref.replace(/\*\*/g, "");
        named.push(heading);
        expect(p).toContain(`## ${heading}`);
      }
    }
    // The loop must not be vacuous: the board contributes one heading, a roster alone
    // one more, and the shape with both has two. A clause that named nothing would pass
    // every assertion above, so the count is the assertion that it is there.
    expect(named.length).toBeGreaterThanOrEqual(4);
    expect(named).toContain("Kanban Board");
    expect(named).toContain("Delegate the Implementation");
  });

  test("leaves no unexpanded template expression", () => {
    // The section interpolates two conditional phrases; an escaping slip would ship
    // literal `${...}` in every request.
    for (const ov of [
      { hasKanban: true },
      { hasKanban: true, hasSubagent: false },
      { hasKanban: true, agentInventory: [agent("planner")] },
      { hasKanban: true, agentInventory: [agent("worker"), agent("planner")] },
    ]) {
      const p = board(ov);
      // Positive anchor: without it a suppressed heading makes the negative pass vacuously.
      expect(p).toContain("## Kanban Board");
      expect(p).not.toContain("${");
    }
  });
});

describe("the delegation-first section is gated on a delegation-capable roster", () => {
  // Pushing implementation to a child is only an instruction the model can obey with
  // an agent to delegate to, so the section is gated on `canDelegate` (spawn tool +
  // non-empty roster + not a child) and the *name* one level finer on `hasWorker`.
  const agent = (name: string) =>
    ({ name, description: "d", model: "m", tools: [], source: "global" }) as never;
  const delegation = (names: string[], ovs: Record<string, unknown> = {}) =>
    section(build({ agentInventory: names.map(agent), ...ovs }),
      "## Delegate the Implementation",
    );

  test("absent on an empty roster, and withheld from a child", () => {
    expect(build()).not.toContain("## Delegate the Implementation");
    expect(build()).not.toContain("worker");
    // A child's own body carries its grading contract; the planning and Quality Pass
    // sections already withhold on the same conjunct, and this one must join them.
    const child = build({
      hasKanban: true,
      isSubagent: true,
      agentInventory: [agent("worker"), agent("planner"), agent("reviewer"), agent("verifier")],
    });
    expect(child).not.toContain("## Delegate the Implementation");
    expect(child).not.toContain("## Plan Before You Implement");
    // The board section is the one section a child *does* keep when `hasKanban` is true:
    // nothing in the builder conjuncts `isSubagent` onto it. That is safe only because
    // `kanban/index.ts` never registers the tool for a child, so `hasKanban` is false
    // there — the gate is the registration, pinned by `kanban/gate.test.ts`, not a check
    // in this builder. This asserts the dependency the comments lean on.
    expect(child).toContain("## Kanban Board");
  });

  test("names `worker`, and the stay-direct cases, when the roster has it", () => {
    const s = delegation(["worker"]);
    expect(s).toContain("delegate them to `worker`:");
    expect(s).toContain("Stay direct when");
    expect(s).toContain("triaging a delegation that came back wrong");
    expect(s).toContain("integration glue");
    expect(s).toContain("Name any skip");
  });

  test("falls back to the roster's role with no dangling name", () => {
    const s = delegation(["planner", "reviewer"]);
    expect(s).toContain("delegate them to the roster agent whose role fits the step");
    expect(s).not.toContain("worker");
  });

  test("drops the grader names and the Quality Pass pointer when no grader can be spawned", () => {
    // A roster with an implementer and no spawnable grader has no child pass to decline.
    // The shipped wording said "do not order that pass again" about a pass that does not
    // exist, which leaves the work graded by nobody *by instruction*, so the inverse is
    // stated and no pointer is emitted to a Quality Pass that was never printed.
    const s = delegation(["worker"]);
    expect(s).toContain("No child's diff comes graded in this install");
    expect(s).toContain("run the project's own checks on what comes");
    expect(s).not.toContain("do not order that pass again");
    expect(s).not.toContain("Quality Pass");
  });

  test("agrees in number with its own roster", () => {
    // The house rule: every phrase around a computed list is derived from it, so a
    // one-grader install is never told to launch two passes.
    const one = delegation(["worker", "reviewer"]);
    expect(one).toContain("graded by `reviewer` — do not order that pass again");
    expect(one).toContain("how to write that task");
    expect(one).not.toContain("those tasks");

    const both = delegation(["worker", "reviewer", "verifier"]);
    expect(both).toContain(
      "graded by `reviewer` and `verifier` (the `verifier` only when execution can settle the change) — do not order that pass again",
    );
    expect(both).toContain("how to write those tasks");
    expect(both).not.toContain("how to write that task");
  });

  test("states the grading rule Quality Pass states, in the same direction", () => {
    // Three sections now carry the worker self-grade exemption (planning, Quality Pass,
    // delegation). They must agree: a child's pass is not ordered twice, and what the
    // orchestrator owns is its own work plus the integration of what came back.
    const p = build({
      agentInventory: [
        agent("planner"),
        agent("worker"),
        agent("reviewer"),
        agent("verifier"),
      ],
    });
    expect(section(p, "## Delegate the Implementation")).toContain("do not order that pass");
    expect(p).toContain("Grade what **you** implemented");
    // The whole-check is the project's own checks, not a grader launch: the shipped
    // sentence named "the check that the whole does what the goal asked" with no tie to
    // an edit, so a fully delegated plan satisfied it and fired the duplicate pass the
    // other two sections forbid. What is owned is glue the orchestrator edited.
    expect(section(p, "## Quality Pass")).toContain("glue **you edited yourself** while integrating");
    expect(section(p, "## Quality Pass")).toContain("not a second grader launch");
    expect(section(p, "## Delegate the Implementation")).toContain(
      "the glue you edited while integrating what",
    );
  });

  test("hands the pass to the orchestrator when no child self-grades", () => {
    // The no-`worker` roster: the implementer must be able to edit files, and no agent in
    // this shape ends its run graded — so the section may promise no self-grade, and the
    // pass is the orchestrator's to order. Quality Pass exists here, so it may point.
    const s = delegation(["spiker", "reviewer", "verifier"]);
    expect(s).toContain("delegate them to the roster agent whose role fits the step");
    // The writer test alone is not enough: `spiker` shows `write` and `edit`, so a
    // capability-only condition routes a real implementation step to a spike sandbox.
    expect(s).toContain("whose role fits the step and whose Tools column shows write and edit (or all)");
    expect(s).toContain("both conditions, read off the Available Agents table");
    expect(s).toContain("whose role is a throwaway spike is not an implementer");
    expect(s).toContain("No agent in this roster ends its own run with a grading pass");
    expect(s).toContain("See **Quality Pass** below for how to write those tasks");
    expect(s).not.toContain("do not order that pass again");
  });

  test("keeps the verifier's condition on the child's own pass", () => {
    // `agents/worker.md` qualifies `verifier` on the change being runtime-testable, and
    // this module's rule is that the obligation is conditional *wherever* it is stated.
    // Unconditional here reads as "the child's run was verified", so the orchestrator
    // declines the pass a docs change still needs; the child's report of what it skipped
    // is the only thing that would save it, and the prompt has to point at it.
    const both = delegation(["worker", "reviewer", "verifier"]);
    expect(both).toContain("(the `verifier` only when execution can settle the change)");
    expect(both).toContain("anything it says it skipped is yours");
    // Reviewer-only has no condition to state, and must not borrow one.
    expect(delegation(["worker", "reviewer"])).not.toContain("execution can settle the change");
  });

  test("routes a step that changes no files away from an implementer", () => {
    // The child's grading pass is mandatory on every run, so delegating a build, a test
    // run, or an inspection buys a grader launch over an empty diff plus a turn of
    // waiting; a read-heavy step belongs with a read-only agent, not the implementer.
    const s = delegation(["worker", "reviewer", "verifier"]);
    expect(s).toContain("A step changes no files");
    expect(s).toContain("a read-only agent from the table above");
    expect(s).not.toContain("a build, a test run, or a sweep");
  });

  test("sits between the planning section and the quality pass it defers to", () => {
    const p = build({
      agentInventory: [agent("planner"), agent("worker"), agent("reviewer"), agent("verifier")],
    });
    const at = (h: string) => p.indexOf(h);
    expect(at("## Plan Before You Implement")).toBeGreaterThan(-1);
    expect(at("## Plan Before You Implement")).toBeLessThan(at("## Delegate the Implementation"));
    expect(at("## Delegate the Implementation")).toBeLessThan(at("## Quality Pass"));
  });

  test("does not assume a grader in the empty-diff bullet", () => {
    // The bullet's point is that a child run over an empty diff buys nothing. In an
    // install that withholds Quality Pass there is no "graded implementer run" to buy, so
    // the sentence must degrade to the cost that does exist: a turn of waiting.
    expect(delegation(["worker"])).toContain("Run it yourself");
    expect(delegation(["worker"])).not.toContain("grader launch");
    const graded = delegation(["worker", "reviewer", "verifier"]);
    expect(graded).toContain("A step changes no files");
    expect(graded).toContain("buys a grader launch");
    // Graders with no self-grading implementer: this section says no child arrives checked, so
    // the launch is the orchestrator's to order — "a graded implementer run" contradicts that.
    // (`delegation()` already returns the section — wrapping it in `section()` again
    // would look for a heading inside it.)
    const gradersNoWorker = delegation(["planner", "reviewer", "verifier"]);
    expect(gradersNoWorker).toContain(
      "no child here comes back with its diff graded, so an empty one buys you a grader launch to order",
    );
    expect(gradersNoWorker).not.toContain("A graded implementer run");
    const selfGrading = delegation(["worker", "reviewer"]);
    expect(selfGrading).toContain("A graded implementer run over an empty diff buys a grader launch");
  });

  test("states the outcome when no roster agent can implement", () => {
    // `canDelegate` is satisfied by a roster of read-only agents, so a flat mandate to delegate
    // is an instruction with no obeiable target — the failure branch has to be printed.
    const p = delegation(["reviewer", "verifier"]);
    expect(p).toContain("If no row does both, this install has no implementer: the editing is yours");
    expect(p).toContain("If no row fits the role and shows write and edit, the editing is yours");
    // The opener must not outlive the capability it presumes.
    expect(p).toContain("You coordinate; a child implements where one can.");
    // Self-editing is the outcome in this shape, so it is not a "skip", and "the implementer"
    // must not name a role the section just said may be absent.
    expect(p).not.toContain("Name any skip");
    expect(p).toContain("Say who is doing it.");
    expect(p).not.toContain("never the implementer");
    const writer = delegation(["worker"]);
    expect(writer).toContain("You coordinate; the child implements.");
    expect(writer).toContain("**Name any skip.**");
    expect(writer).toContain("never the implementer");
  });

  test("leaves no unexpanded template expression", () => {
    for (const names of [["worker"], ["planner", "reviewer"], ["worker", "reviewer"], ["worker", "reviewer", "verifier"]]) {
      const p = delegation(names);
      // Positive anchor: `section()` yields "" for a suppressed heading, so a bare
      // not.toContain("${") passes vacuously if a gate ever hides the section.
      expect(p).toContain("## Delegate the Implementation");
      expect(p).not.toContain("${");
    }
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
    // `worker` rides along: the carve-out for a self-graded child diff is worker-gated
    // (an install without it has no self-grading child), and these tests are about the
    // number the prose agrees with, not about that clause.
    const p = build({ agentInventory: [agent("worker"), ...names.map(agent)] });
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

describe("the agent inventory table is data, not decoration", () => {
  const agent = (name: string, tools: string[] = []) =>
    ({ name, description: "d", model: "m", tools, source: "global" }) as never;

  test("the chain note names no agent pair", () => {
    // It used to read "(e.g., worker → reviewer)", which dangled in a roster without them.
    // Deriving the pair from the roster is worse: the arrow reads as a child spawning a
    // child, and `agents/*.md` `callable_by` refuses most pairs (explorer → healthcheck, and
    // every self-chain), so a derived pair is legal only by luck. No names, no lie.
    const p = build({ agentInventory: [agent("explorer", ["read"]), agent("healthcheck", ["read"])] });
    const s = section(p, "## Available Agents");
    expect(s).toContain("You can chain agents:");
    // The invariant is "names no pair", not "is not phrased that one way" — any future
    // example, in any phrasing, would re-create the instruction the spawn guard refuses.
    const bullet = s.split("\n").find((l) => l.startsWith("- You can chain agents")) ?? "";
    expect(bullet).toContain("You can chain agents:");
    expect(bullet).not.toContain("→");
  });

  test("the Tools column carries each agent's real tools", () => {
    // The no-worker fallback tells the model to read this column to find an agent that can
    // edit files, so it has to tell a read-only agent from one that can write.
    const p = build({
      agentInventory: [agent("explorer", ["read", "ffgrep"]), agent("spiker", ["read", "write", "edit"])],
    });
    const s = section(p, "## Available Agents");
    expect(s).toContain("| explorer | d | m | read, ffgrep | global |");
    expect(s).toContain("| spiker | d | m | read, write, edit | global |");
    expect(s).not.toContain("| explorer | d | m | all |");
  });

  test("an agent with no declared tools renders as all", () => {
    // `tools: []` means unrestricted in AgentInfo, and the column says so — the fixture
    // default everywhere else in this file, pinned so the Tools-column instruction cannot be
    // read as "this agent has no tools".
    const s = section(build({ agentInventory: [agent("planner")] }), "## Available Agents");
    expect(s).toContain("| planner | d | m | all | global |");
  });
  test("the escaped Model cell says how to copy it", () => {
    // Escaping keeps the table well-formed, and the Model cell is a machine value the model
    // passes to a `model:` override — so the section has to state that the backslash is
    // markdown syntax, not part of the reference.
    const p = build({
      agentInventory: [
        { name: "explorer", description: "d", model: "qwen/x|low", tools: ["read"], source: "global" } as never,
      ],
    });
    const s = section(p, "## Available Agents");
    expect(s).toContain("The Model column is markdown-escaped");
    expect(s).toContain("is passed to a `model:` override as `provider/model|low` — drop the backslash");
  });

  test("a model ref containing a pipe cannot split the row", () => {
    // Fleet refs are written `provider/model|effort`. Raw, the pipe closes the cell and a
    // 5-column table renders 6 fields, hiding the Tools column the delegation rule tells the
    // model to read when it picks an implementer.
    const p = build({
      agentInventory: [
        { name: "explorer", description: "d", model: "qwen/x|low", tools: ["read"], source: "global" } as never,
      ],
    });
    const row = section(p, "## Available Agents")
      .split("\n")
      .find((l) => l.startsWith("| explorer "));
    expect(row).toBeDefined();
    expect(row).toContain("qwen/x\\|low");
    // Six unescaped pipes = exactly five cells.
    expect((row!.match(/(?<!\\)\|/g) ?? []).length).toBe(6);
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
      hasKanban: true,
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
      "## Kanban Board",
      "## Delegate the Implementation",
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


describe("healthcheck agent visibility in the inventory", () => {
  // The agent dir is the repo's own `agent/` directory, derived from this
  // test file's location. Setting PI_CODING_AGENT_DIR makes the test hermetic:
  // it works in a container where HOME points at an empty dir.
  const agentDirPath = fileURLToPath(new URL("../..", import.meta.url));
  // Assigned in beforeAll, not the describe body: the body runs at collection
  // time, which would put the override in force for every earlier test in the
  // file.
  let originalEnv: string | undefined;
  beforeAll(() => {
    originalEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDirPath;
  });
  test("the Available Agents table includes healthcheck when hasSubagent is true", async () => {
    const inventory = await discoverAgents(agentsDir());
    const p = build({ agentInventory: inventory as never[], hasSubagent: true });
    expect(p).toContain("## Available Agents");
    expect(p).toContain("| healthcheck |");
  });

  test("the agent section is absent when hasSubagent is false", async () => {
    const inventory = await discoverAgents(agentsDir());
    const p = build({ agentInventory: inventory as never[], hasSubagent: false });
    expect(p).not.toContain("## Available Agents");
    expect(p).not.toContain("| healthcheck |");
  });

  // Restore the original env once the tests have run, so other test files in
  // the same process are unaffected.
  afterAll(() => {
    if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalEnv;
  });
});

// ---------------------------------------------------------------------------
// promptInputs — the pure assembly between the handler's loads and the builder
// ---------------------------------------------------------------------------

describe("promptInputs", () => {
  const agent = (name: string): AgentInfo => ({
    name,
    description: `${name} agent`,
    promptBody: "",
    filePath: `${name}.md`,
  });
  const LIB = "/home/u/.pi/agent/skills";
  /** A minimal call; each test overrides only what it is about. */
  function inputs(overrides: Partial<PromptInputsOptions> = {}) {
    return promptInputs({
      systemPromptOptions: { cwd: "/work/repo" },
      lineage: [],
      roster: { all: [], spawnable: [] },
      owners: new Map(),
      isActive: () => false,
      skillsLibrary: LIB,
      ...overrides,
    });
  }

  test("a non-empty lineage marks a subagent and advertises only .spawnable", () => {
    const roster = { all: [agent("reviewer"), agent("worker")], spawnable: [agent("reviewer")] };
    const sub = inputs({ lineage: ["worker"], roster });
    expect(sub.buildOptions.isSubagent).toBe(true);
    expect(sub.buildOptions.agentInventory.map((a) => a.name)).toEqual(["reviewer"]);

    const top = inputs({ lineage: [], roster });
    expect(top.buildOptions.isSubagent).toBe(false);
  });

  test("hasSubagent, hasQuestionnaire and hasKanban come from selectedTools even without a snippet", () => {
    const out = inputs({
      systemPromptOptions: {
        cwd: "/w",
        selectedTools: ["read", "subagent", "questionnaire", "kanban"],
      },
    });
    expect(out.buildOptions.toolInventory).toEqual([]);
    expect(out.buildOptions.hasSubagent).toBe(true);
    expect(out.buildOptions.hasQuestionnaire).toBe(true);
    expect(out.buildOptions.hasKanban).toBe(true);

    const none = inputs({ systemPromptOptions: { cwd: "/w", selectedTools: ["read"] } });
    expect(none.buildOptions.hasSubagent).toBe(false);
    expect(none.buildOptions.hasQuestionnaire).toBe(false);
    expect(none.buildOptions.hasKanban).toBe(false);
  });

  test("a gated-out kanban tool turns hasKanban off", () => {
    // The flag must read the GATED list, not the raw one: a skill that owns `kanban`
    // and is not active means this session cannot call it, so a board section would be
    // an instruction with no tool behind it. Mirrors the subagent case above.
    const out = inputs({
      systemPromptOptions: {
        cwd: "/w",
        selectedTools: ["kanban"],
        toolSnippets: { kanban: "x" },
      },
      owners: new Map([["kanban", "some-skill"]]),
    });
    expect(out.selectedTools).toEqual([]);
    expect(out.buildOptions.hasKanban).toBe(false);
  });

  test("gating drops only the inactive skill-owned tool, keeps order, and copies", () => {
    const selected = ["read", "trade_journal", "subagent", "web_probe", "bash"];
    const snapshot = [...selected];
    const out = inputs({
      systemPromptOptions: {
        cwd: "/w",
        selectedTools: selected,
        toolSnippets: { trade_journal: "journal", subagent: "delegate", web_probe: "probe" },
      },
      owners: new Map([
        ["trade_journal", "technical-analysis"],
        ["web_probe", "research"],
      ]),
      isActive: (d) => d === "research",
    });
    expect(out.selectedTools).toEqual(["read", "subagent", "web_probe", "bash"]);
    expect(out.selectedTools).not.toBe(selected);
    expect(selected).toEqual(snapshot);
    // The inventory and the subagent flag are computed after gating.
    expect(out.buildOptions.toolInventory.map((t) => t.name)).toEqual(["subagent", "web_probe"]);
    expect(out.buildOptions.hasSubagent).toBe(true);
  });

  test("a gated-out subagent tool turns hasSubagent off", () => {
    const out = inputs({
      systemPromptOptions: { cwd: "/w", selectedTools: ["subagent"], toolSnippets: { subagent: "x" } },
      owners: new Map([["subagent", "some-skill"]]),
    });
    expect(out.selectedTools).toEqual([]);
    expect(out.buildOptions.hasSubagent).toBe(false);
  });

  test("empty guidelines are dropped and context files map to {path}", () => {
    // pi hands over each file's content too; the inventory must not carry it.
    const contextFiles = [
      { path: "/w/AGENTS.md", content: "secret body" },
      { path: "/w/agent/AGENTS.md", content: "more" },
    ];
    const out = inputs({
      systemPromptOptions: {
        cwd: "/w",
        promptGuidelines: ["Keep it short.", "", "   ", "\n\t", "Cite sources."],
        contextFiles,
      },
    });
    expect(out.buildOptions.guidelines).toEqual(["Keep it short.", "Cite sources."]);
    expect(out.buildOptions.contextInventory).toEqual([
      { path: "/w/AGENTS.md" },
      { path: "/w/agent/AGENTS.md" },
    ]);
  });

  test("skills carry their path category and pass-through fields cross verbatim", () => {
    const out = inputs({
      systemPromptOptions: {
        cwd: "/work/repo",
        customPrompt: "custom",
        appendSystemPrompt: "appended",
        skills: [
          { name: "triage", description: "d", filePath: `${LIB}/review-and-verification/triage/SKILL.md` },
        ],
      },
    });
    expect(out.buildOptions.skillInventory).toEqual([
      {
        name: "triage",
        description: "d",
        filePath: `${LIB}/review-and-verification/triage/SKILL.md`,
        pathCategory: "review-and-verification",
      },
    ]);
    expect(out.buildOptions.customPrompt).toBe("custom");
    expect(out.buildOptions.appendSystemPrompt).toBe("appended");
    expect(out.buildOptions.cwd).toBe("/work/repo");
    expect(out.buildOptions.skillsLibrary).toBe(LIB);
  });
});
