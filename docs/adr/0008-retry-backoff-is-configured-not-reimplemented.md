# Retry backoff is configured, not reimplemented

> **Amended by [0034](./0034-local-pi-patches.md).** The claim below that retry
> is handled *entirely* by stock `AgentSession` and reached only through settings
> is **no longer true**: the installed package is hand-patched in two places, to
> make litellm's HTTP 400 "Upstream request failed" retryable and to cap the
> outer ladder, neither of which any extension hook can do. The *intent* of this
> ADR stands — this extension still runs no retry loop of its own — but the
> runtime is now a local fork, and the figures below (8 retries, uncapped,
> ~8.5 min) are superseded by 10 retries capped at 128s, ~10.6 min.

Exponential backoff on transient provider failures (rate limits, 429, 5xx, connection errors) is handled entirely by pi's own `AgentSession`, configured through `agent/settings.json`. The subagent extension contains no retry logic of its own.

`AgentSession._handleRetryableError` already computes `baseDelayMs * 2 ** (attempt - 1)` and already classifies rate limits and server errors as retryable. Because it lives in `AgentSession`, which every mode instantiates, subagent child processes inherit it for free — verified by pointing a subagent at an always-429 endpoint and observing its child process retry at 2s, 4s, 8s, 16s. Adding a second loop in the extension would mean two backoff schedules racing on the same failure, with the observed delays matching neither.

Configured ladder: `baseDelayMs: 2000`, `maxRetries: 8` — 2, 4, 8, 16, 32, 64, 128, 256s, worst case ~8.5 minutes before a **Run** is declared failed.

`retry.provider.maxRetries` is set to `0` deliberately. The provider SDK has its own internal retry, and left enabled the two layers multiply: each visible pi attempt would silently contain several SDK attempts, so the ladder in the UI would not describe what is actually happening on the wire.

## Consequences

A rate-limited **Run** can occupy a **Task** slot for ~8.5 minutes while backing off, and reports only as `running` throughout — `MAX_ACTIVE_TASKS` is a tighter constraint under sustained rate limiting than it looks.

The per-request timeout is left at the provider SDK default of 10 minutes. Backoff triggers on *errors*, so a request that stalls without erroring is not retried until that timeout converts it into one — a hung **Run** can therefore hold a slot for ~10 minutes before its first retry. Lowering `retry.provider.timeoutMs` is the lever if that becomes a problem.
