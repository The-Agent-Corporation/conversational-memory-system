import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { ConversationTurnEvent } from "../domain/events.js";
import type { SourceGrant } from "../domain/source-lifecycle.js";
import type { ImportBatchReceipt } from "../daemon/types.js";
import { IsoDateTimeSchema, type JsonObject } from "../domain/types.js";
import { MemoryService } from "../service/memory-service.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { InMemoryStore } from "../storage/in-memory-store.js";
import { commitStagedGrantBatch, seedStagingImportState, type ApprovedGrantBatchOptions } from "./codex-importer.js";
import { createEventLoopYielder } from "./cooperative-yield.js";
import { composeFileIdentity, fileIdentityMatches } from "./file-identity.js";
import { asObject, extractTextContent, importCheckpointId, readCompleteLines } from "./file-history-utils.js";
import { decodeGrokWorkspaceName, findGrokHistoryFiles, grokCandidateId } from "./grok-cli-discovery.js";
import { QuarantineService, type QuarantineReason } from "./quarantine-service.js";
import { redactKnownSecrets } from "./secret-redactor.js";
import { createToolCallEvent, parseSerializedToolCalls, serializedToolCallsAreMalformed } from "./tool-call-record.js";
import { GrokHistoryApprovalSchema, ImportCheckpointSchema, type GrokHistoryApproval, type HistoryImportResult } from "./types.js";

const PARSER_VERSION = "grok-cli-session-jsonl/v1";

export interface GrokCliHistoryImporterOptions {
  quarantineLookupStore?: MemoryStore;
  clock?: () => string;
  sanitizeContent?: (content: string) => string;
}

export class GrokCliHistoryImporter {
  private readonly clock: () => string;
  private readonly sanitizeContent: (content: string) => string;
  private readonly quarantineLookupStore: MemoryStore | undefined;

  constructor(private readonly store: MemoryStore, options: GrokCliHistoryImporterOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.sanitizeContent = options.sanitizeContent ?? redactKnownSecrets;
    this.quarantineLookupStore = options.quarantineLookupStore;
  }

  async importApprovedSource(approval: GrokHistoryApproval): Promise<HistoryImportResult> {
    return this.importSource(approval);
  }

  async importApprovedGrantBatch(grant: SourceGrant, options: ApprovedGrantBatchOptions = {}): Promise<ImportBatchReceipt> {
    const staging = new InMemoryStore();
    const clock = options.clock ?? this.clock;
    const importer = new GrokCliHistoryImporter(staging, {
      clock,
      sanitizeContent: this.sanitizeContent,
      quarantineLookupStore: this.store
    });
    await seedStagingImportState(this.store, staging, grant);
    await importer.importSource({
      candidateId: grant.candidateId,
      personId: grant.personId,
      application: "grok-cli",
      format: "grok-cli-session-jsonl",
      rootPath: grant.sourceLocator,
      profileId: grant.profileId,
      scopeId: grant.scopeId,
      approvedAt: grant.approvedAt
    });
    return commitStagedGrantBatch(this.store, staging, grant, clock, options);
  }

