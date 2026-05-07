# OpenRouter Sleep Planners Design

## Purpose

Sleep review currently proposes boxes and traces through deterministic keyword planners. That keeps tests stable, but it cannot reason well about legal case structure, recurring issue boundaries, or when a proposed box should be narrower than its first two tokens.

This phase adds optional OpenRouter-backed planning behind the same proposal contracts. Deterministic planners remain the default and the offline test oracle.

## Product Goal

When configured, sleep review should be able to ask a model to review compacted summaries and propose better memory organization:

- topic boxes with titles, summaries, evidence, and candidate parents
- parent/child relationships when the hierarchy is clear
- trace proposals for recurring non-contiguous issue threads

The model should produce proposals only. It should not approve proposals, mutate approved structure directly, or invent source ids.

## Current Baseline

Implemented:

- `DeterministicBoxProposalPlanner`
- `DeterministicTraceProposalPlanner`
- `SleepReviewer.proposeBoxes`
- `SleepReviewer.proposeTraces`
- `hermes:sleep`
- `OpenRouterSummarizer` with testable fetch injection and typed errors
- proposal review commands

Missing:

- shared planner interfaces exposed as injectable contracts
- OpenRouter planner implementation
- runtime selection for `proposal_mode: "openrouter"` or `"hybrid"`
- tests that validate model JSON and malformed-model failure handling

## Design Principles

1. Deterministic remains the default.
2. OpenRouter planners return proposed records only.
3. Every model proposal must reference existing summary ids and turn ranges.
4. Invalid model output fails before persistence.
5. Hybrid mode runs OpenRouter first and falls back to deterministic only when no OpenRouter configuration is present, not when the model returns malformed content.
6. Prompt payloads stay compact and avoid verbatim full-history dumps.
7. The proposal schemas remain the storage boundary.

## Architecture

Add OpenRouter-backed planners in a new module:

- `src/proposals/openrouter-proposal-planner.ts`

The module exposes:

```ts
OpenRouterProposalPlanner
OpenRouterProposalPlannerError
OpenRouterProposalPlannerOptions
createProposalPlannersFromEnv
```

`OpenRouterProposalPlanner` implements both box and trace planning methods:

```ts
proposeBoxes(request: BoxProposalPlanningRequest): Promise<BoxProposalPlanningResult>
proposeTraces(request: TraceProposalPlanningRequest): Promise<TraceProposalPlanningResult>
```

`SleepReviewer` accepts optional planner dependencies:

```ts
new SleepReviewer(store, { boxPlanner, tracePlanner })
```

`hermes:sleep` chooses planner mode:

- `deterministic`: existing behavior
- `openrouter`: require OpenRouter planner configuration
- `hybrid`: use OpenRouter when configured, otherwise deterministic

## Model Contract

The model returns JSON:

```json
{
  "boxProposals": [
    {
      "boxId": "box_topic_smith_pip_provider_bills",
      "title": "Smith PIP Provider Bills",
      "description": "Provider billing issue within Smith PIP.",
      "summary": "The summaries concern Smith PIP provider bills and ledger review.",
      "boxType": "topic",
      "candidateParentBoxId": "box_case_smith",
      "keywords": ["smith", "pip", "provider", "bill"],
      "evidence": ["summary_1 discusses provider bill review", "summary_2 continues the issue"],
      "sourceSummaryIds": ["summary_1", "summary_2"],
      "confidence": 0.84,
      "rationale": "The summaries share a specific provider bill issue."
    }
  ],
  "parentChildProposals": [
    {
      "parentBoxId": "box_case_smith",
      "childBoxId": "box_topic_smith_pip_provider_bills",
      "relationshipLabel": "case issue",
      "rationale": "The child is a specific issue under the Smith case.",
      "sourceSummaryIds": ["summary_1", "summary_2"],
      "confidence": 0.78
    }
  ],
  "traceProposals": [
    {
      "traceId": "trace_smith_pip_provider_bills",
      "title": "Smith PIP Provider Bills",
      "description": "Non-contiguous summaries continue the same provider bill issue.",
      "traceType": "case_issue",
      "summaryIds": ["summary_1", "summary_2"],
      "boxIds": ["box_topic_smith_pip_provider_bills"],
      "continuityReason": "Both summaries discuss the provider bill ledger.",
      "boundaryReason": "BI coverage summaries were excluded.",
      "keywords": ["smith", "pip", "provider", "bill"],
      "confidence": 0.86,
      "rationale": "The issue recurs across separated turns."
    }
  ]
}
```

The implementation validates:

- referenced summary ids exist
- referenced box ids exist or are being proposed in the same response
- confidence is within `0..1`
- proposal payloads satisfy existing Zod schemas
- duplicate proposal ids are skipped using existing duplicate checks

## Prompt Shape

The prompt frames the model as a background reviewer. It receives compact records:

- summaries: id, text, source ranges, box ids, state, created time
- boxes: id, title, summary, parent, children, type, state
- pending proposals: ids, type, title, targets
- approved traces: ids, title, summaries, boxes

The prompt explicitly says:

- return JSON only
- do not approve anything
- do not invent ids
- prefer no proposal over weak organization
- preserve legal/case distinctions such as PIP vs BI

## Error Handling

OpenRouter planner errors are typed:

- missing API key/model
- non-OK response
- invalid chat JSON
- invalid planner JSON
- schema-invalid proposal output

`openrouter` mode propagates errors. `hybrid` mode falls back to deterministic only when OpenRouter configuration is absent.

## Testing Strategy

Unit tests:

- box proposals are built from valid OpenRouter JSON
- parent/child proposals are built from valid OpenRouter JSON
- trace proposals are built from valid OpenRouter JSON
- model proposals with unknown summary ids fail
- malformed model JSON fails with `OpenRouterProposalPlannerError`
- non-OK response fails with status

Integration tests:

- `hermes:sleep` accepts `proposal_mode: "openrouter"` with injected planner factory
- `proposal_mode: "deterministic"` remains default
- `proposal_mode: "hybrid"` falls back to deterministic when no OpenRouter config exists

## Out of Scope

This phase does not implement:

- automatic proposal approval
- multi-step model deliberation
- web dashboard review
- vector embeddings for trace ranking
- case-management system facts/entities
- actual network tests against OpenRouter

## Self-Review

- Placeholder scan: no incomplete sections remain.
- Scope check: this phase is planner selection and model-backed proposal generation only.
- Compatibility: deterministic mode remains default and existing command output remains stable.
