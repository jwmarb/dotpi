# Tasks die with the orchestrator process

Background **Tasks** survive a failed LLM turn, an aborted tool call, and an idle prompt — but not the death of the `pi` process that launched them. Child processes stay attached (no `detached: true`, no on-disk task registry).

Full detachment would mean orphan reaping, stale-registry reconciliation on startup, log files on disk, and reattach semantics — a large surface for a case where the **Task** has no orchestrator left to deliver its **Reminder** to. A **Task** exists to answer a question someone asked; if the asker is gone, so is the reason to finish.

## Consequences

`/exit` or a crashed `pi` silently loses in-flight work. Anything expensive enough that losing it hurts should not be launched as a background **Task** without the user knowing it is running.

The guarantee only holds if children can actually be killed. Escalation from `SIGTERM` to `SIGKILL` must test whether the child has *exited*, not `ChildProcess.killed` — that flag reports only that a signal was delivered, so it is already true immediately after `SIGTERM` and a child ignoring the signal would never be killed. Such a child would outlive its orchestrator and wedge its **Task** in `running` forever, breaking this decision on both counts.
