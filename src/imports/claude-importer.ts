import { stat, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ConversationTurnEvent } from "../domain/events.js";
import type { SourceGrant } from "../domain/source-lifecycle.js";
import type { ImportBatchReceipt } from "../daemon/types.js";
import { IsoDateTimeSchema, type JsonObject } from "../domain/types.js";
import { MemoryService } from "../service/memory-service.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { InMemoryStore } from "../storage/in-memory-store.js";
import { claudeCandidateId, findClaudeHistoryFiles } from "./claude-discovery.js";
import { commitStagedGrantBatch, seedStagingImportState, type ApprovedGrantBatchOptions } from "./codex-importer.js";
import {
  asObject,
  containsContentBlockType,
  extractTextContent,
  importCheckpointId,
  readCompleteLines
} from "./file-history-utils.js";
import { redactKnownSecrets } from "./secret-redactor.js";
import { createToolCallEvent, extractToolCalls } from "./tool-call-record.js";
import { QuarantineService, type QuarantineReason } from "./quarantine-service.js";
import {
  ClaudeHistoryApprovalSchema,
  ImportCheckpointSchema,
  type ClaudeHistoryApproval,
  type HistoryImportResult
} from "./types.js";

const PARSER_VERSION = "claude-project-jsonl/v1";

export interface ClaudeHistoryImporterOptions {
  clock?: () => string;
  sanitizeContent?: (content: string) => string;
}

export class ClaudeHistoryImporter {
  private readonly clock: () => string;
  private readonly sanitizeContent: (content: string) => string;

  constructor(
    private readonly store: MemoryStore,
    options: ClaudeHistoryImporterOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.sanitizeContent = options.sanitizeContent ?? redactKnownSecrets;
  }

  async importApprovedSource(approval: ClaudeHistoryApproval): Promise<HistoryImportResult> {
    return this.importSource(approval, false);
  }

  async importApprovedGrantBatch(
    grant: SourceGrant,
    options: ApprovedGrantBatchOptions = {}
  ): Promise<ImportBatchReceipt> {
    const staging = new InMemoryStore();
    const clock = options.clock ?? this.clock;
    const importer = new ClaudeHistoryImporter(staging, { clock, sanitizeContent: this.sanitizeContent });
    await seedStagingImportState(this.store, staging, grant);
    await importer.importSource({
      candidateId: grant.candidateId,
      personId: grant.personId,
      application: "claude-code",
      format: "claude-project-jsonl",
      rootPath: grant.sourceLocator,
      profileId: grant.profileId,
      scopeId: grant.scopeId,
      approvedAt: grant.approvedAt
    }, true);
    return commitStagedGrantBatch(this.store, staging, grant, clock, options);
  }

  private async importSource(
    approval: ClaudeHistoryApproval,
    trustDurableGrant: boolean
  ): Promise<HistoryImportResult> {
    const parsed = ClaudeHistoryApprovalSchema.parse(approval);
    const root = await realpath(resolve(parsed.rootPath));
    if (!trustDurableGrant && claudeCandidateId(root) !== parsed.candidateId) {
      throw new Error("Approved Claude Code root does not match its discovered candidate");
    }

    const service = new MemoryService(this.store, {
      personId: parsed.personId,
      parserVersion: PARSER_VERSION,
      sourceInstanceId: parsed.candidateId,
      scopeId: parsed.scopeId,
      clock: this.clock
    });
    const result: HistoryImportResult = emptyResult();
    const quarantine = new QuarantineService(this.store, this.clock);

    for (const file of await findClaudeHistoryFiles(root)) {
      result.filesScanned += 1;
      const checkpointId = importCheckpointId(parsed.personId, parsed.candidateId, file.resourcePath);
      const previous = await this.store.getImportCheckpoint(checkpointId);
      const metadata = await stat(file.absolutePath);
      const identity = `${metadata.dev}:${metadata.ino}`;
      const canResume = previous !== null &&
        previous.fileIdentity === identity &&
        previous.parserVersion === PARSER_VERSION &&
        metadata.size >= previous.byteOffset;
      const startingOffset = canResume ? previous.byteOffset : 0;
      let committedOffset = startingOffset;
      let recordIndex = canResume ? previous.recordIndex : 0;
      let nativeSessionId = canResume ? previous.nativeSessionId : null;
      const fallbackSessionId = basename(file.absolutePath, ".jsonl");

      for await (const line of readCompleteLines(file.absolutePath, startingOffset)) {
        committedOffset = line.nextOffset;
        recordIndex += 1;
        const parsedLine = this.parseRecord(
          line.content,
          parsed,
          file.resourcePath,
          nativeSessionId ?? fallbackSessionId,
          recordIndex
        );
        if (parsedLine.sessionId) nativeSessionId = parsedLine.sessionId;
        if (parsedLine.quarantineReason) {
          await quarantine.capture({
            personId: parsed.personId,
            candidateId: parsed.candidateId,
            resourcePath: file.resourcePath,
            recordPosition: String(recordIndex),
            parserVersion: PARSER_VERSION,
            reason: parsedLine.quarantineReason,
            rawRecord: line.content
          });
          result.recordsQuarantined += 1;
        } else {
          await quarantine.resolve({
            personId: parsed.personId,
            candidateId: parsed.candidateId,
            resourcePath: file.resourcePath,
            recordPosition: String(recordIndex)
          });
        }
        if (parsedLine.events.length === 0) {
          result.recordsSkipped += 1;
          continue;
        }
        for (const event of parsedLine.events) {
          await service.ingestEvent(event);
          result.messagesProcessed += 1;
        }
      }

      result.bytesProcessed += committedOffset - startingOffset;
      await this.store.saveImportCheckpoint(ImportCheckpointSchema.parse({
        id: checkpointId,
        personId: parsed.personId,
        candidateId: parsed.candidateId,
        resourcePath: file.resourcePath,
        fileIdentity: identity,
        byteOffset: committedOffset,
        recordIndex,
        nativeSessionId,
        parserVersion: PARSER_VERSION,
        updatedAt: this.clock()
      }));
    }
    return result;
  }

