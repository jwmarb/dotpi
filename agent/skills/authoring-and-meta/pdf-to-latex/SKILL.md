---
name: pdf-to-latex
description: Use when converting a PDF document into LaTeX source — "convert this PDF to LaTeX", "recreate this paper/report as .tex", "re-typeset the PDF", "make a LaTeX version of this document". Assumes a vision-capable agent.
---

# PDF to LaTeX

## Overview

A PDF is a rendering, not a source. The text layer loses layout, and
figures cannot be typed. So: **interpret every page with your vision** to
rebuild the text and structure, and **treat every visual element you cannot
represent as text (graphs, charts, diagrams, photos, screenshots) as an
image to be embedded and verified by a vision-capable reviewer subagent**.

**Faithful means matching what is visible on the rendered pages** — do not
add elements you do not see (axes, legends, captions) even though the
document "should" have them. An element clipped off the page in the source
stays absent in the output.

## Prerequisites

poppler-utils (`pdfinfo`, `pdftotext`, `pdftoppm`, `pdfimages`) + TeX
distribution (`pdflatex`; `xelatex` for non-Latin). Check: `command -v
pdftoppm pdflatex`.

## Workflow

1. **Inventory.** `pdfinfo` for page count; `pdfimages -list` for embedded
   raster images (note the `page` and `type` columns; skip `smask`/`stencil`
   rows); `pdftotext -layout` for text hints. Build a per-page inventory:
   which figures sit on which pages, and the plan for each.
2. **Rasterize.** `pdftoppm -png -r 150 doc.pdf page` → one PNG per page
   (filenames zero-padded to the document's page count — `ls` before use).
   Read every page image with your vision; for long documents, work in
   batches and keep the inventory updated.
3. **Transcribe.** Document class, title, headings, paragraphs, lists,
   display and inline math, tables, footnotes — from the pages, cross-checked
   against the text layer.
4. **Visual elements.** For each figure:
   - Raster image that fills the figure exactly as rendered → extract with
     `pdfimages -p -png` (page number in the filename) and
     `\includegraphics` it.
   - Vector art, or a raster with vector overlays (axes, ticks, labels drawn
     on top — e.g. matplotlib) → **crop from a high-resolution page
     render**: `pdftoppm -png -r 300 -f N -l N -singlefile -x X -y Y -W W -H H
     doc.pdf fig` (pixels = pt × 300/72). Reconstruct in TikZ/pgfplots only
     when the geometry is clearly readable on the page.
   - Keep the caption and `\ref` cross-references pointing at the figure.
   - A figure spanning pages is one unit: review it with every page it
     appears on.
5. **Compile and render.** `pdflatex -interaction=nonstopmode -halt-on-error
   main.tex` twice (for `\ref`); `grep -i undefined main.log`; then
   `pdftoppm -png -r 150 main.pdf out`.
6. **Vision review (mandatory).** Spawn one vision-capable reviewer
   subagent per original page that contains visual elements, covering every
   figure on that page. Vision-capable means its read tool returns images as
   attachments; tell it to open both PNGs with that tool and to answer
   CANNOT VIEW IMAGES (a failed review) if it cannot. Give it the original
   page PNG and **every output page containing that page's figures** — match
   by figure number or caption, because floats and page breaks shift pages.
   Use the prompt below.
7. **Fix loop.** On MISMATCH: fix the `.tex`, recompile, re-render,
   re-review that page. After 3 rounds, stop and report the remaining
   mismatches to the user with the reviewer's evidence — do not claim done.
8. **Final check.** All rendered pages compared against the originals, no
   undefined references, and the inventory shows every figure reviewed.

## Reviewer prompt

```
You are a vision reviewer for a PDF→LaTeX conversion. Judge only from the
images, not from any text description. Open both files with your image-
reading tool; if you cannot view images, answer CANNOT VIEW IMAGES.

Original page:   <path to original page PNG>
Converted pages: <path(s) to rendered output page PNG(s) containing the figure(s)>

For each figure on the original page, check the converted version:
- shape and data trend of every curve/bar/element
- axis ranges, tick labels, axis titles (N/A for photos)
- legend entries, colors, line styles (N/A if absent in the original)
- crop bounds, completeness, orientation, legibility
- annotations and caption text (N/A if the original has none)
Report per figure: MATCH, MISMATCH, or MISSING (figure absent from the
converted pages), then one line of evidence per check.
```

## Skip-review rationalizations — reject all of them

| Excuse | Reality |
|--------|---------|
| "I already looked at the page myself" | You wrote the figure, so you are biased. The reviewer is what compares the two images. |
| "The figure is simple/obvious" | A simple plot is exactly where a guessed reconstruction silently goes wrong. |
| "20+ minutes of review is overkill" | One reviewer call is cheaper than shipping a wrong figure. |
| "The text layer extracted perfectly" | The text layer says nothing about figures. |

## When NOT to use

You already have the LaTeX source; you only want plain text (`pdftotext` is
enough); or the PDF is a form to fill in, not a document to rebuild.
