# Task IDs address invocations, not runs

One `subagent` tool call yields exactly one **Task ID**, whatever **Mode** it uses. A `parallel` call with three **Runs** is one **Task** with one ID and one **Reminder**; a `chain` likewise.

Per-**Run** IDs look more precise but name something the orchestrator cannot act on. A `chain`'s step 2 cannot be retried or read in isolation — step 3 has already consumed its **Result**. IDs should name the unit the orchestrator asked for, because that is the only unit it can meaningfully check, cancel, or re-issue.

## Consequences

A single failed **Run** inside a `parallel` **Task** cannot be retried by ID; the orchestrator issues a new **Task** for that work. Reporting must therefore surface per-**Run** status *inside* a **Task**'s status, even though only the **Task** is addressable.
