# ADR 0064: Hermes Uses the Generic MCP Client

## Status

Accepted

## Context

Hermes ingest, search, and resume were in-process commands with their own identity environment. That made Hermes a privileged path. Search also wrote an injection packet. The public contract is the local stdio MCP profile.

## Decision

`hermes:ingest`, `hermes:inject`, and `hermes:resume` are thin clients of the MCP server selected by `--config` and `--profile`.

- Ingest calls `memory_append_turn` with host name `hermes`. Control signals are ignored. They do not compact or choose a person.
- `hermes:inject` calls `memory_search`. It does not call `prepareInjection` and does not write a packet, strengthen a summary, or revive one.
- Resume calls `memory_resume`. A caller-supplied injection packet contributes only its saved id. Raw turn ranges are not accepted.
- `HERMES_MEMORY_PERSON_ID` and `HERMES_MEMORY_SCOPE_IDS` are not read.
- The wrappers are compatibility for existing command hooks and are scheduled for removal after 2026-12-05.

## Consequences

Hermes has the same authority as any other local MCP client. A profile file is required. Live search no longer mutates memory. This replaces the Hermes environment identity described in ADR 0062.
