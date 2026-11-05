# ADR 0063: Generic Idempotent MCP Live-Turn Append

## Status

Accepted

## Context

Live hosts need to append the turn they just handled. History import is a confirmed batch over a fixed source enum. The core host enum is a source label, not a list of allowed clients. Person and write scope must stay on the MCP profile. ADR 0061 remains reserved for the Phase 13 decision record.

## Decision

Add one closed-catalog tool, `memory_append_turn`.

- The profile owns `personId` and the write scope (`ingestScopeId`). The tool schema rejects caller `personId`, `scopeId`, and `profileId`.
- The idempotency key is host + session + turn id, under that person. An identical replay returns `REPLAYED` and writes nothing. The same key with different content returns `LIVE_TURN_CONFLICT` and does not overwrite.
- Secrets are redacted before storage. A malformed tool-call payload is quarantined, redacted, and not stored as a canonical event.
- A host name is a validated token (`^[a-z0-9][a-z0-9._-]*$`), not the old closed enum. A profile may set `allowedHosts` to narrow that set. Omitting it accepts any validated name.
- The tool works while synchronization is offline. It uses a short-lived write connection and does not take the daemon lease.

## Consequences

Any validated host can append into the profile that launched the server, and only into that profile's person and write scope. A second profile does not see those turns. Replay is safe. Raw secrets are not persisted.
