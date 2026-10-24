---
name: updating-gen-config
description: "Use when a LiteLLM router config (a gen_config script that emits litellm-config.yaml) has manually-added model entries missing details — no model_info, no max_input_tokens/max_output_tokens, or no per-token costs for an externally-served model — and they need to be filled in. Triggers: 'fill in the new model in gen_config', 'complete an incomplete litellm entry', 'research litellm details for a model', 'add context/costs to a router config model'."
---

# Updating a gen_config router script

## Overview

A `gen_config` script (e.g. `~/gen_config`) is a bash script that emits `litellm-config.yaml` (quoted heredoc;
the file lands in the **current directory**). When the user manually adds a model,
the entry is bare: `model_name` + `litellm_params` (provider anchor or api_base,
model id, maybe `allowed_openai_params`). This skill fills out the missing details.

**Core principle: no value without a source.** Every number written into the file
carries a dated comment naming where it came from. Research is delegated — one
librarian task per model — never improvised inline.

## Quick Reference

1. Find the bare entries; classify each as self-hosted or external by where it is served.
2. One librarian per model, all in one turn — every value traces to a report.
3. Write: costs in `litellm_params`, limits + flags in `model_info`, dated provenance comment per entry.
4. Verify: generate in a temp dir; the snippet must pass on the entries you touched.
5. Report values + sources, plus the user-decisions list.

## Step 1 — Find the incomplete entries

An entry is incomplete if any of:

- no `model_info` block
- `model_info` missing `max_input_tokens` (or `max_output_tokens` for externally-served models)
- externally-served and missing cost fields

## Step 2 — Classify each entry

Classify by **where the request is served**:

- **Self-hosted** — your own hardware: `api_key: none` with a local or private
  `api_base` (`*.lan`, a private IP, a remote box the file says is yours).
  Anchors: `*local`, `*aiclub`. Assume the model's standard published settings
  (context length, modalities, tool support). You add no cost fields; the zero
  costs on `*local`/`*aiclub` entries come from the anchor — leave them alone.
- **External** — a provider serves it: uses a provider anchor (`*genai`,
  `*openrouter`, `*openrouterfree`, `*openai`, `*anthropic`, `*nagaai`).
  Research token counts **and** per-token costs.

## Step 3 — Delegate research: one librarian task per model

**Delegate — do not research inline.** Research is done by librarian subagents, one
task per incomplete model, launched all in one turn (they run concurrently). Every
value written into the config must trace to a librarian report.

| Excuse | Reality |
|---|---|
| "I can curl the map myself, it's faster" | Delegation is the requirement, not an optimization — the librarian's report is the sourced artifact; inline research is how values end up memory-sourced. |
| "It's just one model" | The rule is per-model: one model is one librarian task, not zero. |
| "I already know this model" | Memory is not a source; the bundled map and provider pages move. |

**Red flags — stop and delegate:** you are about to curl the litellm map or a
provider API in your own shell; a value in your draft is coming from memory.

Task template:

```
Research LiteLLM model data for <MODEL_ID> (a <chat|embedding> model to be added to a
LiteLLM router config; served via <PROVIDER>). Answer with a source for every value;
mark anything not verified as UNVERIFIED.

1. Bundled map: fetch https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
   and look the model up under litellm's OWN spelling — version dots become dashes
   (e.g. 5.5 -> 5-5); try the bare name and obvious provider prefixes. Regional
   variants exist; report the BASE (non-regional) values. If no base entry exists,
   say so explicitly and fall through to 2.
2. Provider data:
   - OpenRouter: GET https://openrouter.ai/api/v1/models/<vendor>/<model> —
     context_length, pricing (per-token strings in the API — report per-token values; note any long-context tier multiplier),
     top_provider modalities, and whether "endpoints" is non-empty (empty = route
     currently DEAD — report that).
   - Other external: the provider's published pricing page + the model card.
   - Self-hosted: the model's official card / Hugging Face config.json only
     (max_position_embeddings; note if long context needs YaRN or similar). No
     pricing. Look up the underlying checkpoint/quant (the file's
     WHAT-SERVES-WHAT table names it when listed), not the gateway's serving ID.
3. Report as a flat list of litellm fields — max_input_tokens,
   max_output_tokens, input_cost_per_token, output_cost_per_token,
   cache_read_input_token_cost, cache_creation_input_token_cost (omit + say
   why if cache writes bill at the standard input rate), supports_vision,
   supports_function_calling, supports_tool_choice, supports_reasoning,
   supports_prompt_caching, supports_response_schema, supports_system_messages,
   supports_pdf_input, mode, litellm_provider, supported_openai_params
   (embedding models: output_vector_size) — each with its source (map key / URL).
If sources conflict, report BOTH values with sources and say which you would trust and why.
```

Collect each report; a value the librarian marks UNVERIFIED either gets a second
source or an explicit "UNVERIFIED" note in the entry comment.

## Step 4 — Write the entries

