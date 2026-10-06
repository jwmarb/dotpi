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
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, mkdtemp } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveGateAgent } from "./gate-agent.js";
import { CHAIN_ENV, FALLBACK_MODEL_REF } from "../model-fallback/lib.js";
import {
	VERIFY_TIMEOUT_MS,
	type LoopState,
	type VerificationEvidence,
	type VerificationResult,
	parseVerdict,
	renderVerificationPrompt,
} from "./lib.js";

/**
 * Run `spawn` with {@link CHAIN_ENV} set, restoring the previous value after.
 *
 * `pi.exec()` exposes no `env` option and pi's `execCommand` calls `spawn`
 * without one, so a child inherits this process's `process.env` — verified by
 * reading `core/exec.js` and by probing that a runtime mutation does reach a
 * child. Setting the variable around the spawn is therefore the only way to
 * hand a headless gate child its fallback chain.
 *
 * Lives here rather than in `lib.ts` because `lib.ts` is documented as
 * side-effect free so it can be unit-tested without a session; a function that
 * mutates `process.env` has no business there.
 *
 * ## The race this accepts, and why it is safe here
 *
 * Mutating global env around an `await` is not reentrant: a second concurrent
 * caller would see the first one's value. That is acceptable *only* because the
 * loop runs its gates one at a time (`index.ts` awaits the static pass before
 * the runtime pass) and the value is the same for every gate in a session. The
 * previous value is restored rather than deleted because this process may itself
 * be a delegated child with its own chain, and clobbering that would silently
 * re-route the loop's own model requests.
 *
 * If a future caller ever needs two gates in flight, this must become an
 * explicit `env` on a direct `spawn` instead of a global mutation.
 */
export async function withChainEnv<T>(
	chain: readonly string[] | undefined,
	active: boolean,
	spawn: () => Promise<T>,
): Promise<T> {
	if (!active || !chain || chain.length < 2) return spawn();
	const previous = process.env[CHAIN_ENV];
	process.env[CHAIN_ENV] = chain.join(",");
	try {
		return await spawn();
	} finally {
		if (previous === undefined) delete process.env[CHAIN_ENV];
		else process.env[CHAIN_ENV] = previous;
	}
}

/** Tools the gate child is allowed, when the agent definition declares none. */
const DEFAULT_GATE_TOOLS = ["read", "grep", "find", "ls", "bash"];

// The gate's model/chain/tools/prompt resolution lives in `gate-agent.ts`,
// shared with the runtime gate; `DEFAULT_GATE_TOOLS` above stays here because
// it is gate-specific policy, not shared knowledge.

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
	const { model, chain, tools, promptBody } = await resolveGateAgent({
		name: req.agent,
		fallbackModel: req.fallbackModel,
		defaultTools: DEFAULT_GATE_TOOLS,
	});

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
	// extension discovery would make the model unresolvable. That is also what
	// makes the fallback router available to the child.
	//
	// With a chain, the child launches on `fallback/auto` instead of one model, so
	// a provider error during the audit hops rather than burning pi's retry budget
	// against a dead model and returning `inconclusive` (which stops the loop).
	const useChain = !!chain && chain.length > 1;
	const args = [
		"-p",
		"--no-session",
		...(useChain ? [] : ["--provider", req.provider]),
		"--model",
		useChain ? FALLBACK_MODEL_REF : model,
		"--tools",
		tools.join(","),
	];
	if (promptBody) args.push("--append-system-prompt", systemPath);
	args.push("--", `@${promptPath}`);

	let result: Awaited<ReturnType<ExtensionAPI["exec"]>>;
	try {
		// `pi.exec()` exposes no `env` option and `execCommand` spawns without one,
		// so the child inherits this process's `process.env` — verified against
		// `core/exec.js`. The chain therefore crosses by setting the variable for
		// the duration of the spawn and restoring it afterwards. Restoring the
		// *previous* value rather than deleting matters: this process may itself be
		// a delegated child with its own chain, and clobbering it would change how
		// the loop's own model requests are routed.
		result = await withChainEnv(chain, useChain, () =>
			pi.exec(req.piBinary, args, {
				cwd: req.evidence.cwd,
				timeout: VERIFY_TIMEOUT_MS,
			}),
		);
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
