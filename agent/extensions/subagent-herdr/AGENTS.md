# subagent-herdr — herdr-backed subagent delegation

Owns the `subagent` / `subagent_tasks` tools (advertised by the orchestrator prompt). Each delegation is a new herdr tab in the orchestrator's workspace running a native `pi` TUI, plus a run directory under `agent/subagent-runs/`.

## WHERE TO LOOK

| File | Owns |
|---|---|
| `index.ts` | Tool registration; parent-side lifecycle (spawn → wait → classify → backstop pane close) |
| `lib.ts` | Pure launch contract: run ids, `buildChildArgv`, child env, report/result extraction — side-effect free, unit-testable |
| `herdr.ts` | Thin CLI wrapper over the herdr 0.9.0 CLI; the measured behaviours it relies on are documented in its header |
| `rundir.ts` | The run-directory contract (paths + JSON shapes) — spans the parent/child process seam |
| `child-done.ts` | Child half of the completion handshake; loaded into the child with pi `-e`, writes the `<session>.exit` sidecar |
| `lib.test.ts` | The pure parts (41 tests) |

## CONVENTIONS (local)

- **The contract is spelled once.** The child is launched with `-e` and imports only shared modules (`rundir.ts`, and `../lib/agents.ts` for agent definitions) — run-dir paths and JSON shapes change there, never in both halves.
- **IDs come from herdr responses, never predicted** (pane, tab, agent).
- **`herdr.ts` never throws.** Every entry point resolves a structured value; the delegation surface must not take down the session hosting it.
- **Pinned to herdr 0.9.0.** Re-verify the "measured behaviours" in `herdr.ts`'s header against the version before changing any of them.
- **Completion is two signals:** the `subagent_done` tool (injected into every child's allowlist) or a clean `agent_end`. A failed turn writes no sidecar, so the parent classifies from its absence.

## COMMANDS

```sh
bun test agent/extensions/subagent-herdr/lib.test.ts   # 41 tests
```

(The typecheck scope is the one documented in the root AGENTS.md — run from this dir with mcp's tsc.)

## ANTI-PATTERNS

- Hand-writing run-dir paths or JSON shapes in `index.ts`/`lib.ts` *and* `child-done.ts` — the drift this module was refactored to kill; `rundir.ts` exists because nothing else would have caught it.
- Closing a failed pane "to tidy up" — herdr destroys scrollback when a pane closes, and the scrollback is the failure evidence.
- Treating `agent read` as JSON — it is the one herdr command that prints raw terminal text, not a JSON document.
