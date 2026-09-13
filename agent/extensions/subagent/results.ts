/**
 * Write-up extraction.
 *
 * Subagents end their final message with their answer wrapped in a single
 * `<result>` element (see docs/adr/0004-result-tag-writeup-contract.md).
 * The orchestrator consumes that extracted content — never the Transcript.
 *
 * Extraction never throws: a Run that ignored the contract still has its last
 * assistant message surfaced, with a warning attached, because a malformed
 * answer is almost always better than no answer.
 */

import type { Message } from "@mariozechner/pi-ai";

/** The answer a Run produced, plus whether it honored the write-up contract. */
export interface ExtractedResult {
	/** The Result: `<result>` content when present, else the raw final message. */
	text: string;
	/** True when a `<result>` element was found and parsed. */
	conformant: boolean;
	/** Human-readable note when the contract was violated. */
	warning?: string;
}

/**
 * Extract the final text output from a message list.
 *
 * Walks messages in reverse to find the last assistant message's text part.
 *
 * @param messages - Messages from a Run.
 * @returns Text of the last assistant message, or an empty string.
 */
export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			// Concatenate every text part: models sometimes split a write-up
			// across parts, and taking only the first would truncate the tag.
			const texts: string[] = [];
			for (const part of msg.content) {
				if (part.type === "text") texts.push(part.text);
			}
			// A part list of just empty strings is what the framework synthesizes
			// for a failed turn; treating that as "the final output" would mask a
			// complete write-up in the preceding message.
			if (texts.some((t) => t.trim())) return texts.join("\n");
		}
	}
	return "";
}

/**
 * Pull the `<result>` element out of a subagent's write-up.
 *
 * Uses the outermost `<result>` span: an agent that quotes the contract's own
 * example inside its write-up would otherwise have its answer truncated at that
 * example's closing tag.
 *
 * @param messages - Messages from a Run.
 * @returns The extracted Result and its conformance status.
 */
export function extractResult(messages: Message[]): ExtractedResult {
	const raw = getFinalOutput(messages);

	if (!raw.trim()) {
		return {
			text: "",
			conformant: false,
			warning: "Run produced no final text output.",
		};
	}

	// Greedy, and tolerant of whitespace inside the tags. Greedy matters: a
	// write-up that quotes the contract's own example contains a nested
	// `<result>`, and a lazy match would stop at that example's closing tag and
	// silently discard the entire second half of the answer while still
	// reporting conformance.
	const closed = raw.match(/<result\s*>([\s\S]*)<\/\s*result\s*>/i);
	if (closed) {
		const text = closed[1].trim();
		if (text) return { text, conformant: true };
		return {
			text: raw.trim(),
			conformant: false,
			warning:
				"Subagent emitted an empty <result> element; falling back to its full final message.",
		};
	}

	// An unclosed tag usually means the Run hit its turn limit mid-write-up.
	// Everything after the opening tag is still the best available answer.
	const unclosed = raw.match(/<result\s*>([\s\S]*)$/i);
	if (unclosed) {
		return {
			text: unclosed[1].trim(),
			conformant: false,
			warning:
				"Subagent's <result> element was never closed (likely truncated); using everything after the opening tag.",
		};
	}

	return {
		text: raw.trim(),
		conformant: false,
		warning:
			"Subagent did not wrap its write-up in <result> tags; falling back to its final message. The agent definition may need tightening.",
	};
}
