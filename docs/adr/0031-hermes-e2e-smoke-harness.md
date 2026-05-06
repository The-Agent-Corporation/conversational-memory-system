# ADR 0031: Hermes End-to-End Smoke Harness

## Status

Accepted.

## Context

The standalone memory system now exposes command bridges for Roscoe-Hermes:

- `hermes:ingest`
- `hermes:inject`
- `hermes:resume`

Roscoe also has host-side tools for memory search and resume. The next risk is no longer an isolated command contract; it is whether the same SQLite store can support the full accordion loop from captured timeline rows to compacted memory, quiet injection, and verbatim resume.

## Decision

Add `hermes:smoke`.

The smoke harness runs a deterministic local scenario:

1. ingest two Smith PIP timeline rows
2. ingest `/new` as a compaction boundary
3. request memory injection for a later Smith PIP query
4. resume the injected packet into verbatim source turns
5. print the Roscoe environment variables for the same database

The harness is a local validation tool, not a production worker.

## Consequences

- The Roscoe integration loop can be tested before changing more host runtime code.
- The command names and environment variables are now represented in executable code.
- Future host adapters can get similar smoke harnesses without depending on Roscoe internals.

## Roscoe Configuration

For a local memory database at `/path/to/memory.sqlite`, configure Roscoe with:

```sh
export HERMES_CONVERSATIONAL_MEMORY_DB=/path/to/memory.sqlite
export HERMES_CONVERSATIONAL_MEMORY_COMMAND="npm --prefix /Users/aaronwhaley/Github/conversational-memory-system run hermes:ingest -- --db /path/to/memory.sqlite"
export HERMES_CONVERSATIONAL_MEMORY_INJECT_COMMAND="npm --prefix /Users/aaronwhaley/Github/conversational-memory-system run hermes:inject -- --db /path/to/memory.sqlite"
export HERMES_CONVERSATIONAL_MEMORY_RESUME_COMMAND="npm --prefix /Users/aaronwhaley/Github/conversational-memory-system run hermes:resume -- --db /path/to/memory.sqlite"
```

Run the local smoke check with:

```sh
npm run hermes:smoke -- --db /path/to/memory.sqlite
```
