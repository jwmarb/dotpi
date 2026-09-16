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

**Injected prompt**:
The content the orchestrator assembles and hands to a **Run**: the subagent's own system prompt, any preloaded skills, and — on the **Fallback path** only — the conditional result contract; a **Native Run** never receives it, because its **Result** is read from the **Transcript** rather than scraped from a fenced tag. It is exactly what crosses `--append-system-prompt`, and it is recorded in the **Run** directory as `prompt.md` at spawn, left unarchived like **Run Meta**. Distinct from the child's *final* system prompt, which also includes pi's own base prompt: capturing that would require patching pi itself, and it would go stale on every pi release.
_Avoid_: system prompt (overloaded — the child's final prompt includes pi's base), append prompt, delegation brief (that is the task text)

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
One step in a **Plan**: what to do, plus its state as the work progresses. A **Plan Item** may be executed by a **Task** it spawns; the Item records the **Task ID** and reaches its terminal state when that **Task** lands. An Item created by mistake can be **deleted** outright, but only while non-terminal — once terminal it is the record of what happened, so abandoning work is `dropped` (visible) rather than deleted (erased), and the ids of surviving Items are never renumbered because notes, **Task IDs** and **Run** directories may already name them.
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
The per-**Plan Item** setting naming who may clear that Item: `user`, `oracle`, or `skip`. An Item that has **explicitly** stated a route may thereafter only have it escalated, never lowered; an Item that has stated *none* is unconstrained, because absent is an inferred default rather than anybody's decision. An Item with no **Review Route** is treated as routed to `user` wherever the route is *enforced*, always — there is no exception to that reading. **Autonomous Mode** does not change the enforcement reading; it *assigns* `oracle` to an unrouted Item on any non-terminal state change, before later enforcement runs, so an Item that has moved once already carries a route of its own. A terminal transition adopts no route, which is why an unrouted Item attempting `done` is enforced as `user` and refused — deliberately. The distinction between absent and explicitly-`user` is the difference between the two readings `routeOf` and `chosenRouteOf`, and reaching for the wrong one is a silent bug in either direction (ADR 0032).
_Avoid_: reviewer, review level, rigour, review mode

**Escalation**:
Raising an Item's **Review Route** toward more scrutiny — `skip` → `oracle` → `user`. The only direction an **explicitly** routed Item's **Review Route** may move. An agent may escalate its own Item; nothing may lower one it once chose. Setting the *first* route on an Item that never had one is not an **Escalation** and is unrestricted — there is no earlier choice to lower.
_Avoid_: re-routing, downgrade (there is no downward move to name)

**Verdict**:
Oracle's answer when it reviews an Item routed to `oracle`: `pass`, `fail`, or `unsure`. Carried as a fixed token in the **Write-up** so it is read programmatically, not interpreted from prose. `pass` clears the Item; `fail` and `unsure` both return it to `active` for **Rework**. A review that dies without answering yields no **Verdict** at all, which is distinct from `unsure`: no verdict is retried, whereas `unsure` is a real answer meaning oracle could not judge correctness.
_Avoid_: review result, judgement, opinion

**Dead review**:
A dispatched oracle review that reached no **Verdict** — it emitted no parsable token, crashed, outran its deadline, or was refused before it started (inside another review, with no identifiable pi, or against the concurrency cap; ADR 0037). Distinct from every Verdict including `unsure`: a **Dead review** is not an answer, so the Item stays in `review` with the reason appended to its note, no **Review Budget** is spent, and the review can simply be run again.
_Avoid_: failed review (that is a `fail` **Verdict**, the opposite — a real judgement), timeout, error

