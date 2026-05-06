import {
  ConversationTurnEventSchema,
  ControlSignalEventSchema,
  type ControlSignalEvent,
  type HostEvent
} from "../../domain/events.js";
import { z } from "zod";
import type { JsonObject, JsonValue } from "../../domain/types.js";

export const HermesTimelineRowSchema = z.object({
  id: z.string().min(1),
  profile_id: z.string().min(1),
  session_id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  created_at: z.string().datetime(),
  channel: z.string().nullable(),
  metadata_json: z.string().nullable()
});

export type HermesTimelineRow = z.infer<typeof HermesTimelineRowSchema>;

export function mapHermesTimelineRowToHostEvent(row: HermesTimelineRow): HostEvent {
  const signal = controlSignalForContent(row.content);
  if (signal) {
    return ControlSignalEventSchema.parse({
      id: `hermes_${row.id}`,
      host: "roscoe-hermes",
      profileId: row.profile_id,
      hostSessionId: row.session_id,
      sequence: row.sequence,
      type: "control_signal",
      signal,
      createdAt: row.created_at,
      metadata: {
        channel: row.channel,
        sourceMetadata: parseMetadata(row.metadata_json)
      }
    });
  }

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

function controlSignalForContent(content: string): ControlSignalEvent["signal"] | null {
  const command = content.trim().toLowerCase().split(/\s+/, 1)[0];

  if (command === "/new" || command === "/clear") {
    return "new_conversation";
  }
  if (command === "/reset") {
    return "reset";
  }
  if (command === "/compress") {
    return "compress";
  }
  if (command === "/resume") {
    return "resume_requested";
  }

  return null;
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
