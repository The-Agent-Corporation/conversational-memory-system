# ADR 0005: Deterministic Anchor Detection

## Status

Accepted

## Context

Anchors preserve high-signal details that should survive lossy summarization: decisions, deadlines, key facts, strategic insights, and explicit bookmarks. The system does not yet have an LLM extraction pipeline or approval workflow, so anchor detection needs a conservative deterministic starting point.

## Decision

Add an `AnchorDetector` that scans persisted turns for obvious anchor signals and writes anchors through `MemoryStore`.

The first detector:

- creates deterministic ids from turn id and anchor type
- preserves turn id, thread id, content, provenance, trust level, and created time
- leaves `boxId` and `embedding` null
- upserts through store semantics when the same turn is processed again
- only detects simple keyword patterns for the supported anchor types

## Consequences

- High-signal legal details can be captured before full summarization exists.
- False positives are constrained by simple transparent rules.
- Later LLM extraction and approval workflows can replace or supplement this detector while preserving the anchor schema and storage path.
