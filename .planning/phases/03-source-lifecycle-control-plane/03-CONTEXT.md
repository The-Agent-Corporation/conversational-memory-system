# Phase 3 Context: Source Lifecycle Control Plane

## Locked Decisions

- Approval is exact-source, person-owned, durable, inspectable, and revocable.
- Revocation stops future source reads; it does not mutate native histories.
- Deletion is separately confirmed, source-attributable, audited, and propagates into derived memory.
- Unknown or malformed source records are preserved only in bounded, redacted quarantine form.
- Tool calls retain name and bounded redacted invocation summaries; tool-result payloads are excluded.
- Universal storage does not authorize cross-workspace or cross-client retrieval.

## Safety Constraints

- No live personal history is opened during verification; use synthetic fixtures.
- No external model is required.
- Existing unrelated dirty files are preserved.
