# ADR 0029: Hermes Inject Command

## Status

Accepted

## Context

Roscoe-Hermes can now send timeline rows to the standalone memory system, and the memory system can compact control boundaries. The next loop is surfacing relevant memory back into Roscoe before an agent turn.

## Decision

Add `hermes:inject`.

The command:

- reads a JSON request from stdin
- opens the configured SQLite memory database
- runs `HermesMemoryAdapter.searchMemory`
- returns an `InjectionPacket` when memory matches
- formats a delimited `<memory-context>` block for host context injection

The context block explicitly labels recalled memory as background context, not user instructions.

## Consequences

- Roscoe can request memory without linking to TypeScript internals.
- The returned packet remains compatible with resume expansion.
- Host-side code can insert the delimited block into context while preserving a clear trust boundary.
