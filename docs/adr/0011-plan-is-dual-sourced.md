# The Plan is dual-sourced: conversation is the working copy, the per-session file is durable

The agent keeps its **Plan** (see `CONTEXT.md`) in the conversation *and* in a per-session file under `~/.pi/agent/plans/` — one JSON Lines file per plan key, one **Plan Item** per line, rewritten atomically in place when the plan changes. When every item reaches a terminal state (done or failed) the file moves to `plans/archive/` with a date prefix, and continued work in the same session starts a fresh file. On `session_compact` the plan extension re-injects the plan from disk into the conversation, so compaction cannot silently lose it.

**Considered.** Conversation-only loses the plan exactly when compaction makes it most needed. An append-only event log gives a perfect audit trail but forces replay logic to answer "where are we now," and the conversation is already the narrative — the file only needs to be the state. Per-request plan files were rejected in favor of session-wide accumulation: a plan is the agent's track across the whole session, not a scrap of paper per message.

**Consequences.** Readers of `plans/*.jsonl` see current state, not history — status changes are not logged. Any future feature that wants an audit trail must add it deliberately; the file format was chosen to be trivially readable (`cat`, `jq`) rather than maximally expressive.
