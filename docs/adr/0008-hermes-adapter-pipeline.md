# ADR 0008: Roscoe-Hermes Adapter Pipeline

## Status

Accepted

## Context

Roscoe-Hermes is the first intended host adapter. The repository already has a timeline row mapper, memory service, topic monitor, pre-compactor, anchor detector, and retrieval path. The next step is to wire those pieces together behind a Hermes-specific adapter without coupling the core memory system to Hermes internals.

## Decision

Add `HermesMemoryAdapter` as the first host pipeline adapter.

The adapter:

- maps Hermes unified timeline rows to host events
- ingests conversation turns through `MemoryService`
- observes topic movement through `TopicMonitor`
- detects anchors on ingested turns
- pre-compacts completed topic spans
- prepares injection packets from the current topic on request

## Consequences

- Hermes integration now has one orchestration surface to call.
- Core modules remain independently testable and storage-neutral.
- Real Hermes production wiring can call this adapter from the timeline/gateway path without moving memory logic into Hermes.
