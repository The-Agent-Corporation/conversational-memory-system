import type { Anchor, Box, InjectionPacket, Summary, Turn } from "../domain/types.js";
import type { MemoryStore } from "./memory-store.js";

export class InMemoryStore implements MemoryStore {
  private readonly turns: Turn[] = [];
  private readonly summaries: Summary[] = [];
  private readonly boxes: Box[] = [];
  private readonly anchors: Anchor[] = [];
  private readonly injections: InjectionPacket[] = [];

  async saveTurn(turn: Turn): Promise<void> {
    this.turns.push(turn);
  }

  async listTurns(threadId: string): Promise<Turn[]> {
    return this.turns.filter((turn) => turn.threadId === threadId);
  }

  async saveSummary(summary: Summary): Promise<void> {
    this.summaries.push(summary);
  }

  async listSummaries(): Promise<Summary[]> {
    return [...this.summaries];
  }

  async saveBox(box: Box): Promise<void> {
    this.boxes.push(box);
  }

  async listBoxes(): Promise<Box[]> {
    return [...this.boxes];
  }

  async saveAnchor(anchor: Anchor): Promise<void> {
    this.anchors.push(anchor);
  }

  async listAnchors(): Promise<Anchor[]> {
    return [...this.anchors];
  }

  async saveInjection(packet: InjectionPacket): Promise<void> {
    this.injections.push(packet);
  }

  async listInjections(hostSessionId: string): Promise<InjectionPacket[]> {
    return this.injections.filter((packet) => packet.hostSessionId === hostSessionId);
  }
}
