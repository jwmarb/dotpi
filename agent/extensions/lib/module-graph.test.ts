/**
 * Live-tree invariants for the `lib/` module table in `agent/extensions/AGENTS.md`.
 *
 * The precedent is `skill-catalogue.test.ts`: no fixtures, walk `agent/extensions/`
 * as it is on disk. That choice is the point, not a shortcut — the thing under test
 * is a *table* that drifted away from the tree, and a fixture-shaped guard cannot
 * catch a table that drifted. A fixture only ever asserts what its author believed
 * about the tree; the table goes wrong in the real one, when a module is renamed, a
 * consumer starts importing something, or a row is simply never updated.
 *
 * Three claims, all re-derived at run time from file contents:
 *
 *   1. the table holds exactly one row per module in `lib/`, and no row keyed by
 *      anything that is not a module;
 *   2. each row's consumer list is exactly the set of extensions that really import
 *      that module. Edges come from RESOLVING the specifiers in each file, not from
 *      pattern-matching their text, so `./x.js`, `../lib/x.js`, `./lib/x.js` and
 *      `../<name>.js` are all the same edge;
 *   3. `lib/` has no import cycles.
 *
 * Nothing here asserts a number on purpose. An enforced consumer set is not a hand
 * count: a row names who imports the module and a test checks it against the tree,
 * so the table cannot rot the way a hand-written "N modules + M suites" total did. The
 * failure messages point at are the real discovery route — `ls
 * agent/extensions/lib/*.ts` for modules, `find agent/extensions -name '*.test.ts'`
 * for suites, `grep -rn "lib/<name>.js" agent/extensions -l` for one module's
 * consumers, `wc -l` when someone genuinely wants a size.
 *
 * Run from the repo root: `bun test agent/extensions/lib/module-graph.test.ts`
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import { agentDir } from "./layout.js";

const EXT_ROOT = join(agentDir(), "extensions");
const LIB_DIR = join(EXT_ROOT, "lib");
const AGENTS_MD = join(EXT_ROOT, "AGENTS.md");

/** Quote a name the way the table does, so a message reads like the row it wants. */
const code = (s: string): string => "`" + s + "`";

/** A set as `[a, b]`, sorted, so `missing:`/`stale:` lines compare by eye. */
function shown(values: Iterable<string>): string {
  const arr = [...values].sort();
  return `[${arr.join(", ")}]`;
}

/** Non-test `.ts` files in one directory. Test files are consumers, never modules. */
function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => join(dir, e.name))
    .sort();
}

/**
 * Every file that can hold an edge: the extensions at the top level, each directory
 * extension's own files, and `lib/` itself (whose imports are the cycle graph).
 */
function importerFiles(): string[] {
  const out = [...sourceFiles(EXT_ROOT), ...sourceFiles(LIB_DIR)];
  for (const entry of readdirSync(EXT_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "lib" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    out.push(...sourceFiles(join(EXT_ROOT, entry.name)));
  }
  return out;
}

/**
 * Every module specifier in a file, static or dynamic, `type`-only included.
 *
 * Run against the whole text rather than line by line: this tree writes multi-line
 * import lists, and a per-line scan silently drops their source.
 */
const SPECIFIER = /from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g;

function specifiersIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(SPECIFIER)) out.push(match[1] ?? match[2]!);
  return out;
}

/**
 * The `.ts` file a specifier names, or null when it is outside this tree.
 *
 * `moduleResolution: "bundler"`: sources write `./x.js` for the `x.ts` on disk, so a
 * `.js` (or extensionless) specifier is retried as `.ts`. Resolving is what makes the
 * four spellings of the same dependency one edge — pattern-matching the specifier
 * would need a rule per spelling and would miss `../<name>.js` from a sibling dir.
 */
