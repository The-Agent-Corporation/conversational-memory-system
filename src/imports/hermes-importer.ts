import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ConversationTurnEvent } from "../domain/events.js";
import type { SourceGrant } from "../domain/source-lifecycle.js";
import type { ImportBatchReceipt } from "../daemon/types.js";
import type { Turn } from "../domain/types.js";
import { MemoryService } from "../service/memory-service.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { InMemoryStore } from "../storage/in-memory-store.js";
import { commitStagedGrantBatch, seedStagingImportState, type ApprovedGrantBatchOptions } from "./codex-importer.js";
import { importCheckpointId } from "./file-history-utils.js";
import {
  hermesCandidateId,
  hermesResourceName,
  openHermesReadonlyDatabase
} from "./hermes-discovery.js";
import { redactKnownSecrets } from "./secret-redactor.js";
import { createToolCallEvent, parseSerializedToolCalls, serializedToolCallsAreMalformed } from "./tool-call-record.js";
import { QuarantineService } from "./quarantine-service.js";
import { composeFileIdentity, fileIdentityMatches } from "./file-identity.js";
import { createEventLoopYielder } from "./cooperative-yield.js";
import {
  HermesHistoryApprovalSchema,
  ImportCheckpointSchema,
  type HermesHistoryApproval,
  type HistoryImportResult
} from "./types.js";

const PARSER_VERSION = "hermes-state-sqlite/v1";

interface HermesMessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  timestamp: number;
  source: string | null;
  tool_calls: string | null;
}

export interface HermesHistoryImporterOptions {
  /**
   * Where prior quarantine records are READ from, when that is not the store being written
   * to. Set only on the staged-batch path, where writes go to a throwaway staging store but
   * `replay_requested` state and the original `createdAt` live in the durable one.
   */
  quarantineLookupStore?: MemoryStore;
  clock?: () => string;
  sanitizeContent?: (content: string) => string;
}

export class HermesHistoryImporter {
  private readonly clock: () => string;
  private readonly sanitizeContent: (content: string) => string;
  private readonly quarantineLookupStore: MemoryStore | undefined;

  constructor(
    private readonly store: MemoryStore,
    options: HermesHistoryImporterOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.sanitizeContent = options.sanitizeContent ?? redactKnownSecrets;
    this.quarantineLookupStore = options.quarantineLookupStore;
  }

  async importApprovedSource(approval: HermesHistoryApproval): Promise<HistoryImportResult> {
    return this.importSource(approval, false);
  }

  async importApprovedGrantBatch(
    grant: SourceGrant,
    options: ApprovedGrantBatchOptions = {}
  ): Promise<ImportBatchReceipt> {
    const staging = new InMemoryStore();
    const clock = options.clock ?? this.clock;
    const importer = new HermesHistoryImporter(staging, { clock, sanitizeContent: this.sanitizeContent, quarantineLookupStore: this.store });
    await seedStagingImportState(this.store, staging, grant);
    await importer.importSource({
      candidateId: grant.candidateId,
      personId: grant.personId,
      application: "hermes",
      format: "hermes-state-sqlite",
      databasePath: grant.sourceLocator,
      profileId: grant.profileId,
      scopeId: grant.scopeId,
      approvedAt: grant.approvedAt
    }, true);
    return commitStagedGrantBatch(this.store, staging, grant, clock, options);
  }

