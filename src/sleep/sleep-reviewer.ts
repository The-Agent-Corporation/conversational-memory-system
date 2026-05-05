import type { Box, Summary, TurnRange } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface SleepReviewRequest {
  reviewedAt: string;
  minimumSummariesPerBox?: number;
  staleStrengthThreshold?: number;
}

export interface SleepReviewResult {
  proposedBoxes: Box[];
}

export interface SummaryDecayResult {
  updatedSummaries: Summary[];
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

  async decaySummaries(request: SleepReviewRequest): Promise<SummaryDecayResult> {
    const summaries = await this.store.listSummaries();
    const updatedSummaries: Summary[] = [];
    const staleStrengthThreshold = request.staleStrengthThreshold ?? 0.2;

    for (const summary of summaries) {
      const decayed = decaySummary(summary, request.reviewedAt, staleStrengthThreshold);

      if (!decayed) {
        continue;
      }

      await this.store.saveSummary(decayed);
      updatedSummaries.push(decayed);
    }

    return { updatedSummaries };
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

function decaySummary(
  summary: Summary,
  reviewedAt: string,
  staleStrengthThreshold: number
): Summary | null {
  if (!isDecayEligible(summary)) {
    return null;
  }

  const referenceAt = summary.lastAccessedAt ?? summary.retrievedAt ?? summary.createdAt;
  const ageHours = hoursBetween(referenceAt, reviewedAt);

  if (ageHours <= 0) {
    return null;
  }

  const decayedStrength = roundStrength(
    summary.strength * Math.pow(0.5, ageHours / summary.halfLifeHours)
  );
  const decayedState = decayedStrength < staleStrengthThreshold ? "stale" : summary.state;

  if (decayedStrength === summary.strength && decayedState === summary.state) {
    return null;
  }

  return {
    ...summary,
    strength: decayedStrength,
    state: decayedState
  };
}

function isDecayEligible(summary: Summary): boolean {
  return summary.state === "compacted" || summary.state === "active" || summary.state === "revived" || summary.state === "stale";
}

function hoursBetween(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / (1000 * 60 * 60);
}

function roundStrength(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(2));
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
