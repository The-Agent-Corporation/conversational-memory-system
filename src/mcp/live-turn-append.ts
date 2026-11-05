import { createHash } from "node:crypto";
import type { CanonicalEvent } from "../domain/canonical.js";
import type { JsonObject, JsonValue } from "../domain/types.js";
import { HostNameSchema, type ConversationTurnEvent } from "../domain/events.js";
import { QuarantineService } from "../imports/quarantine-service.js";
import { redactKnownSecrets } from "../imports/secret-redactor.js";
import { serializedToolCallsAreMalformed } from "../imports/tool-call-record.js";
import { MemoryService } from "../service/memory-service.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type { ProfileAuthority } from "./authority.js";

export const LIVE_TURN_PARSER_VERSION = "mcp-live-turn/v1";
export const LIVE_TURN_INSTANCE_ID = "mcp-live";

export class LiveTurnConflictError extends Error {
  constructor() {
    super("LIVE_TURN_CONFLICT");
    this.name = "LiveTurnConflictError";
  }
}

export class LiveTurnHostDeniedError extends Error {
  constructor() {
    super("LIVE_TURN_HOST_DENIED");
    this.name = "LiveTurnHostDeniedError";
  }
}

export interface LiveTurnAppendInput {
  host: string;
  hostSessionId: string;
  turnId: string;
  sequence: number;
  role: ConversationTurnEvent["role"];
  content: string;
  createdAt: string;
  eventKind?: "message" | "tool_call";
  metadata?: JsonObject;
}

export interface LiveTurnAppendResult {
  status: "APPENDED" | "REPLAYED" | "QUARANTINED";
  turnId: string | null;
  canonicalEventId: string | null;
  redacted: boolean;
  disclosure: string;
}

const DISCLOSURE = "Assistive memory only; verify against current sources.";

export class LiveTurnAppendService {
  constructor(
    private readonly store: MemoryStore,
    private readonly authority: ProfileAuthority,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  async append(input: LiveTurnAppendInput): Promise<LiveTurnAppendResult> {
    const host = HostNameSchema.parse(input.host);
    if (this.authority.allowedHosts && !this.authority.allowedHosts.includes(host)) {
      throw new LiveTurnHostDeniedError();
    }

    const content = redactKnownSecrets(input.content);
    const metadata = redactRecord(input.metadata ?? {});
    const redacted = content !== input.content || JSON.stringify(metadata) !== JSON.stringify(input.metadata ?? {});
    const eventKind = input.eventKind ?? "message";

    if (eventKind === "tool_call" && serializedToolCallsAreMalformed(content)) {
      await new QuarantineService(this.store, this.now).capture({
        personId: this.authority.personId,
        candidateId: liveCandidateId(host),
        resourcePath: liveResourcePath(host, input.hostSessionId),
        recordPosition: input.turnId,
        parserVersion: LIVE_TURN_PARSER_VERSION,
        reason: "malformed_tool_call",
        rawRecord: content
      });
      return {
        status: "QUARANTINED",
        turnId: null,
        canonicalEventId: null,
        redacted,
        disclosure: DISCLOSURE
      };
    }

    const canonicalEventId = liveCanonicalEventId({
      personId: this.authority.personId,
      host,
      profileId: this.authority.profileName,
      hostSessionId: input.hostSessionId,
      turnId: input.turnId
    });
    const [existing] = await this.store.listCanonicalEventsByIds(this.authority.personId, [canonicalEventId]);
    if (existing) {
      if (!sameTurn(existing, {
        personId: this.authority.personId,
        scopeId: this.authority.ingestScopeId,
        role: input.role,
        content,
        sequence: input.sequence,
        createdAt: input.createdAt,
        eventKind,
        metadata
      })) {
        throw new LiveTurnConflictError();
      }
      return {
        status: "REPLAYED",
        turnId: `turn_${existing.id}`,
        canonicalEventId: existing.id,
        redacted,
        disclosure: DISCLOSURE
      };
    }

    const service = new MemoryService(this.store, {
      personId: this.authority.personId,
      scopeId: this.authority.ingestScopeId,
      sourceInstanceId: LIVE_TURN_INSTANCE_ID,
      parserVersion: LIVE_TURN_PARSER_VERSION,
      clock: this.now
    });
    const turn = await service.ingestEvent({
      id: input.turnId,
      host,
      profileId: this.authority.profileName,
      hostSessionId: input.hostSessionId,
      sequence: input.sequence,
      type: "conversation_turn",
      eventKind,
      nativeEventId: input.turnId,
      role: input.role,
      content,
      createdAt: input.createdAt,
      metadata
    });
    return {
      status: "APPENDED",
      turnId: turn?.id ?? null,
      canonicalEventId,
      redacted,
      disclosure: DISCLOSURE
    };
  }
}

export function liveCanonicalEventId(input: {
  personId: string;
  host: string;
  profileId: string;
  hostSessionId: string;
  turnId: string;
}): string {
  const sourceId = `source_${identityHash([
    input.personId,
    input.host,
    input.profileId,
    LIVE_TURN_INSTANCE_ID
  ])}`;
  return `event_${identityHash([sourceId, input.hostSessionId, input.turnId])}`;
}

const liveCandidateId = (host: string): string => `live:${host}`;
const liveResourcePath = (host: string, hostSessionId: string): string =>
  `mcp-live://${host}/${hostSessionId}`;

const identityHash = (parts: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const sameTurn = (
  existing: CanonicalEvent,
  input: {
    personId: string;
    scopeId: string;
    role: CanonicalEvent["role"];
    content: string;
    sequence: number;
    createdAt: string;
    eventKind: CanonicalEvent["eventKind"];
    metadata: JsonObject;
  }
): boolean =>
  existing.personId === input.personId &&
  existing.scopeId === input.scopeId &&
  existing.role === input.role &&
  existing.content === input.content &&
  existing.nativeSequence === input.sequence &&
  existing.occurredAt === input.createdAt &&
  existing.eventKind === input.eventKind &&
  JSON.stringify(existing.metadata.sourceMetadata ?? {}) === JSON.stringify(input.metadata);

const redactRecord = (value: JsonObject): JsonObject => {
  const redacted: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactValue(entry);
  }
  return redacted;
};

const redactValue = (value: JsonValue): JsonValue => {
  if (typeof value === "string") return redactKnownSecrets(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === "object") return redactRecord(value);
  return value;
};
