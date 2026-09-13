# Reminders are system messages, not simulated user messages

When a **Task** finishes, the extension wakes the orchestrator with a custom message (`customType: "subagent_done"`, `triggerTurn: true`, delivered as a follow-up) carrying the extracted **Results** inline. It does *not* call `sendUserMessage` to impersonate the user.

Impersonation was the obvious implementation and reads identically to the orchestrator in the moment. It was rejected because the transcript is read again later — by compaction, by session summarization, and by the orchestrator reasoning about what the user actually wanted. Machine-generated text attributed to the user corrupts all three, and the corruption is invisible at the point it is introduced.

## Consequences

The extension must register a message renderer for `subagent_done` so **Reminders** are visually distinct in the TUI. **Reminders** queue rather than interrupt: a **Task** finishing mid-turn is delivered when that turn closes, so the orchestrator's in-flight plan is never scrambled halfway through execution.

One limitation is outside our control: pi's `convertToLlm` flattens every custom message to `role: "user"` when building the provider request. On the wire the **Reminder** therefore still reaches the model — and compaction — as a user message. What this decision does buy is an honest *session record*: the stored entry keeps its own type, so renderers and session tooling can tell machine wake-ups from user intent, and the message text self-identifies ("Background task … finished"). Do not assume the attribution guarantee is airtight at the provider layer.
