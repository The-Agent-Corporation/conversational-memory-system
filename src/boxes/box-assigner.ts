import type { Box, Summary, TurnRange } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";

export class BoxAssigner {
  constructor(private readonly store: MemoryStore) {}

  async assignSummary(summary: Summary): Promise<Summary> {
    const boxes = await this.store.listBoxes();
    const match = bestMatchingBox(summary, boxes);

    if (!match) {
      return summary;
    }

    const assignedSummary: Summary = {
      ...summary,
      boxIds: [...new Set([...summary.boxIds, match.id])]
    };

    await this.store.saveBox(updateBoxAggregate(match, assignedSummary));
    return assignedSummary;
  }
}

function bestMatchingBox(summary: Summary, boxes: Box[]): Box | null {
  const summaryTokens = significantTokens(summary.summaryText);
  const matches = boxes
    .filter((box) => box.personId === summary.personId)
    .filter((box) => isAssignableState(box.state))
    .filter((box) => titleTokens(box).every((token) => summaryTokens.has(token)))
    .sort((left, right) => titleTokens(right).length - titleTokens(left).length || left.id.localeCompare(right.id));

  return matches[0] ?? null;
}

function updateBoxAggregate(box: Box, summary: Summary): Box {
  return {
    ...box,
    summaryIds: [...new Set([...box.summaryIds, summary.id])],
    turnRanges: dedupeTurnRanges([...box.turnRanges, ...summary.sourceTurnRanges]),
    summary: appendSummaryText(box.summary, summary.summaryText),
    updatedAt: summary.createdAt,
    lastActivityAt: latestTimestamp([box.lastActivityAt, summary.createdAt])
  };
}

function appendSummaryText(existing: string, next: string): string {
  if (existing.includes(next)) {
    return existing;
  }

  return [existing.trim(), next.trim()].filter(Boolean).join("\n\n");
}

function isAssignableState(state: Box["state"]): boolean {
  return state === "approved" || state === "active" || state === "revived";
}

function titleTokens(box: Box): string[] {
  return [...significantTokens(box.title)];
}

function significantTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1)
      .filter((token) => !STOP_WORDS.has(token))
  );
}

function dedupeTurnRanges(ranges: TurnRange[]): TurnRange[] {
  const seen = new Set<string>();
  const deduped: TurnRange[] = [];

  for (const range of ranges) {
    const key = `${range.threadId}:${range.startSequence}:${range.endSequence}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(range);
    }
  }

  return deduped;
}

function latestTimestamp(timestamps: string[]): string {
  return [...timestamps].sort().at(-1) ?? timestamps[0];
}

const STOP_WORDS = new Set([
  "and",
  "case",
  "coverage",
  "general",
  "matter",
  "topic",
  "with"
]);
