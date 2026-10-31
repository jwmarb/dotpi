/**
 * The shared prompt-input derivation (`lib/prompt-inputs.ts`).
 *
 * These are the derivation tests that used to sit inside
 * `lib/dynamic-prompt.test.ts`'s `promptInputs` block. They moved here when the
 * derivation became shared by three builders — the orchestrator wrapper, the
 * quant handler, and the persona takeover — because a test of the shared rules
 * belongs beside the shared module, not beside one of its callers. What stays in
 * `dynamic-prompt.test.ts` is only what the wrapper adds: the roster and the
 * caller's own text reaching `buildOptions`.
 *
 * Every assertion here is about a *derived* field: the gated tool list, the
 * three inventories, the guidelines, the capability flags. No prompt text, no
 * builder field.
 *
 * Run: `bun test agent/extensions/lib/prompt-inputs.test.ts`
 */
import { describe, expect, test } from "bun:test";

import { derivePromptInputs, type DeriveInputsOptions } from "./prompt-inputs.js";

const LIB = "/home/u/.pi/agent/skills";

/** A minimal call; each test overrides only what it is about. */
function inputs(overrides: Partial<DeriveInputsOptions> = {}) {
  return derivePromptInputs({
    selectedTools: [],
    skills: [],
    contextFiles: [],
    lineage: [],
    owners: new Map(),
    isActive: () => false,
    skillsLibrary: LIB,
    ...overrides,
  });
}

describe("derivePromptInputs", () => {
  test("a non-empty lineage marks this process a subagent", () => {
    expect(inputs({ lineage: ["worker"] }).isSubagent).toBe(true);
    expect(inputs({ lineage: [] }).isSubagent).toBe(false);
  });

  test("hasSubagent, hasQuestionnaire and hasKanban come from selectedTools even without a snippet", () => {
    const out = inputs({
      selectedTools: ["read", "subagent", "questionnaire", "kanban"],
    });
    expect(out.toolInventory).toEqual([]);
    expect(out.hasSubagent).toBe(true);
    expect(out.hasQuestionnaire).toBe(true);
    expect(out.hasKanban).toBe(true);

    const none = inputs({ selectedTools: ["read"] });
    expect(none.hasSubagent).toBe(false);
    expect(none.hasQuestionnaire).toBe(false);
    expect(none.hasKanban).toBe(false);
  });

  test("a snippet cannot add a capability the tool list does not offer", () => {
    // The flags read the gated `selectedTools` FIRST and the snippet-filtered
    // inventory second, and the OR is kept as one shared signal for all three
    // flags. This pins the direction that matters: a snippet for a tool pi never
    // offered must not light up a section the session cannot act on.
    const out = inputs({ selectedTools: [], toolSnippets: { subagent: "x" } });
    expect(out.toolInventory).toEqual([]);
    expect(out.hasSubagent).toBe(false);

    const offered = inputs({ selectedTools: ["subagent"] });
    expect(offered.hasSubagent).toBe(true);
  });

  test("a gated-out kanban tool turns hasKanban off", () => {
    // The flag must read the GATED list, not the raw one: a skill that owns `kanban`
    // and is not active means this session cannot call it, so a board section would be
    // an instruction with no tool behind it. Mirrors the subagent case above.
    const out = inputs({
      selectedTools: ["kanban"],
      toolSnippets: { kanban: "x" },
      owners: new Map([["kanban", "some-skill"]]),
    });
    expect(out.selectedTools).toEqual([]);
    expect(out.hasKanban).toBe(false);
  });

  test("gating drops only the inactive skill-owned tool, keeps order, and copies", () => {
    const selected = ["read", "trade_journal", "subagent", "web_probe", "bash"];
    const snapshot = [...selected];
    const out = inputs({
      selectedTools: selected,
      toolSnippets: { trade_journal: "journal", subagent: "delegate", web_probe: "probe" },
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
    expect(out.toolInventory.map((t) => t.name)).toEqual(["subagent", "web_probe"]);
    expect(out.hasSubagent).toBe(true);
  });

  test("a gated-out subagent tool turns hasSubagent off", () => {
    const out = inputs({
      selectedTools: ["subagent"],
      toolSnippets: { subagent: "x" },
      owners: new Map([["subagent", "some-skill"]]),
    });
    expect(out.selectedTools).toEqual([]);
    expect(out.hasSubagent).toBe(false);
  });

  test("empty guidelines are dropped", () => {
    const out = inputs({
      promptGuidelines: ["Keep it short.", "", "   ", "\n\t", "Cite sources."],
    });
    expect(out.guidelines).toEqual(["Keep it short.", "Cite sources."]);
  });

  test("context files keep their order and carry only their path", () => {
    // pi hands over each file's content too; the inventory must not carry it —
    // it would be duplicated into the prompt on every request.
    const contextFiles = [
      { path: "/w/AGENTS.md", content: "secret body" },
      { path: "/w/agent/AGENTS.md", content: "more" },
      { path: "/proj/AGENTS.md", content: "and more" },
    ];
    const out = inputs({ contextFiles });
    expect(out.contextInventory).toEqual([
      { path: "/w/AGENTS.md" },
      { path: "/w/agent/AGENTS.md" },
      { path: "/proj/AGENTS.md" },
    ]);
    for (const f of out.contextInventory) expect(Object.keys(f)).toEqual(["path"]);
  });

  test("skills carry their path category", () => {
    const out = inputs({
      skills: [
        { name: "triage", description: "d", filePath: `${LIB}/review-and-verification/triage/SKILL.md` },
      ],
    });
    expect(out.skillInventory).toEqual([
      {
        name: "triage",
        description: "d",
        filePath: `${LIB}/review-and-verification/triage/SKILL.md`,
        pathCategory: "review-and-verification",
      },
    ]);
  });

  test("an explicit pathCategory is kept; a skill outside the library gets undefined", () => {
    // The switched profile's library walk already resolved each category, and a
    // path resolved against another root must not be re-derived against this
    // process's library — that is the field the takeover passes through.
    const out = inputs({
      skills: [
        { name: "demo", description: "d", filePath: "/elsewhere/demo/SKILL.md", pathCategory: "local" },
        { name: "pkg", description: "d", filePath: "/home/u/.pi/other/pkg/SKILL.md" },
      ],
    });
    expect(out.skillInventory.map((s) => s.pathCategory)).toEqual(["local", undefined]);
  });
});
