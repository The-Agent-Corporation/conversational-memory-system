import type { Box, Summary, TurnRange } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface SleepReviewRequest {
  reviewedAt: string;
  minimumSummariesPerBox?: number;
}

export interface SleepReviewResult {
  proposedBoxes: Box[];
}

export class SleepReviewer {
  constructor(private readonly store: MemoryStore) {}

  async proposeBoxes(request: SleepReviewRequest): Promise<SleepReviewResult> {
    const [summaries, boxes] = await Promise.all([
      this.store.listSummaries(),
      this.store.listBoxes()
    ]);
    const existingTitles = new Set(boxes.map((box) => normalizeTitle(box.title)));
    const groups = groupSummaries(summaries);
    const minimumSummaries = request.minimumSummariesPerBox ?? 2;
    const proposedBoxes: Box[] = [];

    for (const group of groups.values()) {
      if (group.summaries.length < minimumSummaries || existingTitles.has(normalizeTitle(group.title))) {
        continue;
      }

      const box = buildProposedBox(group.title, group.summaries, request.reviewedAt);
      await this.store.saveBox(box);
      proposedBoxes.push(box);
    }

    return { proposedBoxes };
  }
}

interface SummaryGroup {
  title: string;
  summaries: Summary[];
}

function groupSummaries(summaries: Summary[]): Map<string, SummaryGroup> {
  const groups = new Map<string, SummaryGroup>();

  for (const summary of summaries) {
    const title = proposedTitle(summary);
    const key = normalizeTitle(title);
    const group = groups.get(key) ?? { title, summaries: [] };
    group.summaries.push(summary);
    groups.set(key, group);
  }

  return groups;
}

function proposedTitle(summary: Summary): string {
  const words = summary.summaryText
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 2)
    .filter((word) => !STOP_WORDS.has(word.toLowerCase()))
    .slice(0, 2);

  if (words.length === 0) {
    return "General Topic";
  }

  return titleCase(words.join(" "));
}

function buildProposedBox(title: string, summaries: Summary[], reviewedAt: string): Box {
  return {
    id: `box_topic_${slugify(title)}`,
    title,
    description: `Proposed topic box from ${summaries.length} related summaries.`,
    parentBoxId: null,
    childBoxIds: [],
    summaryIds: summaries.map((summary) => summary.id),
    turnRanges: dedupeTurnRanges(summaries.flatMap((summary) => summary.sourceTurnRanges)),
    state: "proposed",
    createdAt: reviewedAt,
    updatedAt: reviewedAt,
    caseId: null,
    boxType: "topic",
    summary: summaries.map((summary) => summary.summaryText).join("\n\n"),
    lastActivityAt: latestTimestamp(summaries.map((summary) => summary.createdAt)) ?? reviewedAt
  };
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

function latestTimestamp(timestamps: string[]): string | null {
  return timestamps.sort().at(-1) ?? null;
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const STOP_WORDS = new Set([
  "about",
  "and",
  "coverage",
  "demand",
  "discussed",
  "for",
  "from",
  "issue",
  "strategy",
  "the",
  "timing",
  "with"
]);
