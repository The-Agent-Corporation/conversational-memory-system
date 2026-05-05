# ADR 0003: Deterministic Topic Monitor Slice

## Status

Accepted

## Context

The memory design calls for a background topic monitor that keeps a rolling answer to "what are we talking about now?" Retrieval and compaction should operate on that rolling topic representation rather than embedding every isolated user turn.

The project does not yet have summarization, embeddings, ranking, or a production background worker. The next useful slice is therefore a deterministic monitor contract that can be tested without an LLM.

## Decision

Add a `TopicMonitor` that observes host events and tracks rolling topic state per host session.

The first monitor implementation:

- ignores control signals without clearing state
- extracts explicit topic labels from phrases like "talk about", "switch to", and "resume"
- keeps a rolling topic summary with source turn range and turn count
- emits a completed topic span when a clear topic switch occurs
- does not write summaries, boxes, anchors, or injection packets yet

## Consequences

- Pre-compaction can consume completed topic spans in the next slice.
- The current implementation is intentionally heuristic and deterministic.
- LLM-generated summaries, embeddings, and retrieval ranking remain deferred.
