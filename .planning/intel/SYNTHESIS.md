# Universal Personal Memory Ingest Synthesis

## Product

A local-first, host-neutral lifelong conversation memory system that imports approved agent histories, treats them as one provenance-preserving conversation, contracts history into layered memory, and exposes safe recall to agents through MCP.

## Current Capability

The canonical timeline, Codex/Claude Code/OpenClaw/Hermes importers, deterministic historical bootstrap, anchors, summaries, review proposals, and status commands are implemented and covered by synthetic end-to-end tests.

## Immediate Milestone

Complete the source lifecycle control plane before enabling continuous background ingestion:

1. durable approval and audit registry,
2. revocation enforcement,
3. attributable deletion and derived-memory invalidation,
4. parser quarantine and replay,
5. sensitive-context retrieval boundaries.

## Sequencing

Source lifecycle controls precede the local daemon. The daemon precedes MCP. Zero-knowledge sync remains gated by threat-model and protocol research.

## Locked Tool-Call Policy

Durable canonical memory contains user/assistant text and compact, redacted tool-call events. A tool-call event records the tool name and a bounded invocation summary. Tool-result payloads and system prompts are excluded.
