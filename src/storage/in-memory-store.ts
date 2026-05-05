import {
  AnchorSchema,
  BoxSchema,
  InjectionPacketSchema,
  SummarySchema,
  TurnSchema,
  type Anchor,
  type Box,
  type InjectionPacket,
  type Summary,
  type Turn
} from "../domain/types.js";
import type { MemoryStore } from "./memory-store.js";

export class InMemoryStore implements MemoryStore {
  private readonly turns: Turn[] = [];
  private readonly summaries: Summary[] = [];
  private readonly boxes: Box[] = [];
  private readonly anchors: Anchor[] = [];
  private readonly injections: InjectionPacket[] = [];

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

  private upsertById<T extends { id: string }>(items: T[], item: T): void {
    const existingIndex = items.findIndex((existing) => existing.id === item.id);

    if (existingIndex === -1) {
      items.push(item);
      return;
    }

    items[existingIndex] = item;
  }
}
