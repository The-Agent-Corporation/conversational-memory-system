# ADR 0010: OpenRouter Summarizer

## Status

Accepted

## Context

The memory service now has a `Summarizer` interface, but only a deterministic implementation. The user prefers OpenRouter for day-to-day model swapping, and the system should remain standalone so it can plug into Roscoe-Hermes or other hosts without becoming a Pi or Hermes extension.

## Decision

Add `OpenRouterSummarizer` as an optional provider-backed implementation of `Summarizer`.

The implementation:

- calls OpenRouter's OpenAI-compatible chat completions endpoint
- accepts `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` through `OpenRouterSummarizer.fromEnv`
- supports optional `OPENROUTER_REFERER` and `OPENROUTER_TITLE` attribution headers
- requests JSON output with `response_format: { type: "json_object" }`
- returns a storage-neutral `SummaryDraft`
- records provenance as `model: openrouter:<provider-model>` and `promptVersion: openrouter-summarizer-v1`

## Consequences

- Hosts can choose OpenRouter by constructing `PreCompactor` with `new OpenRouterSummarizer(...)`.
- Model changes are configuration changes, not code changes.
- The deterministic summarizer remains the default for local tests and offline operation.
- OpenRouter errors and malformed model output are surfaced as typed `OpenRouterSummarizerError` failures before anything is persisted.
