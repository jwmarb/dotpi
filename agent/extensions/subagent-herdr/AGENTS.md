# subagent-herdr — herdr-backed subagent delegation

Owns the `subagent` / `subagent_tasks` tools (advertised by the orchestrator prompt). Each delegation is a new herdr tab in the orchestrator's workspace running a native `pi` TUI, plus a run directory under `agent/subagent-runs/`.

**Delegation is event-driven: there is deliberately no blocking wait.** The orchestrator delegates, ends its turn, and is woken by a *notice* the child types into its pane (`herdr agent prompt`) when the child reports or finishes. A blocking wait is what the module used to do, and it made mid-run messaging structurally impossible: the wait ran inside a tool call, so the parent was streaming, so a child's report could only queue as a follow-up and stayed invisible until the child was already dead. Do not reintroduce one.

**The briefing is delivered as `deliverAs: "steer"`, and that word is load-bearing.** pi's agent loop drains its two queues from different places (`pi-agent-core/dist/agent-loop.js`, measured at 0.99.2): steering at the end of *every* turn inside `while (hasMoreToolCalls || pendingMessages.length > 0)`, follow-ups only *after* that inner loop exits. So a follow-up reaches an orchestrator that is still calling tools only once it has stopped calling them — i.e. once its turn is already over. Delegating and then continuing to work (a read, a grep, another spawn) kept the loop inside the inner `while`, where the follow-up queue is never polled, so a finished child was unreachable for the rest of the turn however long it lasted. Steering cuts in at the next turn boundary, after the current tool results are in context and before the next LLM call, so it never splits a `tool_call`/`tool_result` pair. Interrupting is the intent: a subagent's answer is new information that should redirect the loop, not queue behind the work it invalidates. The idle path is untouched — `deliverAs` is only consulted while `isStreaming`.
**The briefing is delivered as `deliverAs: "steer"`, and that word is load-bearing.** pi's agent loop drains its two queues from different places (`pi-agent-core/dist/agent-loop.js`): steering at the end of *every* turn inside `while (hasMoreToolCalls || pendingMessages.length > 0)`, follow-ups only *after* that inner loop exits. So a follow-up reaches an orchestrator that is still calling tools only once it has stopped calling them — i.e. once its turn is already over. Delegating and then continuing to work (a read, a grep, another spawn) kept the loop inside the inner `while`, where the follow-up queue is never polled, so a finished child was unreachable for the rest of the turn however long it lasted. Steering cuts in at the next turn boundary, after the current tool results are in context and before the next LLM call, so it never splits a `tool_call`/`tool_result` pair. Interrupting is the intent: a subagent's answer is new information that should redirect the loop, not queue behind the work it invalidates. The idle path is untouched — `deliverAs` is only consulted while `isStreaming`. (Both the queue structure and `deliverAs` re-verified against the installed pi 1.0.0; `index.ts`'s comment still cites the 0.99.2 measurement.)
## WHERE TO LOOK

| File | Owns |
|---|---|
| `index.ts` | Tool registration; parent-side lifecycle (spawn → classify → backstop pane close) **and the `input` hook that turns an arriving notice into a coalesced briefing** |
| `lib.ts` | Pure launch contract: run ids, `buildChildArgv`, child env, report/result extraction, the skills catalogue (`discoverSkills`/`skillEntriesFromPi`/`selectSkills`/`appendSkillCatalogue`) and the ancestry guard (`parseLineage`/`formatLineage`/`lineageRejection`) — side-effect free bar the documented fs reads, unit-testable |
| `herdr.ts` | Thin CLI wrapper over the herdr 0.9.0 CLI; the measured behaviours it relies on are documented in its header |
| `rundir.ts` | The run-directory contract (paths + JSON shapes) **and the wake-notice grammar** — both span the parent/child process seam |
| `child-done.ts` | Child half of the handshake; loaded into the child with pi `-e`, writes the `<session>.exit` sidecar and sends the `report`/`done` notices |
| `lib.test.ts` | The pure parts, plus the launch seam via a stub `Launcher` (122 tests) |

## CONVENTIONS (local)

- **The contract is spelled once.** The child is launched with `-e` and imports only shared modules (`rundir.ts`, and `../lib/agents.ts` for agent definitions) — run-dir paths and JSON shapes change there, never in both halves.
- **IDs come from herdr responses, never predicted** (pane, tab, agent).
- **`herdr.ts` never throws.** Every entry point resolves a structured value; the delegation surface must not take down the session hosting it.
- **Pinned to herdr 0.9.0.** Re-verify the "measured behaviours" in `herdr.ts`'s header against the version before changing any of them.
- **Completion is two signals:** the `subagent_done` tool (injected into every child's allowlist) or a clean `agent_end`. A failed turn writes no sidecar, so the parent classifies from its absence.
- **The notice grammar lives in `rundir.ts` and is parsed strictly.** The parent *swallows* every input that matches it, so a loose pattern would eat a human's typing. Both ids are constrained (`sub-` + four hex; herdr's agent-name rule), and anything that does not match is passed through untouched.
- **A child's prompt is its definition body plus whatever `skills:` names.** pi builds `## Available Skills` for the orchestrator only, so without that key a subagent cannot know any skill exists. An agent that declares no skills gets a byte-identical prompt, which is what makes the feature safe to leave off. Discovery failing costs the catalogue, never the launch.
- **`skills:` resolves against pi's own catalogue, not just `agent/skills/`.** The `before_agent_start` hook captures `systemPromptOptions.skills` into `piSkillCatalogue` and `skillEntriesFromPi` maps it; `spawnRun` prefers that over scanning the skills dir. That is what lets an agent declare a skill from an installed package (`test-driven-development`) or a project-local `.pi/skills` at all — `selectSkills` drops unknown names by design, so before this such a declaration resolved to *nothing* with no error, and the agent merely looked like it was ignoring its skill. Taking pi's already-resolved list also means the human's resource filters (`-skills/foo`, include-lists, `autoload: false`) are honoured for free: a child can never be handed a skill the orchestrator was denied. **Do not re-read `settings.json` to rediscover this** — that is a second parser of a format pi owns, and the first draft of this feature had already drifted from pi on pinned `git:…@ref` sources and on per-skill excludes. Keyed on the *directory*, since `selectSkills` matches `dir` and frontmatter `name` may differ. `disable-model-invocation` skills are retained: pi strips those only when rendering the orchestrator prompt, and an agent that names one should get it. Scanning `agent/skills/` remains the fallback for a spawn before any turn has started.
- **Ancestry is accumulated by processes, not trusted from models.** `buildChildEnv` stamps `PI_SUBAGENT_LINEAGE` (the agent-name chain, oldest first) into the child; `lineageRejection` reads it back one process later and refuses *before* a run dir, registry entry or pane exists. Two rules, cycle first: an agent in its own ancestry is refused (so `librarian → librarian` cannot happen), then `callable_by` is honoured (so `summarizer` is the librarian's alone). An empty lineage is the human's orchestrator and may spawn anything. This replaced a numeric `MAX_DEPTH`, which had to be tuned and whose obvious value of 1 refused the orchestrator's own child; ancestry needs no constant because the roster is finite. `../lib/dotenv.ts` records the fork bomb this interlock exists to prevent.
- **A `done` notice is only a prompt to look, never the evidence.** The `.exit` sidecar on disk is what classifies a run; a notice that never lands costs promptness, not correctness — which is why every read path calls `reconcile` first.
- **The child's notice is `spawn`ed detached.** `closeOwnPane()` kills the child's process group moments later, and a delivery still attached would die with it.
- **herdr agent names are unique among *live* agents server-wide (a name frees when its agent exits or is released), so children register as `<agent>-<runId>`** (`herdrAgentName`). The bare definition name let the first live `librarian` own it and made every concurrent sibling unlaunchable with `agent_name_taken`. The *bare* name still goes in the notice grammar and `PI_SUBAGENT_AGENT` — only the herdr registration is scoped. herdr's 32-char ceiling applies to the **scoped** name, which leaves a definition name 23.
- **Validate the *scoped* name, never the definition name** (`childNameRejection`). Scoping costs 9 chars, so a 24-char definition name is legal alone and illegal once scoped — checking the bare string let that fail late, after a pane was opened.
- **A herdr refusal arrives on stderr with a non-zero exit**, not on stdout (measured, 0.9.0). `herdr()` parses the `{"error":{"code"}}` document off *either* stream; a catch branch that only reported "herdr exited 1" is what disguised `agent_name_taken` as a launch timeout for five runs. `classifyExecFailure` is pure and tested because the bug was *not looking* on the stream that carries the code.

## COMMANDS

```sh
bun test agent/extensions/subagent-herdr/lib.test.ts   # 122 tests
```

This is the repo's **only** `tsc -p` scope (`tsconfig.json` includes `lib.ts`, `herdr.ts`,
`child-done.ts`, `index.ts`), and the only dir with a `package.json` — dev-only
(`typescript`, `@types/node`); pi loads `index.ts` directly and needs none of it at
runtime. Run it from here with the local binary:

```sh
./node_modules/.bin/tsc -p tsconfig.json
```

The `@earendil-works/*` types it resolves come from `~/node_modules` (0.75.4) rather than
the running pi (1.0.0) — see the root AGENTS.md for that skew.

## ANTI-PATTERNS

- Hand-writing run-dir paths, JSON shapes, or the notice grammar in `index.ts`/`lib.ts` *and* `child-done.ts` — the drift this module was refactored to kill; `rundir.ts` exists because nothing else would have caught it.
- **Adding any form of blocking wait, poll loop, or sleep-until-done to the parent.** It re-breaks mid-run messaging for the reason described at the top of this file. Ending the turn *is* the wait.
- Widening the notice regex to be "more forgiving". It decides what the orchestrator silently eats from its own input stream; a false positive loses a user's message.
- Closing a failed pane "to tidy up" — herdr destroys scrollback when a pane closes, and the scrollback is the failure evidence.
- Treating `agent read` as JSON — it is the one herdr command that prints raw terminal text, not a JSON document.
- Registering a child under its bare agent name, or otherwise making a herdr identity that two live children could both want. Names are as unique-by-construction as pane ids.
- Flattening a herdr error code into a generic message before the fallback loop sees it. `agent_name_taken` and `invalid_agent_name` are `fatal` — retrying them across three models turns one actionable code into a fake fleet outage.
- **Switching the briefing back to `deliverAs: "followUp"` so it "waits politely" instead of cutting into the orchestrator's tool calls.** That reads as courtesy and is actually the dropped-wake bug: the follow-up queue is only polled after the inner tool-call loop exits, so the briefing is unreachable until the turn ends on its own. Politeness here means a finished subagent the orchestrator never sees.
