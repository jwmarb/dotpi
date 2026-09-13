# Pi Agent Configuration

Personal configuration for the `pi` coding agent: the orchestrator's extensions, the subagent fleet, and the skills they load. This context covers delegation — how the orchestrator hands work to subagents and gets answers back.

## Language

### Delegation

**Orchestrator**:
The top-level `pi` agent that talks to the user and delegates work. Exactly one per session.
_Avoid_: main agent, parent, primary

**Subagent**:
A specialized agent, defined by a Markdown file with frontmatter, that runs in its own child `pi` process with an isolated context window.
_Avoid_: sub-agent, worker (that is the name of one specific subagent), child agent

**Task**:
One `subagent` tool call and everything it spawns, addressed by a **Task ID**. A task is the unit the orchestrator names, checks on, and cancels. A single task may contain several **Runs**.
_Avoid_: job, invocation, batch

**Task ID**:
The short handle the orchestrator uses to refer to a **Task** (e.g. `sub-a3f1`). One per **Task**, never per **Run**.

**Run**:
One child `pi` process executing one subagent against one prompt. Single mode is one run; parallel and chain modes are several runs under one **Task**.
_Avoid_: step (that is a run's ordinal position within a chain), invocation

**Mode**:
How a **Task**'s runs relate: `single` (one run), `parallel` (independent runs, concurrent), `chain` (sequential runs, each fed the previous run's **Result**).

### Planning

> Terms marked **[design only]** are decided but **not implemented**. They name
> concepts the code does not yet have, so an agent must not call or assume them.
> Everything unmarked describes shipped behaviour.

