/**
 * Tests for the .env parser (lib/dotenv.ts) — the single owner of the
 * `agent/.env` grammar.
 *
 * Run from the repo root: `bun test agent/extensions/lib/dotenv.test.ts`
 */
import { describe, expect, test } from "bun:test";

import { parseEnv } from "./dotenv.js";

describe("parseEnv", () => {
  test("parses a plain KEY=VALUE line", () => {
    const m = parseEnv("LITELLM_API_KEY=sk-abc123");
    expect(m.get("LITELLM_API_KEY")).toBe("sk-abc123");
  });

  test("skips blank lines and # comments", () => {
    const m = parseEnv([
      "",
      "   ",
      "# a comment",
      "  # indented comment",
      "FOO=bar",
    ].join("\n"));
    expect([...m.keys()]).toEqual(["FOO"]);
    expect(m.get("FOO")).toBe("bar");
  });

  test("accepts CRLF line endings", () => {
    const m = parseEnv("FOO=bar\r\nBAZ=qux\r\n");
    expect(m.get("FOO")).toBe("bar");
    expect(m.get("BAZ")).toBe("qux");
  });

  test("tolerates a leading `export ` prefix", () => {
    const m = parseEnv("export FOO=bar");
    expect(m.get("FOO")).toBe("bar");
  });

  test("skips a line with no `=`", () => {
    const m = parseEnv("JUSTAKEY\nFOO=bar");
    expect([...m.keys()]).toEqual(["FOO"]);
  });

  test("skips a line with an empty key", () => {
    const m = parseEnv("=orphan\n =also orphan\nFOO=bar");
    expect([...m.keys()]).toEqual(["FOO"]);
  });

  test("keeps an empty value", () => {
    const m = parseEnv("EMPTY=");
    expect(m.has("EMPTY")).toBe(true);
    expect(m.get("EMPTY")).toBe("");
  });

  test("splits on the first `=`, keeping the rest literal", () => {
    const m = parseEnv("URL=http://host:8080/path?a=1&b=2");
    expect(m.get("URL")).toBe("http://host:8080/path?a=1&b=2");
  });

  test("strips one layer of matching double quotes", () => {
    const m = parseEnv('QUOTED="hello world"');
    expect(m.get("QUOTED")).toBe("hello world");
  });

  test("strips one layer of matching single quotes", () => {
    const m = parseEnv("QUOTED='hello world'");
    expect(m.get("QUOTED")).toBe("hello world");
  });

  test("leaves unmatched quotes literal", () => {
    const m = parseEnv('OPEN="abc\nCLOSED=abc"\nBARE=\'');
    expect(m.get("OPEN")).toBe('"abc');
    expect(m.get("CLOSED")).toBe('abc"');
    expect(m.get("BARE")).toBe("'");
  });

  test("lets a later duplicate win", () => {
    const m = parseEnv("FOO=first\nFOO=second");
    expect(m.get("FOO")).toBe("second");
    expect([...m.values()]).toEqual(["second"]);
  });

  test("does not interpolate $VAR inside values", () => {
    const m = parseEnv("REF=$OTHER\nLITERAL=${OTHER}");
    expect(m.get("REF")).toBe("$OTHER");
    expect(m.get("LITERAL")).toBe("${OTHER}");
  });

  test("trims whitespace around keys and values", () => {
    const m = parseEnv("  FOO  =  bar  ");
    expect(m.get("FOO")).toBe("bar");
  });

  test("returns an empty map for empty input", () => {
    expect([...parseEnv("").keys()]).toEqual([]);
    expect([...parseEnv("# only a comment\n").keys()]).toEqual([]);
  });
  test("# is not stripped from an unquoted value", () => {
    const m = parseEnv("KEY=sk-ab#cd");
    expect(m.get("KEY")).toBe("sk-ab#cd");
  });
});
