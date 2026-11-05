import type { Box, InjectionPacket, MemoryTrace, Summary, Turn, TurnRange } from "../domain/types.js";
import { isRetrievableState } from "../retrieval/retrievable-state.js";
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

/** Server-bound resume authority. Callers do not choose the person or scopes (ADR 0062). */
export interface ResumeAuthority {
  readonly personId: string;
  readonly allowedScopeIds: readonly string[];
  readonly hostSessionId?: string;
}

interface ExpandRequest {
  sourceSummaryIds: string[];
  sourceTraceIds: string[];
  sourceBoxIds: string[];
  sourceTurnRanges: TurnRange[];
  subject: string;
  cappedRangeCount?: number;
}

const RESUMABLE_BOX_STATES = new Set(["active", "approved", "revived", "compacted"]);

export class ConversationResumer {
  private readonly allowedScopeIds: ReadonlySet<string>;

  constructor(
    private readonly store: MemoryStore,
    private readonly authority: ResumeAuthority
  ) {
    this.allowedScopeIds = new Set(authority.allowedScopeIds);
  }

  async resumeSummary(summaryId: string): Promise<ResumeResult> {
    const summaries = await this.summariesById();
    const summary = this.authorizeSummary(summaries.get(summaryId));

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
    const saved = await this.store.getInjection(packet.id);
    if (!this.savedPacketIsAuthorized(saved, packet.hostSessionId)) {
      throw new Error(`Injection packet ${packet.id} was not found.`);
    }

    const summariesById = await this.summariesById();
    const summaries = saved.sourceSummaryIds
      .map((summaryId) => this.authorizeSummary(summariesById.get(summaryId)))
      .filter((summary): summary is Summary => summary !== null);
    const traces: MemoryTrace[] = [];
    for (const traceId of saved.sourceTraceIds) {
      const trace = await this.authorizeTrace(traceId, summariesById);
      if (trace) traces.push(trace);
    }
    const boxes: Box[] = [];
    for (const boxId of saved.boxIds) {
      const box = await this.authorizeBox(boxId, summariesById);
      if (box) boxes.push(box);
    }

    if (summaries.length === 0 && traces.length === 0 && boxes.length === 0) {
      throw new Error(`Injection packet ${packet.id} was not found.`);
    }

    return this.expand({
      sourceSummaryIds: summaries.map((summary) => summary.id),
      sourceTraceIds: traces.map((trace) => trace.id),
      sourceBoxIds: boxes.map((box) => box.id),
      sourceTurnRanges: [
        ...summaries.flatMap((summary) => summary.sourceTurnRanges),
        ...traces.flatMap((trace) => trace.turnRanges),
        ...boxes.flatMap((box) => box.turnRanges)
      ],
      subject: `${summaries.length} summary${summaries.length === 1 ? "" : "ies"}`
    });
  }

  async resumeTrace(traceId: string): Promise<ResumeResult> {
    const trace = await this.authorizeTrace(traceId, await this.summariesById());

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
    const summariesById = await this.summariesById();
    const box = await this.authorizeBox(boxId, summariesById);

    if (!box) {
      throw new Error(`Box ${boxId} was not found.`);
    }

    const maxTurnRanges = options.maxTurnRanges ?? 5;
    const boxes = options.includeChildBoxes
      ? await this.loadAuthorizedChildren(box, summariesById)
      : [box];
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

  private async summariesById(): Promise<Map<string, Summary>> {
    const summaries = await this.store.listSummaries();
    return new Map(summaries.map((summary) => [summary.id, summary]));
  }

  private authorizeSummary(summary: Summary | undefined): Summary | null {
    if (!summary || summary.personId !== this.authority.personId || !isRetrievableState(summary.state)) {
      return null;
    }
    const scopeIds = summary.scopeIds ?? ["personal"];
    return scopeIds.every((scopeId) => this.allowedScopeIds.has(scopeId)) ? summary : null;
  }

  private async authorizeTrace(
    traceId: string,
    summariesById: Map<string, Summary>
  ): Promise<MemoryTrace | null> {
    const trace = await this.store.getTrace(traceId);
    if (!trace || trace.personId !== this.authority.personId || trace.state !== "approved") {
      return null;
    }
    if (trace.summaryIds.length === 0 || trace.summaryIds.some((summaryId) => !this.authorizeSummary(summariesById.get(summaryId)))) {
      return null;
    }
    return trace;
  }

  private async authorizeBox(boxId: string, summariesById: Map<string, Summary>): Promise<Box | null> {
    const box = await this.store.getBox(boxId);
    if (!box || box.personId !== this.authority.personId || !RESUMABLE_BOX_STATES.has(box.state)) {
      return null;
    }
    if (box.summaryIds.length === 0 || box.summaryIds.some((summaryId) => !this.authorizeSummary(summariesById.get(summaryId)))) {
      return null;
    }
    return box;
  }

  private async loadAuthorizedChildren(box: Box, summariesById: Map<string, Summary>): Promise<Box[]> {
    const children: Box[] = [];
    for (const childBoxId of box.childBoxIds) {
      const child = await this.authorizeBox(childBoxId, summariesById);
      if (child) children.push(child);
    }
    return [box, ...children];
  }

  private savedPacketIsAuthorized(
    saved: InjectionPacket | null,
    callerSessionId: string
  ): saved is InjectionPacket {
    if (!saved || saved.personId !== this.authority.personId || saved.hostSessionId !== callerSessionId) {
      return false;
    }
    if (this.authority.hostSessionId && saved.hostSessionId !== this.authority.hostSessionId) {
      return false;
    }
    const scopeIds = saved.allowedScopeIds ?? [];
    return scopeIds.length > 0 && scopeIds.every((scopeId) => this.allowedScopeIds.has(scopeId));
  }

  private async expand(request: ExpandRequest): Promise<ResumeResult> {
    const sourceTurnRanges = dedupeTurnRanges(request.sourceTurnRanges);
    const turns = await loadTurnsForRanges(this.store, sourceTurnRanges, this.authority, this.allowedScopeIds);
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

async function loadTurnsForRanges(
  store: MemoryStore,
  ranges: TurnRange[],
  authority: ResumeAuthority,
  allowedScopeIds: ReadonlySet<string>
): Promise<Turn[]> {
  const turnsByKey = new Map<string, Turn>();

  for (const range of ranges) {
    const threadTurns = await store.listTurns(range.threadId);
    for (const turn of threadTurns) {
      if (turn.sequence < range.startSequence || turn.sequence > range.endSequence) {
        continue;
      }
      if (!turnIsAuthorized(turn, authority, allowedScopeIds)) {
        continue;
      }

      turnsByKey.set(turnKey(turn), turn);
    }
  }

  return [...turnsByKey.values()].sort(
    (left, right) => left.threadId.localeCompare(right.threadId) || left.sequence - right.sequence
  );
}

function turnIsAuthorized(
  turn: Turn,
  authority: ResumeAuthority,
  allowedScopeIds: ReadonlySet<string>
): boolean {
  const personId = turn.metadata.personId;
  const scopeId = turn.metadata.scopeId;
  if (typeof personId === "string" && personId !== authority.personId) return false;
  if (typeof scopeId === "string" && !allowedScopeIds.has(scopeId)) return false;
  return true;
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
