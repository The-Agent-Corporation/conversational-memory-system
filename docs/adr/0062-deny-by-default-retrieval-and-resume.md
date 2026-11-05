# ADR 0062: Deny-by-Default Retrieval and Resume

## Status

Accepted

## Context

ADR 0046 requires strict retrieval to carry both `personId` and `allowedScopeIds`, and it left one compatibility escape: Hermes could opt in to legacy unscoped retrieval. Resume never applied that boundary. A caller who knew a summary, trace, box, or injection-packet id, or who supplied raw turn ranges, received verbatim turns. Child boxes were loaded by id. Unscoped Hermes search also strengthened, revived, and saved injection packets for whatever it touched. Rejected boxes and proposals were ignored by duplicate detection when the next candidate used a different id. ADR 0061 is reserved for the Phase 13 decision record and is not used here.

## Decision

Retrieval and resume are deny-by-default.

- `MemoryRetriever` no longer accepts an unscoped escape. A request without both `personId` and `allowedScopeIds` is rejected.
- Resume takes a server-bound authority (`personId`, `allowedScopeIds`, optional `hostSessionId`). A summary, trace, box, child box, or linked summary outside that authority, or outside the retrievable states, is not found. The error is the same error used for a missing id.
- An injection packet resumes only when that id was saved for the authority's person and scopes and the same host session. Caller-authored turn ranges are ignored. Ranges come from the authorized summaries, traces, and boxes named by the saved packet.
- Turns loaded for an authorized range are dropped when their metadata names a different person or a scope outside the authority.
- Hermes may set exactly one configured person and one configured scope (`HERMES_MEMORY_PERSON_ID`, `HERMES_MEMORY_SCOPE_IDS`, or the adapter options). That identity is not an unscoped grant and is not implied by the host name. Host events reject caller-supplied person or scope fields.
- Authorized injection still strengthens and revives under ADR 0016, ADR 0018, and ADR 0049. A denied retrieval writes nothing.
- A rejected or superseded box or proposal blocks a later candidate with the same title, including one minted under a new id.

## Consequences

- Local stdio MCP stays the public contract. It already binds person and scopes from the profile. Hermes is an ordinary client of the same rules.
- Old objects with no person id are not retrieved or resumed.
- Operators must configure the Hermes identity before ingest, inject, or resume. The deterministic offline path does not call a model.
