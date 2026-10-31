/**
 * Index-level tests for the persona switch's enforcement path — the `tool_call`
 * block, the W2 MCP-server tool rule (the `appliedMcpApplies` clause), the W1
 * widening-gate binding on resume, and the home restore. Hermetic: a temp repo
 * root with a home profile and a quant target, a stub `pi`, and a fresh module
 * import per test (the module carries per-process `homeState` / `applied` state,
 * so each test gets a clean instance).
 *
 * Run: `bun test agent/extensions/persona/index.test.ts`
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { personaOverride, setPersonaOverride } from "../lib/persona.js";

let repoRoot: string;
let agentDirPath: string;
let quantReal: string;
let researchReal: string;
let agentReal: string;
let originalAgentDir: string | undefined;
let originalSubagentRunId: string | undefined;

const HOME_TOOLS = ["read", "bash", "write", "edit"];

/**
 * The sourceInfo pi 1.4.0 reports for an MCP tool. Probed against a live
 * `mcp__github__*` server: `path: "builtin:mcp"`, `source: "builtin"`,
 * `origin: "top-level"` (plus `scope: "temporary"`). This is why the W2 rule is
 * about the *server name*, not the source: a `builtin:` tool that is not in the
 * home active set is not kept by the tool-set rule's `builtin:` branch.
 */
const MCP_SOURCE_INFO = { path: "builtin:mcp", source: "builtin", origin: "top-level" };

beforeAll(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), "persona-index-test-"));
  agentDirPath = join(repoRoot, "agent");
  const quantDir = join(repoRoot, "quant-trader");
  mkdirSync(join(agentDirPath, "extensions"), { recursive: true });
  writeFileSync(join(agentDirPath, "settings.json"), "{}");
  writeFileSync(join(agentDirPath, "extensions", "dynamic-prompt.ts"), "export default function(){}");
  mkdirSync(join(quantDir, "extensions"), { recursive: true });
  writeFileSync(join(quantDir, "settings.json"), "{}");
  // The quant prompt module the `before_agent_start` takeover imports; it must
  // expose `buildQuantPrompt` so the declaration-filter path runs end to end.
  writeFileSync(
    join(quantDir, "extensions", "quant-prompt.ts"),
    "export function buildQuantPrompt(opts) { globalThis.__personaQuantOpts = opts; return 'quant'; }",
  );
  // The target's own AGENTS.md, so the takeover's context swap is assertable.
  writeFileSync(join(quantDir, "AGENTS.md"), "# Quant profile context\n");
  // The target declares a `github` MCP server.
  writeFileSync(
    join(quantDir, "persona-mcp.json"),
    JSON.stringify({ mcpServers: { github: { url: "https://example.test" } } }),
  );
  quantReal = await realpath(quantDir);
  // A second, non-denying profile (orchestrator), so a switch to it re-enables
  // the tools a quant override currently withholds — the live widening the W1
  // cases need.
  const researchDir = join(repoRoot, "research");
  mkdirSync(join(researchDir, "extensions"), { recursive: true });
  writeFileSync(join(researchDir, "settings.json"), "{}");
  writeFileSync(
    join(researchDir, "extensions", "dynamic-prompt.ts"),
    "export function buildOrchestratorPrompt(opts) { globalThis.__personaOrchOpts = opts; return 'orchestrator'; }",
  );
  writeFileSync(join(researchDir, "AGENTS.md"), "# Research profile context\n");
  // A skill in the target's own library, so the skill inventory the takeover
  // derives is assertable against a path that home does not have.
  mkdirSync(join(researchDir, "skills", "demo-cat", "demo"), { recursive: true });
  writeFileSync(
    join(researchDir, "skills", "demo-cat", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: demo skill\n---\nBody.\n",
  );
  researchReal = await realpath(researchDir);
  writeFileSync(join(agentDirPath, "AGENTS.md"), "# Home profile context\n");
  agentReal = await realpath(agentDirPath);
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  originalSubagentRunId = process.env.PI_SUBAGENT_RUN_ID;
  process.env.PI_CODING_AGENT_DIR = agentDirPath;
  // The extension's default export returns early when PI_SUBAGENT_RUN_ID is set
  // (subagents don't run persona wiring), which would skip all handler
  // registration. Clear it so the full extension loads.
  delete process.env.PI_SUBAGENT_RUN_ID;
});

