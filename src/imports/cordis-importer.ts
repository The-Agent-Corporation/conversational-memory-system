import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ConversationTurnEvent } from "../domain/events.js";
import type { SourceGrant } from "../domain/source-lifecycle.js";
import type { ImportBatchReceipt } from "../daemon/types.js";
import { MemoryService } from "../service/memory-service.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { InMemoryStore } from "../storage/in-memory-store.js";
import { commitStagedGrantBatch, seedStagingImportState, type ApprovedGrantBatchOptions } from "./codex-importer.js";
import {
  cordisCandidateId,
  cordisResourceName,
  openCordisReadonlyDatabase
} from "./cordis-discovery.js";
import { importCheckpointId } from "./file-history-utils.js";
import { redactKnownSecrets } from "./secret-redactor.js";
import { QuarantineService } from "./quarantine-service.js";
import { composeFileIdentity, fileIdentityMatches } from "./file-identity.js";
import { createEventLoopYielder } from "./cooperative-yield.js";
import {
  CordisHistoryApprovalSchema,
  ImportCheckpointSchema,
  type CordisHistoryApproval,
  type HistoryImportResult
} from "./types.js";

const PARSER_VERSION = "cordis-journal-sqlite/v1";
const SUPPORTED_SCHEMA_VERSION = 1;
const SKIPPED_KINDS = new Set(["tool.result", "review.output", "compaction.summary"]);

interface JournalRow {
  seq: number;
  session_key: string;
  kind: string;
  origin: string | null;
  schema_version: number;
  payload: string | null;
  created_at: string;
}

export interface CordisHistoryImporterOptions {
  quarantineLookupStore?: MemoryStore;
  clock?: () => string;
  sanitizeContent?: (content: string) => string;
}

export class CordisHistoryImporter {
  readonly forgetNativeEventIds: string[] = [];
  private readonly clock: () => string;
  private readonly sanitizeContent: (content: string) => string;
  private readonly quarantineLookupStore: MemoryStore | undefined;

  constructor(
    private readonly store: MemoryStore,
    options: CordisHistoryImporterOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.sanitizeContent = options.sanitizeContent ?? redactKnownSecrets;
    this.quarantineLookupStore = options.quarantineLookupStore;
  }

  async importApprovedSource(approval: CordisHistoryApproval): Promise<HistoryImportResult> {
    return this.importSource(approval, false);
  }

  async importApprovedGrantBatch(
    grant: SourceGrant,
    options: ApprovedGrantBatchOptions = {}
  ): Promise<ImportBatchReceipt> {
    const staging = new InMemoryStore();
    const clock = options.clock ?? this.clock;
    const importer = new CordisHistoryImporter(staging, {
      clock,
      sanitizeContent: this.sanitizeContent,
      quarantineLookupStore: this.store
    });
    await seedStagingImportState(this.store, staging, grant);
    await importer.importSource({
      candidateId: grant.candidateId,
      personId: grant.personId,
      application: "cordis",
      format: "cordis-journal-sqlite",
      databasePath: grant.sourceLocator,
      profileId: grant.profileId,
      scopeId: grant.scopeId,
      approvedAt: grant.approvedAt
    }, true);
    const receipt = await commitStagedGrantBatch(this.store, staging, grant, clock, options);
    const staged = await staging.listCanonicalEvents(grant.personId);
    const sourceId = staged[0]?.sourceId;
    for (const nativeEventId of importer.forgetNativeEventIds) {
      if (!sourceId) break;
      try {
        await this.store.commitEventDeletion({
          personId: grant.personId,
          sourceId,
          nativeEventId,
          deletedAt: clock(),
          actor: "cordis-journal",
          reason: "journal forget"
        });
      } catch {
        // A forget for a seq that was never imported stays a no-op for the batch.
      }
    }
    return receipt;
  }

