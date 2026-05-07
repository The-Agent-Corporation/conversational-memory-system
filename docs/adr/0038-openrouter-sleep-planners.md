# ADR 0038: OpenRouter Sleep Planners

## Status

Accepted

## Context

Sleep review can propose boxes and traces through deterministic planners. That keeps local runs reliable, but deterministic keyword grouping is limited for legal case memory where PIP, BI, provider bills, deadlines, and factual developments may share broad case terms while requiring separate memory structure.

The system already supports OpenRouter for summarization. The same provider path can support background proposal planning without coupling the memory system to a specific host.

## Decision

Add optional OpenRouter-backed sleep proposal planners behind the same planner interfaces used by deterministic planning.

`hermes:sleep` supports:

- `deterministic`: default local behavior
- `openrouter`: require OpenRouter configuration and use model-backed planners
- `hybrid`: use OpenRouter when configured, otherwise deterministic

OpenRouter planners return proposed records only. They validate model JSON into existing `MemoryProposal` payload schemas before persistence. They reject malformed JSON, unknown summary ids, unknown box ids, and non-OK provider responses.

## Consequences

- Deterministic planning remains the default and test oracle.
- Configured sleep review can propose richer boxes, parent/child relationships, and traces.
- Proposal review remains the approval gate.
- Hosts can enable model-backed planning by setting OpenRouter environment variables instead of changing core code.
