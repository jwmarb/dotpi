# Subagents wrap their write-up in a <result> tag

Every subagent ends its **Write-up** with its answer inside a single `<result>` element. The extension extracts that element as the **Task**'s **Result**; the surrounding **Transcript** never reaches the orchestrator. Content inside the tag stays Markdown, so each agent keeps its existing section structure.

Heading-based extraction (`## Map`, `## Gaps`) is unreliable: models drop, rename, and reorder headings, and each agent had its own set. Per-agent XML schemas were rejected as the opposite failure — six parsers drifting out of sync with six agent files. One wrapper is one parser, and a violation is unambiguous rather than silently partial.

## Consequences

A **Run** that emits no `<result>` falls back to its last assistant message with a warning attached, so a malformed answer still reaches the orchestrator. All six agent definition files must carry the contract, and any new subagent that omits it degrades to fallback extraction.

Extraction takes the **outermost** `<result>` span, not the last one. Agents routinely quote the contract's own fenced example inside their write-up, and matching the innermost or last span silently truncates the answer at that example's closing tag while still reporting conformance — a worse failure than not matching at all, because the orchestrator acts on half an answer believing it complete. Over-capturing a quoted example is recoverable; losing the second half of a review or plan is not.
