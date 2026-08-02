import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { composeFileIdentity } from "./file-identity.js";

export interface HistoryFile {
  absolutePath: string;
  resourcePath: string;
  size: number;
  modifiedAt: string;
  fileIdentity: string;
}

export interface CompleteLine {
  content: string;
  nextOffset: number;
}

export async function canonicalRoot(rootPath: string): Promise<string> {
  return realpath(resolve(rootPath));
}

export function historyCandidateId(application: string, rootPath: string): string {
  return `${application}_${createHash("sha256").update(resolve(rootPath)).digest("hex")}`;
}

export function importCheckpointId(
  personId: string,
  candidateId: string,
  resourcePath: string
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([personId, candidateId, resourcePath]))
    .digest("hex");
  return `checkpoint_${digest}`;
}

export async function collectHistoryFiles(
  rootPath: string,
  startPath: string,
  accepts: (absolutePath: string, resourcePath: string) => boolean
): Promise<HistoryFile[]> {
  const files: HistoryFile[] = [];
  await walk(rootPath, startPath, accepts, files);
  return files.sort((left, right) => left.resourcePath.localeCompare(right.resourcePath));
}

async function walk(
  rootPath: string,
  currentPath: string,
  accepts: (absolutePath: string, resourcePath: string) => boolean,
  files: HistoryFile[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(currentPath, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolutePath = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      await walk(rootPath, absolutePath, accepts, files);
      continue;
    }
    const resourcePath = relative(rootPath, absolutePath);
    if (!entry.isFile() || !accepts(absolutePath, resourcePath)) continue;
    const metadata = await lstat(absolutePath);
    files.push({
      absolutePath,
      resourcePath,
      size: metadata.size,
      modifiedAt: metadata.mtime.toISOString(),
      fileIdentity: composeFileIdentity(metadata)
    });
  }
}

export async function* readCompleteLines(
  filePath: string,
  startingOffset: number
): AsyncGenerator<CompleteLine> {
  const stream = createReadStream(filePath, { start: startingOffset });
  let pending = Buffer.alloc(0);
  let committedOffset = startingOffset;

  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
    let newlineIndex = pending.indexOf(0x0a);
    while (newlineIndex !== -1) {
      const lineBytes = pending.subarray(0, newlineIndex);
      pending = pending.subarray(newlineIndex + 1);
      committedOffset += newlineIndex + 1;
      yield {
        content: (lineBytes.at(-1) === 0x0d
          ? lineBytes.subarray(0, -1)
          : lineBytes
        ).toString("utf8"),
        nextOffset: committedOffset
      };
      newlineIndex = pending.indexOf(0x0a);
    }
  }
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content.length > 0 ? content : null;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((value) => {
    if (typeof value === "string") return [value];
    const part = asObject(value);
    if (!part || part.type !== "text" || typeof part.text !== "string") return [];
    return [part.text];
  }).filter((value) => value.length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

export function containsContentBlockType(content: unknown, types: string[]): boolean {
  if (!Array.isArray(content)) return false;
  const accepted = new Set(types);
  return content.some((value) => {
    const block = asObject(value);
    return typeof block?.type === "string" && accepted.has(block.type);
  });
}

export function fileCandidateSummary(files: HistoryFile[]): {
  sessionCount: number;
  estimatedBytes: number;
  earliestModifiedAt: string | null;
  latestModifiedAt: string | null;
} {
  const modifiedTimes = files.map((file) => file.modifiedAt).sort();
  return {
    sessionCount: files.length,
    estimatedBytes: files.reduce((total, file) => total + file.size, 0),
    earliestModifiedAt: modifiedTimes[0] ?? null,
    latestModifiedAt: modifiedTimes.at(-1) ?? null
  };
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
