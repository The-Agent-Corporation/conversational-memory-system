import { z } from "zod";

export const IsoDateTimeSchema = z.string().datetime();
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isPlainObject(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
};

export const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(isJsonValue, {
  message: "Expected JSON value"
});

export const JsonObjectSchema: z.ZodType<JsonObject> = z.custom<JsonObject>(
  (value) => isPlainObject(value) && Object.values(value).every(isJsonValue),
  { message: "Expected JSON object" }
);

export const RoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export const ProvenanceSchema = z.enum([
  "direct_user_input",
  "assistant_output",
  "tool_output",
  "external_content",
  "system_event"
]);
export const TrustLevelSchema = z.enum(["low", "medium", "high"]);
export const MemoryStateSchema = z.enum([
  "active",
  "compacted",
  "stale",
  "revived",
  "proposed",
  "approved",
  "rejected",
  "superseded",
  "disputed"
]);

export const TurnRangeSchema = z.object({
  threadId: z.string().min(1),
  startSequence: z.number().int().nonnegative(),
  endSequence: z.number().int().nonnegative()
}).refine((range) => range.endSequence >= range.startSequence, {
  message: "endSequence must be greater than or equal to startSequence"
});

export const EmbeddingSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  vector: z.array(z.number().finite()),
  createdAt: IsoDateTimeSchema
}).refine((embedding) => embedding.vector.length === embedding.dimensions, {
  message: "vector length must match dimensions"
});

export const TurnSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  role: RoleSchema,
  content: z.string(),
  createdAt: IsoDateTimeSchema,
  provenance: ProvenanceSchema,
  trustLevel: TrustLevelSchema,
  metadata: JsonObjectSchema,
  contentHash: z.string().min(1)
});

export const SummarySchema = z.object({
  id: z.string().min(1),
  summaryText: z.string().min(1),
  sourceTurnRanges: z.array(TurnRangeSchema),
  sourceSummaryIds: z.array(z.string().min(1)),
  boxIds: z.array(z.string().min(1)),
  embedding: EmbeddingSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  confidence: z.number().min(0).max(1),
  state: MemoryStateSchema,
  detailLevel: z.enum(["full", "medium", "brief", "stub"]),
  tokenCount: z.number().int().nonnegative(),
  lastAccessedAt: IsoDateTimeSchema.nullable(),
  version: z.number().int().positive(),
  strength: z.number().min(0).max(1),
  retrievalCount: z.number().int().nonnegative(),
  retrievedAt: IsoDateTimeSchema.nullable(),
  halfLifeHours: z.number().positive(),
  outcomeScore: z.number().min(-1).max(1).nullable()
});

export const BoxSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  parentBoxId: z.string().min(1).nullable(),
  childBoxIds: z.array(z.string().min(1)),
  summaryIds: z.array(z.string().min(1)),
  turnRanges: z.array(TurnRangeSchema),
  state: MemoryStateSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  caseId: z.string().min(1).nullable(),
  boxType: z.enum(["case", "topic", "general", "project", "person"]),
  summary: z.string(),
  lastActivityAt: IsoDateTimeSchema
});

export const AnchorSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  threadId: z.string().min(1),
  boxId: z.string().min(1).nullable(),
  anchorType: z.enum(["decision", "deadline", "key_fact", "strategic_insight", "bookmark"]),
  content: z.string().min(1),
  embedding: EmbeddingSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  trustLevel: TrustLevelSchema,
  source: ProvenanceSchema
});

export const InjectionPacketSchema = z.object({
  id: z.string().min(1),
  hostSessionId: z.string().min(1),
  currentTopicSummary: z.string().min(1),
  selectedMemory: z.string().min(1),
  sourceSummaryIds: z.array(z.string().min(1)),
  sourceTurnRanges: z.array(TurnRangeSchema),
  boxIds: z.array(z.string().min(1)),
  relevanceReason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  disclosureText: z.string().min(1),
  createdAt: IsoDateTimeSchema
});

export type Turn = z.infer<typeof TurnSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type Box = z.infer<typeof BoxSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type InjectionPacket = z.infer<typeof InjectionPacketSchema>;
export type TurnRange = z.infer<typeof TurnRangeSchema>;
export type Embedding = z.infer<typeof EmbeddingSchema>;
