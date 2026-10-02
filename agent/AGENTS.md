# agent — the runtime tree pi reads: data files, their grammars, and machine state

This tier owns the **non-code** configuration: the agent and skill definitions pi
discovers, the theme, the verification base image, and the gitignored state
directories. The code that reads them lives in `extensions/` (own AGENTS.md).

## WHERE TO LOOK

| Question | Answer |
|---|---|
| Which agents exist and on what model | `agents/*.md` frontmatter — 9 today: explorer, librarian, oracle, planner, reviewer, spiker, summarizer, verifier, worker (summarizer is `callable_by: librarian` — a private helper, not a delegation target) |
| Which skills the model may auto-invoke | `skills/*/SKILL.md` — 37 local dirs; 15 carry `disable-model-invocation: true` (slash-only). Plus 15 from the `superpowers` package (see the package-skills convention below), for 52 in the catalogue |
| Why a skill dir has extra `.md` files | Progressive disclosure: `SKILL.md` is the entry point, siblings (`tests.md`, `REPORT.md`, `PATTERNS.md`) are loaded on demand |
| What a theme key may be | `themes/tokyo-night.json` `$schema` points at pi's own `theme-schema.json` in the installed bundle |
| The verifier's container contract | `docker/verify-base.Dockerfile` — four measured behaviours in its header |
| The spiker's sandbox contract | `agents/spiker.md` — Docker preferred, Apptainer needs `--containall --no-home`, scratch dir last and declared in the output's `Sandbox` field |

## CONVENTIONS

- **`agents/*.md` frontmatter is exactly seven keys**, parsed only by
  `extensions/lib/agents.ts`: `name`, `description`, `tools` (comma-separated;
  omit for all tools), `model`, `fallback_models`, `skills`, and `callable_by`.
  The multi-word keys are **snake_case** — a camelCase key silently never matches,
  which `parseAgentFile`'s tests pin for both. Body after the closing `---` is the
  child's system prompt — verbatim *except* for the skills catalogue below.
- **A subagent sees no skills unless its `skills:` key names them.** pi's
  `dynamic-prompt.ts` builds `## Available Skills` for the *orchestrator* only, so a
  child's prompt is otherwise its definition body and nothing else: a skill is
  invisible to it, including one the orchestrator just loaded. `skills: firecrawl, writing-plans`
  appends a catalogue of those skills' descriptions and paths (`skills: *` for all);
  omitting the key leaves the prompt byte-identical to what it was before the feature
  existed. The agent needs `read` or `read_skill` to open what the catalogue points at
  — without one it is told to delegate instead, since `--tools` is an allowlist and an
  undeclared reader is genuinely absent. Composed in `subagent-herdr/lib.ts`
  (`discoverSkills` → `selectSkills` → `appendSkillCatalogue`).
