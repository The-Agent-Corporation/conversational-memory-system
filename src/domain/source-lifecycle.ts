import { z } from "zod";
import { IsoDateTimeSchema, JsonObjectSchema } from "./types.js";

export const SourceGrantSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  candidateId: z.string().min(1),
  application: z.string().min(1),
  format: z.string().min(1),
  sourceLocator: z.string().min(1),
  profileId: z.string().min(1),
  scopeId: z.string().min(1).default("personal"),
  state: z.enum(["approved", "revoked"]),
  approvedAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
  updatedAt: IsoDateTimeSchema
});

export const SourceLifecycleAuditEventSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  grantId: z.string().min(1),
  candidateId: z.string().min(1),
  action: z.enum([
    "approved",
    "revoked",
    "deletion_requested",
    "deletion_completed",
    "quarantine_replay_requested"
  ]),
  actor: z.string().min(1),
  occurredAt: IsoDateTimeSchema,
  details: JsonObjectSchema
});

export const QuarantineRecordSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  candidateId: z.string().min(1),
  resourcePath: z.string().min(1),
  recordPosition: z.string().min(1),
  parserVersion: z.string().min(1),
  reason: z.enum(["malformed_json", "unsupported_record", "malformed_tool_call"]),
  recordHash: z.string().min(1),
  sanitizedRecord: z.string().max(8192),
  rawByteLength: z.number().int().nonnegative(),
  state: z.enum(["pending", "replay_requested", "replayed", "discarded"]),
  createdAt: IsoDateTimeSchema,
  replayRequestedAt: IsoDateTimeSchema.nullable(),
  replayedAt: IsoDateTimeSchema.nullable()
});

export type SourceGrant = z.infer<typeof SourceGrantSchema>;
export type SourceLifecycleAuditEvent = z.infer<typeof SourceLifecycleAuditEventSchema>;
export type QuarantineRecord = z.infer<typeof QuarantineRecordSchema>;
