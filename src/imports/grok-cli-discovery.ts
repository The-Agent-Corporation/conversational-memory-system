import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { composeFileIdentity } from "./file-identity.js";
import {
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
  const sessions = await readdir(root, { withFileTypes: true });
  const files: HistoryFile[] = [];
  for (const session of sessions) {
    if (!session.isDirectory() || session.isSymbolicLink()) continue;
    const absolutePath = join(root, session.name, "chat_history.jsonl");
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
    files.push({
      absolutePath,
      resourcePath: relative(root, absolutePath),
      size: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      fileIdentity: composeFileIdentity(metadata)
    });
  }
  return files.sort((left, right) => left.resourcePath.localeCompare(right.resourcePath));
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
