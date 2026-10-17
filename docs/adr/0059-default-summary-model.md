# ADR 0059: Default Summary Model

## Status

Accepted.

## Context

Semantic mode used one `chatModel` for span summaries and for box proposal planning, with no default. The Phase 14 bakeoff (`.planning/phases/14-semantic-recall/BAKEOFF.md`) compared four models on the v3 summary prompt. `anthropic/claude-haiku-5.5` passed every case and was the fastest and cheapest. It also lowered `confidence` when the speaker was unsure. The bakeoff did not test the box planner.

## Decision

`${db}.semantic.json` gains `summaryModel`, which defaults to `anthropic/claude-haiku-5.5`.

- With `enabled: true`, the daemon and `memory rebuild-derivations` summarize completed spans with `summaryModel`. A blank `summaryModel` keeps summaries deterministic.
- `chatModel` now drives only the box proposal planner, and the planner stays deterministic while `chatModel` is blank.
- `enabled` still defaults to `false`, so no paid call happens without opting in.
- `createSummarizerFromEnv` is unchanged. A host that only exports `OPENROUTER_API_KEY` stays deterministic, and `OPENROUTER_MODEL` still picks the model there.

## Consequences

An enabled config that set only `chatModel` now summarizes with Haiku and keeps its planner model. Setting `summaryModel` restores a different summary model. In semantic mode the summary id ignores the model, so switching models does not churn ids. Each summary still records the model that wrote it.
