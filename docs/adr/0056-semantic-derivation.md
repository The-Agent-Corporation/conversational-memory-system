# ADR 0056: Semantic Derivation

## Status

Accepted.

## Context

Topic labels were the first six non-stopword tokens, and a summary id hashed that label. A model title would churn ids. Boundaries that share no words split legal and personal threads that are actually one subject. Calling a chat model on every open slice is unnecessary spend.

## Decision

Semantic mode is opt-in through `${db}.semantic.json`.

- While a span is open, contraction uses the deterministic summarizer.
- The chat model runs when the span completes, or at the end of the corpus. The prompt is a personal-agent frame that preserves domain terms (PIP versus BI, case names, coverage types) when they appear. Prompt version is `openrouter-summarizer-v2`.
- In semantic mode the summary id hashes `(personId, firstEventId, boundaryVersion)`, not the label.
- `SemanticTopicMonitor` splits a topic when cosine similarity to the running topic vector drops below 0.72 (`semantic-boundary/v1`). Regex anchors still mint. Model anchors augment them.
- The daemon passes this summarizer into `ContractionRunner`. `memory rebuild-derivations` does the same when semantic mode is enabled.
- Box proposals may use `OpenRouterProposalPlanner`. Trace discovery stays off unless the semantic config turns it on. Nothing is auto-approved.

## Consequences

Checkpoints already embed the hygiene rule version. `hygiene-rules/v5` adds journal `origin` as `synthetic_injected`, which marks older contraction checkpoints stale through the existing processor version.