afterAll(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalSubagentRunId === undefined) delete process.env.PI_SUBAGENT_RUN_ID;
  else process.env.PI_SUBAGENT_RUN_ID = originalSubagentRunId;
  setPersonaOverride(undefined);
  rmSync(repoRoot, { recursive: true, force: true });
});

beforeEach(() => {
  setPersonaOverride(undefined);
  // The stub builders record what they were handed; a stale capture would make a
  // later test pass on an earlier one's call.
  delete (globalThis as { __personaOrchOpts?: unknown }).__personaOrchOpts;
  delete (globalThis as { __personaQuantOpts?: unknown }).__personaQuantOpts;
});

let importCounter = 0;
interface StubPi {
  handlers: Map<string, (event: never, ctx?: never) => Promise<unknown>>;
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }>;
  entries: () => unknown[];
  activeTools: () => string[];
  addTool: (name: string, sourceInfo: { path: string; source: string; origin: string }) => void;
}

async function freshExtension(): Promise<StubPi> {
  const mod = await import(`./index.js?persona-index-test=${++importCounter}`);
  const handlers = new Map<string, (event: never, ctx?: never) => Promise<unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }>();
  let activeTools = [...HOME_TOOLS];
  let entries: unknown[] = [];
  // The process's tools, as `getAllTools()` reports them. The MCP tool is NOT
  // present initially: a server that connects *after* the switch is exactly the
  // case the `appliedMcpApplies` rule exists for, and the W2 union (which walks
  // `getAllTools()` at switch time) cannot see a tool that is not there yet.
  const allTools = [
    { name: "read", sourceInfo: { path: "builtin:read", source: "builtin", origin: "top-level" } },
    { name: "bash", sourceInfo: { path: "builtin:bash", source: "builtin", origin: "top-level" } },
    { name: "write", sourceInfo: { path: "builtin:write", source: "builtin", origin: "top-level" } },
    { name: "edit", sourceInfo: { path: "builtin:edit", source: "builtin", origin: "top-level" } },
  ];
  const pi = {
    on: (name: string, handler: (event: never, ctx?: never) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = [...tools];
    },
    getAllTools: () => allTools,
    registerMcpServer: () => {},
    registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<unknown> }) => {
      commands.set(name, cmd);
    },
    unregisterMcpServer: () => {},
    appendEntry: (type: string, data: unknown) => {
      entries.push({ type: "custom", customType: type, data });
    },
    setModel: async () => true,
    setThinkingLevel: () => {},
  };
  mod.default(pi as never);
  return {
    handlers,
    commands,
    entries: () => entries,
    activeTools: () => activeTools,
    addTool: (name, sourceInfo) => {
      allTools.push({ name, sourceInfo });
    },
  };
}

function makeCtx(entries: unknown[], hasUI = true, confirmResult = true) {
  const notifications: string[] = [];
  return {
    sessionManager: { getEntries: () => entries },
    hasUI,
    ui: {
      confirm: async () => confirmResult,
      notify: (msg: string) => {
        notifications.push(msg);
      },
    },
    model: undefined,
    modelRegistry: { find: () => undefined },
    thinkingLevel: undefined,
    notifications,
  };
}

const entry = (over: Record<string, unknown> = {}) => ({
  profile: "quant-trader",
  dir: quantReal,
  at: "2026-10-30T12:00:00.000Z",
  widened: true,
  confirmed: true,
  dropped: ["write", "edit"],
  missing: [],
  homeTools: HOME_TOOLS,
  ...over,
});

const switchEntry = (over: Record<string, unknown> = {}) => ({
  type: "custom",
  customType: "persona-switch",
  data: entry(over),
});

