import { join, sep } from "node:path";
import {
  canonicalRoot,
  collectHistoryFiles,
  fileCandidateSummary,
  historyCandidateId,
  type HistoryFile
} from "./file-history-utils.js";
import {
  OpenClawHistoryApprovalSchema,
  OpenClawHistoryCandidateSchema,
  type OpenClawHistoryApproval,
  type OpenClawHistoryCandidate
} from "./types.js";

export function openClawCandidateId(rootPath: string): string {
  return historyCandidateId("openclaw", rootPath);
}

export async function findOpenClawHistoryFiles(rootPath: string): Promise<HistoryFile[]> {
  const root = await canonicalRoot(rootPath);
  return collectHistoryFiles(root, join(root, "agents"), (_absolutePath, resourcePath) => {
    const parts = resourcePath.split(sep);
    return parts.length === 4 &&
      parts[0] === "agents" &&
      parts[2] === "sessions" &&
      parts[3].endsWith(".jsonl");
  });
}

export async function discoverOpenClawHistory(
  rootPath: string,
  discoveredAt = new Date().toISOString()
): Promise<OpenClawHistoryCandidate> {
  const root = await canonicalRoot(rootPath);
  const files = await findOpenClawHistoryFiles(root);
  return OpenClawHistoryCandidateSchema.parse({
    id: openClawCandidateId(root),
    application: "openclaw",
    format: "openclaw-session-jsonl",
    rootPath: root,
    ...fileCandidateSummary(files),
    discoveredAt
  });
}

export function approveOpenClawHistory(
  candidate: OpenClawHistoryCandidate,
  personId: string,
  profileId: string,
  approvedAt = new Date().toISOString(),
  scopeId = "personal"
): OpenClawHistoryApproval {
  const parsed = OpenClawHistoryCandidateSchema.parse(candidate);
  return OpenClawHistoryApprovalSchema.parse({
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
