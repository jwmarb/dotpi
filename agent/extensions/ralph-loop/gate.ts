/**
 * Ralph loop — the verification gate.
 *
 * Runs an independent audit of a completion claim. When the loop's agent emits
 * the completion tag, the gate spawns a headless one-shot `pi` child running
 * the `oracle` agent definition, hands it the goal, the loop's starting point,
 * and the agent's own claim, and asks it to inspect the repository and return a
 * verdict.
 *
 * ## Why a headless child rather than the herdr delegation path
 *
 * `subagent-herdr` opens a tab and pane per child, registers the run on disk,
 * and is asynchronous by design — the right shape for delegated *work* the user
 * watches. The gate is a *decision*: synchronous from the loop's point of view,
 * invisible unless it fails, and worthless after the loop it belongs to is
 * gone. `pi -p` (non-interactive: process the prompt, print, exit) gives that
 * with no lifecycle to manage.
 *
 * ## What the gate can and cannot establish
 *
 * oracle is read-only and forbidden from running tests or builds
 * (`agent/agents/oracle.md`). So the gate audits *code and evidence*, not
 * runtime behaviour. That limit is the reason `inconclusive` is a first-class
 * verdict rather than an error: "I cannot confirm this without executing it" is
 * a correct and useful answer, and it must not be silently read as approval.
 *
 * @module ralph-loop/gate
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, mkdtemp } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseAgentFile } from "../lib/agents.js";
import { agentsDir } from "../lib/layout.js";
import {
	VERIFY_TIMEOUT_MS,
	type LoopState,
	type VerificationEvidence,
	type VerificationResult,
	parseVerdict,
	renderVerificationPrompt,
} from "./lib.js";

/** Tools the gate child is allowed, when the agent definition declares none. */
const DEFAULT_GATE_TOOLS = ["read", "grep", "find", "ls", "bash"];

/**
 * Resolve the gate's model and tools from its agent definition.
 *
 * Read from `agent/agents/<name>.md` so the gate tracks the fleet definition
 * rather than duplicating a model id. Falls back rather than throwing: a
 * missing or malformed definition must not take the loop down.
 *
 * @param name Agent name, e.g. `oracle`.
 * @param fallbackModel Model to use when the definition yields none.
 */
export async function resolveGateAgent(
	name: string,
	fallbackModel: string,
): Promise<{ model: string; tools: string[]; promptBody: string }> {
	try {
		const file = join(agentsDir(), `${name}.md`);
		const content = await readFile(file, "utf8");
		const info = parseAgentFile(content, `${name}.md`);
		if (info) {
			return {
				model: info.model ?? fallbackModel,
				tools: info.tools?.length ? info.tools : DEFAULT_GATE_TOOLS,
				promptBody: info.promptBody,
			};
		}
	} catch {
		// Fall through to defaults.
	}
	return { model: fallbackModel, tools: DEFAULT_GATE_TOOLS, promptBody: "" };
}

/** Capture of the repository state a loop started from. */
export interface Baseline {
	startHead: string | undefined;
	startStatus: string;
}

/**
 * Snapshot the repository at loop start, so the gate can distinguish the loop's
 * own work from changes that were already there.
 *
 * Never throws: outside a git repo both fields simply come back empty, and the
 * gate prompt says so explicitly.
 *
 * @param pi Extension API, for `exec`.
 * @param cwd Session working directory.
 */
export async function captureBaseline(
	pi: ExtensionAPI,
	cwd: string,
): Promise<Baseline> {
	const run = async (args: string[]): Promise<string> => {
		try {
			const r = await pi.exec("git", args, { cwd, timeout: 10_000 });
			return r.code === 0 ? r.stdout.trim() : "";
		} catch {
			return "";
		}
	};
	const [head, status] = await Promise.all([
		run(["rev-parse", "HEAD"]),
		run(["status", "--porcelain"]),
	]);
	return { startHead: head || undefined, startStatus: status };
}

/** Everything the gate needs to run one audit. */
export interface GateRequest {
	state: LoopState;
	evidence: VerificationEvidence;
	/** Absolute path of the running `pi` binary (`process.argv[1]`). */
	piBinary: string;
	/** Provider that serves the gate model. */
	provider: string;
	/** Agent definition name, e.g. `oracle`. */
	agent: string;
	/** Model used when the definition yields none. */
	fallbackModel: string;
}

/**
 * Run one gate audit.
 *
 * Every failure mode collapses to `inconclusive` with a human-readable reason:
 * a timeout, a non-zero exit, an unavailable model, an unparseable reply. The
 * caller stops the loop on `inconclusive` rather than continuing, so a broken
 * gate halts safely instead of either rubber-stamping completion (fail-open) or
 * feeding infrastructure errors to the agent as if they were code defects.
 *
 * The audit request crosses as a **file**, not as an argv string: a goal is
 * arbitrary user text, and a multi-kilobyte prompt containing newlines and
 * quotes has no business on a command line. `exec` takes an argv array, so
 * nothing is shell-interpreted either way.
 *
 * @returns The parsed verdict, always — this function does not throw.
 */
export async function runGate(
	pi: ExtensionAPI,
	req: GateRequest,
): Promise<VerificationResult> {
	const { model, tools, promptBody } = await resolveGateAgent(
		req.agent,
		req.fallbackModel,
	);

	let dir: string;
	try {
		dir = await mkdtemp(join(tmpdir(), "ralph-gate-"));
	} catch (err) {
		return {
			verdict: "inconclusive",
			findings: "",
			reason: `could not stage the audit request (${describe(err)})`,
		};
	}

	const promptPath = join(dir, "audit.txt");
	const systemPath = join(dir, "system.md");
	const request = renderVerificationPrompt(req.state, req.evidence);

	try {
		await writeFile(promptPath, request, "utf8");
		if (promptBody) await writeFile(systemPath, promptBody, "utf8");
	} catch (err) {
		return {
			verdict: "inconclusive",
			findings: "",
			reason: `could not stage the audit request (${describe(err)})`,
		};
	}

	// Note: --no-extensions is deliberately NOT passed. The provider serving the
	// gate model is itself a local extension (`litellm.ts`), so disabling
	// extension discovery would make the model unresolvable.
	const args = [
		"-p",
		"--no-session",
		"--provider",
		req.provider,
		"--model",
		model,
		"--tools",
		tools.join(","),
	];
	if (promptBody) args.push("--append-system-prompt", systemPath);
	args.push("--", `@${promptPath}`);

	let result: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		result = await pi.exec(req.piBinary, args, {
			cwd: req.evidence.cwd,
			timeout: VERIFY_TIMEOUT_MS,
		});
	} catch (err) {
		return {
			verdict: "inconclusive",
			findings: "",
			reason: `the audit could not be launched (${describe(err)})`,
		};
	}

	if (result.killed) {
		return {
			verdict: "inconclusive",
			findings: "",
			reason: `the audit timed out after ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s`,
		};
	}
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout || "").trim().slice(0, 300);
		return {
			verdict: "inconclusive",
			findings: "",
			reason: `the audit exited ${result.code}${detail ? `: ${detail}` : ""}`,
		};
	}

	return parseVerdict(result.stdout);
}

/** Best-effort one-line description of a thrown value. */
function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
