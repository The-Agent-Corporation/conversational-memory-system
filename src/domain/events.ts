import { z } from "zod";
import { IsoDateTimeSchema, JsonObjectSchema, RoleSchema } from "./types.js";

export const HostNameSchema = z.enum([
  "roscoe-hermes",
  "claude-code",
  "pi",
  "openclaw",
  "hermes",
  "codex",
  "cursor",
  "unknown"
]);

export const ConversationTurnEventSchema = z.object({
  id: z.string().min(1),
  host: HostNameSchema,
  profileId: z.string().min(1),
  hostSessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  type: z.literal("conversation_turn"),
  eventKind: z.enum(["message", "tool_call"]).optional(),
  nativeEventId: z.string().min(1).optional(),
  role: RoleSchema,
  content: z.string(),
  createdAt: IsoDateTimeSchema,
  nativeParentEventId: z.string().min(1).nullable().optional(),
  metadata: JsonObjectSchema
});

export const ControlSignalEventSchema = z.object({
  id: z.string().min(1),
  host: HostNameSchema,
  profileId: z.string().min(1),
  hostSessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  type: z.literal("control_signal"),
  signal: z.enum([
    "new_conversation",
    "reset",
    "compress",
    "resume_requested",
    "sleep_review_requested"
  ]),
  createdAt: IsoDateTimeSchema,
  metadata: JsonObjectSchema
});

export const HostEventSchema = z.discriminatedUnion("type", [
  ConversationTurnEventSchema,
  ControlSignalEventSchema
]);

export type HostEvent = z.infer<typeof HostEventSchema>;
export type ConversationTurnEvent = z.infer<typeof ConversationTurnEventSchema>;
export type ControlSignalEvent = z.infer<typeof ControlSignalEventSchema>;