describe("the tool_call enforcement path", () => {
  test("(a) a tool in the target's active set is allowed", async () => {
    const ext = await freshExtension();
    const ctx = makeCtx([switchEntry()]);
    await ext.handlers.get("session_start")!({ reason: "resume" }, ctx);
    expect(personaOverride()?.name).toBe("quant-trader");
    const result = await ext.handlers.get("tool_call")!({ toolName: "read", input: {} });
    expect(result).toBeUndefined();
  });

  test("(b) a denied name is blocked", async () => {
    const ext = await freshExtension();
    const ctx = makeCtx([switchEntry()]);
    await ext.handlers.get("session_start")!({ reason: "resume" }, ctx);
    expect(personaOverride()?.name).toBe("quant-trader");
    const result = await ext.handlers.get("tool_call")!({ toolName: "write", input: {} });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("quant-trader") });
  });

  test("W2: a tool from a server that connects after the switch is allowed by the server rule", async () => {
    const ext = await freshExtension();
    const ctx = makeCtx([switchEntry()]);
    await ext.handlers.get("session_start")!({ reason: "resume" }, ctx);
    expect(personaOverride()?.name).toBe("quant-trader");
    // The github server was not connected at switch time, so its tool is not in
    // the active set: the W2 union walks getAllTools() at switch time and never
    // saw it, and the tool-set rule's builtin: branch does not apply (it is not
    // in the home active set). It is reachable only through the server rule.
    expect(ext.activeTools()).not.toContain("mcp__github__search");
    // The server connects now. Its tool is allowed by appliedMcpApplies, not by
    // applied.active — which is the clause this test guards.
    ext.addTool("mcp__github__search", MCP_SOURCE_INFO);
    const result = await ext.handlers.get("tool_call")!({ toolName: "mcp__github__search", input: {} });
    expect(result).toBeUndefined();
    // The declaration filter keeps it by the same rule.
    const opts: {
      selectedTools: string[];
      skills: unknown[];
      contextFiles: { path: string }[];
      promptGuidelines: string[];
    } = {
      selectedTools: ["read", "bash", "mcp__github__search"],
      skills: [],
      contextFiles: [],
      promptGuidelines: [],
    };
    await ext.handlers.get("before_agent_start")!({ messageType: "user", prompt: "hi", systemPromptOptions: opts });
    expect(opts.selectedTools).toContain("mcp__github__search");
  });

  test("(d) after a home restore, a previously-denied tool is allowed", async () => {
    const ext = await freshExtension();
    const ctx = makeCtx([switchEntry()]);
    await ext.handlers.get("session_start")!({ reason: "resume" }, ctx);
    expect(personaOverride()?.name).toBe("quant-trader");
    // Switch back to home: no entry, reason "new" → clear to home.
    const ctx2 = makeCtx([], true);
    await ext.handlers.get("session_start")!({ reason: "new" }, ctx2);
    expect(personaOverride()).toBeUndefined();
    const result = await ext.handlers.get("tool_call")!({ toolName: "write", input: {} });
    expect(result).toBeUndefined();
  });
});

describe("the W1 widening-gate binding on resume", () => {
  // Step 1 in every case: a live quant switch, so the current effective set
  // withholds write/edit. `homeTools` in the resumed entry is set to the
  // *current* active set ([read, bash]) where a case needs `sameTools` to hold.
  async function switchToQuant(ext: StubPi) {
    const ctx = makeCtx([switchEntry({ widened: false, confirmed: false })]);
    await ext.handlers.get("session_start")!({ reason: "resume" }, ctx);
    expect(personaOverride()?.name).toBe("quant-trader");
  }

  test("W1a: widened:false/confirmed:true does not skip a live widening (no UI → refused)", async () => {
    const ext = await freshExtension();
    await switchToQuant(ext);
    // The recorded entry is what every non-widening switch wrote before the W1
    // fix: widened:false, confirmed:true. Restoring research re-enables
    // write/edit — a live widening. `sameTools` holds (homeTools = current
    // active set), so `entry.widened` is the only thing keeping the gate from
    // being skipped.
    const ctx = makeCtx(
      [
        switchEntry({
          profile: "research",
          dir: researchReal,
          widened: false,
          confirmed: true,
          homeTools: ["read", "bash"],
        }),
      ],
      false,
    );
    await ext.handlers.get("session_start")!({ reason: "resume" }, ctx);
    expect(personaOverride()?.name).toBe("quant-trader");
    expect(ctx.notifications.some((n) => n.includes("refused"))).toBe(true);
    const result = await ext.handlers.get("tool_call")!({ toolName: "write", input: {} });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("quant-trader") });
  });

  test("W1b: widened:true/confirmed:true with a stale homeTools falls back to the live gate (refused)", async () => {
    const ext = await freshExtension();
    await switchToQuant(ext);
    // widened:true, confirmed:true, but homeTools does not match the current
    // active set: the sameTools binding fails, so the gate is not skipped even
    // though the entry claims a confirmed widening.
    const ctx = makeCtx(
      [
        switchEntry({
          profile: "research",
          dir: researchReal,
          widened: true,
          confirmed: true,
          homeTools: ["read", "bash", "write", "edit"],
        }),
      ],
      false,
    );
    await ext.handlers.get("session_start")!({ reason: "resume" }, ctx);
    expect(personaOverride()?.name).toBe("quant-trader");
    expect(ctx.notifications.some((n) => n.includes("refused"))).toBe(true);
    const result = await ext.handlers.get("tool_call")!({ toolName: "write", input: {} });
    expect(result).toEqual({ block: true, reason: expect.stringContaining("quant-trader") });
  });

  test("W1c: a matching, confirmed widening restores", async () => {
    const ext = await freshExtension();
    await switchToQuant(ext);
    // widened:true, confirmed:true, homeTools matches the current active set:
    // the gate is skipped and the (widening) restore applies.
    const ctx = makeCtx(
      [
        switchEntry({
          profile: "research",
          dir: researchReal,
          widened: true,
          confirmed: true,
          homeTools: ["read", "bash"],
        }),
      ],
      true,
      true,
    );
    await ext.handlers.get("session_start")!({ reason: "resume" }, ctx);
    expect(personaOverride()?.name).toBe("research");
    const result = await ext.handlers.get("tool_call")!({ toolName: "write", input: {} });
    expect(result).toBeUndefined();
  });

  test("W1d: a non-widening switch records confirmed:false (the W1 recording fix)", async () => {
    const ext = await freshExtension();
    const ctx = makeCtx([]);
    await ext.commands.get("agent")!.handler("quant-trader", ctx);
    const recorded = ext.entries().find(
      (e) => (e as { customType?: string }).customType === "persona-switch",
    ) as { data: { widened: boolean; confirmed: boolean } } | undefined;
    expect(recorded?.data.widened).toBe(false);
    expect(recorded?.data.confirmed).toBe(false);
  });
});