  private async importSource(
    approval: CordisHistoryApproval,
    trustDurableGrant: boolean
  ): Promise<HistoryImportResult> {
    const parsed = CordisHistoryApprovalSchema.parse(approval);
    const databasePath = await realpath(resolve(parsed.databasePath));
    if (!trustDurableGrant && cordisCandidateId(databasePath) !== parsed.candidateId) {
      throw new Error("Approved Cordis journal does not match its discovered candidate");
    }
    const metadata = await lstat(databasePath);
    const identity = composeFileIdentity(metadata);
    const resourcePath = cordisResourceName(databasePath);
    const checkpointId = importCheckpointId(parsed.personId, parsed.candidateId, resourcePath);
    const previous = await this.store.getImportCheckpoint(checkpointId);
    const database = openCordisReadonlyDatabase(databasePath);
    try {
      const maximum = database.prepare("select coalesce(max(seq), 0) as maximum from journal").get() as { maximum: number };
      const canResume = previous !== null &&
        fileIdentityMatches(previous.fileIdentity, metadata) &&
        previous.parserVersion === PARSER_VERSION &&
        Number(previous.rowHighWaterMark ?? previous.recordIndex) <= maximum.maximum;
      const highWaterMark = canResume ? Number(previous.rowHighWaterMark ?? previous.recordIndex) : 0;
      const rows = database.prepare(
        `select seq, session_key, kind, origin, schema_version, payload, created_at
         from journal where seq > ? order by seq asc`
      ).all(highWaterMark) as JournalRow[];
      const service = new MemoryService(this.store, {
        personId: parsed.personId,
        parserVersion: PARSER_VERSION,
        sourceInstanceId: parsed.candidateId,
        scopeId: parsed.scopeId,
        clock: this.clock
      });
      const result: HistoryImportResult = {
        filesScanned: 1,
        messagesProcessed: 0,
        recordsSkipped: 0,
        bytesProcessed: 0,
        recordsQuarantined: 0
      };
      const maybeYield = createEventLoopYielder();
      const quarantine = new QuarantineService(this.store, this.clock, this.quarantineLookupStore);
      let committedHighWaterMark = highWaterMark;
      for (const row of rows) {
        await maybeYield();
        committedHighWaterMark = Math.max(committedHighWaterMark, Number(row.seq));
        if (SKIPPED_KINDS.has(row.kind)) {
          result.recordsSkipped += 1;
          continue;
        }
        if (row.schema_version !== SUPPORTED_SCHEMA_VERSION || !mappedKind(row.kind)) {
          await quarantine.capture({
            personId: parsed.personId,
            candidateId: parsed.candidateId,
            resourcePath,
            recordPosition: `seq:${row.seq}`,
            parserVersion: PARSER_VERSION,
            reason: "unsupported_record",
            rawRecord: JSON.stringify({ kind: row.kind, schemaVersion: row.schema_version })
          });
          result.recordsQuarantined += 1;
          continue;
        }
        if (row.kind === "forget") {
          const target = forgetTarget(row.payload);
          if (target) this.forgetNativeEventIds.push(target);
          else result.recordsSkipped += 1;
          continue;
        }
        const event = this.toEvent(row, parsed.profileId, resourcePath);
        const ingested = await service.ingestEvent(event);
        if (ingested) result.messagesProcessed += 1;
        else result.recordsSkipped += 1;
      }
      await this.store.saveImportCheckpoint(ImportCheckpointSchema.parse({
        id: checkpointId,
        personId: parsed.personId,
        candidateId: parsed.candidateId,
        resourcePath,
        fileIdentity: identity,
        byteOffset: 0,
        recordIndex: committedHighWaterMark,
        rowHighWaterMark: String(committedHighWaterMark),
        nativeSessionId: null,
        parserVersion: PARSER_VERSION,
        updatedAt: this.clock()
      }));
      return result;
    } finally {
      database.close();
    }
  }

  private toEvent(row: JournalRow, profileId: string, resourcePath: string): ConversationTurnEvent {
    const mapped = mappedKind(row.kind)!;
    const payload = parsePayload(row.payload);
    const text = typeof payload.text === "string"
      ? payload.text
      : typeof payload.content === "string"
        ? payload.content
        : row.kind.startsWith("session.")
          ? ""
          : JSON.stringify(payload);
    return {
      id: `cordis:${row.seq}`,
      nativeEventId: String(row.seq),
      host: "cordis",
      profileId,
      hostSessionId: row.session_key,
      sequence: Number(row.seq),
      type: "conversation_turn",
      ...(mapped.eventKind ? { eventKind: mapped.eventKind } : {}),
      role: mapped.role,
      content: this.sanitizeContent(text),
      createdAt: row.created_at,
      metadata: {
        sourceResource: resourcePath,
        origin: row.origin,
        sessionBoundary: row.kind === "session.start" ? "start" : row.kind === "session.end" ? "end" : null,
        kind: row.kind
      }
    };
  }
}

function mappedKind(kind: string): { role: ConversationTurnEvent["role"]; eventKind?: "message" | "tool_call" } | null {
  if (kind === "message.user") return { role: "user", eventKind: "message" };
  if (kind === "message.assistant") return { role: "assistant", eventKind: "message" };
  if (kind === "tool.call") return { role: "assistant", eventKind: "tool_call" };
  if (kind === "memory.write" || kind === "session.start" || kind === "session.end") return { role: "system", eventKind: "message" };
  if (kind === "forget") return { role: "system" };
  return null;
}

function parsePayload(payload: string | null): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { text: payload };
  } catch {
    return { text: payload };
  }
}

function forgetTarget(payload: string | null): string | null {
  const parsed = parsePayload(payload);
  if (typeof parsed.seq === "number") return String(parsed.seq);
  if (typeof parsed.nativeEventId === "string" && parsed.nativeEventId.length > 0) return parsed.nativeEventId;
  return null;
}
