# 0042 — Credentials come from a `.env` file, not from source

Status: implemented

## Context

Two files held live credentials as literals:

- `agent/extensions/litellm.ts` line 5: `const API_KEY = 'sk-…'`
- `agent/mcp.json`: `"x-litellm-api-key": "Bearer …"`

Both authenticate against the same gateway (`your-litellm-gateway`), but they are
**different credentials** — a 25-character `sk-` provider key and a 32-character
bearer token. Nothing on disk explains why, so they must be treated as
independently scoped until proven interchangeable.

ADR 0034's first commit had to exclude both files from git for this reason
alone, and the `.gitignore` entry for `litellm.ts` recorded an embarrassment
rather than a policy: the file's own doc comments (lines 90, 113) claimed
`LITELLM_API_KEY environment variable must be set`, which the code did not do.
The cost was 169 lines of provider and pricing logic with no version history.

Three facts constrained the remedy:

1. **pi has no dotenv support.** Not a dependency, and no `.env` reading
   anywhere in the bundle.
2. **pi does no `${VAR}` expansion** in `mcp.json`.
3. **Both consumers are our own extensions** — `litellm.ts` and
   `agent/extensions/mcp/index.ts`. Extension top-level code runs before a
   provider is used or an MCP server is dialled.

Fact 3 is what makes this cheap: no vendor patch, so nothing here is undone by
the next pi release (contrast ADR 0034, which needs `scripts/patch-pi.sh` after
every update).

## Decision

A shared module, `agent/extensions/dotenv.ts`, loads `agent/.env` into
`process.env`. Both extensions import it and call it at load.

**Two variables, not one.** `LITELLM_API_KEY` and `LITELLM_MCP_KEY`. The keys
on disk differ, and collapsing them would silently cost the MCP server its 76
tools if the bearer token is scoped differently. Pointing both at one value
later is a one-line change; discovering the difference in production is not.

**One loader, not two.** Two parsers of the same file would drift, and drift is
exactly how the fork bomb of ADR 0037 bypassed an interlock that already
existed. Same reasoning as `rundir.ts` in ADR 0039: one implementation, two
consumers.

**`agent/.env`, resolved via `getAgentDir()`.** Not the repo root: this repo is
a config directory that pi is launched *from other projects*, so `cwd` is not
the repo. `getAgentDir()` is already how the MCP extension finds `mcp.json`.

**The real environment wins; `.env` only fills gaps.** Standard dotenv
behaviour. It keeps `LITELLM_API_KEY=other pi` working as a one-off override,
and — load-bearing here — spawned oracle reviews and rework workers inherit
`...process.env` (ADR 0039), so a child must never have an inherited value
replaced by a file it did not choose.

**Minimal parser.** `KEY=VALUE`, `#` comments, optional surrounding quotes.
Every additional feature — multiline, escapes, interpolation inside `.env` — is
another way for a credential to become subtly different from what is visible in
the file.

**Missing credentials fail loudly, naming the variable and the file.** No
fallback to a hardcoded default: a fallback would mean the secret stays in
source and the whole exercise is theatre.

**`mcp.json` gains `${VAR}` expansion, and an unset variable refuses to start
that server.** Leaving the placeholder literal would send
`Bearer ${LITELLM_MCP_KEY}` to the gateway and surface as a 401 that looks like
a gateway or network fault. Refusing names the cause locally.

With the secrets externalised, **both files enter git** and their `.gitignore`
entries are dropped. `agent/.env.example` is committed so the repo states its
own requirements.

## Consequences

- `agent/extensions/litellm.ts` and `agent/mcp.json` are versioned. 169 lines of
  logic gain history; `mcp.json` becomes shareable config that documents which
  variables it needs.
- A new failure mode exists that could not happen before: a fresh machine, or
  one whose `.env` was not restored from Nextcloud, has no credentials. This is
  why the failure is loud and names both the variable and the file.
- `agent/.env` is gitignored and exists only on this machine. Its loss means
  re-minting two keys from the gateway — recoverable, unlike a leaked key.
- Extension load order now matters slightly: the loader must run before a key is
  read. Both call sites are at the top of their module, and a missing value is
  loud, so a future reordering fails visibly rather than silently.
- The `.env` is read by the orchestrator and inherited by every child, so a
  credential rotation takes effect for children on the next spawn without any
  per-child plumbing.

## Rejected alternatives

**One shared variable.** Assumes the two keys are interchangeable. Unverified,
and the failure is silent tool loss rather than an error.

**Shell profile exports instead of a file.** Zero code, but breaks whenever pi
is launched by something that does not source the profile (herdr, systemd,
cron), fails silently, and cannot be committed as config.

**Each extension parses `.env` itself.** No shared dependency, but two parsers
that drift — the ADR 0037 lesson.

**The real `dotenv` package.** Battle-tested, but a new dependency to load two
strings, and it is not currently installed.

**Falling back to the hardcoded key when the variable is absent.** Cannot
break anything, and achieves nothing: the secret stays in the file and the file
stays ignored.

**Leaving the `${VAR}` placeholder as literal text.** Converts a clear local
error into a remote authentication failure.

**Keeping `mcp.json` gitignored after the secret leaves it.** Would be ignoring
a file that contains no secret, for no reason.
