---
title: Universal Personal Memory Pivot
date: 2026-07-16
context: Product exploration replacing a Hermes-specialized integration model with host-neutral personal memory
---

# Universal Personal Memory Pivot

## Product Direction

The product is a host-neutral, lifelong personal conversation memory system. It continuously absorbs user-approved agent histories, contracts older spans into layered memory, expands relevant history on demand, and exposes recall to any compatible agent through MCP.

Hermes, Codex, Claude Code, OpenClaw, and future systems are clients and provenance sources. None of them defines the durable memory boundary.

## Locked Decisions

1. A person has one continuous canonical conversation timeline.
2. Original agent histories remain unchanged in their original locations.
3. Source application, profile, session, event identity, causal linkage, and timestamps remain attached as provenance, but source sessions do not partition recall or compaction.
4. Initial onboarding discovers history sources without reading message bodies, presents a metadata-only manifest, and requires explicit approval for each source or root before import.
5. A continuous local daemon incrementally imports future activity from approved sources.
6. The local database is authoritative and remains fully usable offline.
7. Optional multi-device synchronization is zero-knowledge: servers store ciphertext and cannot decrypt personal memory.
8. A new device joins through approval from an existing device or a user-held recovery key.
9. MCP is the primary generic agent interface. Host-specific adapters translate native history formats into the canonical timeline.
10. Import, re-import, revocation, and deletion must be auditable and reversible.

## Accordion Model

The system does not treat every source chat as a separate memory silo. All approved events enter one ordered personal conversation. Older passages contract into subjects, topic spans, summaries, boxes, anchors, and cross-cutting traces. Recall expands the most relevant layer, including source-linked verbatim history when needed.

Original session boundaries may inform provenance and causal ordering, but they are not retrieval boundaries.

## Import Research Snapshot

- Codex uses session JSONL files as canonical transcripts; prompt-history indexes must not be imported as separate conversations.
- Claude Code uses project-scoped JSONL transcripts with event, parent, sidechain, and tool linkage; its importer must tolerate schema versions and unknown records.
- OpenClaw installations may use JSON/JSONL session files or newer SQLite storage; discovery must capability-detect the active canonical store and avoid importing both sides of a migration.
- Hermes uses its state database as the canonical source; routing metadata and legacy exports must not be double-imported.
- JSONL imports should checkpoint by file identity and byte offset. SQLite imports should checkpoint by stable row identity or a high-water mark.
- Native identifiers are the first deduplication key. Text similarity alone must never delete or merge an event.

## Safety Boundary

Universal memory does not mean indiscriminate disclosure. Import consent, retrieval policy, workspace sensitivity, provenance, human approval gates, source revocation, and deletion remain mandatory. The system must not store detected secrets as durable memory and must not silently surface sensitive client or legal material into unrelated work.

## Historical Architecture

Existing Hermes integration ADRs remain valid descriptions of the first host adapter. The pivot extracts their reusable domain and storage behavior behind host-neutral service contracts rather than discarding the proven implementation.