  private parseRecord(
    line: string,
    approval: ClaudeHistoryApproval,
    resourcePath: string,
    fallbackSessionId: string,
    recordIndex: number
  ): { sessionId?: string; events: ConversationTurnEvent[]; quarantineReason?: QuarantineReason } {
    if (line.trim().length === 0) return { events: [] };
    let unknownRecord: unknown;
    try {
      unknownRecord = JSON.parse(line);
    } catch {
      return { events: [], quarantineReason: "malformed_json" };
    }
    const record = asObject(unknownRecord);
    const message = asObject(record?.message);
    const sessionId = typeof record?.sessionId === "string" ? record.sessionId : undefined;
    if (!record) return { events: [], quarantineReason: "unsupported_record" };
    if (record.type !== "user" && record.type !== "assistant") {
      const knownIgnored = new Set(["progress", "system", "file-history-snapshot", "queue-operation"]);
      return sessionId
        ? { sessionId, events: [], ...(knownIgnored.has(String(record.type)) ? {} : { quarantineReason: "unsupported_record" as const }) }
        : { events: [], ...(knownIgnored.has(String(record.type)) ? {} : { quarantineReason: "unsupported_record" as const }) };
    }
    if (!message) return sessionId ? { sessionId, events: [], quarantineReason: "unsupported_record" } : { events: [], quarantineReason: "unsupported_record" };
    const role = message.role === "user" || message.role === "assistant"
      ? message.role
      : null;
    const timestamp = IsoDateTimeSchema.safeParse(record.timestamp);
    const content = extractTextContent(message.content);
    if (!role || !timestamp.success) {
      return sessionId ? { sessionId, events: [], quarantineReason: "unsupported_record" } : { events: [], quarantineReason: "unsupported_record" };
    }
    const currentSessionId = sessionId ?? fallbackSessionId;
    const nativeEventId = typeof record.uuid === "string"
      ? record.uuid
      : `${currentSessionId}:${recordIndex}`;
    const parentId = typeof record.parentUuid === "string" ? record.parentUuid : null;
    const metadata: JsonObject = {
      sourceResource: resourcePath,
      recordIndex,
      recordType: record.type,
      ...(typeof record.isSidechain === "boolean" ? { isSidechain: record.isSidechain } : {})
    };
    const events: ConversationTurnEvent[] = [];
    if (content !== null) {
      events.push({
        id: nativeEventId,
        nativeEventId,
        host: "claude-code",
        profileId: approval.profileId,
        hostSessionId: currentSessionId,
        sequence: recordIndex * 1_000,
        type: "conversation_turn",
        eventKind: "message",
        role,
        content: this.sanitizeContent(content),
        createdAt: timestamp.data,
        nativeParentEventId: parentId,
        metadata
      });
    }
    if (role === "assistant") {
      extractToolCalls(message.content).forEach((call, index) => {
        events.push(createToolCallEvent({
          call,
          fallbackId: `${nativeEventId}:tool:${index}`,
          host: "claude-code",
          profileId: approval.profileId,
          sessionId: currentSessionId,
          sequence: recordIndex * 1_000 + index + 1,
          createdAt: timestamp.data,
          parentId: content !== null ? nativeEventId : parentId,
          metadata,
          sanitizeContent: this.sanitizeContent
        }));
      });
    }
    if (events.length === 0 && containsContentBlockType(message.content, ["tool_result", "toolResult"])) {
      return { ...(sessionId ? { sessionId } : {}), events: [] };
    }
    if (events.length === 0) {
      return { ...(sessionId ? { sessionId } : {}), events: [], quarantineReason: "unsupported_record" };
    }
    return {
      ...(sessionId ? { sessionId } : {}),
      events
    };
  }
}

function emptyResult(): HistoryImportResult {
  return { filesScanned: 0, messagesProcessed: 0, recordsSkipped: 0, bytesProcessed: 0, recordsQuarantined: 0 };
}