function resolveSource(spec: string, fromFile: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const tries: string[] = [];
  if (/\.(js|mjs)$/.test(spec)) tries.push(base.replace(/\.(js|mjs)$/, ".ts"), base);
  else if (!/\.[a-z]+$/.test(base)) tries.push(`${base}.ts`, base);
  else tries.push(base);
  for (const candidate of tries) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The extension a file stands for in the table's consumer list: a file directly under
 * an extension directory is that extension, a file inside one is the directory, and a
 * file in `lib/` is no consumer at all (it belongs to the cycle graph instead).
 */
function consumerName(file: string): string | null {
  if (dirname(file) === LIB_DIR) return null;
  const segments = relative(EXT_ROOT, file).split("/");
  return segments.length === 1 ? basename(file, ".ts") : segments[0];
}

const moduleNames = sourceFiles(LIB_DIR).map((p) => basename(p));
const moduleSet = new Set(moduleNames);

/** module → extension names that import it (the table's comparison side). */
const importedBy = new Map<string, Set<string>>(moduleNames.map((m) => [m, new Set<string>()]));
/** lib module → lib modules it imports (the cycle graph only). */
const libImports = new Map<string, Set<string>>(moduleNames.map((m) => [m, new Set<string>()]));

for (const file of importerFiles()) {
  const consumer = consumerName(file);
  for (const spec of specifiersIn(readFileSync(file, "utf8"))) {
    const target = resolveSource(spec, file);
    if (!target || target === file) continue; // self-edges prove nothing
    if (dirname(target) !== LIB_DIR) continue;
    const mod = basename(target);
    if (!moduleSet.has(mod)) continue;
    if (consumer) importedBy.get(mod)!.add(consumer);
    else libImports.get(basename(file))!.add(mod);
  }
}

/** One `|` row of the `## lib/` table. */
interface Row {
  /** The module the row is keyed by; null when its first cell is not exactly one `name.ts`. */
  key: string | null;
  /** Every `name.ts` in the first cell — more than one means the row is keyed by two modules. */
  cellNames: string[];
  /** Consumer names after the last `·`. */
  consumers: string[];
  /** 1-based line in `AGENTS.md`, so the message points at the row to edit. */
  line: number;
}

/**
 * The `## lib/` table: rows between that heading and the next `## `, minus the header
 * and the `|---|` rule. Consumers are the text after the row's LAST `·` — the `·`
 * inside a heading's own title is outside the region, and the prose before the
 * separator is allowed to use the character.
 */
function parseTable(): Row[] {
  if (!existsSync(AGENTS_MD)) return [];
  const lines = readFileSync(AGENTS_MD, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("## lib/"));
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  const rows: Row[] = [];
  lines.slice(start + 1, end === -1 ? lines.length : end).forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("|")) return;
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    if (cells[0] === "Module") return; // header
    if (/^[-:\s]+$/.test(cells.join(""))) return; // |---|---|
    const cellNames = [...cells[0].matchAll(/`([^`]+\.ts)`/g)].map((m) => m[1]);
    const body = trimmed.replace(/\|$/, "");
    const afterDot = body.lastIndexOf("·");
    rows.push({
      key: cellNames.length === 1 ? cellNames[0] : null,
      cellNames,
      consumers:
        afterDot === -1
          ? []
          : body
              .slice(afterDot + 1)
              .split(",")
              .map((c) => c.replace(/`/g, "").trim())
              .filter((c) => c.length > 0),
      line: start + 2 + i,
    });
  });
  return rows;
}

const rows = parseTable();

/** The commands that rebuild one row, named in every failure this file can produce. */
function reDerive(moduleName?: string): string[] {
  const out = [
    "re-derive it from the tree, never from this table:",
    "  ls agent/extensions/lib/*.ts",
    "  find agent/extensions -name '*.test.ts'",
  ];
  if (moduleName) {
    out.push(`  grep -rn "lib/${moduleName.replace(/\.ts$/, "")}.js" agent/extensions -l`);
  }
  return out;
}

/**
 * The first back edge found by a DFS over `lib/`'s imports, as the cycle path.
 * A back edge to a node on the stack is the cycle; the path is printed whole.
 */
