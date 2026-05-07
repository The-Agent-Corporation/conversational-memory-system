# Trace and Box Resume Expansion Design

## Purpose

Trace-aware retrieval can now recall approved traces and include `sourceTraceIds` in injection packets. The next accordion step is explicit expansion: a host agent should be able to ask for the verbatim conversation behind a trace or a bounded set of turns behind an approved box.

This phase extends the existing resume path. It does not add new retrieval ranking or sleep planning.

## Product Goal

When memory injection surfaces a trace, the agent should be able to follow up with:

- "Expand this trace."
- "Open the Smith PIP provider bill thread."
- "Show the source turns for this box, but keep it bounded."

Trace expansion should behave like opening a specific issue thread. Box expansion should be more guarded because boxes can represent broad parent cases.

## Current Baseline

Implemented:

- `ConversationResumer.resumeSummary(summaryId)`
- `ConversationResumer.resumeInjection(packet)`
- `hermes:resume` accepting `summary_id` or `injection_packet`
- `MemoryStore.getTrace`
- `MemoryStore.getBox`
- injection packets with `sourceTraceIds`

Missing:

- `ConversationResumer.resumeTrace(traceId)`
- `ConversationResumer.resumeBox(boxId, options)`
- `hermes:resume` request forms for `trace_id` and `box_id`
- box expansion limits and clear disclosure text
- ADR for trace/box resume expansion

## Design Principles

1. Trace resume expands exact trace turn ranges.
2. Box resume is bounded by default.
3. Parent boxes do not automatically expand child boxes.
4. Resume blocks remain verbatim background context, not instructions.
5. Expansion results preserve source summary ids, source trace ids, source box ids, and turn ranges.
6. Missing ids fail clearly.
7. This remains deterministic and local.

## API Design

Extend `ResumeResult`:

```ts
sourceSummaryIds: string[];
sourceTraceIds: string[];
sourceBoxIds: string[];
sourceTurnRanges: TurnRange[];
turns: Turn[];
turnCount: number;
disclosureText: string;
```

Existing summary and injection callers get empty arrays for fields that do not apply.

Add:

```ts
resumeTrace(traceId: string): Promise<ResumeResult>;
resumeBox(boxId: string, options?: BoxResumeOptions): Promise<ResumeResult>;
```

`BoxResumeOptions`:

```ts
{
  maxTurnRanges?: number;
  includeChildBoxes?: boolean;
}
```

Default behavior:

- `maxTurnRanges: 5`
- `includeChildBoxes: false`

## Hermes Command Design

Extend `hermes:resume` request union to accept exactly one of:

- `summary_id`
- `trace_id`
- `box_id`
- `injection_packet`

Optional box fields:

- `max_turn_ranges`
- `include_child_boxes`

Examples:

```json
{ "trace_id": "trace_smith_pip_provider_bills" }
```

```json
{
  "box_id": "box_smith_pip",
  "max_turn_ranges": 3
}
```

## Box Expansion Semantics

Box expansion loads the approved box by id and expands its own `turnRanges`, capped by `maxTurnRanges`. It does not expand child boxes unless `includeChildBoxes` is true.

When `includeChildBoxes` is true, child boxes are loaded by id and their ranges are appended after the parent ranges, still respecting the same `maxTurnRanges` cap.

Disclosure text must say whether the result was capped.

## Testing Strategy

Add unit tests for:

- trace resume expands exact trace ranges
- trace resume preserves source trace and summary ids
- missing trace throws a clear error
- box resume expands bounded own ranges
- box resume excludes child ranges by default
- box resume can include child ranges when explicitly requested
- box resume disclosure says when ranges were capped
- missing box throws a clear error

Add Hermes integration tests for:

- `trace_id`
- `box_id`
- invalid request containing multiple ids

## Out of Scope

This phase does not implement:

- LLM summarization of resumed turns
- automatic child expansion
- cross-profile resume
- UI memory browser
- case-management integration
- trace merge/supersession logic

## Self-Review

- Placeholder scan: no incomplete requirements remain.
- Scope check: this is a single resume expansion phase.
- Compatibility: existing summary and injection resume behavior remains supported.
