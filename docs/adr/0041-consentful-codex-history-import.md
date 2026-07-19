# ADR 0041: Consentful Incremental Codex History Import

## Status

Accepted

## Context

The personal timeline needs to become useful from existing agent history without silently scanning message content or importing duplicate prompt indexes and execution sidecars. Codex stores canonical session transcripts as rollout JSONL files and may continue appending to active files.

The importer must remain local, read-only, resumable, idempotent, and safe around partially written records.

## Decision

Add a two-step Codex history flow:

1. Discovery walks only `sessions` and `archived_sessions`, selects regular `rollout-*.jsonl` files, skips symlinks, and reports filesystem metadata without opening message bodies.
2. Import requires an explicit approval object whose root path hashes to the discovered candidate identity.

The importer:

- reads only approved rollout files,
- ignores `history.jsonl`, non-rollout files, event indexes, system prompts, and tool-result records,
- imports user and assistant message records from `response_item` entries,
- imports function calls as compact assistant events containing the tool name and a bounded, redacted invocation summary,
- applies local secret redaction before persistence,
- checkpoints each file by filesystem identity, newline-safe byte offset, record index, native session ID, and parser version,
- replays from byte zero after truncation, replacement, or parser-version change,
- leaves incomplete final JSONL records uncommitted until a newline arrives,
- uses deterministic canonical identity so replay does not duplicate memory.

Each approved Codex root becomes a distinct source instance. Canonical event metadata stores a root-relative resource path rather than copying the absolute history root into every event.

Expose the flow through separate `memory:codex:discover` and `memory:codex:import` commands. The import command requires the discovered candidate ID through an explicit `--approve` argument.

## Consequences

- A user can inspect source counts, date range, and estimated size before message bodies are read.
- Approval of one root does not authorize another root.
- Active Codex sessions can be imported incrementally by the future daemon.
- Parser upgrades can recover previously unsupported records through deterministic replay.
- Tool calls remain visible in the personal timeline without retaining their potentially large or sensitive result payloads.
- Tool execution results are intentionally excluded from durable canonical memory.
- Approval persistence, revocation, quarantine, progress UI, source deletion, and daemon scheduling remain follow-on work.
