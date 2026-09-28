// Runtime test: toParametersSchema (extracted from index.ts) through pi-ai's real
// validateToolArguments pipeline (Compile validation + JSON-schema coercion).
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const start = src.indexOf("function deref");
const end = src.indexOf("// --- Extension entry point");
if (start < 0 || end < 0) throw new Error("functions not found in index.ts");
let fnText = src.slice(start, end).trim();
// Strip TS-only syntax so it runs in plain node
fnText = fnText
  .replace(/: TSchema/g, "")
  .replace(/\(raw: unknown, description: string\)/, "(raw, description)")
  .replace(/\(ref: string, root: Record<string, unknown>\)/g, "(ref, root)")
  .replace(/\(node: unknown, root: Record<string, unknown>, depth = 0\)/, "(node, root, depth = 0)")
  .replace(/: Record<string, unknown>/g, "")
  .replace(/: string\b/g, "")
  .replace(/: unknown/g, "")
  .replace(/ as TSchema/g, "")
  .replace(/ as Record<string, unknown>/g, "");

const { Type } = await import("typebox");
const factory = new Function("Type", `${fnText}; return toParametersSchema;`);
const toParametersSchema = factory(Type);

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
}

// 1. MCP inputSchema passes through untouched (incl. $defs/$ref, anyOf)
const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "search text" },
    limit: { type: "integer", minimum: 1 },
    verbose: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
    mode: { anyOf: [{ type: "string" }, { type: "number" }] },
    options: { $ref: "#/$defs/Opts" },
  },
  required: ["query"],
  $defs: { Opts: { type: "object", properties: { limit: { type: "integer" } } } },
};
const original = JSON.stringify(inputSchema);
const schema = toParametersSchema(inputSchema, "test tool");
check("passthrough: no local $ref left", !JSON.stringify(schema).includes("\"$ref\""));
check("inlined def present", schema.properties.options.type === "object");
check("original not mutated", JSON.stringify(inputSchema) === original);

// 2. Schema without `type` gets type: object added
const noType = { properties: { q: { type: "string" } } };
const fixed = toParametersSchema(noType, "d");
check("missing type -> object", fixed.type === "object" && fixed.properties.q.type === "string");

// 3. Missing schema falls back to open object
const fallback = toParametersSchema(undefined, "d");
check("fallback open object", fallback.type === "object" && fallback.additionalProperties === true);
// 4. pi-ai's real pipeline: stringified args get coerced to declared types
const { validateToolArguments } = await import(
  "/home/joseph/Nextcloud/.pi/agent/git/github.com/samfoy/pi-lsp-extension/node_modules/@earendil-works/pi-ai/dist/utils/validation.js"
);
const tool = { name: "mcp__test__search", parameters: schema };
const args = validateToolArguments(tool, {
  name: tool.name,
  arguments: { query: "x", limit: "10", verbose: "true", tags: ["a", "b"], options: { limit: "5" }, mode: 2 },
});
check("limit coerced to number", args.limit === 10 && typeof args.limit === "number");
check("verbose coerced to boolean", args.verbose === true);
check("nested $ref option coerced", args.options.limit === 5);
check("anyOf stays a valid member", args.mode === 2 || args.mode === "2");

// 5. Fallback schema still validates with pi-ai
const tool2 = { name: "mcp__test__open", parameters: fallback };
const args2 = validateToolArguments(tool2, { name: tool2.name, arguments: { anything: 1 } });
check("fallback accepts arbitrary props", args2.anything === 1);

console.log(fail === 0 ? `\n${pass}/${pass + fail} passed` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
