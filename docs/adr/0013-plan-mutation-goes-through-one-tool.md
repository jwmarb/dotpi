# Plan mutation goes through one dedicated tool, not raw file writes

The original ask was for `dynamic-prompt.ts` to *emphasize* the task list — prompt-only. The implementation instead registers a `plan` tool (add / status / archive / show) that performs atomic, schema-checked writes to the plan file and executes the archive move as code. The prompt's Planning Discipline section tells the agent to use it; the machinery guarantees the invariants the prompt can only ask for.

**Considered.** Prompt-only — instructing the agent to maintain the `.jsonl` file with plain `read`/`write` tools — was the starting point and was rejected: the schema would drift (malformed lines, renamed keys), the archive-on-complete move would be a hope rather than an action, and nothing would stop a non-atomic rewrite. The tool's `promptSnippet` and `promptGuidelines` self-register into the orchestrator prompt through the existing dynamic-prompt machinery, so prompt emphasis and tooling arrive together in every session, subagents included.

**Consequences.** The plan extension is now a hard dependency of the planning discipline: if it fails to load, the prompt section must not dangle (dynamic-prompt guards its emission the way it already guards the questionnaire section). Anything that writes plan files outside the tool (scripts, manual edits) is out of contract.
