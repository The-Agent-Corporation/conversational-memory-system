# Universal Personal Memory

## Vision

One continuous, expanding and contracting personal conversation across agent products, with every native history left intact and every recalled fact traceable to its source.

## Current State

The full v1.0 roadmap (Phases 1–7) is complete: the host-neutral canonical timeline, four history importers, resumable checkpoints, deterministic historical bootstrap, source lifecycle controls, the continuous local daemon, and the generic sixteen-tool MCP interface; zero-knowledge multi-device sync (Phase 6); and the operator surface (Phase 7) — the `memory` CLI, guided init, REQ-039 audit surface, migration, health/tune, and encrypted backup. Dogfooding real agent histories (292,407 canonical events → 135,366 summaries) validated the pipeline end-to-end and exposed a set of O(n²) scaling hotspots since fixed. That same dogfooding showed the shared-term trace algorithm is combinatorially pathological at scale, motivating the current milestone. v1.1 Phase 8 (Vector Storage Foundation, REQ-041) is complete: a scope-aware, tombstone-ready `summary_vectors` store with a Float32 BLOB codec and verified exact result parity between SqliteStore and InMemoryStore. Phase 9 (Embedding Model + Embedder, REQ-044/051) is complete: opt-in local ONNX embedder (bge-small-en-v1.5 fp32, pinned revision, cls-pooling, asymmetric query prefix) behind `memory embeddings enable`, hash embedder still the zero-action default, golden-vector determinism gated by `npm run test:golden`. Desktop notifications remain explicitly deferred.

## Product Boundaries

- Native Codex, Claude Code, OpenClaw, and Hermes histories remain read-only.
- Content is read only after an exact source grant is approved.
- Canonical memory contains user/assistant text and compact redacted tool-call events; tool results and system prompts are excluded.
- Memory is assistive context, never authority.
- Person, workspace, client, case, and sensitivity boundaries override universal recall.
- External models are optional adapters, never a local correctness dependency.

## Current Milestone: v1.1 Vector-Native Traces + Semantic Recall

**Goal:** Replace the shared-term all-pairs trace algorithm with local vector-embedding plus nearest-neighbor search, and reuse those embeddings for semantic recall over summaries — without weakening REQ-040 (deterministic, local, no external models or services).

**Target features:**
- Embed every summary into a local vector store (backfill the existing 135,366; embed new summaries incrementally).
- Trace-finding via nearest-neighbor-above-threshold instead of shared-term combinatorics.
- A local ANN/vector index so neighbor search does not regress to O(n²).
- Semantic recall — query summaries by meaning, not just keyword overlap.
- Daemon trace step becomes forward-only/incremental (new-vs-existing), never all-pairs post-bootstrap.

**Key open decision:** embedding model — the existing local keyword-hash `DeterministicEmbedder` (REQ-040-safe but weak) versus a small local ONNX sentence-transformer (real semantics, REQ-040-safe, but a new bundled dependency).

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

Last updated: 2026-07-21