describe("the takeover feeds the target's inputs to the builder", () => {
  // The switch derives the target profile's skills and AGENTS.md, then hands them
  // to the target's own builder. When the takeover went through the *home*
  // `promptInputs`, that work was thrown away and the prompt listed the home
  // profile's catalogue — so the assertions are on what the builder received.
  interface Captured {
    skillInventory: Array<{ name: string; filePath: string }>;
    contextInventory: Array<{ path: string }>;
  }

  async function runTakeover(
    ext: StubPi,
    entryOver: Record<string, unknown>,
    contextFiles: Array<{ path: string }>,
  ) {
    const ctx = makeCtx([switchEntry(entryOver)]);
    await ext.handlers.get("session_start")!({ reason: "resume" }, ctx);
    await ext.handlers.get("before_agent_start")!({
      messageType: "user",
      prompt: "hi",
      systemPromptOptions: {
        cwd: "/w",
        selectedTools: ["read"],
        skills: [],
        promptGuidelines: [],
        contextFiles,
      },
    });
  }

  test("an orchestrator target gets its own skill catalogue and AGENTS.md", async () => {
    const ext = await freshExtension();
    await runTakeover(
      ext,
      { profile: "research", dir: researchReal, widened: false, confirmed: false, dropped: [] },
      [{ path: join(agentReal, "AGENTS.md") }, { path: "/proj/AGENTS.md" }],
    );
    expect(personaOverride()?.name).toBe("research");

    const opts = (globalThis as { __personaOrchOpts?: unknown }).__personaOrchOpts as Captured;
    expect(
      opts.skillInventory.map((s) => s.filePath),
    ).toContain(join(researchReal, "skills", "demo-cat", "demo", "SKILL.md"));
    // The home AGENTS.md entry is swapped for the target's; project context stays.
    expect(opts.contextInventory).toEqual([
      { path: join(researchReal, "AGENTS.md") },
      { path: "/proj/AGENTS.md" },
    ]);
  });

  test("a quant target gets its own AGENTS.md", async () => {
    const ext = await freshExtension();
    await runTakeover(ext, {}, [{ path: join(agentReal, "AGENTS.md") }, { path: "/proj/AGENTS.md" }]);
    expect(personaOverride()?.name).toBe("quant-trader");

    const opts = (globalThis as { __personaQuantOpts?: unknown }).__personaQuantOpts as Captured;
    expect(opts.contextInventory[0]?.path).toBe(join(quantReal, "AGENTS.md"));
  });
});
