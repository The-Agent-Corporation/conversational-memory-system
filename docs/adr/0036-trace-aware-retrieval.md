# ADR 0036: Trace-Aware Retrieval

## Status

Accepted

## Context

Proposal approval can create approved traces and box hierarchies, but retrieval previously ranked only summaries and anchors. Approved memory structure therefore existed without affecting foreground agent context.

## Decision

Memory retrieval will rank approved traces as primary candidates and append bounded parent box context after a selected child memory. Injection packets will include `sourceTraceIds` so trace provenance is auditable.

Trace ranking remains deterministic keyword overlap in this phase. Traces require specific overlap and ignore proposed, rejected, and superseded records.

## Consequences

- Agents can resume recurring issue threads without loading entire cases.
- Parent case context can appear when a child issue is selected.
- Broad parent queries are less likely to over-inject child traces.
- Future trace embedding or LLM reranking can be added behind the same candidate shape.
