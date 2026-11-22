/**
 * The synthesized indirect-MCP-servers note.
 *
 * The forced orchestrator prompt suppresses pi's core sections, and core's own
 * `mcp_servers` section is written by the builtin MCP extension's
 * `before_agent_start` handler — which runs after this repo's, because handlers
 * run in registration order and user extensions register first. So the note
 * this module produces is the only thing that tells the model a deferred server
 * exists. These tests pin the two things a wrong answer breaks: which servers
 * appear (an exposure rule read backwards hides a whole server, or advertises
 * one whose tools are already declared), and the names it can actually act on
 * (`mcp__<server>`, `mcp__<server>__<tool>`).
 *
 * The readers are pinned against temp config files rather than a stubbed loader:
 * the config shape is a public file format, and the failure worth catching is a
 * file the reader cannot map (malformed, absent, disabled, a `toolExposure` value
 * that is not a string).
 *
 * Run: `bun test agent/extensions/lib/mcp-config.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  promptMcpServersSection,
  readMcpServersFile,
  readPromptMcpServers,
  synthesizeMcpServersSection,
  type PromptMcpServer,
} from "./mcp-config.js";

/** An agent dir holding the given `mcp.json` content (`undefined` means no file). */
function mcpTree(mcp?: unknown | string): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-test-"));
  if (mcp !== undefined) {
    writeFileSync(join(dir, "mcp.json"), typeof mcp === "string" ? mcp : JSON.stringify(mcp));
  }
  return dir;
}

const server = (over: Partial<PromptMcpServer> & { name: string }): PromptMcpServer => ({ ...over });

