/**
 * `/init` — hierarchical AGENTS.md knowledge base.
 *
 * Two phases:
 * 1. Deterministic tiering (local, no model): scan the repo, score each
 *    subdirectory with a weighted complexity heuristic (adapted from
 *    oh-my-openagent's `init-deep` scoring matrix), and decide which
 *    directories deserve their own AGENTS.md. Root always gets one.
 * 2. Model-driven authoring (opencode `/init` style): the command hands the
 *    agent a self-contained brief with the tier plan, section templates,
 *    line limits and anti-duplication rules; the agent explores and writes.
 *
 * Why this composes with pi: pi loads at most one context file per
 * directory (AGENTS.override.md > AGENTS.md > CLAUDE.md) and walks every
 * ancestor of the cwd, so a root AGENTS.md plus nested AGENTS.md files all
 * load together for a session started in a subdirectory.
 *
 * Usage:
 *   /init                     update mode: improve existing files in place
 *   /init <path>              scope to a subtree (that dir becomes the root tier)
 *   /init --create-new        read existing files for context, then replace from scratch
 *   /init --max-depth=N       nested tiers max N levels below the root (default 3)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DEPTH_DEFAULT = 3;
const MAX_NESTED_TIERS = 10;
const ROOT_LINE_RANGE = "50-150";
const NESTED_LINE_RANGE = "30-80";
/** Score bands (init-deep): >15 create, 8-15 candidate, <8 skip. */
const CREATE_ABOVE = 15;
const CANDIDATE_FROM = 8;

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".kt", ".swift", ".sh",
  ".lua", ".ex", ".exs", ".zig", ".scala", ".php",
]);
const CONFIG_FILES = new Set([
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "CMakeLists.txt",
  "setup.py", "setup.cfg", "pom.xml", "build.gradle", "build.gradle.kts",
  "Makefile", "makefile",
]);
const BOUNDARY_FILES = new Set([
  "index.ts", "index.tsx", "index.js", "__init__.py", "main.py", "main.go",
  "lib.rs", "app.py", "mod.rs", "server.ts",
]);
const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv",
  "target", ".next", "coverage", ".turbo", ".cache", "vendor",
]);
/** Context-file candidates in pi's per-directory precedence order. */
const CONTEXT_FILE_CANDIDATES = [
  "AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function isCodeFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && CODE_EXTS.has(name.slice(dot));
}

/** Fallback file walk for non-git directories. */
function walkFiles(dir: string, root: string, out: string[], cap = 5000): void {
  if (out.length >= cap) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= cap) return;
    if (entry.name.startsWith(".") && entry.name !== ".git") {
      if (entry.isDirectory()) continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walkFiles(full, root, out, cap);
    } else if (entry.isFile()) {
      out.push(relative(root, full));
    }
  }
}

interface DirStats {
  /** relative dir path from root ("" for the root itself) */
  rel: string;
  depth: number;
  /** files in this dir's subtree */
  files: Set<string>;
  /** direct subdirectories containing at least one file */
  subdirs: number;
  /** files directly in this dir */
  topFiles: Set<string>;
}

function buildDirStats(files: string[], root: string, maxDepth: number): Map<string, DirStats> {
  const dirs = new Map<string, DirStats>();
  const ensure = (rel: string, depth: number): DirStats => {
    let d = dirs.get(rel);
    if (!d) {
      d = { rel, depth, files: new Set(), subdirs: 0, topFiles: new Set() };
      dirs.set(rel, d);
    }
    return d;
  };
  ensure("", 0);
  for (const f of files) {
    const parts = f.split(sep);
    for (let i = 1; i <= parts.length; i++) {
      // i < parts.length: a real ancestor dir; i === parts.length: the dir that directly contains f
      const isFileLevel = i === parts.length;
      const rel = parts.slice(0, isFileLevel ? i - 1 : i).join(sep);
      const depth = isFileLevel ? i - 1 : i;
      if (depth > maxDepth) break;
      const d = ensure(rel, depth);
      d.files.add(f);
      if (isFileLevel) d.topFiles.add(f);
    }
  }
  // subdirs count: direct children of each dir that contain files
  for (const d of dirs.values()) {
    const prefix = d.rel ? d.rel + sep : "";
    const children = new Set<string>();
    for (const f of d.files) {
      if (!f.startsWith(prefix) || f === prefix) continue;
      children.add(f.slice(prefix.length).split(sep)[0]);
    }
    d.subdirs = children.size;
  }
  return dirs;
}

