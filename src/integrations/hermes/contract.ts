import {
  ConversationTurnEventSchema,
  type ConversationTurnEvent
} from "../../domain/events.js";
import type { JsonObject, JsonValue } from "../../domain/types.js";

export interface HermesTimelineRow {
  id: string;
  profile_id: string;
  session_id: string;
  sequence: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at: string;
  channel: string | null;
  metadata_json: string | null;
}

export function mapHermesTimelineRowToHostEvent(row: HermesTimelineRow): ConversationTurnEvent {
  return ConversationTurnEventSchema.parse({
    id: `hermes_${row.id}`,
    host: "roscoe-hermes",
    profileId: row.profile_id,
    hostSessionId: row.session_id,
    sequence: row.sequence,
    type: "conversation_turn",
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    metadata: {
      channel: row.channel,
      sourceMetadata: parseMetadata(row.metadata_json)
    }
  });
}

function parseMetadata(metadataJson: string | null): JsonObject {
  if (!metadataJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(metadataJson) as JsonValue;
    if (isJsonObject(parsed)) {
      return parsed;
    }

    return { rawMetadata: parsed };
  } catch {
    return { rawMetadata: metadataJson };
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