describe("synthesizeMcpServersSection", () => {
  test("no servers, and only-direct/only-hidden servers, give an empty string", () => {
    expect(synthesizeMcpServersSection([])).toBe("");
    expect(
      synthesizeMcpServersSection([
        server({ name: "robinhood", exposure: "direct" }),
        server({ name: "secrets", exposure: "hidden" }),
      ]),
    ).toBe("");
  });

  test("a deferred server's line is the whole note, in pi's namespace", () => {
    expect(synthesizeMcpServersSection([server({ name: "robinhood", exposure: "deferred" })])).toBe(
      "- `mcp__robinhood` — tools are NOT declared to you; load them with `tool_search`",
    );
  });

  test("an omitted exposure is pi's codemode default", () => {
    const line = synthesizeMcpServersSection([server({ name: "github" })]);
    expect(line).toContain("call them from codemode scripts (`searchTools()`)");
    // Explicit `codemode` reads the same as the default it replaces.
    expect(synthesizeMcpServersSection([server({ name: "github", exposure: "codemode" })])).toBe(line);
  });

  test("a codemode server names codemode only — pi does not enable tool_search for it", () => {
    const line = synthesizeMcpServersSection([server({ name: "github", exposure: "codemode" })]);
    expect(line).toContain("call them from codemode scripts (`searchTools()`)");
    // pi's `ensureDiscoveryActive` activates `tool_search` only on a `deferred`
    // exposure, so pointing the model at `tool_search` for a codemode-only
    // server would name a tool pi never enabled for it.
    expect(line).not.toContain("tool_search");
  });

  test("a server-level `direct` with one `deferred` pin is listed, with the tool_search reach", () => {
    // pi's `hasIndirectTools` reads the UNION of a server's exposures, and so does
    // this note: the deferred tools are real and only `tool_search` reaches them,
    // even though the server itself is configured `direct`.
    expect(
      synthesizeMcpServersSection([
        server({ name: "robinhood", exposure: "direct", toolExposure: { x: "deferred" } }),
      ]),
    ).toBe("- `mcp__robinhood` — tools are NOT declared to you; load them with `tool_search`");
  });

  test("codemode wins a union that mixes codemode and deferred pins", () => {
    const line = synthesizeMcpServersSection([
      server({ name: "github", exposure: "deferred", toolExposure: { a: "codemode", b: "deferred" } }),
    ]);
    expect(line).toContain("call them from codemode scripts (`searchTools()`)");
  });

  test("a union of only direct and hidden pins contributes nothing", () => {
    expect(
      synthesizeMcpServersSection([
        server({ name: "robinhood", exposure: "direct", toolExposure: { a: "direct", b: "hidden" } }),
        server({ name: "secrets", exposure: "hidden", toolExposure: { a: "direct" } }),
      ]),
    ).toBe("");
  });

  test("an exposure pi does not know lists nothing: the rule is pi's allow-list", () => {
    // Mirrors pi's `hasIndirectTools`, which asks whether the configured union
    // `has` `codemode` or `deferred` rather than refusing `direct`/`hidden`. An
    // exposure name added in a later pi version is then absent from this note
    // exactly as it is from core's own section, which keeps the note aligned with
    // what pi actually enables.
    expect(synthesizeMcpServersSection([server({ name: "future", exposure: "something-new" })])).toBe(
      "",
    );
    // The same unknown pin on an otherwise-indirect server changes nothing.
    expect(
      synthesizeMcpServersSection([
        server({ name: "future", exposure: "deferred", toolExposure: { t: "something-new" } }),
      ]),
    ).toContain("mcp__future");
  });

  test("a `direct` toolExposure override is listed under its declared tool name", () => {
    const line = synthesizeMcpServersSection([
      server({
        name: "robinhood",
        exposure: "deferred",
        toolExposure: { get_accounts: "direct", get_positions: "direct", cancel_order: "hidden" },
      }),
    ]);
    expect(line).toContain(
      "; declared directly: `mcp__robinhood__get_accounts`, `mcp__robinhood__get_positions`",
    );
    expect(line).not.toContain("cancel_order");
  });

  test("a disabled server contributes nothing", () => {
    expect(
      synthesizeMcpServersSection([server({ name: "off", exposure: "deferred", enabled: false })]),
    ).toBe("");
  });

  test("lines are sorted by config name and carry no heading or trailing newline", () => {
    const out = synthesizeMcpServersSection([
      server({ name: "zeta", exposure: "deferred" }),
      server({ name: "alpha", exposure: "deferred" }),
    ]);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("mcp__alpha");
    expect(lines[1]).toContain("mcp__zeta");
    expect(out).not.toContain("##");
    expect(out.endsWith("\n")).toBe(false);
  });

  test("a dash in a server name follows pi's namespace sanitizing", () => {
    const out = synthesizeMcpServersSection([
      server({ name: "my-srv", exposure: "deferred", toolExposure: { "do.it": "direct" } }),
    ]);
    expect(out).toContain("`mcp__my_srv`");
    expect(out).toContain("`mcp__my_srv__do_it`");
  });

  test("the input array is not mutated by the sort", () => {
    const servers = [server({ name: "zeta", exposure: "deferred" }), server({ name: "alpha" })];
    synthesizeMcpServersSection(servers);
    expect(servers.map((s) => s.name)).toEqual(["zeta", "alpha"]);
  });
});

describe("readMcpServersFile", () => {
  test("maps pi's mcpServers shape onto entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-config-read-"));
    const file = join(dir, "mcp.json");
    writeFileSync(
      file,
      JSON.stringify({
        autoEnableCodemode: true,
        mcpServers: {
          robinhood: {
            url: "https://example.test/mcp",
            description: "Trading.",
            timeout: 60,
            exposure: "deferred",
            toolExposure: { get_accounts: "direct", cancel_order: "hidden" },
          },
          off: { url: "https://x.test", enabled: false },
        },
      }),
    );
    expect(readMcpServersFile(file)).toEqual([
      {
        name: "robinhood",
        description: "Trading.",
        exposure: "deferred",
        toolExposure: { get_accounts: "direct", cancel_order: "hidden" },
      },
      { name: "off", enabled: false },
    ]);
  });

  test("a missing file, a directory, malformed JSON, and a non-object mcpServers all read as []", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-config-bad-"));
    expect(readMcpServersFile(join(dir, "nope.json"))).toEqual([]);
    expect(readMcpServersFile(dir)).toEqual([]);

    const malformed = join(dir, "malformed.json");
    writeFileSync(malformed, "{ not json");
    expect(readMcpServersFile(malformed)).toEqual([]);

    const wrongShape = join(dir, "shape.json");
    writeFileSync(wrongShape, JSON.stringify({ mcpServers: ["robinhood"] }));
    expect(readMcpServersFile(wrongShape)).toEqual([]);

    const noKey = join(dir, "empty.json");
    writeFileSync(noKey, "{}");
    expect(readMcpServersFile(noKey)).toEqual([]);
  });

  test("non-string toolExposure values are dropped rather than guessed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-config-odd-"));
    const file = join(dir, "mcp.json");
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { a: { url: "https://x.test", toolExposure: { t: 1, u: "direct" } } } }),
    );
    expect(readMcpServersFile(file)).toEqual([{ name: "a", toolExposure: { u: "direct" } }]);
  });

  test("a BOM-prefixed config still reads: JSON.parse rejects one, Windows editors write one", () => {
    const tree = mcpTree(
      "\uFEFF" + JSON.stringify({ mcpServers: { github: { url: "https://g.test", exposure: "deferred" } } }),
    );
    expect(readMcpServersFile(join(tree, "mcp.json"))).toEqual([{ name: "github", exposure: "deferred" }]);
    expect(promptMcpServersSection(tree)).toBe(
      "- `mcp__github` — tools are NOT declared to you; load them with `tool_search`",
    );
  });
});

