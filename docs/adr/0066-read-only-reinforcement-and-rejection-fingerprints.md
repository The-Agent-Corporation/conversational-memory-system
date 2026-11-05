# ADR 0066: Read-Only Reads, Explicit Reinforcement, and Rejection Fingerprints

## Status

Accepted

## Context

Search and recall were described as reads, while injection also raised summary strength and could revive a stale summary. A rejected proposal could be proposed again by changing its id. Audit rows for source lifecycle already exist, but later intentional writes did not share one content-free record.

## Decision

- `memory_search`, `memory_recall`, `memory_review`, and the other read tools do not write. `prepareInjection` saves an injection packet and does not change summary strength, retrieval count, or state.
- Strength changes only through `memory_reinforce`. Each authorized summary accepts one reinforcement per 60 minutes. The increment is 0.05 and the result is capped at 1. A stale summary becomes `revived` on a successful reinforcement. A summary that is already at the cap and not stale is unchanged. A denied summary is not found.
- Each intentional mutation records a content-free audit row: person, scope, action, target id, and time. The row does not store message text or the rejected value.
- A rejected proposal title is stored as the SHA-256 of its normalized form (trim, lowercase, collapsed whitespace), keyed by person and scope. The raw title is not stored. A new id with the same normalized value is refused for that person and scope. The same value is allowed for a different person or a different scope. `saveProposal` and `saveBox` enforce the check for automated writes.

## Consequences

Injection no longer revives or strengthens memory. Revival is an explicit, rate-limited reinforcement. Rejection survives deletion of the proposal row because only the hash remains.
