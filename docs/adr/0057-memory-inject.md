# ADR 0057: memory_inject Tool Class and Profile Opt-In

## Status

Accepted.

## Context

`memory_recall` is a read. `prepareInjection` writes an injection packet and strengthens selected summaries. Exposing that write on the MCP server by default would make every profile a writer.

## Decision

`memory_inject` takes `{ hostSessionId, currentTopicSummary, maxMemoryTokens }`. Person, scopes, and host come from the loaded profile.

- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: false`.
- `allowInjection` defaults to false. A profile that omits it cannot inject.
- The tool opens a short-lived writable SQLite connection with WAL and `busy_timeout`. It does not take the daemon lease.
- `memory_recall` stays read-only.

## Consequences

Existing MCP profiles remain read-only until `allowInjection` is set true.
