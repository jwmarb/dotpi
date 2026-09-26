# subagent-herdr — herdr-backed subagent delegation

Owns the `subagent` / `subagent_tasks` tools (advertised by the orchestrator prompt). Each delegation is a new herdr tab in the orchestrator's workspace running a native `pi` TUI, plus a run directory under `agent/subagent-runs/`.

**Delegation is event-driven: there is deliberately no blocking wait.** The orchestrator delegates, ends its turn, and is woken by a *notice* the child types into its pane (`herdr agent prompt`) when the child reports or finishes. A blocking wait is what the module used to do, and it made mid-run messaging structurally impossible: the wait ran inside a tool call, so the parent was streaming, so a child's report could only queue as a follow-up and stayed invisible until the child was already dead. Do not reintroduce one.

## WHERE TO LOOK

| File | Owns |
|---|---|
| `index.ts` | Tool registration; parent-side lifecycle (spawn → classify → backstop pane close) **and the `input` hook that turns an arriving notice into a coalesced briefing** |
| `lib.ts` | Pure launch contract: run ids, `buildChildArgv`, child env, report/result extraction — side-effect free, unit-testable |
| `herdr.ts` | Thin CLI wrapper over the herdr 0.9.0 CLI; the measured behaviours it relies on are documented in its header |
| `rundir.ts` | The run-directory contract (paths + JSON shapes) **and the wake-notice grammar** — both span the parent/child process seam |
| `child-done.ts` | Child half of the handshake; loaded into the child with pi `-e`, writes the `<session>.exit` sidecar and sends the `report`/`done` notices |
| `lib.test.ts` | The pure parts, plus the launch seam via a stub `Launcher` (76 tests) |

## CONVENTIONS (local)

- **The contract is spelled once.** The child is launched with `-e` and imports only shared modules (`rundir.ts`, and `../lib/agents.ts` for agent definitions) — run-dir paths and JSON shapes change there, never in both halves.
- **IDs come from herdr responses, never predicted** (pane, tab, agent).
- **`herdr.ts` never throws.** Every entry point resolves a structured value; the delegation surface must not take down the session hosting it.
- **Pinned to herdr 0.9.0.** Re-verify the "measured behaviours" in `herdr.ts`'s header against the version before changing any of them.
- **Completion is two signals:** the `subagent_done` tool (injected into every child's allowlist) or a clean `agent_end`. A failed turn writes no sidecar, so the parent classifies from its absence.
- **The notice grammar lives in `rundir.ts` and is parsed strictly.** The parent *swallows* every input that matches it, so a loose pattern would eat a human's typing. Both ids are constrained (`sub-` + four hex; herdr's agent-name rule), and anything that does not match is passed through untouched.
- **A `done` notice is only a prompt to look, never the evidence.** The `.exit` sidecar on disk is what classifies a run; a notice that never lands costs promptness, not correctness — which is why every read path calls `reconcile` first.
- **The child's notice is `spawn`ed detached.** `closeOwnPane()` kills the child's process group moments later, and a delivery still attached would die with it.
- **herdr agent names are unique among *live* agents server-wide (a name frees when its agent exits or is released), so children register as `<agent>-<runId>`** (`herdrAgentName`). The bare definition name let the first live `librarian` own it and made every concurrent sibling unlaunchable with `agent_name_taken`. The *bare* name still goes in the notice grammar and `PI_SUBAGENT_AGENT` — only the herdr registration is scoped. herdr's 32-char ceiling applies to the **scoped** name, which leaves a definition name 23.
- **Validate the *scoped* name, never the definition name** (`childNameRejection`). Scoping costs 9 chars, so a 24-char definition name is legal alone and illegal once scoped — checking the bare string let that fail late, after a pane was opened.
- **A herdr refusal arrives on stderr with a non-zero exit**, not on stdout (measured, 0.9.0). `herdr()` parses the `{"error":{"code"}}` document off *either* stream; a catch branch that only reported "herdr exited 1" is what disguised `agent_name_taken` as a launch timeout for five runs. `classifyExecFailure` is pure and tested because the bug was *not looking* on the stream that carries the code.

## COMMANDS

```sh
bun test agent/extensions/subagent-herdr/lib.test.ts   # 76 tests
```

(The typecheck scope is the one documented in the root AGENTS.md — run from this dir with mcp's tsc.)

## ANTI-PATTERNS

- Hand-writing run-dir paths, JSON shapes, or the notice grammar in `index.ts`/`lib.ts` *and* `child-done.ts` — the drift this module was refactored to kill; `rundir.ts` exists because nothing else would have caught it.
- **Adding any form of blocking wait, poll loop, or sleep-until-done to the parent.** It re-breaks mid-run messaging for the reason described at the top of this file. Ending the turn *is* the wait.
- Widening the notice regex to be "more forgiving". It decides what the orchestrator silently eats from its own input stream; a false positive loses a user's message.
- Closing a failed pane "to tidy up" — herdr destroys scrollback when a pane closes, and the scrollback is the failure evidence.
- Treating `agent read` as JSON — it is the one herdr command that prints raw terminal text, not a JSON document.
- Registering a child under its bare agent name, or otherwise making a herdr identity that two live children could both want. Names are as unique-by-construction as pane ids.
- Flattening a herdr error code into a generic message before the fallback loop sees it. `agent_name_taken` and `invalid_agent_name` are `fatal` — retrying them across three models turns one actionable code into a fake fleet outage.
