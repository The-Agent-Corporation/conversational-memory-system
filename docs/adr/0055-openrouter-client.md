# ADR 0055: Shared OpenRouter Client

## Status

Accepted.

## Context

Summaries, proposal planning, and embeddings each talked to OpenRouter with their own fetch, retry, and header code. A semantic corpus must not silently substitute a deterministic draft when the provider fails or the daily cap is hit, and a credential proxy on Sprite must be able to call the API without a key in the process environment.

## Decision

`src/openrouter/client.ts` is the only HTTP client for OpenRouter chat and embeddings.

- Default base URL is `https://openrouter.ai/api/v1`. `OPENROUTER_BASE_URL` overrides it. A key is required only for `openrouter.ai`.
- Requests send `HTTP-Referer` and `X-Title`, abort on timeout, and retry 429, 5xx, and 529 with jitter while honoring `Retry-After`. 400, 401, 402, and 404 are not retried.
- Provider policy defaults to `data_collection: "deny"`.
- A per-day spend ledger pauses semantic stages with `SpendCapPausedError` once the configured cap is reached. The client does not invent a deterministic substitute.
- Chat outputs may be cached by stage, prompt version, model, and input hash. Embeddings are not cached.
- `OpenRouterSummarizer` and `OpenRouterProposalPlanner` call this client.

## Consequences

Deterministic summarizers and planners remain the offline path. Tests inject `fetch` or point the base URL at a local server and do not require `OPENROUTER_API_KEY`.
