import { createHash } from "node:crypto";
import type { HostEvent } from "../domain/events.js";
import { TurnSchema, type InjectionPacket, type Turn } from "../domain/types.js";
import { MemoryRetriever } from "../retrieval/memory-retriever.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface InjectionRequest {
  host: string;
  profileId: string;
  hostSessionId: string;
  currentTopicSummary: string;
  requestedAt?: string;
}

export class MemoryService {
  private readonly retriever: MemoryRetriever;

  constructor(private readonly store: MemoryStore) {
    this.retriever = new MemoryRetriever(store);
  }

  async ingestEvent(event: HostEvent): Promise<void> {
    if (event.type === "control_signal") {
      return;
    }

    const turn = TurnSchema.parse({
      id: `turn_${event.id}`,
      threadId: event.hostSessionId,
      sequence: event.sequence,
      role: event.role,
      content: event.content,
      createdAt: event.createdAt,
      provenance: this.provenanceForRole(event.role),
      trustLevel: event.role === "user" ? "high" : "medium",
      metadata: {
        host: event.host,
        profileId: event.profileId,
        hostSessionId: event.hostSessionId,
        sourceMetadata: event.metadata
      },
      contentHash: createHash("sha256").update(event.content).digest("hex")
    });

    await this.store.saveTurn(turn);
  }

  async prepareInjection(request: InjectionRequest): Promise<InjectionPacket | null> {
    return this.retriever.prepareInjection(request);
  }

  private provenanceForRole(role: Turn["role"]): Turn["provenance"] {
    if (role === "user") return "direct_user_input";
    if (role === "assistant") return "assistant_output";
    if (role === "tool") return "tool_output";
    return "system_event";
  }
}
