# ADR 0024: Hermes Resume Expansion

## Status

Accepted

## Context

ADR 0023 added a shared `ConversationResumer` that can expand summaries and injection packets into verbatim source turns. Roscoe Hermes is the first intended host integration, so it needs a direct adapter surface for requesting that expansion without duplicating resume logic.

## Decision

Expose resume expansion through `HermesMemoryAdapter`.

The adapter now:

- owns a `ConversationResumer` backed by the same memory store
- exposes `resumeSummary(summaryId)`
- exposes `resumeInjection(packet)`
- returns the shared `ResumeResult` disclosure, source ranges, source summary ids, and verbatim turns

## Consequences

- Hermes can offer an explicit resume action for a compacted summary or injected memory packet.
- Verbatim expansion stays centralized in `ConversationResumer`.
- Host adapters remain thin integration layers over shared memory services.
