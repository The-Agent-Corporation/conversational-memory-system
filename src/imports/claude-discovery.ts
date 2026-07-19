import { basename, join } from "node:path";
import {
  canonicalRoot,
  collectHistoryFiles,
  fileCandidateSummary,
  historyCandidateId,
  type HistoryFile
} from "./file-history-utils.js";
import {
  ClaudeHistoryApprovalSchema,
  ClaudeHistoryCandidateSchema,
  type ClaudeHistoryApproval,
  type ClaudeHistoryCandidate
} from "./types.js";

export function claudeCandidateId(rootPath: string): string {
  return historyCandidateId("claude-code", rootPath);
}

export async function findClaudeHistoryFiles(rootPath: string): Promise<HistoryFile[]> {
  const root = await canonicalRoot(rootPath);
  return collectHistoryFiles(root, join(root, "projects"), (absolutePath) =>
    basename(absolutePath).endsWith(".jsonl")
  );
}

export async function discoverClaudeHistory(
  rootPath: string,
  discoveredAt = new Date().toISOString()
): Promise<ClaudeHistoryCandidate> {
  const root = await canonicalRoot(rootPath);
  const files = await findClaudeHistoryFiles(root);
  return ClaudeHistoryCandidateSchema.parse({
    id: claudeCandidateId(root),
    application: "claude-code",
    format: "claude-project-jsonl",
    rootPath: root,
    ...fileCandidateSummary(files),
    discoveredAt
  });
}

export function approveClaudeHistory(
  candidate: ClaudeHistoryCandidate,
  personId: string,
  profileId: string,
  approvedAt = new Date().toISOString(),
  scopeId = "personal"
): ClaudeHistoryApproval {
  const parsed = ClaudeHistoryCandidateSchema.parse(candidate);
  return ClaudeHistoryApprovalSchema.parse({
    candidateId: parsed.id,
    personId,
    application: parsed.application,
    format: parsed.format,
    rootPath: parsed.rootPath,
    profileId,
    scopeId,
    approvedAt
  });
}
