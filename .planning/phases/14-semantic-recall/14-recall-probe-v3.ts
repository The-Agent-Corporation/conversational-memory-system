/**
 * Phase 14 recall probe. The frozen Phase 11 probe is unchanged.
 * These twelve questions are the same evaluation set, selected through the
 * current retriever so a later clone run can compare semantic top-K recall.
 */
export const RECALL_QUERIES_V3 = [
  "What did we decide about coverage?",
  "When is the next deadline?",
  "What preference did I state?",
  "Which project was active?",
  "What should be remembered?",
  "What changed in the plan?",
  "Who owns the follow-up?",
  "What was the budget?",
  "Which case names came up?",
  "What is still open?",
  "What did the journal say about routines?",
  "What should not be injected?"
] as const;

export function recallProbeQueries(): readonly string[] {
  return RECALL_QUERIES_V3;
}
