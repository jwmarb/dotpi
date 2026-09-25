# agent — the runtime tree pi reads: data files, their grammars, and machine state

This tier owns the **non-code** configuration: the agent and skill definitions pi
discovers, the theme, the verification base image, and the gitignored state
directories. The code that reads them lives in `extensions/` (own AGENTS.md).

## WHERE TO LOOK

| Question | Answer |
|---|---|
| Which agents exist and on what model | `agents/*.md` frontmatter — 8 today: explorer, librarian, oracle, planner, reviewer, spiker, verifier, worker |
| Which skills the model may auto-invoke | `skills/*/SKILL.md` — 37 dirs; 15 carry `disable-model-invocation: true` (slash-only) |
| Why a skill dir has extra `.md` files | Progressive disclosure: `SKILL.md` is the entry point, siblings (`tests.md`, `REPORT.md`, `PATTERNS.md`) are loaded on demand |
| What a theme key may be | `themes/tokyo-night.json` `$schema` points at pi's own `theme-schema.json` in the installed bundle |
| The verifier's container contract | `docker/verify-base.Dockerfile` — four measured behaviours in its header |

## CONVENTIONS

- **`agents/*.md` frontmatter is exactly five keys**, parsed only by
  `extensions/lib/agents.ts`: `name`, `description`, `tools` (comma-separated;
  omit for all tools), `model`, `fallback_models` (comma-separated, **snake_case** —
  a camelCase key silently never matches). Body after the closing `---` is the
  child's system prompt verbatim.
- **Every agent declares `fallback_models`.** They are tried when a child fails to
  *launch* (unknown model, provider down or rate-limiting), not when it fails its
  task. Read-only recon agents lead with a flash model; the expensive models sit in
  the fallback chain.
- **The `description` is the routing signal.** It is what the orchestrator sees in
  its inventory when deciding whether to delegate — write it as "use me when…",
  not as a title.
- **A read-only agent's `tools` list is its enforcement.** `oracle`, `planner`,
  `reviewer`, `explorer`, `verifier` have no `write`/`edit` by construction.
  Widening a list to unblock one task silently destroys the independence that makes
  the verdict worth anything — add a new definition instead.
- **`skills/*/agents/openai.yaml` is optional presentation** (`display_name`,
  `short_description`); 22 of 37 skills have one. Its absence changes nothing
  functional.
- **A skill that must not fire on its own sets `disable-model-invocation: true`.**
  Interview- and workflow-style skills (grilling, triage, wayfinder, handoff) all do:
  they need a human in the loop, so model-initiated invocation is a bug, not a
  feature. `argument-hint` prefills the slash-command prompt.
- **Personal-identity skills are kept on disk and untracked**, not placeholdered —
  see the `.gitignore` rationale (`skills/uarizona-hpc/` is the live example). Add a
  path to `.gitignore` rather than sanitising a file in place.

## ANTI-PATTERNS

- Hand-editing anything under `sessions/`, `subagent-runs/`, `verify-images/`,
  `fff/`, `npm/`, `git/`, or `pi-blackhole/`. All gitignored machine state,
  rewritten without warning — configuration never belongs there.
- Editing `docker/verify-base.Dockerfile` without building and running it. Every
  line encodes a behaviour that was a bug first (Node >= 24, `sudo` for
  `install --with-deps`, Chrome landing in root's `$HOME`, the versioned Chrome
  directory). `AGENT_BROWSER_VERSION` is pinned because the CLI is pre-1.0 and the
  image depends on install-path behaviour that is not a documented API.
- Duplicating a skill to tweak one section. `skills/diagnose/` and
  `skills/diagnosing-bugs/` are already a near-duplicate pair, and they now drift.
