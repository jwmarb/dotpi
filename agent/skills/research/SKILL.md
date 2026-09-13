---
name: research
description: Research a topic with parallel subagents and cited sources, producing an optional self-contained HTML report with visualizations. Use when the user wants to research, investigate, or get a deep dive / briefing / report on a topic. Skip for one-line factual lookups.
---

# Research

Run a small research pipeline: frame the topic into questions, farm out each
question to a parallel subagent, synthesize the findings, and report back —
with an HTML report containing charts whenever the data supports it.

## Steps

1. **Frame the topic.** Restate the topic in one line, then decompose it into
   3–6 **questions** — each independently answerable from 2–4 sources.
   Skip this step if the user already supplies the questions.

2. **Fan out to subagents.** Call `delegate_task` once per question, all in a
   single message so they run in parallel. Each task reads:

   > Research question: "<question>". Context: the overall topic is "<topic>".
   > Use search_web, then fetch_url on the 2–4 best sources. Return: (a) a
   > direct answer, (b) 3–6 key findings each backed by a specific source,
   > (c) the source list as title + URL, (d) anything you found that
   > contradicts or weakens the answer.
   > **Done when:** every question has a result with at least one fetched
   > source, or an explicit gap note — not a bare "couldn't find anything".

3. **Synthesize.** Write the report: an executive summary, one section per
   question, and a merged source list. Where subagents' answers conflict,
   say so and state which source is stronger (primary over secondary, more
   recent over older) instead of averaging them away.

4. **Build the HTML report** if the findings are quantitative, comparative,
   or trend-based. Otherwise skip to step 5 and say why no report. Follow the
   template and chart rules in `REPORT.md`. Write the file to
   `~/reports/<topic-slug>.html` (create the directory if it does not exist).

5. **Deliver.** Send the executive summary and highlights in chat, then call
   `display_file` on the HTML report so it opens in the user's browser. If
   no report was built, deliver the full report in chat with its source list.

## Failure modes

- **Thin results** — rephrase or broaden the question and retry once. If
  still thin, mark the question as an open gap in the report.
- **Subagent failure** — retry once, then fold that question into the
  synthesis and answer it directly from a couple of sources.
- **Conflicting sources** — surface the conflict; do not pick the smoother
  story.
- **Nothing visualizable** — a report with zero charts is still useful;
  tables and the source list carry it.