Conventions (the file's own section headers are the authority — read them first):

- **Costs**: unquoted, decimal point in the mantissa (`2.5e-06`, never `2e-06`) —
  YAML 1.1 parses only mantissas with a `.` as floats. Do NOT copy the legacy
  quoted-string style of the older openrouter entries.
- **Placement**: cost fields live under `litellm_params`; token limits and
  `supports_*` flags under `model_info`. The litellm map keeps costs at the
  top level — do not mirror that layout into `model_info`.
- **Self-hosted**: no cost fields you add; omit `max_output_tokens` when the
  server does not enforce a cap (llama.cpp without `--n-predict`, SGLang) — and
  when its launch flags are unknown, omit it and note "server cap unknown" in
  the provenance comment; `supports_prompt_caching: false` (server-side
  radix/prompt caches are not the cache_control API);
  `supported_openai_params` mirrors the nearest sibling entry, including
  `reasoning_effort` when the model reasons. The provenance comment carries
  "card value, NOT probed against the server".
- **External**: cost fields from the researched rates; `max_output_tokens`
  present; `supports_*` flags from the researched capabilities; mirror
  `mode`, `litellm_provider` and `supported_openai_params` from the nearest
  completed sibling entry.
- `litellm_provider` names the serving backend (bedrock, openai, openrouter), not
  the model vendor.
- Keep the user's `allowed_openai_params` / `additional_drop_params` unless research
  contradicts them; if you change them, say so in the report.
- **Provenance comment** above each entry: dated, source named. For externally-served
  models add "NOT probed against this gateway".
- If the entry's provenance differs from the section header's claim (e.g. the
  self-hosted header says "Every value ... verified against the LIVE servers"),
  append a dated note to the section header so it stops overclaiming — but only
  when the entry belongs to that header's host. If a bare entry's `api_base`
  points at a different host than the header describes (e.g. a `*.lan` entry
  under a remote-host header), flag the mismatch in the report instead.

## Step 5 — Verify

```bash
d=$(mktemp -d) && cd "$d"
bash ~/gen_config   # or the gen_config path you are editing
python3 - <touched model_name> [more touched names...] <<'PY'
import sys, yaml
d = yaml.safe_load(open('litellm-config.yaml'))
names = [m['model_name'] for m in d['model_list']]
touched = set(sys.argv[1:])
missing = touched - set(names)
assert not missing, f'model_name not in config: {sorted(missing)}'
touched_dups = {n for n in touched if names.count(n) > 1}
assert not touched_dups, f'touched model_name has multiple entries: {sorted(touched_dups)}'
# The check applies to the entries you just edited. The 2026-10-11/12
# openrouter entries carry quoted-string costs — a known exception, do not
# "fix" them in passing (their entry comment claims the quoting makes them
# floats; it does not).
matched = 0
for m in d['model_list']:
    if m['model_name'] not in touched:
        continue
    matched += 1
    lp = m.get('litellm_params', {})
    mi = m.get('model_info', {})
    for k in ('input_cost_per_token','output_cost_per_token',
              'cache_creation_input_token_cost','cache_read_input_token_cost'):
        v = lp.get(k)
        if v is not None:
            # str is the real failure mode (YAML 1.1: no dot in the mantissa);
            # int 0 is the free-tier cost inherited from the *local/
            # *openrouterfree/*openai/*anthropic anchors
            assert isinstance(v, float) or (isinstance(v, int) and v == 0), \
                (m['model_name'], k, type(v))
        if k in mi:
            raise AssertionError(
                f'cost field {k} belongs in litellm_params, not model_info: {m["model_name"]}')
print('OK', matched, 'touched entries checked of', len(names), 'models')
PY
```

`gen_config` writes to the **current directory** — verify in a temp dir, never the
real one.

## Step 6 — Report

Per model: the values written + the source. Then a **user decisions** list: dead
routes (empty OpenRouter `endpoints`), source conflicts you resolved, changes to
the user's own parameter choices, and any UNVERIFIED value left in.

## Common mistakes

| Mistake | Why it bites |
|---|---|
| Researching inline instead of delegating | Slow, and your context fills with raw map JSON; the librarian's report is the artifact |
| Looking up the gateway spelling in the bundled map | The map uses litellm's own spelling (dots→dashes; `claude-sonnet-5-5`, not `claude-5-5`); a miss looks like "no price map" |
| Mirroring a previous generation's pricing | Newer models are cheaper; this file has burned on it twice (2026-09-07, 2026-10-06 corrections) |
| `2e-06` without a decimal point | Loads as a STRING under YAML 1.1; billing only works by luck |
| Inventing `max_output_tokens` for self-hosted | The server may not enforce a cap; advertising one is a fabrication |
| Leaving the section header as-is | The header claims live verification; a spec-sourced entry makes it a lie |
| Costs written into `model_info` | That's where the litellm map keeps them, so it looks right — but the file puts costs in `litellm_params`, and the verification only checks there |
| Failing on `0` (int) costs from the free anchors | `*local`/`*openrouterfree`/`*openai`/`*anthropic` merge in a zero cost; int 0 is the free-tier convention, not a broken float |
| Running the Step 5 snippet with the example names | It passes while checking nothing — pass the model_names you actually touched |
