/**
 * Ralph loop — the gate agent's resolution seam.
 *
 * Both verification gates launch a headless `pi` child from an agent
 * definition, and both need the same three facts from it: which fallback
 * chain, which tools, and which system-prompt body. This module is the one
 * place that reads `agent/agents/<name>.md` for a gate — the static gate
 * (`gate.ts`) and the runtime gate (`runtime-gate.ts`) are adapters at this
 * seam, parameterised only by what they are (name, fallback model, default
 * tools).
 *
 * ## Why a chain and not just a model
 *
 * The gate is an agent like any other, and the goal is that *any* agent which
 * errors moves to its next fallback. Reading `info.model` alone left the
 * agent's declared `fallback_models` inert: a gate audit on an erroring
 * provider burned pi's retry budget against one dead model and returned
 * `inconclusive`, which stops the loop. The chain is handed to the child the
 * same way a subagent gets one (`PI_FALLBACK_CHAIN` plus
 * `--model fallback/auto`), so one declaration covers the launcher, a running
 * subagent, and both gates.
 *
 * @module ralph-loop/gate-agent
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseAgentFile } from "../lib/agents.js";
import { agentsDir } from "../lib/layout.js";
// The chain rule is owned by the module that defines it: one parser per
// format, so the gates cannot drift from the launcher.
import { childFallbackChain } from "../subagent-herdr/lib.js";
import { formatChainItem, parseChainItem } from "../model-fallback/lib.js";

/** The three facts both gates launch a child with. */
export interface ResolvedGateAgent {
	chain: string[];
	tools: string[];
	promptBody: string;
}

/** What varies between the gate adapters. */
export interface GateAgentDefaults {
	/** Agent definition name, e.g. `oracle` or `verifier`. */
	name: string;
	/** Model to use when the definition yields none. */
	fallbackModel: string;
	/** Tools granted when the definition declares none. */
	defaultTools: readonly string[];
}

/**
 * Resolve the gate's chain and tools from its agent definition.
 *
 * Read from `agent/agents/<name>.md` so the gate tracks the fleet definition
 * rather than duplicating a model id. Falls back rather than throwing: a
 * missing or malformed definition must not take the loop down.
 *
 * The chain is the declaration canonicalised through the shared chain rule —
 * a model-less declaration keeps its declared `fallback_models` in order,
 * and only a declaration that yields nothing at all degrades to the
 * fallback model alone (canonicalised the same way, so a pinned fallback
 * model keeps its pin).
 *
 * @param defaults The adapter's identity: agent name, fallback model and
 *   default tools.
 */
export async function resolveGateAgent(
	defaults: GateAgentDefaults,
): Promise<ResolvedGateAgent> {
	const { name, fallbackModel, defaultTools } = defaults;
	try {
		const file = join(agentsDir(), `${name}.md`);
		const content = await readFile(file, "utf8");
		const info = parseAgentFile(content, `${name}.md`);
		if (info) {
		  return {
		    chain: childFallbackChain(undefined, info) ?? canonicalChainItem(fallbackModel),
		    tools: info.tools?.length ? info.tools : [...defaultTools],
		    promptBody: info.promptBody,
		  };
		}
	} catch {
		// Fall through to defaults.
	}
	return { chain: canonicalChainItem(fallbackModel), tools: [...defaultTools], promptBody: "" };
}

/** One fallback model as a chain item, canonicalised through the item grammar. */
function canonicalChainItem(model: string): string[] {
	const entry = parseChainItem(model);
	// The `: [model]` branch is unreachable for the two gate constants
	// (`GATE_FALLBACK_MODEL`, `RUNTIME_FALLBACK_MODEL`), which are both plain
	// `provider/id` refs that parse — and this seam is documented never to
	// throw, so a future constant that does not parse degrades to the bare
	// string instead of taking the loop down. `lib.test.ts` pins that both
	// constants parse, so the branch cannot become reachable silently.
	return entry ? [formatChainItem(entry)] : [model];
}
