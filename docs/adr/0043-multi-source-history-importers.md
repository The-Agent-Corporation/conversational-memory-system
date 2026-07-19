# ADR 0043: Multi-Source History Importers

## Status

Accepted

## Context

The initial personal-memory bootstrap must cover Codex, Claude Code, OpenClaw, and Hermes without modifying their native stores or pretending their formats are identical. Claude Code and OpenClaw use append-oriented JSONL transcripts with different record and tree structures. Current Hermes uses a canonical SQLite session database. Each format can evolve independently and may contain tool output, system prompts, sidecars, indexes, or archived copies that should not automatically become durable memory.

## Decision

Add application-specific discovery and parsing behind one approval and canonical-event boundary.

All importers:

- perform metadata-only discovery before content access,
- bind approval to the canonical root or database path,
- preserve application, profile or agent, native session, native event, parent-event, timestamp, resource, record position, and parser version,
- redact common secret forms before durable persistence,
- use deterministic canonical identity and person ownership,
- never modify native history,
- ingest user and assistant text plus compact, redacted tool-call events,
- retain only a tool's name and bounded invocation summary while excluding tool-result payloads, binary content, system prompts, indexes, and unrelated sidecars,
- checkpoint only complete records and replay after parser-version or file-identity changes.

Claude Code discovery reads regular `projects/**/*.jsonl` files and includes sidechain transcripts as conversation provenance. Its parser accepts string or text-block content and preserves `uuid`, `parentUuid`, `sessionId`, timestamp, and `isSidechain`.

OpenClaw discovery reads regular `agents/<agentId>/sessions/*.jsonl` transcripts, excluding `sessions.json`, cron logs, and nested sidecars. It capability-detects the session header and message entries, preserves the `id`/`parentId` tree, and places each agent in a distinct source profile. Explicit transcript overrides outside the approved root are not followed.

Hermes discovery opens `state.db` read-only, verifies the required `sessions` and `messages` table capabilities, and reads session counts and timestamp range without reading message bodies. Import uses the monotonically increasing message row ID as a high-water mark and resets safely after database replacement or truncation.

Expose Claude Code, OpenClaw, and Hermes through dedicated npm command aliases backed by shared discovery/import command implementations. Codex retains its existing commands and follows the same approval contract.

## Consequences

- A fresh installation can bootstrap all four initial agent sources into one chronological person-level conversation.
- Native session and branch boundaries remain auditable but do not partition historical compaction.
- Tool-call provenance remains available without turning large or sensitive execution results into durable memory.
- Tool outputs and system prompts are intentionally excluded from durable canonical memory.
- Unsupported records are counted and skipped; durable quarantine inspection remains follow-on work.
- OpenClaw remote Gateway histories must be imported on the Gateway host or exported into an explicitly approved local root.
- Hermes import depends only on SQLite metadata and message tables and does not invoke Hermes itself.

## Format Evidence

- Claude Code local transcript schema remains observational rather than a stable public contract: <https://github.com/anthropics/claude-code/issues/53516>
- OpenClaw session persistence and transcript structure: <https://github.com/openclaw/openclaw/blob/main/docs/reference/session-management-compaction.md>
- Hermes session storage and SQLite schema: <https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/session-storage.md>