**Plan**:
The ordered list of upcoming steps that one agent session maintains to keep its work on track. A **Plan** belongs to the agent doing the work — it is not a **Task** (a **Task** is a delegated unit of work handed to a subagent).
_Avoid_: task list (a **Task** is a subagent delegation; the agent's step list is a **Plan**), to-do list, checklist

**Plan-meta line**:
A single JSON object at the head of a plan file carrying `kind: "plan-meta"` and the plan's own settings — currently just **Autonomous Mode** — as distinct from the one-per-line **Plan Items** below it. Every writer rebuilds a plan file wholly from its Item list, so meta is only safe because it is read and rewritten inside the same lock; a per-plan field added any other way is destroyed by the next write (ADR 0032).
_Avoid_: header, frontmatter, config line

**Plan Item**:
One step in a **Plan**: what to do, plus its state as the work progresses. A **Plan Item** may be executed by a **Task** it spawns; the Item records the **Task ID** and reaches its terminal state when that **Task** lands.
_Avoid_: subtask, step (a **step** is what you do; a **Plan Item** is the tracked entry for it)

**Starter Plan**:
A **Plan** the orchestrator authors for a subagent before delegating work. The subagent owns and maintains it from that moment on; the orchestrator never reads it back.
_Avoid_: delegation brief (that is the prompt text; the **Starter Plan** is the tracked structure behind it)

**Revision**:
The rewriting of an existing **Plan Item**'s text, in place, when the work it describes changes shape. A **Revision** keeps the Item's identity, position, and **Task ID**; it leaves no record of the prior wording.
_Avoid_: edit, update, amend

**Plan Archive**:
The resting place for plans whose **Plan Items** have all reached a terminal state (done, failed, or dropped). Where finished work is kept on record.
_Avoid_: history, log

**Review Route**:
The per-**Plan Item** setting naming who may clear that Item: `user`, `oracle`, or `skip`. Chosen when the Item is **Groomed**, and thereafter only ever escalated, never lowered. An Item with no **Review Route** is routed to `user` — unless the plan is in **Autonomous Mode**, which changes only that default.
_Avoid_: reviewer, review level, rigour, review mode

**Escalation**:
Raising an Item's **Review Route** toward more scrutiny — `skip` → `oracle` → `user`. The only direction a **Review Route** may move. An agent may escalate its own Item; nothing may lower one.
_Avoid_: re-routing, downgrade (there is no downward move to name)

**Verdict**:
Oracle's answer when it reviews an Item routed to `oracle`: `pass`, `fail`, or `unsure`. Carried as a fixed token in the **Write-up** so it is read programmatically, not interpreted from prose. `pass` clears the Item; `fail` and `unsure` both return it to `active` for **Rework**. A review that dies without answering yields no **Verdict** at all, which is distinct from `unsure`: no verdict is retried, whereas `unsure` is a real answer meaning oracle could not judge correctness.
_Avoid_: review result, judgement, opinion

**Dead review**:
A dispatched oracle review that reached no **Verdict** — it emitted no parsable token, crashed, outran its deadline, or was refused before it started (inside another review, with no identifiable pi, or against the concurrency cap; ADR 0037). Distinct from every Verdict including `unsure`: a **Dead review** is not an answer, so the Item stays in `review` with the reason appended to its note, no **Review Budget** is spent, and the review can simply be run again.
_Avoid_: failed review (that is a `fail` **Verdict**, the opposite — a real judgement), timeout, error

**Autonomous Mode**:
A per-plan setting under which a **Groomed** **Plan Item** defaults to the `oracle` **Review Route** instead of `user`. It changes only the default: an Item explicitly routed `user` still waits for the user's hand, and existing Items are never re-routed when the mode is turned on. Set with plan op `autonomous` and stored as the plan file's **plan-meta line**, so it survives restarts and shows as `◇ autonomous` on the **Board**. _[the review is dispatched automatically and runs detached, reporting through the Item's note and route — and, since ADR 0039, also as a `pln-`prefixed **Run** with its own `/runs` row, **Board** progress and **Mirror Pane**.]_
_Avoid_: auto mode, unattended mode, headless (that is pi's no-UI mode, a different thing)

**Rework** _[partly implemented — the return to `active` with findings is live; the fresh **Run** is deliberately not. Plan-spawned processes became observable in ADR 0039, but observability is detection, not prevention: a Rework worker also needs a spawn admission cap and either no `bash` or a scratch-copy applied only on a `pass`]_:
The return of a **Plan Item** from `review` to `active` carrying oracle's findings in its note. The Item's text is left alone — it still says what the step is — so **Rework** records what was wrong without destroying what was asked. **Rework** is meant to be carried out by a fresh **Run**, never by the orchestrator that wrote the rejected work, so the reviser has oracle's findings without the original author's attachment to its own approach. The counterpart to **Escalation**: **Escalation** moves an Item toward more scrutiny, **Rework** moves it back to be redone.
_Avoid_: revision (that is the in-place rewriting of an Item's *text*, a different operation), retry, bounce, kickback

**Review Budget**:
The ceiling on how many times one **Plan Item** may be reviewed in **Autonomous Mode** before it stops being cleared automatically: two failed **Verdicts**, after which the Item's **Review Route** ratchets to `user`. Bounds the `active` → `review` → `active` loop, so an Item oracle keeps rejecting reaches the user instead of consuming runs forever. Counted in the Item's `reviews` field. Only a real **Verdict** spends it — a dead review costs nothing, because the Budget exists to stop oracle disagreeing forever, not to punish an Item for a crashed endpoint.
_Avoid_: retry limit, attempts, quota
### Herdr surfaces

**Pane**:
The herdr-managed terminal that hosts one process. A **Pane** is what actually displays something; it is the unit an agent occupies.
_Avoid_: window, split, terminal (a herdr terminal is a distinct lower-level concept)

**Tab**:
A herdr layout container holding one or more **Panes**. A **Tab** never hosts a process itself — it is where **Panes** are arranged. One **Tab** per **Task**.
_Avoid_: agent tab (a **Tab** groups panes; the agent lives in a **Pane**)

**Mirror Pane**:
The **Pane** that displays one **Run**'s output, live while the **Run** writes and historical once it has finished. The orchestrator's extension still owns the child process; the **Mirror Pane** only renders the session file that child writes. It is a viewport, never the process's home. Given its **Run**'s session *directory*, it resolves and latches onto the session file itself rather than being told a filename that may not exist yet (ADR 0025). Its output is append-only, so the terminal's own scrollback holds the history and nothing is pinned (ADR 0029). It self-reports to herdr via `pane report-agent`, so the **Run** appears in herdr's agent list with its own session. **Reopening** a finished **Run** produces a **Mirror Pane** too: one viewer, two lifecycles (ADR 0028).
_Avoid_: agent pane, subagent tab, run pane, replay pane (a reopened Run is still a **Mirror Pane**)

**Run Meta**:
The `run.json` written beside a **Run**'s session, recording which subagent the **Run** is and its lifecycle `outcome`. It exists because a session file records what a child *did* but never which specialist it was, and the **Board** reads these directories from a separate process with no view of the **Task** (ADR 0026). Written **twice** — `running` at the start, then a terminal outcome from a `finally` — because the parent is the only party that knows a **Run** died before writing a transcript, which on disk is indistinguishable from one about to start (ADR 0036, ADR 0039).
_Avoid_: manifest, metadata file, run info

**Spawn slot**:
A unit of the single shared budget for concurrently running child processes, capped at six and claimed per child rather than per **Task** — because a **Task** is not a process, and a parallel one runs several **Runs** at once. Delegated **Runs** and autonomous plan reviews compete for the same pool, so a full budget refuses whichever asks next, naming the holders. Claimed synchronously with its check so no caller can slip through the gap, and released from a `finally`. A **Run** refused a slot fails with the refusal as its error rather than waiting, and a refused review is a **Dead review** (ADR 0040).
_Avoid_: task limit (that is `MAX_ACTIVE_TASKS`, which bounds work in flight, not processes), quota, semaphore

**Run directory contract**:
The published on-disk layout `<agentDir>/subagent-sessions/<runId>/` — a **Transcript** plus its **Run Meta** — shared by both producers of **Runs** and read by three consumers that hold no handle on the producing process: the **Run Index**, **Board** progress and the **Mirror Pane**. The subagent extension mints `sub-` **Run** IDs, the plan extension mints `pln-` ones for its autonomous reviews, and both write through one module so the twice-written sidecar cannot be forgotten by one of them (ADR 0039). A `pln-` prefix in `/runs` is how to tell a plan-spawned **Run** from a delegated one.
_Avoid_: session folder, run store, the registry (that is the in-memory **Task** list, deliberately not shared)

**Run Index**:
The listing of **Tasks** available to open, merged from two sources: the in-memory registry for the current session, and a scan of the **Run** session directories on disk for everything older. Neither source alone is enough — the registry dies with the orchestrator (ADR 0001), and disk does not record a **Task**'s **Mode** (ADR 0028). Grouped by **Task**, one row each, because `/run` opens a whole **Task** and so a row per **Run** gave a parallel **Task** three identical rows offering three ways to do one thing; a multi-**Run** **Task** adds an indented child line per **Run** and its header state is pessimistic, reading `failed` if any single **Run** failed (ADR 0038). Read by the user with `/runs` and by the orchestrator with the `list` action; a row is **Reopened** by its **Task ID**.
_Avoid_: task list (that means **Plan**), history, run log

**Attach**:
Recording on a **Plan Item** the **Task ID** of the delegation executing it. A separate act from creating the Item, because an Item always exists before the delegation that runs it — and the only thing that makes a **Task**'s progress visible on the **Board** (ADR 0026, ADR 0030).
_Avoid_: link, bind, assign

**Reopen**:
Opening a finished **Run**'s session in a **Mirror Pane** to read its **Transcript**. Addressed by **Task ID**, which opens every **Run** of that Task. **Archived** sessions are **Thawed** on reopen, so age is invisible to the reader.
_Avoid_: replay, restore (that is what **Thaw** does), resume (a reopened **Run** never continues)

**Board Pane**:
The **Pane** that renders the **Board**. Exactly one per session, spawned at session start. It occupies the alternate screen, so it keeps its own display buffer rather than sharing the pane's scrollback, and is scrolled with keys (ADR 0031).

**Board**:
The live kanban projection of a **Plan**, drawn as columns in the **Board Pane**. Unlike other readers, the **Board** may also write: see **Column**. It reads more than the plan: a card carrying a **Task ID** shows that **Task**'s live progress, read from its **Runs**' sessions and **Run Meta** (ADR 0026).
_Avoid_: kanban, plan view (the **Board** is writable, so it is not merely a view)

**Column**:
One lane of the **Board**, corresponding exactly to one **Plan Item** state. There is no column concept separate from state — moving a card *is* a state change. The lanes are `backlog`, `ready`, `active`, `blocked`, `review`, `done`.
_Avoid_: lane, swimlane, board position (there is no position independent of state)

**Groomed**:
What moves a **Plan Item** from `backlog` to `ready`: the item is specified well enough to be started as written, and nothing is blocking it. Grooming is also when the Item's **Review Route** is chosen. Grooming is a judgement, not a computed property — the model has no dependency edges between Items.
_Avoid_: refined, unblocked (an item can be unblocked and still too vague to start)

**Accepted**:
What moves a **Plan Item** to `done`: its **Review Route** was satisfied. A `user` route — the default — means the user's hand via `/accept`, and the plan tool refuses `done` on such an Item; `oracle` means a `pass` **Verdict**; `skip` means the work simply landed. The user may accept any Item in `review` whatever its route, because a route binds the agent, not the user. _[the `oracle` route is not yet automated: nothing dispatches a review or reads a **Verdict**, so an `oracle`-routed Item waits in `review` like a `user`-routed one until that lands.]_
_Avoid_: approved, signed off, complete

**Archived**:
A **Run** session compressed to cold storage (zstd). Nothing is lost, but an **Archived** session is unreadable to herdr's sidebar and to the **Mirror Pane** until it is **Thawed**. Compression *is* archiving — there is no separate archive location.
_Avoid_: compressed (that is the mechanism), backed up, cold (that is the state, not the name)

**Thaw**:
Restoring an **Archived** session to plain JSONL so it can be read again. Opening a Run is what thaws it; a thaw is idempotent and, if interrupted, leaves the readable copy authoritative.
_Avoid_: decompress (that is the mechanism), restore, unarchive

### Results and notification

**Result**:
What a **Run** is for: the extracted answer the orchestrator consumes. Distinct from the run's **Transcript** — the orchestrator reads results, not transcripts.
_Avoid_: output, response

**Write-up**:
A subagent's final message, formatted to a fixed contract so the **Result** can be extracted programmatically rather than by prose-reading.

**Transcript**:
The full message stream of a **Run** — every assistant turn and tool call. Rendered for the human; not fed to the orchestrator.
_Avoid_: history, log, messages

**Reminder**:
The message injected into the orchestrator's session when a **Task** reaches a terminal state, waking it to collect the **Result**. Not a user message: it is attributed to the system. Delivered when the orchestrator next goes idle rather than the moment the **Task** lands, because a **Reminder** queued mid-turn cannot be recalled if the orchestrator collects the **Result** itself first (ADR 0027).
_Avoid_: notification, callback, ping

### Flagged ambiguities

**"Background"** means the orchestrator's turn does not block on the **Task**, and the task outlives a failed turn, an aborted tool call, and an idle prompt. It does *not* mean the task outlives the `pi` process — a task dies with its orchestrator.

**"Failed"** means a **Plan Item** was attempted and did not land. A step abandoned by choice is **dropped**, not failed — both are terminal, but only `failed` claims something went wrong. A **dropped** Item is excluded from the plan's progress denominator.

**"Task list"** means **Plan**. A **Task** is a subagent delegation and its ID names that delegated unit of work; a **Plan** is the agent's own ordered step list. A **Plan Item** may record the **Task ID** of the delegation executing it — but a **Task** is never itself a **Plan Item**.

**"Tab"** means a herdr layout container, not an agent. The request "one agent tab per subagent" resolves to: one **Tab** per **Task**, one **Mirror Pane** per **Run**. An agent never occupies a **Tab** directly.

**"Blocked"** is now overloaded across two models and they are not the same thing. Herdr's `blocked` is normally a *detected* pane state — herdr recognised an approval or question UI on screen. A **Plan Item**'s `blocked` is a *declared* state meaning the work cannot proceed. A **Run** can be herdr-blocked while its **Plan Item** is `active`, and an Item can be `blocked` with no pane at all. For a **Mirror Pane** the herdr state is *also* declared rather than detected (see ADR 0019), since a JSON-mode child shows no recognisable UI.

**"Done"** means **Accepted** — the Item's **Review Route** was satisfied — not "the agent finished". What that costs varies by route: a `user`-routed Item (the default) still reaches `done` only by the user's hand, and the plan tool refuses an agent's attempt to set it; `oracle` and `skip` routes let an Item be cleared without the user ever seeing it. `done` is therefore not a single claim, and must be read together with the Item's route (ADR 0023, superseding 0017).

**"Review"** is the column for Items *awaiting a reviewer*, so a `skip`-routed Item never enters it — it goes `active` → `done` directly. An Item sitting in `review` is always waiting on someone: the user, or (once the automation lands) a dispatched oracle review.

**"Unsure"** is two different things and only one is a **Verdict**. An orchestrator unsure whether work is *trivial* does not skip: it routes to `oracle`, and triviality is never referred out. An oracle unsure whether work is *correct* returns the `unsure` **Verdict**, which sends the Item back for **Rework** exactly as `fail` does, and reaches the user only once the **Review Budget** is spent. Judging triviality is the orchestrator's alone; oracle only ever judges correctness. The three tokens are still distinct even though two share a destination: `unsure` says the work may be right but oracle could not establish it, which is worth telling a reviser, and a *missing* token is not `unsure` at all but a dead review — which leaves the Item in `review` to be retried and spends no **Review Budget**.

**"Closing a Mirror Pane"** means you stopped watching, not that you stopped the work. The **Run** continues, its **Result** still lands, and its **Reminder** still fires. Cancelling is `subagent_tasks` `cancel` — never a pane close. Closing is now also something the *system* does: a **Task**'s **Tab** closes when its **Reminder** is delivered (ADR 0028). Either way no evidence is lost — the session file outlives every pane, and the **Run** can be **Reopened**.

## Example dialogue

> **Dev**: When I call `subagent` with three tasks in parallel, do I get three IDs back?
>
> **Expert**: One. That call is a single **Task** in `parallel` **Mode** with three **Runs**. The **Task ID** addresses the whole thing.
>
> **Dev**: So if one run fails I can't retry just that one?
>
> **Expert**: Not by ID, no. You'd start a new **Task**. IDs name the unit you asked for, not the units it decomposed into — otherwise a `chain` would hand you back step 2 alone, which is meaningless because step 3 already consumed its **Result**.
>
> **Dev**: And when the task finishes, the **Reminder** carries the results?
>
> **Expert**: The **Reminder** wakes you and tells you which **Task** landed. What it carries is the **Write-up**'s extracted **Result** — never the **Transcript**. You don't need to know how the subagent got there.
