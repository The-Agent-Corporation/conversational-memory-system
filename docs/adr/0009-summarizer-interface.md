# ADR 0009: Summarizer Interface

## Status

Accepted

## Context

Pre-compaction currently creates deterministic summary text directly inside `PreCompactor`. That was useful for an auditable foundation, but the next step is real memory behavior: LLM-generated summaries that still preserve exact source turn ranges and storage contracts.

## Decision

Introduce a `Summarizer` interface and move the deterministic implementation behind it.

The first interface:

- accepts a completed topic span and source turns
- returns a summary draft without storage-specific ids
- keeps source range, id generation, state, decay metadata, and persistence in `PreCompactor`
- ships with `DeterministicSummarizer` as the default

## Consequences

- `PreCompactor` can use an LLM-backed summarizer later without changing its public behavior.
- Tests can inject custom summarizers to verify compaction orchestration.
- Source-linked summary storage remains stable while summary text generation evolves.
