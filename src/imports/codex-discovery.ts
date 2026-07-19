import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  CodexHistoryCandidateSchema,
  HistorySourceApprovalSchema,
  type CodexHistoryCandidate,
  type HistorySourceApproval
} from "./types.js";

export interface CodexHistoryFile {
  absolutePath: string;
  resourcePath: string;
  size: number;
  modifiedAt: string;
  fileIdentity: string;
}

export const codexCandidateId = (rootPath: string): string =>
  `codex_${createHash("sha256").update(resolve(rootPath)).digest("hex")}`;

export const findCodexHistoryFiles = async (rootPath: string): Promise<CodexHistoryFile[]> => {
  const canonicalRoot = await realpath(resolve(rootPath));
  const files: CodexHistoryFile[] = [];

  for (const directoryName of ["sessions", "archived_sessions"]) {
    await collectRolloutFiles(canonicalRoot, join(canonicalRoot, directoryName), files);
  }

  return files.sort((left, right) => left.resourcePath.localeCompare(right.resourcePath));
};

export const discoverCodexHistory = async (
  rootPath: string,
  discoveredAt = new Date().toISOString()
): Promise<CodexHistoryCandidate> => {
  const canonicalRoot = await realpath(resolve(rootPath));
  const files = await findCodexHistoryFiles(canonicalRoot);
  const modifiedTimes = files.map((file) => file.modifiedAt).sort();

  return CodexHistoryCandidateSchema.parse({
    id: codexCandidateId(canonicalRoot),
    application: "codex",
    format: "codex-rollout-jsonl",
    rootPath: canonicalRoot,
    sessionCount: files.length,
    estimatedBytes: files.reduce((total, file) => total + file.size, 0),
    earliestModifiedAt: modifiedTimes[0] ?? null,
    latestModifiedAt: modifiedTimes.at(-1) ?? null,
    discoveredAt
  });
};

export const approveCodexHistory = (
  candidate: CodexHistoryCandidate,
  personId: string,
  profileId: string,
  approvedAt = new Date().toISOString(),
  scopeId = "personal"
): HistorySourceApproval => {
  const parsedCandidate = CodexHistoryCandidateSchema.parse(candidate);
  return HistorySourceApprovalSchema.parse({
    candidateId: parsedCandidate.id,
    personId,
    application: parsedCandidate.application,
    format: parsedCandidate.format,
    rootPath: parsedCandidate.rootPath,
    profileId,
    scopeId,
    approvedAt
  });
};

const collectRolloutFiles = async (
  rootPath: string,
  currentPath: string,
  files: CodexHistoryFile[]
): Promise<void> => {
  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }

    const entryPath = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await collectRolloutFiles(rootPath, entryPath, files);
      continue;
    }

    if (!entry.isFile() || !/^rollout-.*\.jsonl$/u.test(entry.name)) {
      continue;
    }

    const metadata = await lstat(entryPath);
    files.push({
      absolutePath: entryPath,
      resourcePath: relative(rootPath, entryPath),
      size: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      fileIdentity: `${metadata.dev}:${metadata.ino}`
    });
  }
};

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
