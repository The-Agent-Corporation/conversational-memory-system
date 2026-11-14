# ADR 0067: Grok CLI History Import Boundary

## Status

Accepted

## Context

Grok CLI stores transcripts beneath `~/.grok/sessions/<url-encoded cwd>/<session-uuid>`.
One sessions tree may therefore contain several workspaces, while source grants have one immutable
scope. Transcript reasoning items also contain a readable summary and encrypted reasoning material;
neither is ordinary user-visible assistant output.

## Decision

Discovery returns one candidate for each direct, non-symlink workspace directory under the sessions
root. The decoded absolute cwd is that candidate's immutable scope. Approval and import operate on
that workspace directory, never the parent tree, and import revalidates the candidate identity and
decoded scope before reading content.

The importer reads only regular `<session-uuid>/chat_history.jsonl` files and their sibling
`events.jsonl` timestamp sidecars. It accepts user and assistant text plus compact assistant tool
calls. It skips system content, tool results, reasoning summaries, `encrypted_content`, indexes,
uploads, authentication data, and all unrelated sidecars. Recognized exclusions do not enter either
canonical history or quarantine. Supporting reasoning summaries later requires a separate canonical
representation and retrieval decision.

Turn timestamps are joined by `turn_number` from `events.jsonl`. Missing or unusable timestamps fall
back to the transcript mtime with explicit low-confidence provenance. Accepted text and tool-call
summaries pass through the import redactor. Malformed or unsupported transcript and event records use
the bounded quarantine contract from ADR 0045. Checkpoints and deterministic native identities make
replay idempotent under ADR 0053.

Discovery is metadata-only. Import is read-only against Grok's files, and a real source remains
blocked until its per-workspace candidates receive explicit owner approval.

## Consequences

An approved workspace cannot authorize a sibling workspace. Hidden or encrypted reasoning cannot
become durable memory through canonical events or quarantine. A transcript whose event sidecar is
missing or partially malformed remains importable, but its fallback timestamp provenance makes that
lower confidence visible.
