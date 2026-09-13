# Cancellation is decided by the Task's signal, not a Run's stop reason

A **Task** is `canceled` only when its own `AbortController` was aborted. A **Run** reporting `stopReason: "aborted"` is not sufficient evidence, and never promotes the **Task** to `canceled` on its own.

`stopReason` is copied verbatim from the child `pi` process, and providers emit `"aborted"` for their own reasons — a failed request under an aborted internal signal, for instance. Trusting it conflated two very different events: "the orchestrator cancelled this" and "this run died". That distinction matters because a `canceled` **Task** deliberately sends no **Reminder**, on the grounds that the orchestrator already knows. When a **Run** nobody cancelled was misread as a cancellation, the orchestrator was never told the **Task** had ended — and since it was instructed to rely on the **Reminder**, it waited for a wake-up that would never come.

## Consequences

Per-**Run** abort state is tracked separately from `stopReason`, set only where the extension itself kills the process. Esc does not cancel **Tasks** at all (only explicit `cancel` and process shutdown do), so a **Task** entering `canceled` always corresponds to a deliberate request.
