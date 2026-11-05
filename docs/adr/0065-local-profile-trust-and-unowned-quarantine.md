# ADR 0065: Local Profile Trust and Unowned-Row Quarantine

## Status

Accepted

## Context

A local MCP profile selects the database, person, and allowed scopes for one child process. Derived rows from earlier imports can omit `personId`. Assigning those rows to the operator's person, or to whichever profile happens to be open, would invent ownership.

## Decision

The profile file is local trust. Whoever can read the file and start the process can use that person and those scopes. It is not remote authentication, and it does not prove the operator's identity to another machine.

Rows among summaries, boxes, traces, and anchors with no `personId` are quarantined by `memory quarantine-unowned`. The quarantine `personId` is the marker `legacy-unowned`. That marker is not a person and must not be configured as a profile person. The original row is removed. Its text is redacted and stored on the quarantine record. Owned rows are left unchanged. Dry-run is the default. `--apply` also requires a non-empty backup file that is not the database or a link to it.

## Consequences

Operators restore unowned rows only from the backup they confirmed, not by guessing a person. Retrieval for a real person does not see the marker or the removed rows.
