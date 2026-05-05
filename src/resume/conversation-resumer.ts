import type { InjectionPacket, Summary, Turn, TurnRange } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface ResumeResult {
  sourceSummaryIds: string[];
  sourceTurnRanges: TurnRange[];
  turns: Turn[];
  turnCount: number;
  disclosureText: string;
}

export class ConversationResumer {
  constructor(private readonly store: MemoryStore) {}

  async resumeSummary(summaryId: string): Promise<ResumeResult> {
    const summaries = await this.store.listSummaries();
    const summary = summaries.find((candidate) => candidate.id === summaryId);

    if (!summary) {
      throw new Error(`Summary ${summaryId} was not found.`);
    }

    return this.expand([summary.id], summary.sourceTurnRanges);
  }

  async resumeInjection(packet: InjectionPacket): Promise<ResumeResult> {
    return this.expand(packet.sourceSummaryIds, packet.sourceTurnRanges);
  }

  private async expand(sourceSummaryIds: string[], sourceTurnRanges: TurnRange[]): Promise<ResumeResult> {
    const turns = await loadTurnsForRanges(this.store, sourceTurnRanges);

    return {
      sourceSummaryIds: [...new Set(sourceSummaryIds)],
      sourceTurnRanges: dedupeTurnRanges(sourceTurnRanges),
      turns,
      turnCount: turns.length,
      disclosureText: `Expanded ${new Set(sourceSummaryIds).size} summary${new Set(sourceSummaryIds).size === 1 ? "" : "ies"} into ${turns.length} verbatim turn${turns.length === 1 ? "" : "s"}.`
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
