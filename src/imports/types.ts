import { z } from "zod";
import { IsoDateTimeSchema } from "../domain/types.js";

export const CodexHistoryCandidateSchema = z.object({
  id: z.string().min(1),
  application: z.literal("codex"),
  format: z.literal("codex-rollout-jsonl"),
  rootPath: z.string().min(1),
  sessionCount: z.number().int().nonnegative(),
  estimatedBytes: z.number().int().nonnegative(),
  earliestModifiedAt: IsoDateTimeSchema.nullable(),
  latestModifiedAt: IsoDateTimeSchema.nullable(),
  discoveredAt: IsoDateTimeSchema
});

export const HistorySourceApprovalSchema = z.object({
  candidateId: z.string().min(1),
  personId: z.string().min(1),
  application: z.literal("codex"),
  format: z.literal("codex-rollout-jsonl"),
  rootPath: z.string().min(1),
  profileId: z.string().min(1),
  scopeId: z.string().min(1).default("personal"),
  approvedAt: IsoDateTimeSchema
});

const FileHistoryCandidateFields = {
  rootPath: z.string().min(1),
  sessionCount: z.number().int().nonnegative(),
  estimatedBytes: z.number().int().nonnegative(),
  earliestModifiedAt: IsoDateTimeSchema.nullable(),
  latestModifiedAt: IsoDateTimeSchema.nullable(),
  discoveredAt: IsoDateTimeSchema
};

export const ClaudeHistoryCandidateSchema = z.object({
  id: z.string().min(1),
  application: z.literal("claude-code"),
  format: z.literal("claude-project-jsonl"),
  ...FileHistoryCandidateFields
});

export const OpenClawHistoryCandidateSchema = z.object({
  id: z.string().min(1),
  application: z.literal("openclaw"),
  format: z.literal("openclaw-session-jsonl"),
  ...FileHistoryCandidateFields
});

export const HermesHistoryCandidateSchema = z.object({
  id: z.string().min(1),
  application: z.literal("hermes"),
  format: z.literal("hermes-state-sqlite"),
  databasePath: z.string().min(1),
  sessionCount: z.number().int().nonnegative(),
  estimatedBytes: z.number().int().nonnegative(),
  earliestSessionAt: IsoDateTimeSchema.nullable(),
  latestSessionAt: IsoDateTimeSchema.nullable(),
  discoveredAt: IsoDateTimeSchema
});

export const ClaudeHistoryApprovalSchema = z.object({
  candidateId: z.string().min(1),
  personId: z.string().min(1),
  application: z.literal("claude-code"),
  format: z.literal("claude-project-jsonl"),
  rootPath: z.string().min(1),
  profileId: z.string().min(1),
  scopeId: z.string().min(1).default("personal"),
  approvedAt: IsoDateTimeSchema
});

export const OpenClawHistoryApprovalSchema = z.object({
  candidateId: z.string().min(1),
  personId: z.string().min(1),
  application: z.literal("openclaw"),
  format: z.literal("openclaw-session-jsonl"),
  rootPath: z.string().min(1),
  profileId: z.string().min(1),
  scopeId: z.string().min(1).default("personal"),
  approvedAt: IsoDateTimeSchema
});

export const HermesHistoryApprovalSchema = z.object({
  candidateId: z.string().min(1),
  personId: z.string().min(1),
  application: z.literal("hermes"),
  format: z.literal("hermes-state-sqlite"),
  databasePath: z.string().min(1),
  profileId: z.string().min(1),
  scopeId: z.string().min(1).default("personal"),
  approvedAt: IsoDateTimeSchema
});

export const ImportCheckpointSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  candidateId: z.string().min(1),
  resourcePath: z.string().min(1),
  fileIdentity: z.string().min(1),
  byteOffset: z.number().int().nonnegative(),
  recordIndex: z.number().int().nonnegative(),
  nativeSessionId: z.string().min(1).nullable(),
  parserVersion: z.string().min(1),
  updatedAt: IsoDateTimeSchema,
  rowHighWaterMark: z.string().min(1).nullable().optional()
});

export interface CodexImportResult {
  filesScanned: number;
  messagesProcessed: number;
  recordsSkipped: number;
  bytesProcessed: number;
  recordsQuarantined: number;
}

export type CodexHistoryCandidate = z.infer<typeof CodexHistoryCandidateSchema>;
export type HistorySourceApproval = z.infer<typeof HistorySourceApprovalSchema>;
export type ImportCheckpoint = z.infer<typeof ImportCheckpointSchema>;
export type ClaudeHistoryCandidate = z.infer<typeof ClaudeHistoryCandidateSchema>;
export type OpenClawHistoryCandidate = z.infer<typeof OpenClawHistoryCandidateSchema>;
export type HermesHistoryCandidate = z.infer<typeof HermesHistoryCandidateSchema>;
export type ClaudeHistoryApproval = z.infer<typeof ClaudeHistoryApprovalSchema>;
export type OpenClawHistoryApproval = z.infer<typeof OpenClawHistoryApprovalSchema>;
export type HermesHistoryApproval = z.infer<typeof HermesHistoryApprovalSchema>;
export type HistoryImportResult = CodexImportResult;
