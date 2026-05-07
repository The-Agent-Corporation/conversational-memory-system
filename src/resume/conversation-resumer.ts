import type { Box, InjectionPacket, Summary, Turn, TurnRange } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface ResumeResult {
  sourceSummaryIds: string[];
  sourceTraceIds: string[];
  sourceBoxIds: string[];
  sourceTurnRanges: TurnRange[];
  turns: Turn[];
  turnCount: number;
  disclosureText: string;
}

export interface BoxResumeOptions {
  maxTurnRanges?: number;
  includeChildBoxes?: boolean;
}

interface ExpandRequest {
  sourceSummaryIds: string[];
  sourceTraceIds: string[];
  sourceBoxIds: string[];
  sourceTurnRanges: TurnRange[];
  subject: string;
  cappedRangeCount?: number;
}

export class ConversationResumer {
  constructor(private readonly store: MemoryStore) {}

  async resumeSummary(summaryId: string): Promise<ResumeResult> {
    const summaries = await this.store.listSummaries();
    const summary = summaries.find((candidate) => candidate.id === summaryId);

    if (!summary) {
      throw new Error(`Summary ${summaryId} was not found.`);
    }

    return this.expand({
      sourceSummaryIds: [summary.id],
      sourceTraceIds: [],
      sourceBoxIds: [],
      sourceTurnRanges: summary.sourceTurnRanges,
      subject: `${1} summary`
    });
  }

  async resumeInjection(packet: InjectionPacket): Promise<ResumeResult> {
    return this.expand({
      sourceSummaryIds: packet.sourceSummaryIds,
      sourceTraceIds: packet.sourceTraceIds,
      sourceBoxIds: packet.boxIds,
      sourceTurnRanges: packet.sourceTurnRanges,
      subject: `${new Set(packet.sourceSummaryIds).size} summary${new Set(packet.sourceSummaryIds).size === 1 ? "" : "ies"}`
    });
  }

  async resumeTrace(traceId: string): Promise<ResumeResult> {
    const trace = await this.store.getTrace(traceId);

    if (!trace) {
      throw new Error(`Trace ${traceId} was not found.`);
    }

    return this.expand({
      sourceSummaryIds: trace.summaryIds,
      sourceTraceIds: [trace.id],
      sourceBoxIds: trace.boxIds,
      sourceTurnRanges: trace.turnRanges,
      subject: `trace ${trace.id}`
    });
  }

  async resumeBox(boxId: string, options: BoxResumeOptions = {}): Promise<ResumeResult> {
    const box = await this.store.getBox(boxId);

    if (!box) {
      throw new Error(`Box ${boxId} was not found.`);
    }

    const maxTurnRanges = options.maxTurnRanges ?? 5;
    const boxes = options.includeChildBoxes ? await this.loadBoxWithChildren(box) : [box];
    const allRanges = boxes.flatMap((sourceBox) => sourceBox.turnRanges);
    const sourceTurnRanges = allRanges.slice(0, maxTurnRanges);
    const cappedRangeCount = allRanges.length > sourceTurnRanges.length
      ? allRanges.length - sourceTurnRanges.length
      : undefined;

    return this.expand({
      sourceSummaryIds: [...new Set(boxes.flatMap((sourceBox) => sourceBox.summaryIds))],
      sourceTraceIds: [],
      sourceBoxIds: boxes.map((sourceBox) => sourceBox.id),
      sourceTurnRanges,
      subject: `${boxes.length} box${boxes.length === 1 ? "" : "es"}`,
      cappedRangeCount
    });
  }

  private async loadBoxWithChildren(box: Box): Promise<Box[]> {
    const childBoxes = await Promise.all(box.childBoxIds.map((childBoxId) => this.store.getBox(childBoxId)));
    return [box, ...childBoxes.filter((childBox): childBox is Box => childBox !== null)];
  }

  private async expand(request: ExpandRequest): Promise<ResumeResult> {
    const sourceTurnRanges = dedupeTurnRanges(request.sourceTurnRanges);
    const turns = await loadTurnsForRanges(this.store, sourceTurnRanges);
    const cappedText = request.cappedRangeCount
      ? ` Omitted ${request.cappedRangeCount} additional source range${request.cappedRangeCount === 1 ? "" : "s"} due to the resume range cap.`
      : "";

    return {
      sourceSummaryIds: [...new Set(request.sourceSummaryIds)],
      sourceTraceIds: [...new Set(request.sourceTraceIds)],
      sourceBoxIds: [...new Set(request.sourceBoxIds)],
      sourceTurnRanges,
      turns,
      turnCount: turns.length,
      disclosureText: `Expanded ${request.subject} into ${turns.length} verbatim turn${turns.length === 1 ? "" : "s"}.${cappedText}`
    };
  }
}

async function loadTurnsForRanges(store: MemoryStore, ranges: TurnRange[]): Promise<Turn[]> {
  const turnsByKey = new Map<string, Turn>();

  for (const range of ranges) {
    const threadTurns = await store.listTurns(range.threadId);
    for (const turn of threadTurns) {
      if (turn.sequence < range.startSequence || turn.sequence > range.endSequence) {
        continue;
      }

      turnsByKey.set(turnKey(turn), turn);
    }
  }

  return [...turnsByKey.values()].sort(
    (left, right) => left.threadId.localeCompare(right.threadId) || left.sequence - right.sequence
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

function turnKey(turn: Turn): string {
  return `${turn.threadId}:${turn.sequence}:${turn.id}`;
}
