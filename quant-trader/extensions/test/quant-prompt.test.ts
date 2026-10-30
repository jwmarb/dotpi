/**
 * The quant-research system prompt.
 *
 * `quant-prompt.ts` replaces pi's default prompt for the quant-trader profile,
 * so its output *is* what the desk's model reads — and its `selectedTools`
 * filter *is* the desk's read-only rule, because pi has no top-level `tools:`
 * config. The module exports `buildQuantPrompt` as the pure seam, and the
 * default export wires the session event to it; these tests cross both, the
 * way `agent/extensions/lib/dynamic-prompt.test.ts` crosses the
 * orchestrator's `buildOrchestratorPrompt` and `promptInputs`.
 *
 * The handler tests are hermetic: `PI_CODING_AGENT_DIR` points at a temp tree
 * with a stub fleet, so nothing here depends on `quant-trader/agents/` as
 * other work reshapes it in parallel.
 *
 * Run: `bun test quant-trader/extensions/test/quant-prompt.test.ts`
 */
import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import quantExtension, { buildQuantPrompt } from "../quant-prompt.js";
import { LINEAGE_ENV, type AgentInfo } from "../lib/agents.js";

const LIB = "/home/u/.pi/quant-trader/skills";

/** The profile's own fleet, as a builder input — never read from disk. */
const fleet = (names: string[]): AgentInfo[] =>
  names.map(
    (name) =>
      ({
        name,
        description: `${name} agent`,
        model: "m",
        tools: [],
        promptBody: "",
        filePath: `${name}.md`,
      }) satisfies AgentInfo,
  );

/** A minimal valid call; each test overrides only what it is about. */
function build(overrides: Partial<Parameters<typeof buildQuantPrompt>[0]> = {}) {
  return buildQuantPrompt({
    agentInventory: [],
    skillInventory: [],
    contextInventory: [],
    guidelines: [],
    // True by default: the roster is what most of these tests are about, and a
    // session without the spawn tool is the exception, not the baseline.
    hasSubagent: true,
    isSubagent: false,
    cwd: "/work/desk",
    skillsLibrary: LIB,
    // Fixed so the footer is assertable without freezing time globally.
    now: new Date(2026, 8, 29),
    ...overrides,
  });
}

describe("the prompt is always well-formed", () => {
  test("names itself and its core responsibilities even with every inventory empty", () => {
    const p = build();
    expect(p).toContain("# Quant-Research Agent");
    expect(p).toContain("## Core Responsibilities");
  });

  test("ends with the date and cwd footer", () => {
    const p = build();
    expect(p).toContain("Current date: 2026-09-29");
    expect(p.trimEnd().endsWith("Current working directory: /work/desk")).toBe(true);
  });

  test("emits no section heading for an inventory that is empty", () => {
    // A heading with nothing under it reads to the model as a capability it has
    // and cannot use.
    const p = build();
    expect(p).not.toContain("## Available Agents");
    expect(p).not.toContain("## Available Skills");
    expect(p).not.toContain("## Project Context");
    expect(p).not.toContain("## Guidelines");
  });

  test("leaves no unexpanded template expression, in every shape", () => {
    // The prompt interpolates mapped lists and nested conditionals; an escaping
    // slip would ship literal `${...}` into every request.
    for (const p of [
      build(),
      build({ agentInventory: fleet(["market-scout", "backtester"]) }),
      build({
        isSubagent: true,
        agentInventory: fleet(["market-scout"]),
        customPrompt: "CUSTOM",
        appendSystemPrompt: "APPEND",
        guidelines: ["Cite sources."],
        contextInventory: [{ path: "/work/desk/AGENTS.md" }],
        skillInventory: [
          {
            name: "fundamental-analysis",
            description: "d",
            filePath: `${LIB}/finance/fundamental-analysis/SKILL.md`,
            pathCategory: "finance",
          },
        ],
      }),
    ]) {
      expect(p).not.toContain("${");
    }
  });
});

describe("the prompt is a research desk, not an orchestrator", () => {
  // The orchestrator's prompt says `# Orchestrator Agent`; the quant prompt
  // must never drift back toward it, in either the top-level or the child
  // shape. The scan is over the whole rendered output, case-insensitive.
  test("never says orchestrator, in the top-level shape", () => {
    const p = build({
      agentInventory: fleet(["market-scout", "backtester", "risk-check", "scribe"]),
      skillInventory: [
        {
          name: "fundamental-analysis",
          description: "d",
          filePath: `${LIB}/finance/fundamental-analysis/SKILL.md`,
          pathCategory: "finance",
        },
      ],
      contextInventory: [{ path: "/work/desk/AGENTS.md" }],
      guidelines: ["Cite sources."],
      customPrompt: "CUSTOM",
      appendSystemPrompt: "APPEND",
    });
    expect(p.toLowerCase()).not.toContain("orchestrator");
  });

  test("never says orchestrator, in the child shape", () => {
    const p = build({
      isSubagent: true,
      agentInventory: fleet(["market-scout", "backtester"]),
      appendSystemPrompt: "APPEND",
    });
    expect(p.toLowerCase()).not.toContain("orchestrator");
  });
});

