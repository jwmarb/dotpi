---
name: latex-study-guide
description: Write exam study material in LaTeX. Use when making a note sheet or cheat sheet (dense, one printed sheet), or a study guide (multi-page teaching document for a quiz or exam), or when adding to either.
---

# LaTeX study material

Two document types, two branches. Pick one first:

- **Note sheet**: one printed sheet, packed with fact chunks. Go to *Branch A*.
- **Study guide**: a multi-page teaching document. Go to *Branch B*.

If the project already has a sheet or guide, it is the exemplar: match its preamble, macros, and colors over the templates here. Otherwise, start from `templates/`.

Before writing, settle the **scope** (which lectures, readings, and topics the exam covers) and the **sources** (slides, papers, handouts) with the user. Every number, constant, and quote must come from those sources and be checked with grep against a text copy of them. If you cannot check a fact, drop it or tag it "(general background)". This is study support: write explanations and practice problems, and never write graded work (assignments, reports, project code).

## Branch A: note sheet

Copy `templates/note-sheet.tex`. Fill in its top comment with the exam date, the page limit, the print setting, and the scope. Keep the preamble as it is: landscape letter, 0.25in margins, Helvetica at `\fontsize{5.5}{6.15}`, and `multicols*{5}` with column rules.

- `\Hd{N. TOPIC (Author year)}` is a full-width topic bar, numbered in lecture order.
- `\hd{Label}` is a red run-in label. Its text follows on the same line. Each line is one *fact chunk*, a terse phrase with no full sentences.
- `\fg{Figure name}` is a green "Fig:" chunk. Name the axes, describe what the curves show, and say what they prove.
- `\B{}` marks the key term in a chunk. `\ra\` stands for "leads to / therefore". Use `;` between clauses. Write numbers compactly: `$R$=3--4`, `$\approx$`, `$\times$`.
- One gold box comes first. It gives the answering strategy for this exam's question types.
- Within a topic, list the core chunks first. After a blank line, add the detail chunks: worked numbers, sample-question walk-throughs, and comparisons.
- The last topic is `\Hd{N. COMMON TRAPS}`, with one `\hd{}` per topic: the mistake and the correct version.
- Small tables use `tabular` with `p{}` columns at `\tiny`. A small TikZ diagram is fine.
- If it runs long, cut the least-tested chunks. Changing the font size or the margins is a last resort, and only if the user agrees.

Done when: `latexmk -pdf <file>.tex` exits 0, `pdfinfo <file>.pdf` shows no more pages than the limit (2 for a double-sided sheet), and grepping the `.log` for `Overfull|^! ` prints nothing.

## Branch B: study guide

Copy `templates/guide.tex`, `templates/preamble.tex`, and `templates/chapters/01-topic.tex` into one folder. In `preamble.tex`, set the `primary` and `accent` colors (for example, the school's colors), and add any TikZ styles the subject needs. After that, `preamble.tex` is a fixed API: chapters use only what it defines.

- **Top-level file**: fill in the title page, including a short `minipage` that says what the exam covers and what the guide builds up. Add one `\input{chapters/NN-<stem>}` per chapter.
- **Each chapter**: open with `\chapter{...}\label{ch:<stem>}` and a `glance` box (`\glanceitem{Problem}`, `\glanceitem{Big ideas}`). Teach with `\section`s. Explain *why* a mechanism exists before *how* it works. Use the boxes from `preamble.tex`:
  - `definition` for a term,
  - `keyidea` for the core insight,
  - `example` for numbers worked by hand,
  - `pitfall` for a common mistake,
  - `examtip` where it fits,
  - `reading` for a paper (Problem / Approach / Results / Limitations).
  
  End each chapter with a `selfcheck` and `answers` pair, one answer per question, in the same order.
- **Running example**: put every worked example on one concrete scenario that runs through the whole guide.
- **Closing chapters**: near the end, add an end-to-end walkthrough chapter. Then add a `Problem Bank` chapter with short-answer, computation, and scenario sections; continue the question numbering with `\setcounter{enumi}{N}`. Finish with a one-page reference appendix.
- **Conventions**:
  - Tables are `booktabs` `tabularx` with `@{}…@{}`, and any cell with prose goes in an `X` column.
  - Identifiers go in `\code{}`, and a term's first use goes in `\term{}`.
  - Cross-reference with `\cref{ch:...}` instead of restating another chapter.
- **LaTeX gotchas**:
  - Write `\%` for every percent sign.
  - Escape `_ # & $` in text.
  - Use `[H]` floats.
  - Never name a TikZ style `step`.
  - Brace computed coordinates.
  - Reword any line that goes overfull because of a long `\code{}` token.

Done when: `latexmk -pdf guide.tex` exits 0, grepping the `.log` for `Overfull|^! |Missing character` prints nothing, every chapter file is `\input`, and every `selfcheck` has a matching `answers` list.
