# ADR 0026: Hermes Control Signal Compaction

## Status

Accepted

## Context

The accordion memory model treats `/new`, `/clear`, `/reset`, and `/compress` as compaction boundaries rather than true memory deletion. Hermes timeline rows previously mapped every user message to a conversation turn, which meant these commands could be stored as normal memory content and would not close the active topic.

## Decision

Map explicit Hermes slash commands to `control_signal` events:

- `/new` and `/clear` become `new_conversation`
- `/reset` becomes `reset`
- `/compress` becomes `compress`
- `/resume` becomes `resume_requested`

`TopicMonitor` now closes the active topic for `new_conversation`, `reset`, and `compress`, returning a completed span for pre-compaction and clearing the rolling state. Resume requests keep the current topic active.

## Consequences

- Slash commands no longer become ordinary stored turns.
- Starting a new conversation compacts the prior topic instead of losing it.
- Hermes can drive accordion behavior using host-native commands while the memory service preserves source-linked summaries.
