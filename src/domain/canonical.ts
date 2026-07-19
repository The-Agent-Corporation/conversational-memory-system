import { z } from "zod";
import {
  IsoDateTimeSchema,
  JsonObjectSchema,
  ProvenanceSchema,
  RoleSchema,
  TrustLevelSchema
} from "./types.js";

export const PersonSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).nullable(),
  createdAt: IsoDateTimeSchema
});

export const MemorySourceSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  application: z.string().min(1),
  profileId: z.string().min(1),
  instanceId: z.string().min(1).default("default"),
  scopeId: z.string().min(1).optional(),
  createdAt: IsoDateTimeSchema,
  lastImportedAt: IsoDateTimeSchema
});

export const CanonicalEventSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceApplication: z.string().min(1),
  sourceProfileId: z.string().min(1),
  scopeId: z.string().min(1).optional(),
  nativeSessionId: z.string().min(1),
  nativeEventId: z.string().min(1),
  nativeSequence: z.number().int().nonnegative(),
  causalParentId: z.string().min(1).nullable(),
  eventKind: z.enum(["message", "tool_call"]).optional(),
  role: RoleSchema,
  content: z.string(),
  occurredAt: IsoDateTimeSchema,
  importedAt: IsoDateTimeSchema,
  provenance: ProvenanceSchema,
  trustLevel: TrustLevelSchema,
  contentHash: z.string().min(1),
  parserVersion: z.string().min(1),
  metadata: JsonObjectSchema
});

export type Person = z.infer<typeof PersonSchema>;
export type MemorySource = z.infer<typeof MemorySourceSchema>;
export type CanonicalEvent = z.infer<typeof CanonicalEventSchema>;
