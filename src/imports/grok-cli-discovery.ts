import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  collectHistoryFiles,
  fileCandidateSummary,
  historyCandidateId,
  type HistoryFile
} from "./file-history-utils.js";
import {
  GrokHistoryApprovalSchema,
  GrokHistoryCandidateSchema,
  type GrokHistoryApproval,
  type GrokHistoryCandidate
} from "./types.js";

export function grokCandidateId(workspacePath: string): string {
  return historyCandidateId("grok-cli", workspacePath);
}

export function decodeGrokWorkspaceName(name: string): string | null {
  try {
    const decoded = decodeURIComponent(name);
    return isAbsolute(decoded) ? resolve(decoded) : null;
  } catch {
    return null;
  }
}

export async function findGrokHistoryFiles(workspacePath: string): Promise<HistoryFile[]> {
  const root = await realpath(resolve(workspacePath));
  return collectHistoryFiles(root, root, (_absolutePath, resourcePath) => {
    const parts = resourcePath.split(sep);
    return parts.length === 2 && parts[1] === "chat_history.jsonl";
  });
}

export async function discoverGrokCliHistory(
  sessionsPath: string,
  discoveredAt = new Date().toISOString()
): Promise<GrokHistoryCandidate[]> {
  const sessionsRoot = await realpath(resolve(sessionsPath));
  const entries = await readdir(sessionsRoot, { withFileTypes: true });
  const candidates: GrokHistoryCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const scopeId = decodeGrokWorkspaceName(entry.name);
    if (!scopeId) continue;
    const workspacePath = join(sessionsRoot, entry.name);
    const metadata = await lstat(workspacePath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) continue;
    const canonicalWorkspace = await realpath(workspacePath);
    if (relative(sessionsRoot, canonicalWorkspace).split(sep).length !== 1 ||
        relative(sessionsRoot, canonicalWorkspace).startsWith("..")) continue;
    const files = await findGrokHistoryFiles(canonicalWorkspace);
    candidates.push(GrokHistoryCandidateSchema.parse({
      id: grokCandidateId(canonicalWorkspace),
      application: "grok-cli",
      format: "grok-cli-session-jsonl",
      rootPath: canonicalWorkspace,
      scopeId,
      ...fileCandidateSummary(files),
      discoveredAt
    }));
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

export function approveGrokCliHistory(
  candidate: GrokHistoryCandidate,
  personId: string,
  profileId: string,
  approvedAt = new Date().toISOString()
): GrokHistoryApproval {
  const parsed = GrokHistoryCandidateSchema.parse(candidate);
  return GrokHistoryApprovalSchema.parse({
    candidateId: parsed.id,
    personId,
    application: parsed.application,
    format: parsed.format,
    rootPath: parsed.rootPath,
    profileId,
    scopeId: parsed.scopeId,
    approvedAt
  });
}
