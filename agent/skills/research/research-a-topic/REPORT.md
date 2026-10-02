# HTML Report

Build one self-contained `.html` file: inline CSS, inline JS, no network
requests at load time. It must open and render fully offline in any modern
browser.

## Layout

1. **Header** — topic, one-line summary, report date, number of sources.
2. **Key findings** — 3–5 bullets, the answers a reader should get first.
3. **Sections** — one per research question, each with its findings and a
   source list.
4. **Charts** — embedded where a section's data is numeric, comparative, or
   temporal.
5. **Sources** — full merged list: title, URL (as a link), date if known,
   and which question(s) it supports.

## Charts

- **Prefer hand-written inline SVG.** A simple bar or line chart is ~30
  lines of SVG and needs no dependencies, no build step, and works offline.
  Reserve a library for genuinely complex charts (scatter, geo, network).
- If a library is needed, use Chart.js from a CDN with an `<script>` tag,
  and put a `<noscript>` fallback table next to the chart so the data is
  never lost.
- Every chart gets: a title, axis labels with units, and a visible source
  note. Never chart data you didn't actually read from a source.
- Keep the palette to two or three colors.

## Template skeleton

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>[Topic] — Research Report</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto;
         padding: 0 1rem; line-height: 1.6; color: #1a1a1a; }
  h1 { border-bottom: 2px solid #1a1a1a; padding-bottom: .5rem; }
  .meta { color: #666; font-size: .9rem; }
  .finding { background: #f4f4f4; border-left: 4px solid #444; padding: .75rem 1rem;
             margin: .75rem 0; }
  .sources li { margin: .25rem 0; }
  svg text { font-family: system-ui, sans-serif; }
</style>
</head>
<body>
<h1>[Topic]</h1>
<p class="meta">Report date · N sources</p>
<p><strong>Summary:</strong> [one line]</p>
<h2>Key findings</h2>
<ul>
  <li class="finding">…</li>
</ul>
<h2>[Question section]</h2>
<!-- findings, chart SVG if any -->
<h2>Sources</h2>
<ol class="sources">
  <li><a href="URL">Title</a> — [date, if known] — supports: [questions]</li>
</ol>
</body>
</html>
```

## Mini bar chart (SVG)

```svg
<svg width="600" height="220" viewBox="0 0 600 220" role="img" aria-label="[chart title]">
  <!-- one rect per value; scale: max value maps to height 160, baseline y=180 -->
  <rect x="40" y="20" width="60" height="160" fill="#4472b8"/>
  <rect x="140" y="80" width="60" height="100" fill="#4472b8"/>
  <text x="70" y="200" text-anchor="middle" font-size="12">Label A</text>
  <text x="170" y="200" text-anchor="middle" font-size="12">Label B</text>
  <text x="40" y="15" font-size="12">value 100</text>
  <text x="140" y="75" font-size="12">value 63</text>
  <text x="0" y="215" font-size="11" fill="#666">Source: [source title]</text>
</svg>
```
