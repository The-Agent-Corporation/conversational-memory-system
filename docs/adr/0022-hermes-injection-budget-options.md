# ADR 0022: Hermes Injection Budget Options

## Status

Accepted

## Context

Core retrieval supports `maxMemoryTokens`, but `HermesMemoryAdapter.prepareCurrentTopicInjection` only accepted a positional `requestedAt` string. That prevented Hermes or a future context assembler from passing memory budget information through the adapter.

## Decision

Allow `prepareCurrentTopicInjection` to accept either:

- the existing `requestedAt` string
- an options object with `requestedAt` and `maxMemoryTokens`

The adapter passes both values through to `MemoryService.prepareInjection`.

## Consequences

- Existing callers remain compatible.
- Hermes can cap injected memory without reaching into core retrieval.
- The budget-packing and stub-fallback behavior is now reachable through the first host adapter.