**Autonomous Mode**:
A per-plan setting under which a **Plan Item** with no **Review Route** of its own picks up `oracle` instead of `user`, on **any non-terminal state change** rather than only when **Groomed** — it was gated on grooming alone for one session, and since the natural path to work is `backlog` → `active` → `review`, the mode did nothing at all while displaying its banner (ADR 0032). Terminal transitions never adopt a route, or an Item could award itself the route that permits its own completion. **Switching the mode on also adopts `oracle` for every unrouted Item that already exists**, dispatching a review at once for any of them already sitting in `review` — without that, an Item parked in `review` never transitions again and waits for a reviewer nobody dispatches, which stranded five real Items. It changes only the *default*: an Item explicitly routed `user` still waits for the user's hand, and that limit is what keeps the backfill from being the plan-level override ADR 0023 rejected. Set with plan op `autonomous` and stored as the plan file's **plan-meta line**, so it survives restarts and shows as `◇ autonomous` on the **Board**. _[the review is dispatched automatically and runs detached, reporting through the Item's note and route — and, since ADR 0039, also as a `pln-`prefixed **Run** with its own `/runs` row, **Board** progress and **Mirror Pane**.]_
_Avoid_: auto mode, unattended mode, headless (that is pi's no-UI mode, a different thing)

**Rework**:
The return of a **Plan Item** from `review` to `active` carrying oracle's findings in its note. The Item's text is left alone — it still says what the step is — so **Rework** records what was wrong without destroying what was asked. **Rework** is carried out by a fresh **Run** — a `worker` with `write`, `edit` and `bash`, told to verify by running things and to commit exactly one commit — never by the orchestrator that wrote the rejected work, so the reviser has oracle's findings without the original author's attachment to its own approach. Many **Reworks** may happen per Item before the **Review Budget** escalates it, and while one is in flight the Item carries a `reworkRunId` and refuses to be reviewed, because judging code a worker is mid-way through changing yields a stale **Verdict** (ADR 0041). The loop stops there: nothing moves the Item back to `review`, so a human or the orchestrator re-submits it. The counterpart to **Escalation**: **Escalation** moves an Item toward more scrutiny, **Rework** moves it back to be redone.
_Avoid_: revision (that is the in-place rewriting of an Item's *text*, a different operation), retry, bounce, kickback

**Review Budget**:
The ceiling on how many times one **Plan Item** may be reviewed in **Autonomous Mode** before it stops being cleared automatically: twenty failed **Verdicts**, after which the Item's **Review Route** ratchets to `user`. Bounds the `active` → `review` → `active` loop, so an Item oracle keeps rejecting reaches the user instead of consuming runs forever. It was **two** until that proved too eager — an Item can be genuinely improved by each **Rework** and still be rejected twice on different grounds, and the ratchet then parked correct-and-improving work in front of a user with nothing to add. At twenty the Budget is effectively unlimited *with a floor*: a runaway stop rather than a routine handoff, so the loop still terminates but is allowed to actually run. Counted in the Item's `reviews` field. Only a real **Verdict** spends it — a dead review costs nothing, because the Budget exists to stop oracle disagreeing forever, not to punish an Item for a crashed endpoint.
_Avoid_: retry limit, attempts, quota
### Herdr surfaces

**Pane**:
The herdr-managed terminal that hosts one process. A **Pane** is what actually displays something; it is the unit an agent occupies.
_Avoid_: window, split, terminal (a herdr terminal is a distinct lower-level concept)

**Tab**:
A herdr layout container holding one or more **Panes**. A **Tab** never hosts a process itself — it is where **Panes** are arranged. One **Tab** per **Task**.
_Avoid_: agent tab (a **Tab** groups panes; the agent lives in a **Pane**)

**Mirror Pane**:
The **Pane** that displays one **Run**'s output, live while the **Run** writes and historical once it has finished. The orchestrator's extension still owns the child process; the **Mirror Pane** only renders the session file that child writes. It is a viewport, never the process's home. Given its **Run**'s session *directory*, it resolves and latches onto the session file itself rather than being told a filename that may not exist yet (ADR 0025). Its output is append-only, so the terminal's own scrollback holds the history and nothing is pinned (ADR 0029). It self-reports to herdr via `pane report-agent`, so the **Run** appears in herdr's agent list with its own session. Belongs to the **Fallback path** alone: a **Native Run** has no **Mirror Pane** because it renders itself, and with **Reopen** retired nothing displays a *finished* **Run** either — so this term now describes the fallback and nothing else. It was not deleted with the native path's arrival, because the fallback is permanent (ADR 0044).
_Avoid_: agent pane, subagent tab, run pane, replay pane; **Run Pane** (that is the opposite thing — the process's home, not a viewport)

**Run Pane**:
The **Pane** a **Native Run** *lives in* — a real interactive `pi` TUI that the user watches, types into and steers, exactly as they steer the orchestrator. The inverse of a **Mirror Pane** in the one way that matters: it is the process's home, so closing it ends the **Run**. Launched by herdr rather than by the orchestrator, because `pi` is a TUI only when stdin and stdout are both TTYs and a piped child can never satisfy that. Because it *is* the process's terminal, herdr destroys it the instant that process exits and its scrollback dies with it — so a failing Run's wrapper deliberately stays alive to hold the pane, which is the only reason a failure's output is still readable (ADR 0044).
_Avoid_: mirror pane (the opposite), native pane, agent pane

**Pane label**:
The name herdr shows for a **Pane** and its tab, set by whoever opened it. One convention across every producer: `agent (#shortid)` — `explorer (#6748abcd)` for a delegated **Run**, `oracle (#44da80f1)` for an autonomous review, `worker (#44da80f1)` for a **Rework** — because all of them sit in the same tab bar and a second format would read as a different kind of thing. A top-level session labels itself `orchestrator`; a **Run** never does, since its spawner knows the **Task**, agent and id and names it better. The agent in a label is the same name `createRunDir` records, so a pane cannot disagree with its own `/runs` row. Always best-effort: a label is cosmetic and never worth failing a spawn or a startup over.
_Avoid_: tab name, pane title (`terminal_title` is a different, shell-owned field)

**Native Run**:
A **Run** executing as a real interactive `pi` session in its own **Run Pane**, as opposed to the **Fallback path**'s piped JSON-mode child. Its **Result** is signalled by a **Done signal** and read from its own **Transcript**, not parsed from stdout — the parent holds no pipes to it at all. Chosen automatically whenever herdr is available — including for an autonomous review or **Rework**, which take the same path so the one Run type that executes without a human is not the one a human cannot watch (ADR 0044). **Nesting** is allowed for a delegated Run: a **Native Run** carries `subagent`/`subagent_tasks`, so its own delegations are native too, each a full `pi` with its own context window and pane. It is withheld from a review or Rework, which must not be able to route around ADR 0037's recursion interlock via a different spawner — and whose verdict is meant to be its own reading of the work. That grant is safe only because the **Spawn slot** budget is tree-wide — it is the exact capability ADR 0040 named as the thing to guard, so it was enabled last, after the guard was measured (ADR 0044).
_Avoid_: interactive run, TUI run, herdr run

**Fallback path**:
The original spawn mechanism — a `--mode json` child on pipes, its **Result** parsed from `message_end` events — retained permanently for every context herdr cannot host: headless, CI, `--mode json`. Not deprecated and not removable, so two spawn paths exist indefinitely and may drift; that drift is the standing cost of ADR 0044.
_Avoid_: legacy path, old path (it is current, not superseded), JSON mode (that is the flag, not the path)

**Run Meta**:
The `run.json` written beside a **Run**'s session, recording which subagent the **Run** is and its lifecycle `outcome`. It exists because a session file records what a child *did* but never which specialist it was, and the **Board** reads these directories from a separate process with no view of the **Task** (ADR 0026). Written **twice** — `running` at the start, then a terminal outcome from a `finally` — because the parent is the only party that knows a **Run** died before writing a transcript, which on disk is indistinguishable from one about to start (ADR 0036, ADR 0039).
_Avoid_: manifest, metadata file, run info

**Spawn slot**:
A unit of the single shared budget for concurrently running child processes, capped at six and claimed per child rather than per **Task** — because a **Task** is not a process, and a parallel one runs several **Runs** at once. Delegated **Runs** and autonomous plan reviews compete for the same pool, so a full budget refuses whichever asks next, naming the holders. Claimed synchronously with its check so no caller can slip through the gap, and released from a `finally`. A **Run** refused a slot fails with the refusal as its error rather than waiting, and a refused review is a **Dead review** (ADR 0040). The budget is **tree-wide**: shared by every `pi` in the orchestrator's descent through a lock directory of pid-stamped tokens, in the shape ADR 0035 uses for the plan lock. It had to stop being per-process the moment a **Native Run** — a full `pi` that can itself spawn — became possible, exactly as ADR 0040 predicted in its own closing sentence; six per process, recursively, is not a cap. Liveness is decided by probing a holder's pid, never by age, because a Run may legitimately hold a slot for hours while a user steers it (ADR 0044). A Run whose pane is being **held open** after failure releases its slot as soon as its exit code lands, since the pane outliving the work is presentation, not work.
_Avoid_: task limit (that is `MAX_ACTIVE_TASKS`, which bounds work in flight, not processes), quota, semaphore

**Run directory contract**:
The published on-disk layout `<agentDir>/subagent-sessions/<runId>/` — a **Transcript**, its **Run Meta**, and, for delegated `sub-` **Runs**, its **Injected prompt** recorded at spawn as `prompt.md` — shared by both producers of **Runs** and read by three consumers that hold no handle on the producing process: the **Run Index**, **Board** progress and the **Mirror Pane**. Plan-spawned `pln-` **Runs** (autonomous reviews, rework) still route their prompt through a temp file, so their directories carry no `prompt.md` (ADR 0045). The subagent extension mints `sub-` **Run** IDs, the plan extension mints `pln-` ones for its autonomous reviews, and both write the twice-written **Run Meta** sidecar through one module so it cannot be forgotten by one of them (ADR 0039). A `pln-` prefix in `/runs` is how to tell a plan-spawned **Run** from a delegated one.
_Avoid_: session folder, run store, the registry (that is the in-memory **Task** list, deliberately not shared)

**Run State** _[design only]_:
The answer to "what state was this **Run** left in?", derived from a **Run** directory alone by one reader that every consumer shares: `running`, `completed`, `failed`, `dismissed` or unknown, plus the turn count, the start time, the agent, and whether the directory is **Archived**. The **Run directory contract**'s read side, as **Run Meta** is its write side — the same layout approached from the other direction, which is why the reader borrows `RunOutcome` from the writer's module rather than restating it.

It exists because the derivation is not obvious and every consumer got it wrong separately: a **Run** killed mid-tool-call reads `running` forever from its **Transcript**, a **Run** retrying a provider error reads `failed` while alive, and a **Dismissed** one never settles at all — so **Run Meta**'s explicit outcome is authoritative *in both directions* and only a sidecar predating the field falls back to the transcript. An **Archived** **Run** is the one exception: `running` beside `archived: true` is self-contradictory, so it is not honoured, and the reader never thaws to find out (ADR 0022).

Its strongest form is a different question with the same subject — "is a writer editing the tree *right now*?", which **Rework** must ask before a re-review, and which escalates past the files to probing the child's pid and bounding by age. The two wrong answers are not equally bad: claiming still-running wedges a **Plan Item** recoverably, while claiming finished judges a tree a worker is mid-way through editing (ADR 0041).

Takes a directory path rather than resolving one, because two of its consumers are standalone processes in bare **Panes** that cannot import the pi host at all.
_Avoid_: run status (**Run Meta**'s `outcome` field is the recorded fact; **Run State** is what a reader derives), progress, liveness (that is only the strongest form of it)

**Run Index**:
The listing of **Tasks** available to open, merged from two sources: the in-memory registry for the current session, and a scan of the **Run** session directories on disk for everything older. Neither source alone is enough — the registry dies with the orchestrator (ADR 0001), and disk does not record a **Task**'s **Mode** (ADR 0028). Grouped by **Task**, one row each, because `/run` opens a whole **Task** and so a row per **Run** gave a parallel **Task** three identical rows offering three ways to do one thing; a multi-**Run** **Task** adds an indented child line per **Run** and its header state is pessimistic, reading `failed` if any single **Run** failed (ADR 0038). Read by the user with `/runs` and by the orchestrator with the `list` action; a row is **Resumed** by its **Task ID** — which, since **Reopen** retired, means continuing that **Run** rather than reading it (ADR 0044).
_Avoid_: task list (that means **Plan**), history, run log

**Attach**:
Recording on a **Plan Item** the **Task ID** of the delegation executing it. A separate act from creating the Item, because an Item always exists before the delegation that runs it — and the only thing that makes a **Task**'s progress visible on the **Board** (ADR 0026, ADR 0030).
_Avoid_: link, bind, assign

**Resume**:
Opening a finished **Run**'s session in a real `pi` and *continuing* it — new turns appended to the existing **Transcript**. Addressed by **Task ID**. **Archived** sessions are **Thawed** first, so age is invisible. This retires **Reopen**, which meant reading a finished **Run** without continuing it: there is deliberately no read-only path, so a **Run**'s **Transcript** is a living document rather than a record, and every revisit can alter it (ADR 0044, superseding the ADR 0021 finding that treated the same append as corruption).
_Avoid_: reopen (retired — it promised a read that no longer exists), replay, restore (that is what **Thaw** does)

**Board Pane**:
The **Pane** that renders the **Board**. Exactly one per session, spawned at session start. It occupies the alternate screen, so it keeps its own display buffer rather than sharing the pane's scrollback, and is scrolled with keys (ADR 0031).

**Board**:
The live kanban projection of a **Plan**, drawn as columns in the **Board Pane**. Unlike other readers, the **Board** may also write: see **Column**. It reads more than the plan: a card carrying a **Task ID** shows that **Task**'s live progress, read from its **Runs**' sessions and **Run Meta** (ADR 0026). A card's title is the item's whole text — wrapped or multi-line, every line keeps title styling — so the item's note is the card's only dimmed element (ADR 0043).
_Avoid_: kanban, plan view (the **Board** is writable, so it is not merely a view)

**Column**:
One lane of the **Board**, corresponding exactly to one **Plan Item** state. There is no column concept separate from state — moving a card *is* a state change. The lanes are `backlog`, `ready`, `active`, `blocked`, `review`, `done`.
_Avoid_: lane, swimlane, board position (there is no position independent of state)

**Groomed**:
What moves a **Plan Item** from `backlog` to `ready`: the item is specified well enough to be started as written, and nothing is blocking it. Grooming is the natural moment to choose the Item's **Review Route**, but no longer the only one — under **Autonomous Mode** an unrouted Item adopts the default on any non-terminal transition, because relying on grooming alone meant work that went straight to `active` was never routed at all (ADR 0032). Grooming is a judgement, not a computed property — the model has no dependency edges between Items.
_Avoid_: refined, unblocked (an item can be unblocked and still too vague to start)

**Accepted**:
What moves a **Plan Item** to `done`: its **Review Route** was satisfied. A `user` route — the default — means the user's hand via `/accept`, and the plan tool refuses `done` on such an Item; `oracle` means a `pass` **Verdict**; `skip` means the work simply landed. The user may accept any Item in `review` whatever its route, because a route binds the agent, not the user. Under **Autonomous Mode** an `oracle`-routed Item is dispatched to a review automatically on entering `review`, so it can reach `done` with no human hand at all.
_Avoid_: approved, signed off, complete

**Archived**:
A **Run** session compressed to cold storage (zstd). Nothing is lost, but an **Archived** session is unreadable to herdr's sidebar and to the **Mirror Pane** until it is **Thawed**. Compression *is* archiving — there is no separate archive location.
_Avoid_: compressed (that is the mechanism), backed up, cold (that is the state, not the name)

**Thaw**:
Restoring an **Archived** session to plain JSONL so it can be read again. **Resuming** a **Run** is what thaws it; a thaw is idempotent and, if interrupted, leaves the readable copy authoritative.
_Avoid_: decompress (that is the mechanism), restore, unarchive

### Results and notification

**Result**:
What a **Run** is for: the extracted answer the orchestrator consumes. Distinct from the run's **Transcript** — the orchestrator reads results, not transcripts.
_Avoid_: output, response

**Write-up**:
A subagent's final message, formatted to a fixed contract so the **Result** can be extracted programmatically rather than by prose-reading.

**Transcript**:
The full message stream of a **Run** — every assistant turn and tool call. Rendered for the human; not fed to the orchestrator. For a **Native Run** it is also where the **Result** is read from, which makes it load-bearing rather than merely evidence, and it is no longer read-only: **Resume** appends to it. Locating the Result inside it is not simply "the last thing said" — the turn carrying the **Done signal** is authoritative, because a child often answers *in* that turn and pi may add a courtesy turn after the tool returns (ADR 0044).
_Avoid_: history, log, messages

**Done signal**:
How a **Native Run** declares it has finished, since the parent holds no pipes to watch. Two sources, both writing the same `<session>.exit` sidecar: a `subagent_done` tool the child calls deliberately, and an automatic write when the child's last turn ends cleanly — the second exists so a child that answers well but forgets the tool is not mistaken for one that wedged. The sidecar says *when*; the **Transcript** says *what*, read from the turn that carried the signal. Auto-injected into every **Native Run**'s tool allowlist, so no subagent definition has to declare it and a tool-restricted child can still finish. Distinct from the `<runId>.exitcode` sidecar, which the wrapper writes and which reports how the *process* ended: a **Done signal** is a claim about the work, an exit code is a fact about the process, and a Run can have either without the other (ADR 0044).
_Avoid_: exit sidecar (that is the file, one of two things the signal is), completion marker, done marker

**Dismissed**:
The outcome of a **Native Run** whose **Run Pane** the user closed before it finished. A fourth **Run Meta** `outcome` beside `running`, `completed` and `failed`, and deliberately not folded into `failed`: a **Run** the user waved away is not a **Run** that went wrong, and conflating them would repeat the error CONTEXT.md's **"Failed"** flag already warns about for **Plan Items** (ADR 0044).
_Avoid_: cancelled (that is `subagent_tasks` `cancel`, a different act with a different cause), closed, aborted, failed

**Reminder**:
The message injected into the orchestrator's session when a **Task** reaches a terminal state, waking it to collect the **Result**. Not a user message: it is attributed to the system. Delivered when the orchestrator next goes idle rather than the moment the **Task** lands, because a **Reminder** queued mid-turn cannot be recalled if the orchestrator collects the **Result** itself first (ADR 0027).
_Avoid_: notification, callback, ping

### Configuration and credentials

**Env file**:
The single file holding this installation's live credentials, at `agent/.env`, read by a **Credential loader** into the process environment. Gitignored and machine-local, so it is the one file here with no version history. Its committed companion `agent/.env.example` names every variable required without holding a value, so the repo states its own requirements (ADR 0042).
_Avoid_: dotenv, secrets file, config — the last is any config, most of which is committed.

**Credential loader**:
The one module (`agent/extensions/dotenv.ts`) that reads the **Env file**. Deliberately singular: two parsers of the same file drift, and drift is how the interlock of ADR 0037 was bypassed. Fills only variables that are *not* already set, so the real environment always wins — a one-off override works, and a spawned child never has an inherited value replaced by a file it did not choose.
_Avoid_: dotenv loader, env parser

**Placeholder**:
A `${VAR}` reference inside `agent/mcp.json`, expanded from the environment when the config is read. What lets a config file that needs a credential be committed, since it names the variable rather than carrying the value. An unset variable refuses to start that server rather than expanding to empty or staying literal — a literal `Bearer ${VAR}` reaches the gateway and returns a 401 that looks like a network fault (ADR 0042).
_Avoid_: variable, template, interpolation

### Flagged ambiguities

**"Background"** means the orchestrator's turn does not block on the **Task**, and the task outlives a failed turn, an aborted tool call, and an idle prompt. It does *not* mean the task outlives the `pi` process — a task dies with its orchestrator.

**"Failed"** means a **Plan Item** was attempted and did not land. A step abandoned by choice is **dropped**, not failed — both are terminal, but only `failed` claims something went wrong. A **dropped** Item is excluded from the plan's progress denominator.

**"Task list"** means **Plan**. A **Task** is a subagent delegation and its ID names that delegated unit of work; a **Plan** is the agent's own ordered step list. A **Plan Item** may record the **Task ID** of the delegation executing it — but a **Task** is never itself a **Plan Item**.

**"Tab"** means a herdr layout container, not an agent. The request "one agent tab per subagent" resolves to: one **Tab** per **Task**, one pane per **Run** — a **Mirror Pane** on the **Fallback path**, a **Run Pane** for a **Native Run**. An agent never occupies a **Tab** directly.

**"Blocked"** is now overloaded across two models and they are not the same thing. Herdr's `blocked` is normally a *detected* pane state — herdr recognised an approval or question UI on screen. A **Plan Item**'s `blocked` is a *declared* state meaning the work cannot proceed. A **Run** can be herdr-blocked while its **Plan Item** is `active`, and an Item can be `blocked` with no pane at all. For a **Mirror Pane** the herdr state is *also* declared rather than detected (see ADR 0019), since a JSON-mode child shows no recognisable UI — whereas a **Native Run** is a real `pi` TUI, so herdr *detects* its state the ordinary way and the declaration shim is not needed at all (ADR 0044).

**"Done"** means **Accepted** — the Item's **Review Route** was satisfied — not "the agent finished". What that costs varies by route: a `user`-routed Item (the default) still reaches `done` only by the user's hand, and the plan tool refuses an agent's attempt to set it; `oracle` and `skip` routes let an Item be cleared without the user ever seeing it. `done` is therefore not a single claim, and must be read together with the Item's route (ADR 0023, superseding 0017).

**"Review"** is the column for Items *awaiting a reviewer*, so a `skip`-routed Item never enters it — it goes `active` → `done` directly. An Item sitting in `review` is always waiting on someone: the user, or (once the automation lands) a dispatched oracle review.

**"Unsure"** is two different things and only one is a **Verdict**. An orchestrator unsure whether work is *trivial* does not skip: it routes to `oracle`, and triviality is never referred out. An oracle unsure whether work is *correct* returns the `unsure` **Verdict**, which sends the Item back for **Rework** exactly as `fail` does, and reaches the user only once the **Review Budget** is spent. Judging triviality is the orchestrator's alone; oracle only ever judges correctness. The three tokens are still distinct even though two share a destination: `unsure` says the work may be right but oracle could not establish it, which is worth telling a reviser, and a *missing* token is not `unsure` at all but a dead review — which leaves the Item in `review` to be retried and spends no **Review Budget**.

**"Closing a pane"** now means two opposite things, and which one depends on the kind of pane. Closing a **Mirror Pane** means you stopped watching, not that you stopped the work: the **Run** continues, its **Result** still lands, its **Reminder** still fires, and cancelling is `subagent_tasks` `cancel` — never a pane close. Closing a **Run Pane** *ends the **Run***, because that pane is the process's home rather than a viewport; the outcome is **Dismissed**, distinct from both `completed` and `failed` (ADR 0044). So the old blanket guarantee — "closing is always safe" — is gone, and the safe-to-close pane is now the exception rather than the rule.

Closing is also something the *system* does, and its rule changed too: ADR 0028 closed a **Task**'s **Tab** when its **Reminder** was delivered, which was harmless for viewports. A **Task** whose **Runs** are native instead auto-closes on clean completion and *holds the pane open on failure*, so evidence of what went wrong stays on screen and a pane you are typing into is never yanked (ADR 0044). Evidence loss is no longer fully recoverable either: with **Reopen** retired there is no read-only path back to a finished **Run**, only **Resume**, which appends.

**"The subagent's Result"** is no longer necessarily the subagent's own work. A **Native Run** is interactive, so the user may have typed into it and shaped its final message — and the **Result** the orchestrator consumes is that message either way. Nothing marks the difference: flagging a steered **Result** as human-influenced was considered and declined (ADR 0044), on the grounds that a **Run** is a **Run** and the **Transcript** records the truth. The consequence to hold in mind is that in a `chain`, one **Run**'s **Result** is fed to the next as though a specialist produced it, when a human may have written it.

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
