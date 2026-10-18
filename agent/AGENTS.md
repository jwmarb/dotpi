# agent — the runtime tree pi reads: data files, their grammars, and machine state

This tier owns the **non-code** configuration: the agent and skill definitions pi
discovers, the theme, the verification base image, and the gitignored state
directories. The code that reads them lives in `extensions/` (own AGENTS.md); the
delegation *mechanism* behind the `skills:`/`callable_by` keys is documented in
`extensions/subagent-herdr/AGENTS.md`.

## WHERE TO LOOK

| Question | Answer |
|---|---|
| Which agents exist, on what model | `agents/*.md` frontmatter — the directory is the list: explorer, librarian, oracle, planner, reviewer, spiker, summarizer, verifier, worker, healthcheck |
| Which skills the model may auto-invoke | `skills/<category>/<skill>/SKILL.md`, minus the slash-only ones (`disable-model-invocation: true`), plus whatever the `superpowers` package contributes. Derive it — `find agent/skills -name SKILL.md` for the local set, `grep -rl 'disable-model-invocation: true' agent/skills` for the slash-only ones — rather than trusting a count written here |
| Why a skill dir has extra `.md` files | Progressive disclosure: `SKILL.md` is the entry point, siblings (`tests.md`, `REPORT.md`) load on demand |
| Which skill ships its own tool / agents | `technical-analysis` alone declares `tools:` (`trade_journal`); `automate-browser` declares the unrelated `allowed-tools:` (a Bash allowlist) plus `hidden: true`; many skills have an `agents/` dir but only `technical-analysis` defines real agents there — the rest hold `openai.yaml` alone. The live answer: `find agent/skills -path '*/agents/*.md'` |
| What a theme key may be | `themes/tokyo-night.json` `$schema` → pi's own `theme-schema.json` in the installed bundle |
| The verifier's container contract | `docker/verify-base.Dockerfile` — four measured behaviours in its header, `AGENT_BROWSER_VERSION` pinned at 0.38.1 |
| The spiker's sandbox contract | `agents/spiker.md` — Docker preferred, Apptainer needs `--containall --no-home` |
| Which builtins are on/off | `settings.json` `extensions` — one `+builtin:`/`-builtin:` entry each; currently `mcp` and `codemode` enabled, `llama.cpp` and `tool-search` disabled |
| Why a skill's `agents/` yields nothing | It holds `openai.yaml` alone — which is why discovery gates on `agents/*.md`, not on the directory existing. `technical-analysis` is currently the only skill whose `agents/` holds real `*.md` definitions (and the only one with no `openai.yaml`); derive it with `find agent/skills -path '*/agents/*.md'` rather than trusting a count |
| This tier's own build/test commands | There are none — it is data, not code. Every command lives at the repo root (`scripts/check.sh`); the suites that assert *this* tier's grammars live in `extensions/lib/` — `agents.test.ts` for the frontmatter, and `skill-catalogue.test.ts`, which walks the **live** `skills/` tree rather than a fixture |

## CONVENTIONS

- **`agents/*.md` frontmatter draws on a seven-key vocabulary**, parsed only by
  `extensions/lib/agents.ts`: `name`, `description`, `tools` (comma-separated; omit for
  all), `model`, `fallback_models`, and the two optional keys `skills` and `callable_by`.
  Only `name` is strictly required by the parser, but every file in `agents/` (and every
  skill-shipped agent) declares `callable_by` — see the delegation-graph bullet below. Multi-word keys are
  **snake_case** — a camelCase key silently never matches, which `parseAgentFile`'s tests
  pin both ways. Body after the closing `---` is the child's system prompt, verbatim
  except for the appended skills catalogue.
- **`description` is the routing signal**, not a title: it is what the orchestrator reads
  when deciding whether to delegate. Write it as "use me when…".
- **A read-only agent's `tools` list is its enforcement.** `oracle`, `planner`,
  `reviewer`, `explorer`, `verifier` have no `write`/`edit` by construction. Widening one
  to unblock a task destroys the independence that makes its verdict worth anything — add
  a new definition instead.
- **Whoever implements, grades afterwards — and never grades itself.** `worker` ends every
  run by delegating a quality pass to `reviewer` (always) and `verifier` (when the change is
  runtime-testable), then fixes every Critical and in-scope Warning before reporting; the
  orchestrator does the same for code *it* edited directly, via the `## Quality Pass` section
  `extensions/dynamic-prompt.ts` gates on those agents existing. Only `worker` and `spiker`
  can write at all, so no other definition needs this. `spiker` is deliberately excluded: it
  may not touch the user's project, so there is nothing of the project's to grade. The
  ancestry guard is what keeps this from recursing — `lineageRejection` refuses an agent
  already in its own chain, so neither a `worker` nor a grader can spawn a second `worker`.
- **A subagent sees no skills unless its `skills:` key names them.** `dynamic-prompt.ts`
  builds `## Available Skills` for the *orchestrator* only, so a child's prompt is
  otherwise its body and nothing else — a skill is invisible to it, including one the
  orchestrator just loaded. Omitting the key leaves the prompt byte-identical to
  pre-feature, which is what makes it safe to leave off. The agent also needs `read` or
  `read_skill` to open what the catalogue points at: `tools` is an allowlist, so an
  undeclared reader is genuinely absent. A declaration may name a **package** skill
  (`test-driven-development`), because resolution goes through pi's catalogue rather than
  a scan of `skills/`. The skill's **directory name** is the identity both `skills:` and
  `skill-activation.ts` match on, which is why a skill may be filed under a category
  (`skills/finance/technical-analysis/`) without any declaration changing: the category is
  in the path, the identity is the leaf. Finding a skill in that tree belongs to
  `extensions/lib/skill-tree.ts` alone — three readers once each did their own one-level
  `readdir`, and nesting broke all three *silently*.
- **`callable_by` declares the delegation graph; nothing is public by default.** Grammar:
  a comma list of agent names (who may spawn it as their *direct* child), plus two
  sentinels — `orchestrator` (the human's orchestrator, i.e. the empty lineage; always
  allowed, so writing it is documentation) and `any` (public: every agent may spawn it).
  **Absent means orchestrator-only.** Every file declares the key anyway. The current graph,
  each edge backed by a `subagent(agent: …)` instruction in the caller's body:
  `worker → reviewer, verifier, librarian`; `reviewer, verifier, spiker, oracle → librarian`;
  `librarian → summarizer, spiker, explorer`; everything else (`oracle`, `planner`,
  `healthcheck`, `worker`, the `technical-analysis` journal agents) is orchestrator-only.
  No agent uses `any` today. Adding an edge means editing the callee's `callable_by`,
  the caller's prompt body, and the `EXPECTED` table in `subagent-herdr/lib.test.ts`
  ("the fleet delegation graph"), which fails on drift. Enforcement is `lineageRejection`
  in `extensions/lib/agents.ts` (cycle first, then `callable_by`); the same rule is applied
  once, in `delegationRoster` (same file), whose `.spawnable` is both the `## Available Agents`
  roster `dynamic-prompt.ts` shows each process (read from its `PI_SUBAGENT_LINEAGE`) and the
  "Available agents" error list — so what an agent is told it can delegate to is exactly what it can. A subagent's prompt also omits the orchestrator-voiced Plan/Quality Pass sections (`isSubagent`); `worker.md` carries its own. The one non-model spawn — a health check — bypasses `callable_by` (not the cycle rule) via `{ system: true }`. No
  depth bound beyond that: the cycle rule plus a finite roster terminates every chain.
- **Every agent declares `fallback_models`** (all 10 do), and the list feeds the **router**.
  `childFallbackChain` in `extensions/subagent-herdr/lib.ts` builds a non-empty deduped
  canonical chain from the agent's `model` and `fallback_models`; that chain crosses as
  `PI_FALLBACK_CHAIN` and the child always launches on `fallback/auto`. A provider error
  *mid-task* moves work to the next model instead of re-asking the one that just failed —
  then hands the following request back to the primary. So the order matters: a chain whose
  later entries are unreachable degrades a running child. An explicit `model` on the
  delegation call yields a **singleton chain** (the caller's pin is preserved, agent-file
  fallbacks are suppressed). See `extensions/model-fallback/AGENTS.md`. Recon
  agents lead with a cheap model and keep the expensive ones in the chain — `explorer` and
  `librarian` on `occamy-1.0`, `summarizer` on `openai/gpt-5.6-terra`. A model reference here
  must exist on the gateway: an unreachable primary costs a launch attempt per run, and an
  unreachable *tail* degrades a running child, so verify against
  `/model_group/info` rather than by eye.
- **A chain entry may pin its thinking level: `ref|level`.** `model:` and each
  `fallback_models:` entry accept `openai/gpt-5.6-sol|high` — the seven case-sensitive
  levels `off|minimal|low|medium|high|xhigh|max`. The pin overrides the session's
  selected level for the requests that entry answers, and it is applied only by the
  child's `fallback/auto` router. **Any non-empty chain is valid** — the router registers
  for every non-empty `PI_FALLBACK_CHAIN`, including a single unpinned entry, because the
  child always launches on `fallback/auto` and needs at least one resolvable entry.
  An unpinned entry passes the selection through, so today's files (bare refs)
  behave exactly as before. The item grammar is owned by
  `extensions/model-fallback/lib.ts` (`parseChainItem`/`formatChainItem`);
  `agents.ts` keeps the value verbatim, and `PI_FALLBACK_CHAIN` carries the same
  `ref|level` text to the child. An explicit `model` on the delegation call
  yields a singleton chain with its pin preserved. Invalid levels drop the pin, keep the model.
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
- **`healthcheck` is the only agent that is not model-delegated.** It is spawned programmatically by `subagent-herdr` (via the release ledger's `requestHealthCheck`) when a child stalls or ends without a readable answer. Its `tools` allowlist is read-only (`read bash ffgrep fffind grep find ls`) and it deliberately omits `subagent` and `subagent_tasks`, which is what prevents recursive health checks at the schema level in addition to the `target.agent === "healthcheck"` guard in `requestHealthCheck` (`release-ledger.ts`). Its absence from the orchestrator's `Available Agents` table when `hasSubagent` is false is the same gate as every other agent.
- **An agent's final answer must be visible assistant text, and saying `<result>` in its
  prompt makes that a contract the runtime enforces.** `subagent-herdr` reads each run's
  own `system-prompt.md`: mention `<result>` and the child may not complete until it has
  written a complete `<result>…</result>` element as a normal message, while an agent whose
  prompt never mentions it (the three `technical-analysis` journal agents) completes on any
  non-empty visible text. Both ends use the one predicate in
  `extensions/subagent-herdr/rundir.ts`. Two consequences when writing an agent: **an answer
  composed only in reasoning does not count** (the orchestrator never sees thinking), and
  **an answer passed to `subagent_done` as an argument does not count** (the tool takes
  none and discards them) — those two mistakes cost 9 of the 37 recorded `explorer` runs,
  and 5 of the 64 `librarian` ones, their entire report. Writing a `<result>` *example* in a prompt is enough
  to switch the strict rule on, so put illustrative tags in prose or fences deliberately.
- **`skills/<category>/<skill>/agents/openai.yaml` is optional presentation**
  (`display_name`, `short_description`); most skills have one and its absence changes nothing
  functional. An `agents/` directory holding only this file defines **no agents** — which is
  why discovery gates on `agents/*.md`, not on the directory existing.
- **Interview-, workflow- and teaching-style skills set `disable-model-invocation: true`**
  (15 of them: `compact-session-for-handoff`, `explain-bigger-picture`, `implement-from-spec`,
  `improve-codebase-architecture`, `interview-my-plan`, `interview-plan-with-docs`,
  `repitch-last-message`, `setup-engineering-skills`, `teach-concept`, `to-questionnaire`,
  `to-spec`, `to-tickets`, `triage`, `wayfinder`, `which-skill-fits`): they need a
  human in the loop, so model-initiated
  invocation is a bug. `argument-hint` prefills the slash prompt.
- **Personal-identity skills stay on disk and untracked**, not placeholdered —
  a gitignored skill directory under its category is the pattern (one is on disk
  a gitignored skill directory under its category is the pattern (none is on disk
  right now — the pattern stands, the instance does not). Add a `.gitignore` path rather than sanitising in place.
- **The superpowers bootstrap extension is deliberately disabled.** Its package entry is
  the object form with `extensions: ["-.pi/extensions/superpowers.ts"]`, so only the 15
  skills load. That extension injects an `<EXTREMELY_IMPORTANT>` block every turn
  mandating skill invocation before any response. `dynamic-prompt.ts` now pushes hard
  toward skills itself — the catalogue carries descriptions again and is framed as the
  default opening move, with a skip allowed only if it is named — so the *stance* no
  longer conflicts. What still does is the degree and the detail: a hard every-turn
  mandate pressures the 15 skills that are slash-only *because* they need a human, and
  its bundled tool mapping is wrong here (it claims pi has no subagent or task-list tool;
  `subagent` and `todo` both exist). Re-enabling means owning those two conflicts and
  accepting a second, louder voice on a question this repo's own prompt already answers.
  `pi list` prints `(filtered)` while the exclusion is live.
- **Three local skills were retired in favour of the package's** — `tdd` →
  `test-driven-development`, `diagnose`/`diagnosing-bugs` → `systematic-debugging` — so
  those names are now dangling (`git log` has them). Two were kept because they differ:
  `code-review` is fixed-point, two-axis and tracker-aware where `requesting-code-review`
  is not, and `writing-for-agents` covers `AGENTS.md`, which `writing-skills` does not.
- **15 local skills were renamed when the library was categorized.** The reason at the
  time was that the prompt had been reduced to bare *names*, so a name like `wait-what`
  or `ask-matt` was no signal at all. The prompt carries descriptions again, which means
  the names no longer have to do that job alone — but they still lead every catalogue
  line and are what a `/skill:` invocation types, so the verb-phrase convention stands.
  The old names are gone rather than aliased; the was/now
  table lives in `skills/dialogue-and-handoff/which-skill-fits/SKILL.md`, the skill whose
  job is answering "which skill was that?". The `firecrawl` and `agent-browser` **CLI
  binaries** keep their names — only the skills documenting them moved.

## ANTI-PATTERNS

- Hand-editing anything under `sessions/`, `subagent-runs/`, `verify-images/`, `fff/`,
  `npm/`, `git/`, `pi-blackhole/`, or the loose state files beside them (`auth.json`,
  `models-store.json`, `mcp-auth.json`, `run-history.jsonl`, `settings.json.bak`, the
  `*.log`s). All gitignored, rewritten without warning — configuration never lives there.
  **Sole exception:** `pi-blackhole/pi-blackhole-config.json` *is* hand-edited tracked
  configuration (the only non-ignored file in `pi-blackhole/`). Edit it directly or via
  `/blackhole settings`; note that a modal save rewrites the file, so keep it valid JSON.
- Following `git/github.com/obra/superpowers/AGENTS.md`. That is the vendored package's
  own contributor guide; its rules govern *its* repo, not this one.
- Editing `docker/verify-base.Dockerfile` without building and running it. Every line
  encodes a behaviour that was a bug first (Node >= 24, `sudo` for `install --with-deps`,
  Chrome landing in root's `$HOME`, the versioned Chrome directory).
- Duplicating a skill to tweak one section. The `diagnose/` + `diagnosing-bugs/` pair was
  exactly this, drifted, and is gone. Retire one, or point it at the other.
- Adding a local skill that restates one `superpowers` ships. Check the union first, and
  keep a local version only when it does something upstream's does not.
