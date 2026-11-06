# Plan 13-01 Summary

GAP-12-E. The daemon and `hermes:sleep` inject `NullTraceProposalPlanner` (ADR 0061). The shared-term matcher is unchanged and unreachable from `src/daemon/`.

`traceDiscoveryEnabled` stays the semantic-config default-off gate. It does not reattach `DeterministicTraceProposalPlanner` on the daemon path. A `reviewerFactory` still owns its reviewer. An explicit OpenRouter bundle still overrides the null planner because it is spread after the default.

`memory hermes:sleep` does not gain vector trace discovery in this plan. That would need a person and allowed scopes the sleep request does not carry, and a second writer to the Phase 13 checkpoint without the daemon lease. Both stay deferred for ADR 0061 (plan 13-12).

The smoke harness no longer pinned `trace_smith_pip_provider_bill`. Its sleep assertion is now an empty `proposedTraceIds`, with the old value named in the test comment. `tests/traces/trace-proposal-planner.test.ts` and `tests/sleep/sleep-reviewer.test.ts` are unedited.
