// Firecrawl regression test: the real firecrawl_scrape inputSchema through
// toParametersSchema (extracted from index.ts) + pi-ai's validateToolArguments.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const start = src.indexOf("function deref");
const end = src.indexOf("// --- OAuth");
let fnText = src.slice(start, end).trim();
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
const toParametersSchema = new Function("Type", `${fnText}; return toParametersSchema;`)(Type);

const firecrawlSchema = JSON.parse(
  readFileSync(new URL("./test-firecrawl-schema.json", import.meta.url), "utf8"),
);
const original = JSON.stringify(firecrawlSchema);

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}`); }
}

const schema = toParametersSchema(firecrawlSchema, "Firecrawl scrape");
check("schema usable", schema && typeof schema === "object");
check("original not mutated", JSON.stringify(firecrawlSchema) === original);

const { validateToolArguments } = await import(
  "/home/joseph/Nextcloud/.pi/agent/git/github.com/samfoy/pi-lsp-extension/node_modules/@earendil-works/pi-ai/dist/utils/validation.js"
);
const tool = { name: "mcp__litellm_gateway__firecrawl_mcp_firecrawl_scrape", parameters: schema };

// 1. The classic failure: LLM stringifies numbers/booleans, nested objects included
const sloppy = validateToolArguments(tool, {
  name: tool.name,
  arguments: {
    url: "https://example.com",
    formats: ["markdown"],
    maxAge: "60",
    timeout: "30000",
    mobile: "true",
    onlyMainContent: "true",
    screenshotOptions: { fullPage: "true", quality: "80", viewport: { width: "1280", height: "720" } },
    pdfOptions: { maxPages: "10" },
    actions: [
      { type: "wait", milliseconds: "1500" },
      { type: "click", selector: "#submit" },
      { type: "screenshot", fullPage: "true" },
    ],
    queryOptions: { prompt: "extract the price", mode: "directQuote" },
  },
});
check("maxAge -> number", sloppy.maxAge === 60);
check("timeout -> integer", sloppy.timeout === 30000);
check("mobile -> boolean", sloppy.mobile === true);
check("nested viewport coerced", sloppy.screenshotOptions.viewport.width === 1280 && sloppy.screenshotOptions.viewport.height === 720);
check("nested fullPage -> boolean", sloppy.screenshotOptions.fullPage === true);
check("pdfOptions.maxPages -> int", sloppy.pdfOptions.maxPages === 10);
check("array items coerced (milliseconds)", sloppy.actions[0].milliseconds === 1500);
check("array item enum kept", sloppy.actions[1].type === "click");

// 2. Clean, correctly-typed call passes untouched
const clean = validateToolArguments(tool, {
  name: tool.name,
  arguments: { url: "https://example.com", maxAge: 0, proxy: "stealth", alexandria: { provider: "fred", capability: "series/observations" } },
});
check("clean call intact", clean.maxAge === 0 && clean.proxy === "stealth" && clean.alexandria.provider === "fred");

// 3. Strictness is back: unknown top-level prop is rejected (old empty schema let anything through)
let strictErr = null;
try {
  validateToolArguments(tool, { name: tool.name, arguments: { url: "https://example.com", bogusProp: 1 } });
} catch (e) {
  strictErr = e.message;
}
check("unknown prop rejected", strictErr !== null && /bogusProp/.test(strictErr));

// 4. Required-field enforcement from the real schema
let reqErr = null;
try {
  validateToolArguments(tool, { name: tool.name, arguments: { queryOptions: { mode: "freeform" } } });
} catch (e) {
  reqErr = e.message;
}
check("required queryOptions.prompt enforced", reqErr !== null && /prompt/.test(reqErr));

console.log(fail === 0 ? `\n${pass}/${pass + fail} passed` : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