- **The delegation tree is bounded by ancestry, not by a depth number.**
  `PI_SUBAGENT_LINEAGE` carries the chain of agent names from the human's orchestrator
  down to the running process; the parent writes it and only the child reads it, so no
  model can forge its own ancestry. An agent already in its own lineage is refused, which
  makes `librarian → librarian` impossible by construction and ends every chain without
  tuning a constant: each generation must introduce a *new* agent, and the roster is
  finite. `lib/dotenv.ts` records a fork bomb in this repo's history; this is the
  interlock. (A numeric `MAX_DEPTH` came first and was deleted — it had to be tuned, and
  the obvious-looking 1 silently refused the orchestrator's own child.)
- **`callable_by` makes an agent a private helper.** Absent means public, which is every
  agent that predates the key. `callable_by: librarian` on `summarizer` means only the
  librarian may spawn it — so a research helper never clutters another agent's options or
  gets mistaken for a general-purpose worker. The human's orchestrator is always allowed
  (empty lineage), which is how you run a private helper by hand to debug it. Unspawnable
  agents are also filtered out of the "Available agents" list in an unknown-agent error,
  so a caller is never advertised something it cannot use.
- **A delegating agent must pass `cwd` when the child should read a *different* tree.**
  The child inherits the parent's working directory, so a librarian that cloned a library
  into `.firecrawl/src/<repo>` and then spawned the explorer *without* `cwd` gets a
  confident, correctly formatted map of the user's project instead of the dependency — a
  wrong answer that looks right. `.firecrawl/` is gitignored precisely because research
  now writes shallow clones there, not just scraped pages.
- **A spawning agent should declare `subagent_tasks` too.** Only `subagent_done` and
  `subagent_report` are auto-added to a child's allowlist. The wake briefing delivers a
  finished child's answer either way, so this is not required — but without it the agent
  cannot re-read a result, poll status, or answer a child that asked it a question.
- **A searching agent declares the FFF tool names `ffgrep`/`fffind`**, not just pi's
  built-in `grep`/`find`. `settings.json` loads `npm:@ff-labs/pi-fff` in its default
  `tools-and-ui` mode, so the FFF tools are *additional* names — and `--tools` is an
  allowlist over extension tools too, so an agent that omits them simply never sees
  them. The built-ins stay in each list as the fallback for a session where the
  extension fails to load. Do not declare `fff-multi-grep`: it is gated behind
  `PI_FFF_MULTIGREP=1` and is a dead name without it.
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
- **Some skills come from a package, and the catalogue is the union.** `settings.json`
  `packages` carries `git:github.com/obra/superpowers`, which declares its own
  `pi.skills` root; pi discovers those 15 and offers them alongside `skills/`. Three local
  skills were *retired* in favour of its versions — `tdd` → `test-driven-development`,
  and `diagnose`/`diagnosing-bugs` → `systematic-debugging` — so a reference to the
  old names is now dangling (`git log` has them if one is needed back). Where this
  repo's version is genuinely different it was kept: `code-review` does a
  fixed-point, two-axis, tracker-aware review that `requesting-code-review` does not,
  and `writing-for-agents` covers `AGENTS.md`, which `writing-skills` does not.
- **The superpowers bootstrap extension is deliberately disabled.** The package entry
  is the object form with `extensions: ["-.pi/extensions/superpowers.ts"]`, so only its
  skills load. That extension injects an `<EXTREMELY_IMPORTANT>` block on every turn
  which mandates skill invocation before any response — it fights `dynamic-prompt.ts`
  (which owns the orchestrator prompt and frames skills as advisory), pressures against
  the 15 skills that set `disable-model-invocation: true` *because* they need a human in
  the loop, and its bundled tool mapping is wrong for this config (it claims pi has no
  subagent or task-list tool; `subagent` and `todo` both exist here). Re-enabling it
  means owning all four conflicts. `pi list` prints `(filtered)` when the exclusion is
  live.
- **A subagent's catalogue comes from pi's resolved skill list, not from a directory
  scan.** `subagent-herdr`'s `before_agent_start` hook captures
  `systemPromptOptions.skills` and `skillEntriesFromPi` maps it, so `skills:` can name
  a package skill (`test-driven-development`) or a project-local one, and the human's
  resource filters are already applied upstream — a child can never be handed a skill
  the orchestrator was denied. Without this a declaration resolves to *nothing* and
  `selectSkills` drops it silently, which reads as "my agent ignores its skill".
  **Do not re-derive this from `settings.json`**: pi owns that format, and the first
  draft of this feature drifted from it on pinned `git:...@ref` sources and on per-skill
  excludes. **`agent/skills/` stays flat** regardless: the directory name is the identity
  `skills:` and `skill-activation.ts` both match on.

## ANTI-PATTERNS

- Hand-editing anything under `sessions/`, `subagent-runs/`, `verify-images/`,
  `fff/`, `npm/`, `git/`, or `pi-blackhole/`. All gitignored machine state,
  rewritten without warning — configuration never belongs there.
- Editing `docker/verify-base.Dockerfile` without building and running it. Every
  line encodes a behaviour that was a bug first (Node >= 24, `sudo` for
  `install --with-deps`, Chrome landing in root's `$HOME`, the versioned Chrome
  directory). `AGENT_BROWSER_VERSION` is pinned because the CLI is pre-1.0 and the
  image depends on install-path behaviour that is not a documented API.
- Duplicating a skill to tweak one section. The `skills/diagnose/` +
  `skills/diagnosing-bugs/` pair was exactly this, drifted, and is now gone in favour of
  the package's `systematic-debugging`. Prefer retiring one, or pointing it at the other.
- Adding a local skill that restates one the `superpowers` package already ships. Check
  the union first (`ls agent/skills` plus the package's `skills/`), and keep a local
  version only when it does something upstream's does not — the two kept exceptions above
  each name that difference.