function countMatches(root: string, pattern: string, paths: string[]): number {
  if (paths.length === 0) return 0;
  const out = git(root, ["grep", "-cE", pattern, "--", ...paths]);
  if (!out) return 0;
  let total = 0;
  for (const line of out.split("\n")) {
    const idx = line.lastIndexOf(":");
    if (idx > 0) total += parseInt(line.slice(idx + 1), 10) || 0;
  }
  return total;
}

/** Files outside `rel`'s subtree that reference it by path (centrality proxy). */
function countReferences(root: string, rel: string, files: string[]): number {
  if (!rel) return 0;
  const out = git(root, ["grep", "-lF", rel, "--", ...files]);
  if (!out) return 0;
  const prefix = rel + sep;
  let n = 0;
  for (const line of out.split("\n")) {
    const f = line.trim();
    if (f && f !== rel && !f.startsWith(prefix)) n++;
  }
  return n;
}

interface TierScore {
  score: number;
  reasons: string[];
  files: number;
  symbols: number;
  refs: number;
}

function scoreDir(root: string, d: DirStats, allFiles: string[]): TierScore {
  const files = [...d.files];
  const codeFiles = files.filter((f) => isCodeFile(basename(f)));
  const codeRatio = files.length > 0 ? codeFiles.length / files.length : 0;
  const topNames = new Set([...d.topFiles].map((f) => basename(f)));
  const hasConfig = [...topNames].some((n) => CONFIG_FILES.has(n));
  const hasBoundary = [...topNames].some((n) => BOUNDARY_FILES.has(n));
  const symbols = countMatches(root, "^(export |def |class |func |pub fn |public )", codeFiles.slice(0, 400));
  const exports = countMatches(root, "^export ", codeFiles.slice(0, 400));
  const refs = countReferences(root, d.rel, allFiles);

  const reasons: string[] = [];
  let score = 0;
  if (files.length > 20) { score += 3; reasons.push(`${files.length} files`); }
  if (d.subdirs > 5) { score += 2; reasons.push(`${d.subdirs} subdirs`); }
  if (codeRatio > 0.7) { score += 2; reasons.push(`${Math.round(codeRatio * 100)}% code`); }
  if (hasConfig) { score += 1; reasons.push("own build config"); }
  if (hasBoundary) { score += 2; reasons.push("module boundary"); }
  if (symbols > 30) { score += 2; reasons.push(`${symbols} symbols`); }
  if (exports > 10) { score += 2; reasons.push(`${exports} exports`); }
  if (refs > 20) { score += 3; reasons.push(`${refs} inbound refs`); }
  return { score, reasons, files: files.length, symbols, refs };
}

interface Tier {
  rel: string;
  depth: number;
  score: number;
  reasons: string[];
  fileCount: number;
  /** "create" | "candidate" (distinct-domain check by the model) */
  status: "create" | "candidate";
  /** context files already present in this dir */
  existing: string[];
}

interface TierPlan {
  root: string;
  isGit: boolean;
  tiers: Tier[];
  maxDepth: number;
}

function planTiers(cwd: string, scopeRel: string | undefined, maxDepth: number): TierPlan {
  const gitRoot = git(cwd, ["rev-parse", "--show-toplevel"]);
  const isGit = gitRoot.length > 0;
  const repoRoot = isGit ? gitRoot : cwd;
  const scopeAbs = scopeRel ? resolve(cwd, scopeRel) : repoRoot;
  if (!existsSync(scopeAbs)) throw new Error(`Scope directory not found: ${scopeRel}`);

  let files: string[];
  let prefixRel = "";
  if (isGit && (scopeAbs === repoRoot || scopeAbs.startsWith(repoRoot + sep))) {
    const out = git(cwd, ["ls-files", "-z"]);
    files = out ? out.split("\0").filter(Boolean) : [];
    if (scopeAbs !== repoRoot) {
      prefixRel = relative(repoRoot, scopeAbs) + sep;
      files = files.filter((f) => f.startsWith(prefixRel));
    }
  } else {
    const out: string[] = [];
    walkFiles(scopeAbs, scopeAbs, out);
    files = out;
  }
  const strip = (f: string) => (prefixRel ? f.slice(prefixRel.length) : f);

  const dirs = buildDirStats(files.map(strip), scopeAbs, maxDepth);
  const tiers: Tier[] = [];
  for (const [rel, d] of [...dirs.entries()].sort((a, b) => a[0].length - b[0].length)) {
    if (rel === "") continue;
    const s = scoreDir(scopeAbs, d, files.map(strip));
    const status: Tier["status"] = s.score > CREATE_ABOVE ? "create" : s.score >= CANDIDATE_FROM ? "candidate" : "skip" as never;
    if (status === ("skip" as never)) continue;
    const existing = CONTEXT_FILE_CANDIDATES.filter((name) => existsSync(join(scopeAbs, rel, name)));
    tiers.push({ rel, depth: d.depth, score: s.score, reasons: s.reasons, fileCount: s.files, status: status as Tier["status"], existing });
  }
  tiers.sort((a, b) => b.score - a.score);
  const kept = tiers.slice(0, MAX_NESTED_TIERS);

  const rootExisting = CONTEXT_FILE_CANDIDATES.filter((name) => existsSync(join(scopeAbs, name)));
  const rootTier: Tier = {
    rel: "",
    depth: 0,
    score: -1,
    reasons: ["project root"],
    fileCount: files.length,
    status: "create",
    existing: rootExisting,
  };
  return { root: scopeAbs, isGit, tiers: [rootTier, ...kept], maxDepth };
}

