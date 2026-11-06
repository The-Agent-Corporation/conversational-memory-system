import type {
  TraceProposalPlanner,
  TraceProposalPlanningRequest,
  TraceProposalPlanningResult
} from "./trace-proposal-planner.js";

/**
 * GAP-12-E holding action (ADR 0061, `13-ADR-NUMBER.md`).
 *
 * The shared-term all-pairs pass produced 449,103 distinct traces on 5,138 summaries and did not
 * finish in 18 minutes at 56,706 summaries (`12-CLOSING.md`). This planner makes that pass
 * unreachable from the daemon and from `hermes:sleep`. Plan 13-10 replaces it with
 * `VectorTraceDiscovery`. It does not tune the matcher.
 */
export class NullTraceProposalPlanner implements TraceProposalPlanner {
  async proposeTraces(_request: TraceProposalPlanningRequest): Promise<TraceProposalPlanningResult> {
    return { proposals: [], skippedCandidates: [] };
  }
}
