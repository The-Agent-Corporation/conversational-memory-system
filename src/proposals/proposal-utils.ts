import type { MemoryProposal, Summary, TurnRange } from "../domain/types.js";

export const COMMON_TERMS = new Set([
  "about", "and", "are", "case", "coverage", "discussed", "for", "from",
  "issue", "legal", "matter", "review", "strategy", "the", "this", "that",
  "with"
]);

export function significantTerms(text: string): string[] {
  return [...new Set(text.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2 && !COMMON_TERMS.has(term)))];
}

export function sharedTerms(left: string[] | Set<string>, right: string[] | Set<string>): string[] {
  const leftSet = left instanceof Set ? left : new Set(left);
  const rightSet = right instanceof Set ? right : new Set(right);
  return [...leftSet].filter((term) => rightSet.has(term)).sort();
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.length <= 3 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function dedupeTurnRanges(ranges: TurnRange[]): TurnRange[] {
  const seen = new Set<string>();
  return ranges.filter((range) => {
    const key = `${range.threadId}:${range.startSequence}:${range.endSequence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function latestSummaryTimestamp(summaries: Summary[], fallback: string): string {
  return summaries.map((summary) => summary.createdAt).sort().at(-1) ?? fallback;
}

export function hasExistingProposal(proposals: MemoryProposal[], proposalId: string): boolean {
  return proposals.some((proposal) => proposal.id === proposalId && proposal.state === "proposed");
}
