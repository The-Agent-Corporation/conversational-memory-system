# ADR 0011: Summarizer Runtime Selection

## Status

Accepted

## Context

`OpenRouterSummarizer` exists, but host adapters should not have to hard-code provider construction. The default path must remain deterministic for tests, offline use, and local development, while production adapter wiring needs a simple way to select OpenRouter by configuration.

## Decision

Add `createSummarizerFromEnv` and let `HermesMemoryAdapter` accept an optional summarizer or summarizer runtime config.

Runtime selection:

- if `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are both set, use `OpenRouterSummarizer`
- otherwise use `DeterministicSummarizer`
- pass optional `OPENROUTER_REFERER` and `OPENROUTER_TITLE` through to OpenRouter attribution headers
- allow tests and hosts to inject an explicit `Summarizer`

## Consequences

- OpenRouter can be enabled without changing adapter code.
- Incomplete OpenRouter configuration does not break local deterministic operation.
- Roscoe-Hermes and future adapters can share the same summarizer selection path.
- Hosts that need tighter control can still construct and inject their own summarizer.
