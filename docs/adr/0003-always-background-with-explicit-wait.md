# Every Task is background; blocking is an explicit wait

`subagent` never blocks. It registers a **Task**, returns a **Task ID** immediately, and the orchestrator either waits on it via `subagent_tasks` `wait` or lets the **Reminder** wake it later.

The alternative — blocking by default, backgrounding on request — makes the tool's return value depend on a flag, so the model must reason about two different shapes from one tool. A uniform "always returns a Task ID" contract costs one extra call in the wait case and buys a launch path with no modes.

## Consequences

Recon feeding the immediate next decision is now two calls (launch, then `wait`) instead of one. `wait` accepting several **Task IDs** at once partly repays this: fanning out four **Tasks** and waiting on all of them is two calls total, which the blocking design could not express at all.

`wait` must claim notification for the **Tasks** it awaits *before* awaiting them, and must be interruptible by the turn's abort signal. Claiming afterwards is too late — completion listeners fire before waiters wake, so the **Reminder** would already have been sent and the **Results** would land in context twice. And since `wait` may be unbounded, ignoring the abort signal would leave a turn parked on a promise nothing resolves.