// ---------------------------------------------------------------------------
// Brief (the self-contained authoring instruction handed to the agent)
// ---------------------------------------------------------------------------

function tierLine(t: Tier, rootName: string): string {
  const where = t.rel === "" ? `${rootName}/  (root — full treatment)` : `${t.rel}/  (nested — reduced)`;
  const status = t.rel === "" ? "" : t.status === "candidate" ? "  [CANDIDATE — include only if it has a distinct domain the root does not cover]" : "";
  const existing = t.existing.length > 0 ? `  [existing: ${t.existing.join(", ")}]` : "";
  return `  - ${where}  (score ${t.rel === "" ? "root" : t.score}, ${t.fileCount} files; ${t.reasons.join(", ") || "n/a"})${status}${existing}`;
}

function buildBrief(plan: TierPlan, mode: "update" | "create-new"): string {
  const rootName = basename(plan.root);
  const lines: string[] = [];
  lines.push("/init: generate a hierarchical AGENTS.md knowledge base.");
  lines.push("");
  lines.push(`Mode: ${mode === "create-new" ? "--create-new (read existing files first for context, then replace from scratch)" : "update (improve existing files in place — keep what is still true, fix what is stale, do not blindly rewrite)"}; tiers below ${plan.maxDepth} levels deep; root = ${plan.root}${plan.isGit ? " (git root)" : " (no git repo; walked from cwd)"}.`);
  lines.push("");
  lines.push("Tier plan (computed locally by the /init extension — you may refine, e.g. drop a CANDIDATE tier, but do not add tiers beyond max-depth without a strong reason):");
  for (const t of plan.tiers) lines.push(tierLine(t, rootName));
  lines.push("");
  lines.push("For each tier, a tier covers its own files; files under a child tier belong to the child, not the parent.");
  lines.push("");
  lines.push("Before writing, explore: read the build/test/lint/CI config at every tier (package.json scripts, Makefile, pyproject.toml, .github/workflows, etc.), entry points, and existing context files. Verify every command you record against config — do not run them, do not guess.");
  lines.push("");
  lines.push("Root AGENTS.md template (50-150 lines, no generic advice, nothing obvious from filenames alone):");
  lines.push(`  # ${rootName} — Project Knowledge Base`);
  lines.push("  ## OVERVIEW — what the project is and does, one tight paragraph");
  lines.push("  ## STRUCTURE — top-level layout, one line per top-level dir/package");
  lines.push("  ## WHERE TO LOOK — table: task -> path (how a developer finds things)");
  lines.push("  ## CONVENTIONS — project-specific conventions only");
  lines.push("  ## COMMANDS — build / test / lint / verify, with focused subsets (single test, single package) where they exist");
  lines.push("  ## NOTES — quirks, gotchas, and a one-line pointer to each nested AGENTS.md that exists");
  lines.push("");
  lines.push(`Nested AGENTS.md template (${NESTED_LINE_RANGE} lines, reduced — never repeat what the root or an ancestor already says):`);
  lines.push("  # <dir> — one-line OVERVIEW of what this subtree is and owns");
  lines.push("  ## WHERE TO LOOK — only if non-obvious");
  lines.push("  ## CONVENTIONS — only the ones that DIFFER from the root");
  lines.push("  ## COMMANDS — only if this subtree has local commands");
  lines.push("  ## ANTI-PATTERNS — only if observed in this subtree");
  lines.push("");
  lines.push("Rules:");
  lines.push("- Write with the write/edit tools. Existing file => improve in place (update mode) or replace after reading it (create-new). Missing file => create.");
  lines.push("- A directory that already has a CLAUDE.md (or AGENTS.override.md): pi gives AGENTS.md lower precedence than AGENTS.override.md but higher than CLAUDE.md — reference the other file, do not duplicate its content.");
  lines.push("- Anti-duplication is the whole point of the hierarchy: a child never restates parent content, and generic advice that applies to all projects belongs nowhere.");
  lines.push("- Respect the line limits per tier. If the codebase cannot answer something material (e.g. which framework version a package pins to and it is not written down), you may ask at most two targeted questions, then proceed with what you have.");
  lines.push("");
  lines.push("When done, print the final report: the hierarchy tree of files written/updated with their line counts, exactly like:");
  lines.push("  AGENTS.md (root) — 120 lines, written");
  lines.push("  src/worker/AGENTS.md — 41 lines, created");
  lines.push("  ...");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function parseArgs(args: string): { scope: string | undefined; maxDepth: number; createNew: boolean; unknown: string[] } {
  const out = { scope: undefined as string | undefined, maxDepth: MAX_DEPTH_DEFAULT, createNew: false, unknown: [] as string[] };
  for (const raw of args.trim().split(/\s+/).filter(Boolean)) {
    if (raw === "--create-new") out.createNew = true;
    else if (raw.startsWith("--max-depth=")) {
      const n = parseInt(raw.slice("--max-depth=".length), 10);
      if (Number.isFinite(n) && n >= 1 && n <= 10) out.maxDepth = n;
      else out.unknown.push(raw);
    } else if (!raw.startsWith("--")) out.scope = raw;
    else out.unknown.push(raw);
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "Generate a hierarchical AGENTS.md knowledge base (root + scored nested tiers)",
    getArgumentCompletions: (prefix) =>
      prefix.startsWith("--")
        ? ["--create-new", "--max-depth="].filter((f) => f.startsWith(prefix))
        : [],
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      if (parsed.unknown.length > 0) {
        ctx.ui.notify(`init: unknown option(s): ${parsed.unknown.join(", ")} (use --create-new, --max-depth=N)`, "warning");
        return;
      }

      const notify = (msg: string, type: "info" | "warning" | "error" = "info") =>
        ctx.ui.notify(msg, type);

      try {
        ctx.ui.setStatus("init", "init: scanning…");
        const plan = planTiers(ctx.cwd, parsed.scope, parsed.maxDepth);
        const nested = plan.tiers.filter((t) => t.rel !== "");
        const createCount = nested.filter((t) => t.status === "create").length;
        const candidateCount = nested.length - createCount;
        const existing = plan.tiers.flatMap((t) => t.existing.map((f) => `${t.rel ? t.rel + "/" : ""}${f}`));
        notify(
          `init: ${plan.tiers.length} tiers (root + ${createCount} create, ${candidateCount} candidate) under ${plan.root}; ` +
          (existing.length > 0 ? `${existing.length} existing file(s) will be improved in place` : "no existing context files")
        );

        if (parsed.createNew && existing.length > 0 && ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            "init --create-new",
            `Will replace ${existing.length} existing context file(s):\n${existing.join("\n")}\n\nContinue?`,
          );
          if (!ok) {
            ctx.ui.setStatus("init", "");
            notify("init: cancelled", "info");
            return;
          }
        }

        const brief = buildBrief(plan, parsed.createNew ? "create-new" : "update");
        ctx.ui.setStatus("init", "init: agent authoring tiers…");
        ctx.ui.setWidget("init", [
          `init: ${plan.tiers.length} tiers — root + ${nested.map((t) => t.rel).filter(Boolean).join(", ") || "none"}`,
          `mode ${parsed.createNew ? "--create-new" : "update"}, max-depth ${plan.maxDepth}`,
        ]);

        // `pi.sendUserMessage()` is fire-and-forget from the extension API: the
        // authoring turn starts asynchronously, and returning from this handler
        // completes the outer prompt. In print mode (pi -p) the session is
        // disposed as soon as that happens, so pin the turn here: poll until it
        // has started (agent no longer idle), then wait for it to settle.
        await pi.sendUserMessage(brief, { deliverAs: "followUp" });
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && ctx.isIdle()) {
          await new Promise((r) => setTimeout(r, 50));
        }
        await ctx.waitForIdle();
      } catch (err) {
        ctx.ui.setStatus("init", "");
        notify(`init: ${(err as Error).message}`, "error");
      }
    },
  });
}