describe("readPromptMcpServers and promptMcpServersSection", () => {
  test("reads the agent dir's mcp.json and advertises its indirect servers", () => {
    const tree = mcpTree({
      mcpServers: {
        robinhood: { url: "https://r.test", exposure: "deferred" },
        github: { url: "https://g.test", exposure: "deferred" },
      },
    });
    expect(readPromptMcpServers(tree).map((s) => s.name)).toEqual(["robinhood", "github"]);
    const section = promptMcpServersSection(tree);
    expect(section).toContain("mcp__robinhood");
    expect(section).toContain("mcp__github");
  });

  test("missing files, an unreadable dir, and a malformed config all yield ''", () => {
    const empty = mkdtempSync(join(tmpdir(), "mcp-config-none-"));
    expect(promptMcpServersSection(empty)).toBe("");
    expect(promptMcpServersSection(join(empty, "does-not-exist"))).toBe("");
    expect(promptMcpServersSection(mcpTree("{ broken"))).toBe("");
    // A path that is a file, not a directory: `readFileSync` fails, the note is ''.
    const tree = mcpTree({ mcpServers: {} });
    expect(promptMcpServersSection(join(tree, "mcp.json"))).toBe("");
  });

  test("names that pi's namespace folds together dedupe to one line, first-wins", () => {
    // `mcpNamespace` turns `-` into `_`, so these two keys name one server in
    // the tool list; the note must not advertise it twice.
    const tree = mcpTree({
      mcpServers: {
        "my-srv": { url: "https://a.test", description: "first", exposure: "deferred" },
        my_srv: { url: "https://b.test", description: "second", exposure: "deferred" },
      },
    });
    expect(readPromptMcpServers(tree)).toEqual([
      { name: "my-srv", description: "first", exposure: "deferred" },
    ]);
    expect(promptMcpServersSection(tree).split("\n")).toEqual([
      "- `mcp__my_srv` — tools are NOT declared to you; load them with `tool_search`",
    ]);
  });

  test("a disabled name does not suppress the enabled one it folds onto", () => {
    // A disabled server is never registered, so the enabled `my_srv` must still
    // be advertised even though `my-srv` shares its namespace and comes first.
    const tree = mcpTree({
      mcpServers: {
        "my-srv": { url: "https://a.test", exposure: "deferred", enabled: false },
        my_srv: { url: "https://b.test", exposure: "deferred" },
      },
    });
    expect(readPromptMcpServers(tree).map((s) => s.name)).toEqual(["my_srv"]);
    expect(promptMcpServersSection(tree).split("\n")).toEqual([
      "- `mcp__my_srv` — tools are NOT declared to you; load them with `tool_search`",
    ]);
  });

  test("an agent dir with only direct servers gets no section", () => {
    const tree = mcpTree({
      mcpServers: { robinhood: { url: "https://r.test", exposure: "direct" } },
    });
    expect(promptMcpServersSection(tree)).toBe("");
  });
});
