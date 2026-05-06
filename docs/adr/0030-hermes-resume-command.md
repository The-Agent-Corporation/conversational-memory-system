# ADR 0030: Hermes Resume Command

## Status

Accepted

## Context

The memory system can inject compacted context into Roscoe-Hermes, and each injection packet preserves source summary ids and source turn ranges. The next interaction needed by the accordion model is explicit expansion: a host should be able to request verbatim source turns for a recalled summary or injection packet.

## Decision

Add `hermes:resume`.

The command:

- reads a JSON request from stdin
- accepts either `summary_id` or `injection_packet`
- opens the configured SQLite memory database
- expands source ranges through `ConversationResumer`
- returns source turns plus a delimited `<memory-resume>` block

The resume block marks verbatim history as background context, not a user instruction.

## Consequences

- Roscoe can expose a resume tool without linking to TypeScript internals.
- Injection packets can now support a follow-up expansion flow.
- The host can choose whether to insert resumed context, display it, or summarize it further.
