---
name: firecrawl
description: "Self-hosted Firecrawl through the `firecrawl` CLI: read a page as markdown, search the web, list a site's URLs, bulk-extract a section, parse a local file. Use when the user mentions firecrawl, scraping, crawling, or wants web pages fetched as clean markdown for research, and when a firecrawl command returns empty, null, or a 500 and you need to know whether this instance supports that feature at all."
---

# Firecrawl (self-hosted)

The `firecrawl` CLI pointed at a **self-hosted** instance. `FIRECRAWL_API_URL` is already in the
environment (set by `agent/extensions/firecrawl-cli.ts`), so pass no `--api-url` and set no API
key: a non-default URL makes the CLI skip key validation entirely.

This instance runs the open-source stack: Fetch + Playwright, no fire-engine, no model provider.
That removes whole features the upstream cloud skills assume. The capability list lives in
[CAPABILITIES.md](CAPABILITIES.md) — read it when a command fails, when the user asks why a
feature is missing, or before promising a capability.

Two environment facts override the CLI's own output:

- `firecrawl --status` prints **"Not authenticated"**. That is correct and irrelevant — this
  instance needs no credentials. Ignore it as a health signal.
- `firecrawl credit-usage` 500s. There is no credit model here. Nothing you run costs credits,
  so never budget, check, or report credits.

## Hollow results

A **hollow** result is the defining hazard of this instance: the command exits 0, prints no
error, and hands back content that is empty or quietly wrong. Cloud-only features degrade this
way instead of failing loudly, so exit status proves nothing. Verify the payload, every time.

The four hollow cases, all confirmed on this instance:

| Command | Hollow behaviour | Do this instead |
| --- | --- | --- |
| `scrape --query "..."` | Returns the page, never an answer. Sets `warning: "Query generation failed after all models."` | `scrape` to a file, then `grep`/`head` it |
| `scrape --format screenshot` | HTTP 200 with `screenshot: null` | Treat screenshots as unavailable |
| `search --sources images` or `news` | Returns ordinary web results under `data.web` | Ask for web results and say so |
| `map --search "term"` | Filter ignored; byte-identical to an unfiltered run | `map`, then filter with `grep` |

Check the `warning` field whenever output looks thin:

```bash
firecrawl scrape "<url>" --json | jq -r '.warning // "none"'
```

**A hollow result is a fact about this instance, never a fact about the page or the world.**
Report it as an instance limit and name the limit.

## Commands

Pass `--sources web` on **every** search. The default sources include `alexandria`, a cloud-only
index, and without the flag every search dies with *"Alexandria requires a Firecrawl API key."*
That error means the flag is missing — not that the topic has no results.

```bash
# Find pages.
firecrawl search "<query>" --sources web --limit 5

# Find pages AND get their full text in one call. Preferred for research:
# one round trip, and the markdown lands in data.web[].markdown.
firecrawl search "<query>" --sources web --limit 3 --scrape --json -o .firecrawl/s.json

# Read one page. This is the evidence step.
firecrawl scrape "<url>" --format markdown -o .firecrawl/page.md

# Read the main content only, dropping nav and footer.
firecrawl scrape "<url>" --only-main-content -o .firecrawl/page.md

# List a site's URLs when you know the site but not the page.
firecrawl map "<url>" --limit 200

# Bulk-extract a section. Scope it with --include-paths.
firecrawl crawl "<url>" --include-paths /docs --limit 25 --wait > .firecrawl/crawl.json

# Parse a local file (PDF, DOCX, XLSX, HTML). Takes an upload, not a URL.
firecrawl parse ./report.pdf
```

Quote every URL — the shell eats `?` and `&`. Run `firecrawl <command> --help` for options rather
than guessing; this file deliberately does not restate them.

**`crawl` writes raw JSON to stdout and supports neither `--json` nor `-o`.** Redirect it to a
file (`> file.json`) or it floods the context. Then read it with `jq`:

```bash
jq -r '.status, (.data | length)' .firecrawl/crawl.json
jq -r '.data[].metadata.sourceURL' .firecrawl/crawl.json
```

## Workflow

Escalate only as far as the question requires.

1. **Have a URL?** `scrape` it. Static pages and JS-rendered SPAs both work — Playwright is in
   the default stack. Done when the markdown is saved and read.
2. **No URL?** `search --sources web --scrape`, which fetches the pages in the same call. Reuse
   that markdown rather than re-scraping the same URLs. Done when every result you intend to
   cite has been read, not just its snippet.
3. **Know the site, not the page?** `map`, `grep` the URL list, then `scrape` the hit. Done when
   the chosen URL is scraped.
4. **Need a whole section?** `crawl --include-paths <section> --limit <n> --wait`, redirected to a
   file. Done when `.status` is `completed` and `.data` holds the expected page count.

**Snippets are leads; scraped text is evidence.** Cite only what you read in a fetched page.

Blocked by anti-bot (`SCRAPE_ALL_ENGINES_FAILED`)? That needs fire-engine, which this instance
does not have. Say the page is unreachable from this instance and move to another source.

## Output

Write results under `.firecrawl/` with `-o` unless the user asked for content inline, and keep
`.firecrawl/` in `.gitignore`. Read files back in bounded slices so a long page cannot swamp the
context:

```bash
wc -l .firecrawl/page.md && head -50 .firecrawl/page.md
grep -n -i "<symbol>" .firecrawl/page.md
```

One `--format` prints raw content; several print JSON. Keep stderr out of a JSON pipe — the CLI
writes progress lines like `Scrape ID: ...` to stderr, so never `2>&1` into `jq`.

**Done when:** the narrowest command that answers the request has run, its payload was inspected
rather than trusted, any `warning` field was read, every hollow case above was ruled out, and the
answer cites the saved files it came from.
