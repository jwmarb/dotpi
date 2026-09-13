---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round, then wait for the user's answers before the next round.

Deliver each round with the `questionnaire` tool (from the `ask-user` extension): one call per round, one `questionnaire` question per frontier question. The tool renders every question as a tabbed TUI and returns all answers before you continue, so the round discipline is enforced by the tool itself.

Map each frontier question to a `questionnaire` question like this:

- `id`: a stable slug (`scope`, `priority`, …) or `q1`, `q2`, …
- `label`: the question title, kept short — it shows in the tab bar
- `prompt`: the full question body; multiple paragraphs are fine
- `options`: the choices the question implies, 2–5 of them. Put your recommended answer **first** and mark its label `(recommended)`. If the question has no natural choice list, still give at least two options: your recommendation and the strongest alternative.
- `allowOther`: leave it `true` so the user can type their own answer.

Your recommendation lives in the options, not in prose: state it as the first option, and say why in its `description`.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round with a fresh `questionnaire` call. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

If the user cancels the questionnaire (Esc), do not assume any answers: stop, state what is still unresolved, and ask how to proceed.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

If the `questionnaire` tool is unavailable (e.g. non-interactive mode), fall back to plain-text rounds: number each question, give your recommended answer after it, and wait for the user's answers before the next round.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
