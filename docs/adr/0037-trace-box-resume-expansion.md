# ADR 0037: Trace and Box Resume Expansion

## Status

Accepted

## Context

Trace-aware retrieval can surface approved traces and include `sourceTraceIds` in injection packets. Before this decision, `hermes:resume` could expand summaries or injection packets, but it could not directly expand a trace or an approved box.

The accordion model needs both levels: specific issue traces should expand exactly, while boxes need bounded expansion because they can represent broad cases or projects.

## Decision

`ConversationResumer` will support:

- `resumeTrace(traceId)`
- `resumeBox(boxId, options)`

Trace resume expands the trace's exact turn ranges and returns trace, summary, box, and turn-range provenance.

Box resume expands the box's own turn ranges by default. Child boxes are included only when explicitly requested, and source ranges are capped by `maxTurnRanges` with a default of five.

`hermes:resume` accepts exactly one of `summary_id`, `trace_id`, `box_id`, or `injection_packet`. Box-specific options are valid only with `box_id`.

## Consequences

- Hosts can open the verbatim source behind a retrieved trace.
- Broad boxes are protected from unbounded expansion by default.
- Resume results now include summary, trace, and box provenance.
- Future UI or agent workflows can offer "expand trace" and "expand box" as distinct actions.