  private async importSource(approval: GrokHistoryApproval): Promise<HistoryImportResult> {
    const parsed = GrokHistoryApprovalSchema.parse(approval);
    const approvedPath = resolve(parsed.rootPath);
    const approvedMetadata = await lstat(approvedPath);
    if (!approvedMetadata.isDirectory() || approvedMetadata.isSymbolicLink()) {
      throw new Error("Approved Grok workspace must remain a regular directory");
    }
    const workspace = await realpath(approvedPath);
    const sessionsRoot = await realpath(dirname(workspace));
    const decodedScope = decodeGrokWorkspaceName(basename(workspace));
    if (workspace !== approvedPath || basename(sessionsRoot) !== "sessions" || decodedScope !== parsed.scopeId ||
        grokCandidateId(workspace) !== parsed.candidateId) {
      throw new Error("Approved Grok workspace does not match its discovered candidate and scope");
    }

    const result = emptyResult();
    const quarantine = new QuarantineService(this.store, this.clock, this.quarantineLookupStore);
    const maybeYield = createEventLoopYielder();
    const service = new MemoryService(this.store, {
      personId: parsed.personId,
      parserVersion: PARSER_VERSION,
      sourceInstanceId: parsed.candidateId,
      scopeId: parsed.scopeId,
      clock: this.clock
    });

    for (const file of await findGrokHistoryFiles(workspace)) {
      await maybeYield();
      result.filesScanned += 1;
      const sessionId = basename(dirname(file.absolutePath));
      const sidecar = await this.readTurnTimestamps(dirname(file.absolutePath), file.resourcePath, parsed, quarantine, result);
      const metadata = await stat(file.absolutePath);
      const fallbackTimestamp = metadata.mtime.toISOString();
      const checkpointId = importCheckpointId(parsed.personId, parsed.candidateId, file.resourcePath);
      const previous = await this.store.getImportCheckpoint(checkpointId);
      const canResume = previous !== null && fileIdentityMatches(previous.fileIdentity, metadata) &&
        previous.parserVersion === PARSER_VERSION && previous.rowHighWaterMark === sidecar.identity &&
        metadata.size >= previous.byteOffset;
      const startingOffset = canResume ? previous.byteOffset : 0;
      let committedOffset = startingOffset;
      let recordIndex = canResume ? previous.recordIndex : 0;
      let turnNumber = canResume ? checkpointTurnNumber(previous?.nativeSessionId, sessionId) : firstTurnNumber(sidecar.timestamps) - 1;

      for await (const line of readCompleteLines(file.absolutePath, startingOffset)) {
        await maybeYield();
        committedOffset = line.nextOffset;
        recordIndex += 1;
        const classified = classifyRecord(line.content);
        if (classified.startsTurn) turnNumber += 1;
        const joinedTimestamp = sidecar.timestamps.get(turnNumber);
        const parsedLine = this.parseRecord(classified, parsed, file.resourcePath, sessionId, recordIndex, turnNumber,
          joinedTimestamp ?? fallbackTimestamp, joinedTimestamp ? "events_turn" : "chat_history_mtime");
        if (parsedLine.quarantineReason) {
          await quarantine.capture({
            personId: parsed.personId, candidateId: parsed.candidateId, resourcePath: file.resourcePath,
            recordPosition: String(recordIndex), parserVersion: PARSER_VERSION,
            reason: parsedLine.quarantineReason, rawRecord: line.content
          });
          result.recordsQuarantined += 1;
        } else if (!classified.recognizedExclusion) {
          await quarantine.resolve({ personId: parsed.personId, candidateId: parsed.candidateId,
            resourcePath: file.resourcePath, recordPosition: String(recordIndex) });
        }
        if (parsedLine.events.length === 0) result.recordsSkipped += 1;
        for (const event of parsedLine.events) {
          await service.ingestEvent(event);
          result.messagesProcessed += 1;
        }
      }
      result.bytesProcessed += committedOffset - startingOffset;
      await this.store.saveImportCheckpoint(ImportCheckpointSchema.parse({
        id: checkpointId, personId: parsed.personId, candidateId: parsed.candidateId,
        resourcePath: file.resourcePath, fileIdentity: composeFileIdentity(metadata), byteOffset: committedOffset,
        recordIndex, nativeSessionId: `${sessionId}|${turnNumber}`, parserVersion: PARSER_VERSION,
        rowHighWaterMark: sidecar.identity, updatedAt: this.clock()
      }));
    }
    return result;
  }

  private async readTurnTimestamps(
    sessionPath: string,
    chatResource: string,
    approval: GrokHistoryApproval,
    quarantine: QuarantineService,
    result: HistoryImportResult
  ): Promise<{ timestamps: Map<number, string>; identity: string }> {
    const timestamps = new Map<number, string>();
    let index = 0;
    const sidecarPath = resolve(sessionPath, "events.jsonl");
    try {
      const metadata = await lstat(sidecarPath);
      if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(sidecarPath) !== sidecarPath) {
        return { timestamps, identity: "absent" };
      }
      const identity = `${composeFileIdentity(metadata)}:${metadata.size}:${Math.trunc(metadata.mtimeMs)}`;
      for await (const line of readCompleteLines(sidecarPath, 0)) {
        index += 1;
        let value: unknown;
        try { value = JSON.parse(line.content); } catch { value = null; }
        const event = asObject(value);
        const turn = typeof event?.turn_number === "number" && Number.isInteger(event.turn_number) ? event.turn_number : null;
        const timestamp = IsoDateTimeSchema.safeParse(event?.ts);
        if (event && turn !== null && turn >= 0 && timestamp.success) {
          timestamps.set(turn, timestamp.data);
          await quarantine.resolve({ personId: approval.personId, candidateId: approval.candidateId,
            resourcePath: chatResource, recordPosition: `events:${index}` });
        } else {
          await quarantine.capture({ personId: approval.personId, candidateId: approval.candidateId,
            resourcePath: chatResource, recordPosition: `events:${index}`, parserVersion: PARSER_VERSION,
            reason: value === null ? "malformed_json" : "unsupported_record", rawRecord: line.content });
          result.recordsQuarantined += 1;
        }
      }
      return { timestamps, identity };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return { timestamps, identity: "absent" };
  }

