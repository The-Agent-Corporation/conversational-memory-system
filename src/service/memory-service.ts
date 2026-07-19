import { createHash } from "node:crypto";
import {
  CanonicalEventSchema,
  MemorySourceSchema,
  PersonSchema,
  type CanonicalEvent,
  type MemorySource
} from "../domain/canonical.js";
import type { HostEvent } from "../domain/events.js";
import { TurnSchema, type InjectionPacket, type Turn } from "../domain/types.js";
import type { Embedder } from "../embeddings/embedder.js";
import { MemoryRetriever } from "../retrieval/memory-retriever.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { mutationEffectsFingerprint } from "../storage/mcp-mutation-contracts.js";
import {
  DEFAULT_LOCAL_SYNC_DEVICE_ID,
  emitLocalSyncOperation
} from "../sync/materialization/sync-materializer.js";

export interface InjectionRequest {
  host: string;
  profileId: string;
  hostSessionId: string;
  currentTopicSummary: string;
  requestedAt?: string;
  maxMemoryTokens?: number;
  personId?: string;
  allowedScopeIds?: string[];
}

export interface MemoryServiceOptions {
  embedder?: Embedder;
  personId?: string;
  personDisplayName?: string | null;
  parserVersion?: string;
  sourceInstanceId?: string;
  scopeId?: string;
  allowLegacyUnscopedRetrieval?: boolean;
  clock?: () => string;
  syncDeviceId?: string;
}

export class MemoryService {
  private readonly retriever: MemoryRetriever;
  private readonly personId: string;
  private readonly personDisplayName: string | null;
  private readonly parserVersion: string;
  private readonly sourceInstanceId: string;
  private readonly scopeId: string;
  private readonly clock: () => string;
  private readonly syncDeviceId: string;

  constructor(private readonly store: MemoryStore, options: MemoryServiceOptions = {}) {
    this.retriever = new MemoryRetriever(store, {
      embedder: options.embedder,
      allowLegacyUnscoped: options.allowLegacyUnscopedRetrieval ?? false
    });
    this.personId = options.personId ?? "person_default";
    this.personDisplayName = options.personDisplayName ?? null;
    this.parserVersion = options.parserVersion ?? "host-event/v1";
    this.sourceInstanceId = options.sourceInstanceId ?? "default";
    this.scopeId = options.scopeId ?? "personal";
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.syncDeviceId = options.syncDeviceId ?? DEFAULT_LOCAL_SYNC_DEVICE_ID;
  }

  async ingestEvent(event: HostEvent): Promise<Turn | null> {
    if (event.type === "control_signal") {
      return null;
    }

    const importedAt = this.clock();
    const source = await this.ensurePersonAndSource(event, importedAt);
    const provenance = this.provenanceForRole(event.role);
    const trustLevel = event.role === "user" ? "high" : "medium";
    const contentHash = createHash("sha256").update(event.content).digest("hex");
    const nativeEventId = event.nativeEventId ?? event.id;
    const canonicalEvent = CanonicalEventSchema.parse({
      id: this.canonicalEventId(source.id, event.hostSessionId, nativeEventId),
      personId: this.personId,
      sourceId: source.id,
      sourceApplication: event.host,
      sourceProfileId: event.profileId,
      scopeId: source.scopeId ?? this.scopeId,
      nativeSessionId: event.hostSessionId,
      nativeEventId,
      nativeSequence: event.sequence,
      causalParentId: event.nativeParentEventId
        ? this.canonicalEventId(source.id, event.hostSessionId, event.nativeParentEventId)
        : null,
      eventKind: event.eventKind ?? "message",
      role: event.role,
      content: event.content,
      occurredAt: event.createdAt,
      importedAt,
      provenance,
      trustLevel,
      contentHash,
      parserVersion: this.parserVersion,
      metadata: {
        sourceMetadata: event.metadata
      }
    });
    const turn = TurnSchema.parse({
      id: event.nativeEventId ? `turn_${canonicalEvent.id}` : `turn_${event.id}`,
      threadId: event.hostSessionId,
      sequence: event.sequence,
      role: event.role,
      content: event.content,
      createdAt: event.createdAt,
      provenance,
      trustLevel,
      metadata: {
        personId: this.personId,
        canonicalEventId: canonicalEvent.id,
        sourceId: source.id,
        sourceInstanceId: source.instanceId,
        scopeId: source.scopeId ?? this.scopeId,
        host: event.host,
        profileId: event.profileId,
        hostSessionId: event.hostSessionId,
        sourceMetadata: event.metadata
      },
      contentHash
    });

    await this.store.saveCanonicalEvent(canonicalEvent);
    await this.store.saveTurn(turn);
    await emitLocalSyncOperation(this.store, {
      personId: this.personId,
      deviceId: this.syncDeviceId,
      operationKind: "host_event_ingest",
      targetId: canonicalEvent.id,
      effectFingerprint: mutationEffectsFingerprint({
        canonicalEventId: canonicalEvent.id,
        turnId: turn.id,
        sourceId: source.id,
        contentHash
      }),
      committedAt: importedAt
    });
    return turn;
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

  private async ensurePersonAndSource(
    event: Extract<HostEvent, { type: "conversation_turn" }>,
    importedAt: string
  ): Promise<MemorySource> {
    const existingPerson = await this.store.getPerson(this.personId);
    if (!existingPerson) {
      await this.store.savePerson(PersonSchema.parse({
        id: this.personId,
        displayName: this.personDisplayName,
        createdAt: importedAt
      }));
    }

    const sourceId = this.sourceId(event.host, event.profileId, this.sourceInstanceId);
    const existingSource = await this.store.getSource(sourceId);
    const source = MemorySourceSchema.parse({
      id: sourceId,
      personId: this.personId,
      application: event.host,
      profileId: event.profileId,
      instanceId: this.sourceInstanceId,
      scopeId: existingSource?.scopeId ?? this.scopeId,
      createdAt: existingSource?.createdAt ?? importedAt,
      lastImportedAt: importedAt
    });
    await this.store.saveSource(source);
    return source;
  }

  private sourceId(application: string, profileId: string, instanceId: string): string {
    return `source_${this.identityHash([this.personId, application, profileId, instanceId])}`;
  }

  private canonicalEventId(
    sourceId: string,
    nativeSessionId: string,
    nativeEventId: string
  ): CanonicalEvent["id"] {
    return `event_${this.identityHash([sourceId, nativeSessionId, nativeEventId])}`;
  }

  private identityHash(parts: string[]): string {
    return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  }
}