function findCycle(edges: Map<string, Set<string>>): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const walk = (node: string): string[] | null => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of [...(edges.get(node) ?? [])].sort()) {
      const seen = state.get(next);
      if (seen === "visiting") return [...stack.slice(stack.indexOf(next)), next];
      if (seen === undefined) {
        const found = walk(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(node, "done");
    return null;
  };
  for (const node of [...edges.keys()].sort()) {
    if (state.get(node)) continue;
    const found = walk(node);
    if (found) return found;
  }
  return null;
}

describe("the lib/ table in agent/extensions/AGENTS.md", () => {
  test("walks a real tree: modules and rows both exist (the non-vacuity guard)", () => {
    // Without this, a typo'd root or a renamed heading yields zero modules and zero
    // rows, every set below compares equal, and the whole file goes green doing
    // nothing — the exact outcome the assertions exist to prevent.
    expect(
      moduleNames.length,
      [
        `expected the live walk of ${LIB_DIR} to find modules; found ${moduleNames.length}.`,
        `Is the root still ${code("join(agentDir(), \"extensions\")")}?`,
        ...reDerive(),
      ].join("\n"),
    ).toBeGreaterThan(10);

    expect(
      rows.length,
      [
        `expected at least one row per module (${moduleNames.length}) in the ${code("## lib/")} table of`,
        `${AGENTS_MD}; parsed ${rows.length}. Did the heading, the column order, or the ${code("·")} separator move?`,
        ...reDerive(),
      ].join("\n"),
    ).toBeGreaterThanOrEqual(moduleNames.length);
  });

  test("holds exactly one row per module, and no row for anything else", () => {
    const keys = rows.map((r) => r.key).filter((k): k is string => k !== null);
    const keyed = new Set(keys);
    const missing = moduleNames.filter((m) => !keyed.has(m));
    const stale = keys.filter((k) => !moduleSet.has(k));
    const duplicated = keys.filter((k, i) => keys.indexOf(k) !== i);
    const unkeyed = rows.filter((r) => r.key === null);

    const problems: string[] = [];
    if (missing.length > 0) {
      problems.push(`missing: ${shown(missing)} — a module in lib/ has no row of its own.`);
      problems.push(
        ...missing.map((m) => `  add a row keyed by ${code(m)}, consumers after ${code(" · ")}`),
      );
    }
    if (stale.length > 0) {
      problems.push(`stale: ${shown(stale)} — a row is keyed by a name with no file in lib/.`);
      for (const k of stale) {
        const row = rows.find((r) => r.key === k)!;
        problems.push(`  ${AGENTS_MD}:${row.line} — drop the row or fix its key`);
      }
    }
    if (duplicated.length > 0) {
      problems.push(`duplicated: ${shown(new Set(duplicated))} — one module, several rows.`);
      for (const k of duplicated) {
        for (const row of rows.filter((r) => r.key === k)) {
          problems.push(`  ${AGENTS_MD}:${row.line} — merge the consumer lists into one row`);
        }
      }
    }
    if (unkeyed.length > 0) {
      problems.push(
        `unkeyed: ${unkeyed.length} row(s) whose first cell is not exactly one \`name.ts\`. One module per row:`,
      );
      for (const row of unkeyed) {
        const named = row.cellNames.length > 0 ? row.cellNames.join(", ") : "(no module named)";
        problems.push(
          `  ${AGENTS_MD}:${row.line} is keyed by ${named} — split it into one row per module, consumers after ${code(" · ")}`,
        );
      }
    }
    if (problems.length > 0) problems.push(...reDerive(missing[0]));

    expect(
      problems,
      `the ${code("## lib/")} table and ${LIB_DIR} disagree (row numbers are ${code("AGENTS.md")} lines).`,
    ).toEqual([]);
  });

  test("names exactly the extensions that really import each module", () => {
    const problems: string[] = [];
    for (const row of rows) {
      if (row.key === null || !moduleSet.has(row.key)) continue; // the row-per-module test owns those
      const documented = new Set(row.consumers);
      const discovered = importedBy.get(row.key)!;
      const missing = [...discovered].filter((c) => !documented.has(c));
      const stale = [...documented].filter((c) => !discovered.has(c));
      if (missing.length === 0 && stale.length === 0) continue;
      problems.push(
        [
          `${row.key} (${AGENTS_MD}:${row.line})`,
          `  documented: ${shown(documented)}`,
          `  discovered: ${shown(discovered)}`,
          `  missing: ${shown(missing)} — imports it, not in the row`,
          `  stale: ${shown(stale)} — in the row, imports nothing of the sort`,
        ].join("\n"),
      );
      problems.push(...reDerive(row.key));
    }

    expect(
      problems,
      [
        `a consumer list is not the set of extensions importing the module. Consumers are`,
        `extension-level names only (a lib-internal importer is not a consumer), compared as sets,`,
        `so order and duplicates in the row do not matter — an import does.`,
      ].join(" "),
    ).toEqual([]);
  });

  test("has no import cycles inside lib/", () => {
    const cycle = findCycle(libImports);
    expect(
      cycle ? cycle.join(" → ") : "",
      [
        `lib/ modules import one another one way only. A cycle means one module's export cannot be`,
        `imported without running another's module initialisation, which is exactly the startup`,
        `surface ${code("AGENTS.md")} warns about, and it makes either module's behaviour depend on`,
        `which one was loaded first. The path above is the cycle, in order.`,
        ...reDerive(),
      ].join("\n"),
    ).toBe("");
  });
});
