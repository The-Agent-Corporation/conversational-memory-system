# Plan 13-02 Summary

GAP-12-D. Decay is `min(current strength, DECAY_BASELINE_STRENGTH × 0.5^(elapsed half-lives))` (ADR 0061). A second pass at the same clock writes nothing. Ten passes at one timestamp do not compound. A weak recently accessed summary is not raised.

`strength` is a recency bound, not an accumulator. A mid-strength summary decays less per pass and reaches `stale` later, so the stale population after a pass changes shape. Retrieval reinforcement (`reinforceSummary`, ADR 0066) is not decay and is unchanged. Plan 13-12 should carry both in ADR 0061's "not addressed here".

The three pinned decay tests changed two expectations, each commented with GAP-12-D and the old value. The "review time is not after the reference" test is unchanged.

`decaySummaries` loads `states: DECAY_ELIGIBLE_STATES` and re-checks that predicate in the loop. `refreshBoxStates` still calls unfiltered `listSummaries()`; that full-table load is out of this plan.

No `SummarySchema` field, store method, or scheduler wiring was added. `hermes:sleep` drops `summary_old` from `updatedSummaryIds` because its strength is already at the bound.