  private async importSource(
    approval: HermesHistoryApproval,
    trustDurableGrant: boolean
  ): Promise<HistoryImportResult> {
    const parsed = HermesHistoryApprovalSchema.parse(approval);
    const databasePath = await realpath(resolve(parsed.databasePath));
    if (!trustDurableGrant && hermesCandidateId(databasePath) !== parsed.candidateId) {
      throw new Error("Approved Hermes database does not match its discovered candidate");
    }
    const metadata = await lstat(databasePath);
    const identity = composeFileIdentity(metadata);
    const resourcePath = hermesResourceName(databasePath);
    const checkpointId = importCheckpointId(parsed.personId, parsed.candidateId, resourcePath);
    const previous = await this.store.getImportCheckpoint(checkpointId);
    const database = openHermesReadonlyDatabase(databasePath);
    try {
      const maximum = database.prepare("select coalesce(max(id), 0) as maximum from messages")
        .get() as { maximum: number };
      const canResume = previous !== null &&
        fileIdentityMatches(previous.fileIdentity, metadata) &&
        previous.parserVersion === PARSER_VERSION &&
        Number(previous.rowHighWaterMark ?? previous.recordIndex) <= maximum.maximum;
      const highWaterMark = canResume
        ? Number(previous.rowHighWaterMark ?? previous.recordIndex)
        : 0;
      const messageColumns = new Set(
        (database.prepare("pragma table_info(messages)").all() as { name: string }[])
          .map((row) => row.name)
      );
      const toolCallsSelection = messageColumns.has("tool_calls")
        ? "m.tool_calls"
        : "null as tool_calls";
      const rows = database.prepare(
        `select m.id, m.session_id, m.role, m.content, m.timestamp, s.source, ${toolCallsSelection}
         from messages m
         left join sessions s on s.id = m.session_id
         where m.id > ?
         order by m.id asc`
      ).all(highWaterMark) as HermesMessageRow[];
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
        // Let the daemon's heartbeat timer run; see cooperative-yield.ts.
        await maybeYield();
        committedHighWaterMark = Math.max(committedHighWaterMark, Number(row.id));
        const role = supportedRole(row.role);
        if (!role || !Number.isFinite(row.timestamp)) {
          result.recordsSkipped += 1;
          continue;
        }
        const source = typeof row.source === "string" && row.source.length > 0
          ? row.source
          : "unknown";
        const profileId = `${parsed.profileId}/${source}`;
        const createdAt = epochToIso(row.timestamp);
        const eventMetadata = {
          sourceResource: resourcePath,
          rowId: Number(row.id),
          sessionSource: source
        };
        const events: ConversationTurnEvent[] = [];
        const malformedToolCalls = role === "assistant" && serializedToolCallsAreMalformed(row.tool_calls);
        if (malformedToolCalls) {
          await quarantine.capture({
            personId: parsed.personId,
            candidateId: parsed.candidateId,
            resourcePath,
            recordPosition: `row:${row.id}`,
            parserVersion: PARSER_VERSION,
            reason: "malformed_tool_call",
            rawRecord: typeof row.tool_calls === "string" ? row.tool_calls : JSON.stringify(row.tool_calls)
          });
          result.recordsQuarantined += 1;
        } else {
          await quarantine.resolve({
            personId: parsed.personId,
            candidateId: parsed.candidateId,
            resourcePath,
            recordPosition: `row:${row.id}`
          });
        }
        if (typeof row.content === "string" && row.content.length > 0) {
          events.push({
            id: `message:${row.id}`,
            nativeEventId: `message:${row.id}`,
            host: "hermes",
            profileId,
            hostSessionId: row.session_id,
            sequence: Number(row.id) * 1_000,
            type: "conversation_turn",
            eventKind: "message",
            role,
            content: this.sanitizeContent(row.content),
            createdAt,
            metadata: eventMetadata
          });
        }
        if (role === "assistant" && !malformedToolCalls) {
          parseSerializedToolCalls(row.tool_calls).forEach((call, index) => {
            events.push(createToolCallEvent({
              call,
              fallbackId: `message:${row.id}:tool:${index}`,
              host: "hermes",
              profileId,
              sessionId: row.session_id,
              sequence: Number(row.id) * 1_000 + index + 1,
              createdAt,
              metadata: eventMetadata,
              sanitizeContent: this.sanitizeContent
            }));
          });
        }
        if (events.length === 0) {
          result.recordsSkipped += 1;
          continue;
        }
        for (const event of events) {
          await service.ingestEvent(event);
          result.messagesProcessed += 1;
        }
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
}

function supportedRole(value: string): Turn["role"] | null {
  return value === "user" || value === "assistant" ? value : null;
}

function epochToIso(value: number): string {
  return new Date(value > 1_000_000_000_000 ? value : value * 1000).toISOString();
}