  private parseRecord(
    classified: ClassifiedRecord,
    approval: GrokHistoryApproval,
    resourcePath: string,
    sessionId: string,
    recordIndex: number,
    turnNumber: number,
    createdAt: string,
    timestampSource: "events_turn" | "chat_history_mtime"
  ): { events: ConversationTurnEvent[]; quarantineReason?: QuarantineReason } {
    if (classified.quarantineReason) return { events: [], quarantineReason: classified.quarantineReason };
    if (!classified.record || classified.recognizedExclusion) return { events: [] };
    const record = classified.record;
    const role = record.role ?? record.type;
    if (role !== "user" && role !== "assistant") return { events: [], quarantineReason: "unsupported_record" };
    const content = extractTextContent(record.content);
    if (serializedToolCallsAreMalformed(record.tool_calls)) return { events: [], quarantineReason: "malformed_tool_call" };
    const nativeEventId = typeof record.id === "string" ? record.id : `${sessionId}:${recordIndex}`;
    const metadata: JsonObject = {
      sourceResource: resourcePath,
      recordIndex,
      turnNumber,
      timestampSource,
      timestampConfidence: timestampSource === "events_turn" ? "high" : "low",
      ...(typeof record.model_id === "string" ? { modelId: record.model_id } : {}),
      ...(typeof record.model_fingerprint === "string" ? { modelFingerprint: record.model_fingerprint } : {})
    };
    const events: ConversationTurnEvent[] = [];
    if (content !== null) events.push({
      id: nativeEventId, nativeEventId, host: "grok-cli", profileId: approval.profileId,
      hostSessionId: sessionId, sequence: recordIndex * 1_000, type: "conversation_turn",
      eventKind: "message", role, content: this.sanitizeContent(content), createdAt,
      nativeParentEventId: null, metadata
    });
    if (role === "assistant") parseSerializedToolCalls(record.tool_calls).forEach((call, index) => {
      events.push(createToolCallEvent({ call, fallbackId: `${nativeEventId}:tool:${index}`,
        host: "grok-cli", profileId: approval.profileId, sessionId,
        sequence: recordIndex * 1_000 + index + 1, createdAt,
        parentId: content !== null ? nativeEventId : null, metadata, sanitizeContent: this.sanitizeContent }));
    });
    return { events };
  }
}

interface ClassifiedRecord {
  record: Record<string, unknown> | null;
  startsTurn: boolean;
  recognizedExclusion: boolean;
  quarantineReason?: QuarantineReason;
}

function classifyRecord(line: string): ClassifiedRecord {
  if (line.trim().length === 0) return { record: null, startsTurn: false, recognizedExclusion: true };
  let value: unknown;
  try { value = JSON.parse(line); } catch {
    return { record: null, startsTurn: false, recognizedExclusion: false, quarantineReason: "malformed_json" };
  }
  const record = asObject(value);
  if (!record) return { record: null, startsTurn: false, recognizedExclusion: false, quarantineReason: "unsupported_record" };
  const role = record.role ?? record.type;
  const exclusion = role === "reasoning" || role === "tool" || role === "tool_result" || role === "system" ||
    "encrypted_content" in record || "summary" in record && role !== "assistant";
  return { record, startsTurn: role === "user", recognizedExclusion: exclusion };
}

function emptyResult(): HistoryImportResult {
  return { filesScanned: 0, messagesProcessed: 0, recordsSkipped: 0, bytesProcessed: 0, recordsQuarantined: 0 };
}

function firstTurnNumber(timestamps: Map<number, string>): number {
  return timestamps.size > 0 ? Math.min(...timestamps.keys()) : 1;
}

function checkpointTurnNumber(value: string | null | undefined, sessionId: string): number {
  const prefix = `${sessionId}|`;
  if (!value?.startsWith(prefix)) return 0;
  const parsed = Number(value.slice(prefix.length));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}