describe("the roster", () => {
  test("lists exactly the inventory it was given, one row per agent", () => {
    const inv = fleet(["market-scout", "backtester", "risk-check", "scribe"]);
    const p = build({ agentInventory: inv });
    expect(p).toContain("## Available Agents");
    for (const a of inv) {
      expect(p).toContain(`| ${a.name} | ${a.description} | all | m |`);
    }
    // Nothing from the coding profile's fleet may leak into the desk's prompt.
    for (const name of ["worker", "reviewer", "planner", "verifier", "healthcheck"]) {
      expect(p).not.toContain(name);
    }
  });

  test("is withheld when the spawn tool is absent, even with a roster", () => {
    // A roster discovered on disk is not a capability unless the tool that
    // spawns those agents is offered this run.
    const p = build({ agentInventory: fleet(["backtester"]), hasSubagent: false });
    expect(p).not.toContain("## Available Agents");
    expect(p).not.toContain("backtester");
  });

  test("is withheld on an empty roster, which a fresh install hits", () => {
    expect(build()).not.toContain("## Available Agents");
  });

  test("a child keeps the roster but loses the coordinator's charter", () => {
    // The charter is written for the top-level session; a child's own body
    // carries its contract, so it is withheld rather than duplicated.
    const p = build({ isSubagent: true, agentInventory: fleet(["backtester"]) });
    expect(p).not.toContain("## Core Responsibilities");
    expect(p).toContain("## Available Agents");
  });
});

describe("the appended body", () => {
  test("a child run keeps its appendSystemPrompt body in the output", () => {
    // The child is launched with `--append-system-prompt`; its body must
    // survive the replacement, verbatim, after the persona and before the
    // footer.
    const p = build({ isSubagent: true, appendSystemPrompt: "CHILD-BODY-MARK" });
    expect(p).toContain("CHILD-BODY-MARK");
    expect(p.indexOf("CHILD-BODY-MARK")).toBeGreaterThan(p.indexOf("# Quant-Research Agent"));
    expect(p.indexOf("CHILD-BODY-MARK")).toBeLessThan(p.indexOf("Current date:"));
  });

  test("a top-level run threads it through too, after the custom prompt", () => {
    // Ordering is the contract: an append that preceded the custom prompt would
    // let a user override be silently overridden.
    const p = build({ customPrompt: "CUSTOM-MARK", appendSystemPrompt: "APPEND-MARK" });
    expect(p).toContain("CUSTOM-MARK");
    expect(p).toContain("APPEND-MARK");
    expect(p.indexOf("CUSTOM-MARK")).toBeLessThan(p.indexOf("APPEND-MARK"));
    expect(p.indexOf("APPEND-MARK")).toBeLessThan(p.indexOf("Current date:"));
  });

  test("no append leaves no dangling section", () => {
    const p = build();
    expect(p).not.toContain("\n\n\n");
  });
});

describe("the skill catalogue", () => {
  test("groups library skills by their path category, one line each", () => {
    const p = build({
      skillInventory: [
        {
          name: "fundamental-analysis",
          description: "Business quality",
          filePath: `${LIB}/finance/fundamental-analysis/SKILL.md`,
          pathCategory: "finance",
        },
        {
          name: "technical-analysis",
          description: "Chart read",
          filePath: `${LIB}/finance/technical-analysis/SKILL.md`,
          pathCategory: "finance",
        },
      ],
    });
    expect(p).toContain("## Available Skills");
    expect(p).toContain("**finance**");
    expect(p).toContain("- **fundamental-analysis** — Business quality");
    expect(p).toContain("- **technical-analysis** — Chart read");
    // A library skill's path is implied by the root, so it must not be repeated.
    expect(p).not.toContain(`${LIB}/finance/fundamental-analysis/SKILL.md`);
  });
});

