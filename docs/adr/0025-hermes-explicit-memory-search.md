# ADR 0025: Hermes Explicit Memory Search

## Status

Accepted

## Context

Passive memory injection works from the current topic monitor, and Hermes can now resume summaries or injection packets. The next host-facing gap is explicit search: an agent or tool call should be able to ask the memory system for relevant prior memory even when no current rolling topic has been established.

## Decision

Add `HermesMemoryAdapter.searchMemory`.

The search request includes:

- `profileId`
- `hostSessionId`
- free-text `query`
- optional `requestedAt`
- optional `maxMemoryTokens`

The adapter reuses `MemoryService.prepareInjection` with the query as the retrieval topic and returns the same auditable `InjectionPacket` shape used by passive memory injection. It adds disclosure text showing that the packet came from explicit search.

## Consequences

- Hermes can expose a memory search tool without duplicating retrieval logic.
- Search results remain compatible with existing injection and resume flows.
- Explicit search does not depend on the topic monitor having seen prior turns in the current session.
