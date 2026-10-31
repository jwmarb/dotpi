/**
 * The pure persona logic: profile discovery, name resolution, tool-set
 * computation, widening, and session-entry parsing.
 *
 * Hermetic: temp dirs, no real profile reads — the same stance as
 * `quant-trader/extensions/test/quant-prompt.test.ts`, so nothing here
 * depends on `~/.pi` as other work reshapes it in parallel.
 *
 * Run: `bun test agent/extensions/persona/lib.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeTargetTools,
  deniedToolsFor,
  discoverProfiles,
  installedPackageNames,
  isWidening,
  latestPersonaEntry,
  missingInProcess,
  packageBaseName,
  personaBlock,
  readPersonaMcp,
  readPersonaMcpSync,
  resolveProfileArg,
  type PersonaEntry,
  type ProfileInfo,
  type ProcessToolInfo,
} from "./lib.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "persona-test-"));
}

/** A minimal profile: a directory with a `settings.json` and an `extensions/`. */
function makeProfile(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "extensions"), { recursive: true });
  writeFileSync(join(dir, "settings.json"), "{}");
  return dir;
}

// ---------------------------------------------------------------------------
// (a) discoverProfiles
// ---------------------------------------------------------------------------

describe("discoverProfiles", () => {
  test("(a) finds the settings.json dirs, dedupes symlinks into aliases, skips the excluded", async () => {
    const root = tempRoot();
    const agent = makeProfile(root, "agent");
    makeProfile(root, "quant-trader");
    symlinkSync("agent", join(root, "orchestrator"));
    for (const name of ["docs", "scripts", "node_modules", ".git", "nosettings"]) {
      mkdirSync(join(root, name), { recursive: true });
    }
    try {
      const profiles = await discoverProfiles(root);
      expect(profiles).toHaveLength(2);
      const [a, q] = profiles;
      expect(a?.name).toBe("agent");
      // The non-symlink entry is the canonical name; the symlink is the alias.
      expect(a?.aliases).toEqual(["orchestrator"]);
      expect(a?.dir).toBe(await realpath(agent));
      expect(q?.name).toBe("quant-trader");
      expect(q?.aliases).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a broken symlink and a settings-less dir are not profiles", async () => {
    const root = tempRoot();
    makeProfile(root, "agent");
    symlinkSync("does-not-exist", join(root, "ghost"));
    mkdirSync(join(root, "plain"));
    try {
      const profiles = await discoverProfiles(root);
      expect(profiles).toHaveLength(1);
      expect(profiles[0]?.name).toBe("agent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (b) resolveProfileArg
// ---------------------------------------------------------------------------

describe("resolveProfileArg", () => {
  const profiles: ProfileInfo[] = [
    { name: "agent", aliases: ["orchestrator"], dir: "/root/agent", promptKind: "orchestrator" },
    { name: "quant-trader", aliases: [], dir: "/root/quant-trader", promptKind: "quant" },
  ];
  const home = "/root/agent";

  /** Resolves and asserts success, returning the profile name. */
  const nameOf = (arg: string, list: ProfileInfo[] = profiles): string => {
    const r = resolveProfileArg(arg, list, home);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    return r.profile.name;
  };

  test("(b) a unique prefix resolves to the full profile", () => {
    expect(nameOf("quant")).toBe("quant-trader");
  });

  test("(b) an alias resolves to its profile", () => {
    expect(nameOf("orchestrator")).toBe("agent");
  });

  test("(b) -, default and home all name the process's real profile", () => {
    for (const arg of ["-", "default", "home"]) {
      expect(nameOf(arg)).toBe("agent");
    }
  });

  test("(b) an ambiguous prefix is an error that names every candidate", () => {
    const list = [
      ...profiles,
      { name: "quant-x", aliases: [], dir: "/root/quant-x", promptKind: undefined },
    ];
    const r = resolveProfileArg("quant", list, home);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toContain("quant-trader");
    expect(r.error).toContain("quant-x");
  });

  test("(b) a name nothing matches is an error", () => {
    const r = resolveProfileArg("zz", profiles, home);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c)/(d) computeTargetTools
// ---------------------------------------------------------------------------

describe("computeTargetTools", () => {
  // The home session's full set, with the source facts a real process would
  // carry: builtins are `builtin:`-sourced, the board and the spawner are
  // top-level extension tools, MCP tools ride on the `builtin:mcp` source.
  const homeActive = [
    "read",
    "bash",
    "write",
    "edit",
    "code_rewrite",
    "undo_last_edit",
    "kanban",
    "subagent",
    "mcp__github__search",
    "mcp__robinhood__x",
  ];
  const tools: ProcessToolInfo[] = [
    { name: "read", sourcePath: "builtin:read", source: "builtin", origin: "top-level" },
    { name: "bash", sourcePath: "builtin:bash", source: "builtin", origin: "top-level" },
    { name: "write", sourcePath: "builtin:write", source: "builtin", origin: "top-level" },
    { name: "edit", sourcePath: "builtin:edit", source: "builtin", origin: "top-level" },
    { name: "code_rewrite", sourcePath: "builtin:code_rewrite", source: "builtin", origin: "top-level" },
    { name: "undo_last_edit", sourcePath: "builtin:undo_last_edit", source: "builtin", origin: "top-level" },
    // The quant profile's spawner is a symlink into the process's own
    // extension, so its target ext realpaths carry this realpath.
    { name: "kanban", sourcePath: "/root/agent/extensions/kanban/index.ts", source: "agent/extensions/kanban", origin: "top-level" },
    { name: "subagent", sourcePath: "/root/agent/extensions/subagent-herdr/index.ts", source: "agent/extensions/subagent-herdr", origin: "top-level" },
    { name: "mcp__github__search", sourcePath: "builtin:mcp", source: "builtin", origin: "top-level" },
    { name: "mcp__robinhood__x", sourcePath: "builtin:mcp", source: "builtin", origin: "top-level" },
  ];

  test("(c) a quant target drops the mutators, the board, and its own MCP tools", () => {
    const out = computeTargetTools({
      homeActive,
      tools,
      targetExtRealpaths: ["/root/agent/extensions/subagent-herdr"],
      targetPackages: [],
      targetMcpServers: [],
      sharedMcpServers: ["robinhood"],
      denied: deniedToolsFor("quant"),
    });
    // Input order is kept: what survives is in home order.
    expect(out.active).toEqual(["read", "bash", "subagent", "mcp__robinhood__x"]);
    expect(out.dropped).toEqual(["write", "edit", "code_rewrite", "undo_last_edit", "kanban", "mcp__github__search"]);
  });

  test("(d) switching back to the home target keeps homeActive unchanged", () => {
    const out = computeTargetTools({
      homeActive,
      tools,
      targetExtRealpaths: [
        "/root/agent/extensions/kanban",
        "/root/agent/extensions/subagent-herdr",
      ],
      targetPackages: [],
      targetMcpServers: ["github"],
      sharedMcpServers: ["robinhood"],
      denied: new Set<string>(),
    });
    expect(out.active).toEqual(homeActive);
    expect(out.dropped).toEqual([]);
  });

  test("a package tool follows the target's packages, and a denied tool drops no matter its source", () => {
    const out = computeTargetTools({
      homeActive: ["trade_journal", "read"],
      tools: [
        { name: "trade_journal", sourcePath: "/pkg/trade-journal/tool.ts", source: "@me/trade-journal", origin: "package" },
        { name: "read", sourcePath: "builtin:read", source: "builtin", origin: "top-level" },
      ],
      targetExtRealpaths: [],
      targetPackages: ["@me/trade-journal"],
      targetMcpServers: [],
      sharedMcpServers: [],
      denied: new Set(["read"]),
    });
    expect(out.active).toEqual(["trade_journal"]);
    expect(out.dropped).toEqual(["read"]);
  });

  test("a package tool matches by installed name when the specifier list does not carry it", () => {
    // pi reports package tools by installed name — `npm:opensec-pi-fff@0.11.1`,
    // `npm:pi-blackhole@2.1.0` — which the specifier list does not carry.
    // `targetPackages` is the target's *effective* declared set: settings
    // `packages` plus the piBolt overlay (which is what swaps
    // `@ff-labs/pi-fff` for `opensec-pi-fff`), as `readSettings` supplies it.
    // The installed-name and git-path intersection is what keeps such tools for
    // a target that declares them.
    const out = computeTargetTools({
      homeActive: ["ffgrep", "recall", "lsp_diagnostics"],
      tools: [
        { name: "ffgrep", sourcePath: "/t/npm/node_modules/opensec-pi-fff/dist-bun/index.js", source: "npm:opensec-pi-fff@0.11.1", origin: "package" },
        { name: "recall", sourcePath: "/t/npm/node_modules/pi-blackhole/index.js", source: "npm:pi-blackhole@2.1.0", origin: "package" },
        { name: "lsp_diagnostics", sourcePath: "/t/git/github.com/samfoy/pi-lsp-extension/dist/index.js", source: "git:github.com/samfoy/pi-lsp-extension", origin: "package" },
      ],
      targetExtRealpaths: [],
      targetPackages: ["npm:@ff-labs/pi-fff", "npm:opensec-pi-fff@0.11.1", "npm:pi-blackhole", "git:github.com/samfoy/pi-lsp-extension"],
      targetNpmNames: ["opensec-pi-fff", "pi-blackhole"],
      targetGitPaths: ["github.com/samfoy/pi-lsp-extension"],
      targetMcpServers: [],
      sharedMcpServers: [],
      denied: new Set<string>(),
    });
    expect(out.active).toEqual(["ffgrep", "recall", "lsp_diagnostics"]);
    expect(out.dropped).toEqual([]);
  });

  test("a scoped specifier whose installed base differs, with no exact entry, drops (the W4 union must cover it)", () => {
    // W4 motivation. `readSettings` used to let the piBolt overlay *replace*
    // `npm:@ff-labs/pi-fff` with `npm:opensec-pi-fff`; the union keeps both.
    // Given only the scoped specifier, `computeTargetTools` cannot keep a tool
    // whose installed base (`opensec-pi-fff`) differs from the declared base
    // (`@ff-labs/pi-fff`): the installed-name intersection requires the base to
    // be a *declared* base, and the exact specifier does not carry the installed
    // name. This is the gap the union closes.
    const out = computeTargetTools({
      homeActive: ["ffgrep"],
      tools: [
        { name: "ffgrep", sourcePath: "/t/npm/node_modules/opensec-pi-fff/dist-bun/index.js", source: "npm:opensec-pi-fff@0.11.1", origin: "package" },
      ],
      targetExtRealpaths: [],
      targetPackages: ["npm:@ff-labs/pi-fff"],
      targetNpmNames: ["opensec-pi-fff"],
      targetGitPaths: [],
      targetMcpServers: [],
      sharedMcpServers: [],
      denied: new Set<string>(),
    });
    expect(out.active).toEqual([]);
    expect(out.dropped).toEqual(["ffgrep"]);
  });

  test("a defined-but-empty targetNpmNames drops an installed-name tool (the unreadable-tree fallback)", () => {
    // The documented fallback (`installedPackageNames`): an unreadable tree yields
    // an empty set, so the rule falls back to the specifier match alone. A
    // defined-but-empty `targetNpmNames` must not leak an installed-name tool
    // through — its base is neither an exact declared specifier nor a declared
    // npm base here.
    const out = computeTargetTools({
      homeActive: ["ffgrep"],
      tools: [
        { name: "ffgrep", sourcePath: "/t/npm/node_modules/opensec-pi-fff/dist-bun/index.js", source: "npm:opensec-pi-fff@0.11.1", origin: "package" },
      ],
      targetExtRealpaths: [],
      targetPackages: ["npm:pi-blackhole"],
      targetNpmNames: [],
      targetGitPaths: [],
      targetMcpServers: [],
      sharedMcpServers: [],
      denied: new Set<string>(),
    });
    expect(out.active).toEqual([]);
    expect(out.dropped).toEqual(["ffgrep"]);
  });

  test("an installed package the target does not declare drops; the declared-and-installed one keeps", () => {
    // The target's package tree is a symlink into the home cache, so "installed
    // in the target" is true for every home package: the declared set is what
    // trims. `pi-lsp-extension` is installed in the tree but not declared → its
    // tools drop; `pi-blackhole` is declared and installed → it keeps.
    const out = computeTargetTools({
      homeActive: ["lsp_diagnostics", "recall"],
      tools: [
        { name: "lsp_diagnostics", sourcePath: "/t/npm/node_modules/pi-lsp-extension/index.js", source: "npm:pi-lsp-extension@1.4.2", origin: "package" },
        { name: "recall", sourcePath: "/t/npm/node_modules/pi-blackhole/index.js", source: "npm:pi-blackhole@2.1.0", origin: "package" },
      ],
      targetExtRealpaths: [],
      targetPackages: ["npm:pi-blackhole"],
      targetNpmNames: ["pi-lsp-extension", "pi-blackhole"],
      targetGitPaths: [],
      targetMcpServers: [],
      sharedMcpServers: [],
      denied: new Set<string>(),
    });
    expect(out.active).toEqual(["recall"]);
    expect(out.dropped).toEqual(["lsp_diagnostics"]);
  });

  test("an installed git package the target does not declare drops", () => {
    // The git tree is a symlink into the home cache, so the package is
    // "installed" in the target; without a declared `git:` specifier it must
    // not cross — this is the leak the intersection closes.
    const out = computeTargetTools({
      homeActive: ["lsp_diagnostics"],
      tools: [
        { name: "lsp_diagnostics", sourcePath: "/t/git/github.com/samfoy/pi-lsp-extension/dist/index.js", source: "git:github.com/samfoy/pi-lsp-extension", origin: "package" },
      ],
      targetExtRealpaths: [],
      targetPackages: [],
      targetNpmNames: [],
      targetGitPaths: ["github.com/samfoy/pi-lsp-extension"],
      targetMcpServers: [],
      sharedMcpServers: [],
      denied: new Set<string>(),
    });
    expect(out.active).toEqual([]);
    expect(out.dropped).toEqual(["lsp_diagnostics"]);
  });

  test("a package tool the target does not install drops", () => {
    const out = computeTargetTools({
      homeActive: ["lsp_diagnostics"],
      tools: [
        { name: "lsp_diagnostics", sourcePath: "/h/git/github.com/samfoy/pi-lsp-extension/dist/index.js", source: "git:github.com/samfoy/pi-lsp-extension", origin: "package" },
      ],
      targetExtRealpaths: [],
      targetPackages: [],
      targetNpmNames: [],
      targetGitPaths: [],
      targetMcpServers: [],
      sharedMcpServers: [],
      denied: new Set<string>(),
    });
    expect(out.active).toEqual([]);
    expect(out.dropped).toEqual(["lsp_diagnostics"]);
  });
});

describe("packageBaseName", () => {
  test("strips the scheme and a trailing version, keeps a scope", () => {
    expect(packageBaseName("npm:opensec-pi-fff@0.11.1")).toBe("opensec-pi-fff");
    expect(packageBaseName("npm:pi-blackhole")).toBe("pi-blackhole");
    expect(packageBaseName("npm:@ff-labs/pi-fff")).toBe("@ff-labs/pi-fff");
    expect(packageBaseName("git:github.com/obra/superpowers")).toBe("github.com/obra/superpowers");
  });
});

describe("installedPackageNames", () => {
  test("reads installed names from the npm and git trees", () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, "npm", "node_modules", "opensec-pi-fff"), { recursive: true });
      writeFileSync(
        join(root, "npm", "node_modules", "opensec-pi-fff", "package.json"),
        JSON.stringify({ name: "opensec-pi-fff" }),
      );
      mkdirSync(join(root, "npm", "node_modules", "@ff-labs", "pi-fff"), { recursive: true });
      writeFileSync(
        join(root, "npm", "node_modules", "@ff-labs", "pi-fff", "package.json"),
        JSON.stringify({ name: "@ff-labs/pi-fff" }),
      );
      mkdirSync(join(root, "git", "github.com", "samfoy", "pi-lsp-extension"), { recursive: true });
      writeFileSync(
        join(root, "git", "github.com", "samfoy", "pi-lsp-extension", "package.json"),
        JSON.stringify({ name: "pi-lsp-extension" }),
      );
      const out = installedPackageNames(root);
      expect(out.npmNames).toEqual(expect.arrayContaining(["opensec-pi-fff", "@ff-labs/pi-fff"]));
      expect(out.gitPaths).toEqual(["github.com/samfoy/pi-lsp-extension"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unreadable tree yields empty sets", () => {
    const out = installedPackageNames(join(tempRoot(), "absent"));
    expect(out.npmNames).toEqual([]);
    expect(out.gitPaths).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (e) missingInProcess
// ---------------------------------------------------------------------------

describe("missingInProcess", () => {
  test("(e) a quant process missing kanban and ralph-loop reports them, not the prompt markers", () => {
    const target = [
      "/root/agent/extensions/kanban",
      "/root/agent/extensions/ralph-loop",
      "/root/agent/extensions/dynamic-prompt.ts",
      "/root/agent/extensions/subagent-herdr",
    ];
    // The quant process loads the same subagent-herdr realpath through its
    // symlink, so it is not missing.
    const processExts = ["/root/agent/extensions/subagent-herdr"];
    const missing = missingInProcess(target, processExts, [], []);
    expect(missing).toContain("/root/agent/extensions/kanban");
    expect(missing).toContain("/root/agent/extensions/ralph-loop");
    // The persona extension supplies the prompt, so its marker is not a gap.
    expect(missing).not.toContain("/root/agent/extensions/dynamic-prompt.ts");
    expect(missing).not.toContain("/root/agent/extensions/subagent-herdr");
  });

  test("a target package the process lacks is listed", () => {
    const missing = missingInProcess([], [], ["@me/extra"], []);
    expect(missing).toEqual(["@me/extra"]);
  });
});

// ---------------------------------------------------------------------------
// (f) isWidening
// ---------------------------------------------------------------------------

describe("isWidening", () => {
  test("(f) lists the gained tools; the reverse gains nothing", () => {
    const quantEffective = ["read", "bash", "subagent", "mcp__robinhood__x"];
    // The home session has the shared robinhood server too, so the reverse
    // switch (agent → quant) gains nothing.
    const agentActive = ["read", "bash", "write", "edit", "kanban", "subagent", "mcp__github__search", "mcp__robinhood__x"];
    const gained = isWidening(quantEffective, agentActive);
    expect(gained).toContain("write");
    expect(gained).toContain("edit");
    // Nothing the quant session already has is "gained" again.
    expect(gained).not.toContain("read");
    expect(isWidening(agentActive, quantEffective)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (g) latestPersonaEntry
// ---------------------------------------------------------------------------

describe("latestPersonaEntry", () => {
  const entry = (over: Partial<PersonaEntry> = {}): PersonaEntry => ({
    profile: "quant-trader",
    dir: "/root/quant-trader",
    at: "2026-10-30T12:00:00.000Z",
    widened: false,
    confirmed: true,
    dropped: ["write"],
    missing: [],
    ...over,
  });

  test("(g) the last persona-switch entry wins; other types and malformed data are skipped", () => {
    const first = entry({ profile: "agent", at: "2026-10-30T11:00:00.000Z" });
    const second = entry({ profile: "quant-trader", at: "2026-10-30T12:00:00.000Z" });
    const entries = [
      { type: "custom", customType: "persona-switch", data: first },
      // A different extension's entry: not a persona switch.
      { type: "custom", customType: "kanban-card", data: second },
      // Malformed data: skipped, not fatal.
      { type: "custom", customType: "persona-switch", data: { profile: 42 } },
      // Not an entry at all.
      null,
      { type: "message" },
      { type: "custom", customType: "persona-switch", data: second },
    ];
    expect(latestPersonaEntry(entries)).toEqual(second);
  });

  test("(g) a JSON round-trip leaves the entry equal", () => {
    const e = entry({ homeTools: ["read", "bash"], homeModel: { provider: "p", id: "m" }, homeThinking: "xhigh" });
    const round = JSON.parse(JSON.stringify(e)) as unknown;
    expect(latestPersonaEntry([{ type: "custom", customType: "persona-switch", data: round }])).toEqual(e);
  });
});

// ---------------------------------------------------------------------------
// (h) personaBlock
// ---------------------------------------------------------------------------

describe("personaBlock", () => {
  test("(h) names the persona, the home, and every dropped tool", () => {
    const block = personaBlock({
      name: "quant-trader",
      homeName: "agent",
      at: new Date("2026-10-30T12:00:00Z"),
      dropped: ["write", "edit", "kanban"],
      missing: ["ralph-loop"],
    });
    expect(block).toContain("## Active Persona");
    expect(block).toContain("quant-trader");
    expect(block).toContain("agent");
    for (const t of ["write", "edit", "kanban"]) {
      expect(block).toContain(t);
    }
    expect(block).toContain("ralph-loop");
  });
});

// ---------------------------------------------------------------------------
// readPersonaMcp (the sync variant's load-time registration is step 6's;
// the parse rules are pinned here)
// ---------------------------------------------------------------------------

describe("readPersonaMcp", () => {
  test("a missing file gives the empty set, async and sync", async () => {
    const dir = tempRoot();
    try {
      expect(await readPersonaMcp(dir)).toEqual({});
      expect(readPersonaMcpSync(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parses mcpServers, async and sync", async () => {
    const dir = tempRoot();
    const servers = {
      github: { url: "https://example.test", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" }, exposure: "direct" },
    };
    writeFileSync(join(dir, "persona-mcp.json"), JSON.stringify({ mcpServers: servers }));
    try {
      expect(await readPersonaMcp(dir)).toEqual(servers);
      expect(readPersonaMcpSync(dir)).toEqual(servers);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed JSON throws with the path in the message", async () => {
    const dir = tempRoot();
    writeFileSync(join(dir, "persona-mcp.json"), "{ not json");
    try {
      await expect(readPersonaMcp(dir)).rejects.toThrow(/persona-mcp\.json/);
      expect(() => readPersonaMcpSync(dir)).toThrow(/persona-mcp\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