describe("the before_agent_start handler", () => {
  // The filter and the roster wiring live in the handler, not in
  // `buildQuantPrompt`, so this is the only layer that can pin them. The env is
  // pointed at a temp profile tree, so the roster comes from the stub fleet
  // below — not from `quant-trader/agents/`, which other work is reshaping in
  // parallel.
  let agentRoot: string;
  let originalAgentDir: string | undefined;

  beforeAll(() => {
    agentRoot = mkdtempSync(join(tmpdir(), "quant-prompt-test-"));
    mkdirSync(join(agentRoot, "agents"));
    mkdirSync(join(agentRoot, "skills"));
    // The stub fleet: the profile's own four. Two are public to a child
    // (`callable_by: any`), so a child's roster is non-empty and assertable.
    const def = (name: string, description: string, callableBy?: string) =>
      [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        ...(callableBy ? [`callable_by: ${callableBy}`] : []),
        "---",
        `${description} body.`,
        "",
      ].join("\n");
    writeFileSync(join(agentRoot, "agents", "market-scout.md"), def("market-scout", "Scans markets", "any"));
    writeFileSync(join(agentRoot, "agents", "backtester.md"), def("backtester", "Backtests ideas", "any"));
    writeFileSync(join(agentRoot, "agents", "risk-check.md"), def("risk-check", "Audits risk"));
    writeFileSync(join(agentRoot, "agents", "scribe.md"), def("scribe", "Writes the journal"));
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentRoot;
  });

  afterAll(() => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  /** Runs the extension's `before_agent_start` handler against a fake event. */
  async function start(overrides: {
    selectedTools: string[];
    lineage?: string;
    appendSystemPrompt?: string;
  }) {
    const handlers = new Map<string, (event: never, ctx: never) => Promise<unknown>>();
    quantExtension({
      on(name: string, handler: (event: never, ctx: never) => Promise<unknown>) {
        handlers.set(name, handler);
      },
    } as never);
    const startHandler = handlers.get("before_agent_start");
    expect(startHandler).toBeDefined();
    const originalLineage = process.env[LINEAGE_ENV];
    if (overrides.lineage === undefined) delete process.env[LINEAGE_ENV];
    else process.env[LINEAGE_ENV] = overrides.lineage;
    try {
      const event = {
        messageType: "user",
        prompt: "",
        systemPromptOptions: {
          cwd: "/work/desk",
          selectedTools: overrides.selectedTools,
          skills: [],
          contextFiles: [],
          promptGuidelines: [],
          appendSystemPrompt: overrides.appendSystemPrompt,
        },
      };
      const result = (await startHandler!(event as never, undefined as never)) as {
        systemPrompt: string;
      };
      return {
        selectedTools: event.systemPromptOptions.selectedTools as string[],
        systemPrompt: result.systemPrompt,
      };
    } finally {
      if (originalLineage === undefined) delete process.env[LINEAGE_ENV];
      else process.env[LINEAGE_ENV] = originalLineage;
    }
  }

  test("strips write, edit, code_rewrite and undo_last_edit from the offered tool set", async () => {
    const { selectedTools, systemPrompt } = await start({
      selectedTools: ["read", "bash", "write", "edit", "code_rewrite", "undo_last_edit", "subagent"],
    });
    for (const t of ["write", "edit", "code_rewrite", "undo_last_edit"]) {
      expect(selectedTools).not.toContain(t);
    }
    // The rest is untouched, in order — the filter removes, it does not reorder.
    expect(selectedTools).toEqual(["read", "bash", "subagent"]);
    expect(systemPrompt).toContain("# Quant-Research Agent");
  });

  test("strips them from a child's --tools allowlist too — the filter is not a no-op for a child", async () => {
    const { selectedTools, systemPrompt } = await start({
      selectedTools: ["read", "bash", "write", "edit", "code_rewrite", "undo_last_edit", "subagent"],
      lineage: "market-scout",
    });
    expect(selectedTools).toEqual(["read", "bash", "subagent"]);
    // The child is a child: the coordinator's charter is withheld.
    expect(systemPrompt).not.toContain("## Core Responsibilities");
  });

  test("a child run keeps its appendSystemPrompt body in the output", async () => {
    const { systemPrompt } = await start({
      selectedTools: ["read", "bash", "subagent"],
      lineage: "market-scout",
      appendSystemPrompt: "CHILD-BODY-MARK",
    });
    expect(systemPrompt).toContain("CHILD-BODY-MARK");
    expect(systemPrompt.indexOf("CHILD-BODY-MARK")).toBeGreaterThan(
      systemPrompt.indexOf("# Quant-Research Agent"),
    );
    expect(systemPrompt.indexOf("CHILD-BODY-MARK")).toBeLessThan(systemPrompt.indexOf("Current date:"));
  });

  test("the roster lists only the profile's own fleet", async () => {
    const { systemPrompt } = await start({ selectedTools: ["read", "bash", "subagent"] });
    for (const name of ["market-scout", "backtester", "risk-check", "scribe"]) {
      expect(systemPrompt).toContain(`| ${name} |`);
    }
    for (const name of ["worker", "reviewer", "planner", "verifier"]) {
      expect(systemPrompt).not.toContain(name);
    }
  });

  test("a child sees only what its lineage may spawn", async () => {
    // `backtester` is `callable_by: any` and not in its own ancestry;
    // `market-scout` is in its own ancestry (a cycle); the rest are
    // orchestrator-only.
    const { systemPrompt } = await start({
      selectedTools: ["read", "bash", "subagent"],
      lineage: "market-scout",
    });
    expect(systemPrompt).toContain("| backtester |");
    for (const name of ["market-scout", "risk-check", "scribe"]) {
      expect(systemPrompt).not.toContain(`| ${name} |`);
    }
  });

  test("no spawn tool, no roster section, even with a roster on disk", async () => {
    const { systemPrompt } = await start({ selectedTools: ["read", "bash"] });
    expect(systemPrompt).not.toContain("## Available Agents");
    expect(systemPrompt).toContain("# Quant-Research Agent");
  });
});
