# ADR 0035: Proposal Review Commands

## Status

Accepted.

## Context

Sleep review now stores proposed boxes, parent/child relationships, and traces. Hosts need a command-based way to inspect, approve, and reject those proposals without a dashboard.

## Decision

Add `hermes:proposals:list`, `hermes:proposals:approve`, and `hermes:proposals:reject`.

Approval is explicit and proposal-type specific. Box approval creates or updates the target approved box. Parent/child approval wires existing boxes. Trace approval creates an approved `MemoryTrace`. Rejection marks a proposal rejected without deleting it or mutating durable memory.

## Consequences

- Agents can mature memory organization safely.
- Approved structure remains auditable through proposal decision metadata.
- The system stays command-based and host-agnostic.
