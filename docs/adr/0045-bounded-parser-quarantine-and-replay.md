# ADR 0045: Bounded Parser Quarantine and Replay

## Status

Accepted

## Context

Native agent history formats evolve. Silently discarding malformed or unsupported records makes later parser recovery impossible, but copying raw records into a durable error log would create a second unbounded store of sensitive conversation data and tool output.

## Decision

Add a person- and source-owned parser quarantine with the following contract:

- Quarantine only malformed JSON, unsupported records, and malformed tool-call metadata.
- Recognized exclusions—tool results, system prompts, indexes, progress records, and compaction metadata—are skipped and never quarantined.
- Store a deterministic record identity, relative resource path, record position, parser version, reason, raw byte length, and SHA-256 hash.
- Store at most 8 KiB of locally redacted source text. Never store an unbounded raw record.
- Keep quarantine state explicit: `pending`, `replay_requested`, `replayed`, or `discarded`.
- Replay requires an active durable source grant and exact candidate-ID confirmation.
- A replay request resets only that candidate's import checkpoints and writes an audit event. The next normal import rereads the native source and marks records replayed when the current parser recognizes them.
- Source deletion removes that source's quarantine records along with imported memory.

## Consequences

- Parser upgrades can recover previously unsupported history without silently expanding the durable data boundary.
- Replay remains read-only against native history and uses the ordinary idempotent importer path.
- Tool-result payloads do not enter canonical memory or quarantine.
- Quarantine inspection exposes only bounded, redacted content plus provenance and hashes.
