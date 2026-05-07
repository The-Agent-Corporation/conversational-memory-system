import {
  AnchorSchema,
  BoxSchema,
  InjectionPacketSchema,
  MemoryProposalSchema,
  MemoryTraceSchema,
  SummarySchema,
  TurnSchema,
  type Anchor,
  type Box,
  type InjectionPacket,
  type MemoryProposal,
  type MemoryTrace,
  type Summary,
  type Turn
} from "../domain/types.js";
import type { MemoryStore, ProposalFilter, TraceFilter } from "./memory-store.js";

export class InMemoryStore implements MemoryStore {
  private readonly turns: Turn[] = [];
  private readonly summaries: Summary[] = [];
  private readonly boxes: Box[] = [];
  private readonly anchors: Anchor[] = [];
  private readonly injections: InjectionPacket[] = [];
  private readonly proposals: MemoryProposal[] = [];
  private readonly traces: MemoryTrace[] = [];

  async saveTurn(turn: Turn): Promise<void> {
    this.upsertById(this.turns, structuredClone(TurnSchema.parse(turn)));
  }

  async listTurns(threadId: string): Promise<Turn[]> {
    return this.turns
      .filter((turn) => turn.threadId === threadId)
      .sort((left, right) => left.sequence - right.sequence)
      .map((turn) => structuredClone(turn));
  }

  async saveSummary(summary: Summary): Promise<void> {
    this.upsertById(this.summaries, structuredClone(SummarySchema.parse(summary)));
  }

  async listSummaries(): Promise<Summary[]> {
    return structuredClone(this.summaries);
  }

  async saveBox(box: Box): Promise<void> {
    this.upsertById(this.boxes, structuredClone(BoxSchema.parse(box)));
  }

  async getBox(id: string): Promise<Box | null> {
    return structuredClone(this.boxes.find((box) => box.id === id) ?? null);
  }

  async listBoxes(): Promise<Box[]> {
    return structuredClone(this.boxes);
  }

  async saveAnchor(anchor: Anchor): Promise<void> {
    this.upsertById(this.anchors, structuredClone(AnchorSchema.parse(anchor)));
  }

  async listAnchors(): Promise<Anchor[]> {
    return structuredClone(this.anchors);
  }

  async saveInjection(packet: InjectionPacket): Promise<void> {
    this.upsertById(this.injections, structuredClone(InjectionPacketSchema.parse(packet)));
  }

  async listInjections(hostSessionId: string): Promise<InjectionPacket[]> {
    return this.injections
      .filter((packet) => packet.hostSessionId === hostSessionId)
      .map((packet) => structuredClone(packet));
  }

  async saveProposal(proposal: MemoryProposal): Promise<void> {
    this.upsertById(this.proposals, structuredClone(MemoryProposalSchema.parse(proposal)));
  }

  async getProposal(id: string): Promise<MemoryProposal | null> {
    return structuredClone(this.proposals.find((proposal) => proposal.id === id) ?? null);
  }

  async listProposals(filter: ProposalFilter = {}): Promise<MemoryProposal[]> {
    return structuredClone(this.proposals.filter((proposal) =>
      (filter.state === undefined || proposal.state === filter.state) &&
      (filter.proposalType === undefined || proposal.proposalType === filter.proposalType)
    ));
  }

  async saveTrace(trace: MemoryTrace): Promise<void> {
    this.upsertById(this.traces, structuredClone(MemoryTraceSchema.parse(trace)));
  }

  async getTrace(id: string): Promise<MemoryTrace | null> {
    return structuredClone(this.traces.find((trace) => trace.id === id) ?? null);
  }

  async listTraces(filter: TraceFilter = {}): Promise<MemoryTrace[]> {
    return structuredClone(this.traces.filter((trace) =>
      filter.state === undefined || trace.state === filter.state
    ));
  }

  private upsertById<T extends { id: string }>(items: T[], item: T): void {
    const existingIndex = items.findIndex((existing) => existing.id === item.id);

    if (existingIndex === -1) {
      items.push(item);
      return;
    }

    items[existingIndex] = item;
  }
}
