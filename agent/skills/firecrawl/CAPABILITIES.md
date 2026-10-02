# What this instance can and cannot do

Disclosed reference for [SKILL.md](SKILL.md). Read it when a command fails or returns nothing,
when the user asks why a feature is missing, or before promising a capability.

Every row was **measured against this instance**, not read from docs. Where the measurement and
the official docs agree, the docs are cited too.

## Works

| Feature | Evidence |
| --- | --- |
| `scrape`, `crawl`, `map`, `batch/scrape` | HTTP 200 |
| `markdown`, `html`, `rawHtml`, `links` formats | HTTP 200 |
| `changeTracking`, `attributes` formats | HTTP 200 |
| JS-rendered SPAs | `react.dev` → 16.6k chars of markdown |
| PDF parsing | arXiv PDF → 39.7k chars |
| Web search | `--sources web` returns real results, no SERP key |
| `search --scrape` | full page text in `data.web[].markdown`, ~31k chars |
| `crawl --include-paths` | 3 scoped pages, `status: completed` |
| `parse` (local files) | reachable; wants a multipart upload, not a URL |

Concurrency is `maxConcurrency: 2` (`GET /v2/concurrency-check`). Run independent scrapes in
parallel up to that, then `wait`.

## Missing: needs fire-engine

Fire-engine is Firecrawl's **proprietary, closed-source** engine. A maintainer confirmed it "is
not (yet) open-source" and is unavailable self-hosted ([issue #468][i468]), and the self-host
docs list it as "not included" ([self-host][sh]). It is the single root cause of this whole
group, and there is no way to switch it on.

| Feature | What this instance returns |
| --- | --- |
| `--format screenshot` | 200 with `screenshot: null` — **hollow, no error** |
| `--format branding` | `SCRAPE_BRANDING_NOT_SUPPORTED: Branding extraction requires Chrome CDP (fire-engine).` |
| `actions` (click, fill, scroll) | `SCRAPE_ACTIONS_NOT_SUPPORTED: Actions require Fire Engine to be enabled.` |
| `proxy: stealth`, advanced anti-bot | `SCRAPE_ALL_ENGINES_FAILED` |

Anti-bot is the practical daily limit: a Cloudflare-fronted target (`g2.com`) failed outright,
while `indeed.com` succeeded. Expect hard-protected sites to fail and route around them.

## Missing: needs a model provider

These 500 because no LLM is wired up, **not** because the feature is absent. The docs say
connecting an OpenAI-compatible endpoint or **Ollama** enables them ([self-host][sh]) — the one
group here that is fixable locally.

| Feature | Returns |
| --- | --- |
| `--format json` (structured extraction) | 500 |
| `--format summary` | 500 |
| `scrape --query "..."` | 200 + `warning: "Query generation failed after all models."` — **hollow** |
| `/v2/extract` (deprecated route) | accepts, then fails downstream |

## Missing: cloud-only surfaces

| Feature | Returns | Note |
| --- | --- | --- |
| `firecrawl developer` | 404 — `POST /v2/developer/search is not a Firecrawl API endpoint` | no GitHub issue/PR index; the route does not exist |
| `firecrawl research` (papers) | 404 — route does not exist | ~43M-abstract index is cloud-only |
| `alexandria`, `find-tools` | `{"tools":[]}` + `"Some tool discovery results are unavailable."` | why `--sources web` is mandatory |
| `firecrawl agent` | 500 | cloud product surface ([oss-vs-cloud][osc]) |
| `interact` / browser sandbox | 503 — `Browser feature is not configured (HANGAR_URL is missing).` | |
| `monitor` | 500 | |
| `credit-usage` | 500 | no credit model self-hosted |
| `sources: images` / `news` | plain web results | **hollow** |
| `map --search` | filter silently ignored | **hollow** |

Researching a bug or error message without the developer index: search the error text with
`--sources web`, then scrape the `github.com/.../issues/...` hits directly. GitHub issue pages
scrape fine.

## Reading an empty result

Empty is ambiguous here — three different causes look identical:

1. **Your own flags.** Missing `--sources web`, or `--categories developer` (cloud-only, returns
   nothing). Fix the command first.
2. **The instrument.** Run a control query that must match (`huggingface`, or the bare library
   name). If the control is also empty, say so up front and report findings as coverage-limited.
3. **Genuine absence.** Only conclude this after 1 and 2 are ruled out — and still write it as
   "could not verify", never as "does not exist".

[sh]: https://docs.firecrawl.dev/contributing/self-host
[osc]: https://docs.firecrawl.dev/contributing/open-source-or-cloud
[i468]: https://github.com/firecrawl/firecrawl/issues/468
