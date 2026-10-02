# agent — the runtime tree pi reads: data files, their grammars, and machine state

This tier owns the **non-code** configuration: the agent and skill definitions pi
discovers, the theme, the verification base image, and the gitignored state
directories. The code that reads them lives in `extensions/` (own AGENTS.md); the
delegation *mechanism* behind the `skills:`/`callable_by` keys is documented in
`extensions/subagent-herdr/AGENTS.md`.

## WHERE TO LOOK

| Question | Answer |
|---|---|
| Which agents exist, on what model | `agents/*.md` frontmatter — 9: explorer, librarian, oracle, planner, reviewer, spiker, summarizer, verifier, worker |
| Which skills the model may auto-invoke | `skills/*/SKILL.md` — 37 local dirs, 15 slash-only (`disable-model-invocation: true`); plus 15 from the `superpowers` package, so the catalogue reads 52 |
| Why a skill dir has extra `.md` files | Progressive disclosure: `SKILL.md` is the entry point, siblings (`tests.md`, `REPORT.md`) load on demand |
| Which skill ships its own tool / agents | `technical-analysis` alone declares `tools:` (`trade_journal`); 24 skills ship `skills/<skill>/agents/` |
| What a theme key may be | `themes/tokyo-night.json` `$schema` → pi's own `theme-schema.json` in the installed bundle |
| The verifier's container contract | `docker/verify-base.Dockerfile` — four measured behaviours in its header, `AGENT_BROWSER_VERSION` pinned at 0.38.1 |
| The spiker's sandbox contract | `agents/spiker.md` — Docker preferred, Apptainer needs `--containall --no-home` |

## CONVENTIONS

- **`agents/*.md` frontmatter is exactly seven keys**, parsed only by
  `extensions/lib/agents.ts`: `name`, `description`, `tools` (comma-separated; omit for
  all), `model`, `fallback_models`, `skills`, `callable_by`. Multi-word keys are
  **snake_case** — a camelCase key silently never matches, which `parseAgentFile`'s tests
  pin both ways. Body after the closing `---` is the child's system prompt, verbatim
  except for the appended skills catalogue.
- **`description` is the routing signal**, not a title: it is what the orchestrator reads
  when deciding whether to delegate. Write it as "use me when…".
- **A read-only agent's `tools` list is its enforcement.** `oracle`, `planner`,
  `reviewer`, `explorer`, `verifier` have no `write`/`edit` by construction. Widening one
  to unblock a task destroys the independence that makes its verdict worth anything — add
  a new definition instead.
- **A subagent sees no skills unless its `skills:` key names them.** `dynamic-prompt.ts`
  builds `## Available Skills` for the *orchestrator* only, so a child's prompt is
  otherwise its body and nothing else — a skill is invisible to it, including one the
  orchestrator just loaded. Omitting the key leaves the prompt byte-identical to
  pre-feature, which is what makes it safe to leave off. The agent also needs `read` or
  `read_skill` to open what the catalogue points at: `tools` is an allowlist, so an
  undeclared reader is genuinely absent. A declaration may name a **package** skill
  (`test-driven-development`), because resolution goes through pi's catalogue rather than
  a scan of `skills/` — which is also why `skills/` must stay **flat**: the directory name
  is the identity both `skills:` and `skill-activation.ts` match on.
- **`callable_by` makes an agent a private helper.** Absent means public. `callable_by:
  librarian` on `summarizer` means only the librarian may spawn it; the human's
  orchestrator is always allowed, which is how you debug one by hand. Unspawnable agents
  are filtered out of the "Available agents" error list too, so a caller is never
  advertised what it cannot use.
- **Every agent declares `fallback_models`** (all 9 do). They cover a failure to
  *launch* — unknown model, provider down or rate-limiting — not a failed task. Recon
  agents lead with a flash model and keep the expensive ones in the chain.
- **A searching agent declares `ffgrep`/`fffind`**, not just `grep`/`find`.
  `npm:@ff-labs/pi-fff` adds those as *extra* names and `tools` is an allowlist, so
  omitting them means never seeing them; the built-ins stay as the fallback for a session
  where the extension fails to load. Never declare `fff-multi-grep` — it is gated behind
  `PI_FFF_MULTIGREP=1` and dead without it.
- **A spawning agent should declare `subagent_tasks`.** Only `subagent_done` and
  `subagent_report` are auto-added. The wake briefing arrives either way, but without it
  the agent cannot re-read a result, poll status, or answer a child's question. Such an
  agent's prompt must also tell it to pass `cwd` when the grandchild should read a
  *different* tree: the librarian that clones into `.firecrawl/src/<repo>` and then spawns
  the explorer without `cwd` gets a confident, well-formatted map of the user's project
  instead of the dependency — a wrong answer that looks right.
- **`skills/*/agents/openai.yaml` is optional presentation** (`display_name`,
  `short_description`); 23 of 37 have one and its absence changes nothing functional.
- **Interview- and workflow-style skills set `disable-model-invocation: true`** (grilling,
  triage, wayfinder, handoff): they need a human in the loop, so model-initiated
  invocation is a bug. `argument-hint` prefills the slash prompt.
- **Personal-identity skills stay on disk and untracked**, not placeholdered —
  `skills/uarizona-hpc/` is the live example. Add a `.gitignore` path rather than
  sanitising in place.
- **The superpowers bootstrap extension is deliberately disabled.** Its package entry is
  the object form with `extensions: ["-.pi/extensions/superpowers.ts"]`, so only the 15
  skills load. That extension injects an `<EXTREMELY_IMPORTANT>` block every turn
  mandating skill invocation before any response: it fights `dynamic-prompt.ts` (which
  owns the orchestrator prompt and frames skills as advisory), pressures the 15 skills
  that are slash-only *because* they need a human, and its bundled tool mapping is wrong
  here (it claims pi has no subagent or task-list tool; `subagent` and `todo` both exist).
  Re-enabling means owning all four conflicts. `pi list` prints `(filtered)` while the
  exclusion is live.
- **Three local skills were retired in favour of the package's** — `tdd` →
  `test-driven-development`, `diagnose`/`diagnosing-bugs` → `systematic-debugging` — so
  those names are now dangling (`git log` has them). Two were kept because they differ:
  `code-review` is fixed-point, two-axis and tracker-aware where `requesting-code-review`
  is not, and `writing-for-agents` covers `AGENTS.md`, which `writing-skills` does not.

## ANTI-PATTERNS

- Hand-editing anything under `sessions/`, `subagent-runs/`, `verify-images/`, `fff/`,
  `npm/`, `git/`, `pi-blackhole/`, or the loose state files beside them (`auth.json`,
  `models-store.json`, `mcp-auth.json`, `run-history.jsonl`, `settings.json.bak`, the
  `*.log`s). All gitignored, rewritten without warning — configuration never lives there.
- Following `git/github.com/obra/superpowers/AGENTS.md`. That is the vendored package's
  own contributor guide; its rules govern *its* repo, not this one.
- Editing `docker/verify-base.Dockerfile` without building and running it. Every line
  encodes a behaviour that was a bug first (Node >= 24, `sudo` for `install --with-deps`,
  Chrome landing in root's `$HOME`, the versioned Chrome directory).
- Duplicating a skill to tweak one section. The `diagnose/` + `diagnosing-bugs/` pair was
  exactly this, drifted, and is gone. Retire one, or point it at the other.
- Adding a local skill that restates one `superpowers` ships. Check the union first, and
  keep a local version only when it does something upstream's does not.
