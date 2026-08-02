import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import type { ConversationTurnEvent } from "../domain/events.js";
import type { SourceGrant } from "../domain/source-lifecycle.js";
import { IsoDateTimeSchema, type JsonObject, type Turn } from "../domain/types.js";
import type { CanonicalEvent, MemorySource } from "../domain/canonical.js";
import { WriteAuthoritySchema, type ImportBatchReceipt, type WriteAuthority } from "../daemon/types.js";
import { MemoryService } from "../service/memory-service.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { InMemoryStore } from "../storage/in-memory-store.js";
import { codexCandidateId, findCodexHistoryFiles } from "./codex-discovery.js";
import { redactKnownSecrets } from "./secret-redactor.js";
import { createToolCallEvent } from "./tool-call-record.js";
import { QuarantineService, type QuarantineReason } from "./quarantine-service.js";
import {
  DEFAULT_LOCAL_SYNC_DEVICE_ID,
  emitLocalSyncOperation
} from "../sync/materialization/sync-materializer.js";
import { mutationEffectsFingerprint } from "../storage/mcp-mutation-contracts.js";
import { composeFileIdentity, fileIdentityMatches } from "./file-identity.js";
import {
  HistorySourceApprovalSchema,
  ImportCheckpointSchema,
  type CodexImportResult,
  type HistorySourceApproval,
  type ImportCheckpoint
} from "./types.js";

const PARSER_VERSION = "codex-rollout/v1";

export interface CodexHistoryImporterOptions {
  clock?: () => string;
  sanitizeContent?: (content: string) => string;
}

export interface ApprovedGrantBatchOptions {
  clock?: () => string;
  authority?: WriteAuthority;
  beforeCommit?: () => void | Promise<void>;
  syncDeviceId?: string;
}

interface CompleteLine {
  content: string;
  nextOffset: number;
}

interface ParsedCodexRecord {
  nativeSessionId?: string;
  events: ConversationTurnEvent[];
  quarantineReason?: QuarantineReason;
}

export class CodexHistoryImporter {
  private readonly clock: () => string;
  private readonly sanitizeContent: (content: string) => string;

  constructor(
    private readonly store: MemoryStore,
    options: CodexHistoryImporterOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.sanitizeContent = options.sanitizeContent ?? redactKnownSecrets;
  }

  async importApprovedSource(approval: HistorySourceApproval): Promise<CodexImportResult> {
    return this.importSource(approval, false);
  }

  async importApprovedGrantBatch(
    grant: SourceGrant,
    options: ApprovedGrantBatchOptions = {}
  ): Promise<ImportBatchReceipt> {
    const staging = new InMemoryStore();
    const clock = options.clock ?? this.clock;
    const importer = new CodexHistoryImporter(staging, {
      clock,
      sanitizeContent: this.sanitizeContent
    });
    await seedStagingImportState(this.store, staging, grant);
    await importer.importSource({
      candidateId: grant.candidateId,
      personId: grant.personId,
      application: "codex",
      format: "codex-rollout-jsonl",
      rootPath: grant.sourceLocator,
      profileId: grant.profileId,
      scopeId: grant.scopeId,
      approvedAt: grant.approvedAt
    }, true);
    return commitStagedGrantBatch(this.store, staging, grant, clock, options);
  }

  private async importSource(
    approval: HistorySourceApproval,
    trustDurableGrant: boolean
  ): Promise<CodexImportResult> {
    const parsedApproval = HistorySourceApprovalSchema.parse(approval);
    const canonicalRoot = await realpath(resolve(parsedApproval.rootPath));
    if (!trustDurableGrant && codexCandidateId(canonicalRoot) !== parsedApproval.candidateId) {
      throw new Error("Approved Codex root does not match its discovered candidate");
    }

    const service = new MemoryService(this.store, {
      personId: parsedApproval.personId,
      parserVersion: PARSER_VERSION,
      sourceInstanceId: parsedApproval.candidateId,
      scopeId: parsedApproval.scopeId,
      clock: this.clock
    });
    const quarantine = new QuarantineService(this.store, this.clock);
    const result: CodexImportResult = {
      filesScanned: 0,
      messagesProcessed: 0,
      recordsSkipped: 0,
      bytesProcessed: 0,
      recordsQuarantined: 0
    };

    for (const file of await findCodexHistoryFiles(canonicalRoot)) {
      result.filesScanned += 1;
      const checkpointId = this.checkpointId(parsedApproval, file.resourcePath);
      const previous = await this.store.getImportCheckpoint(checkpointId);
      const currentMetadata = await stat(file.absolutePath);
      const currentIdentity = composeFileIdentity(currentMetadata);
      const canResume = previous !== null &&
        fileIdentityMatches(previous.fileIdentity, currentMetadata) &&
        previous.parserVersion === PARSER_VERSION &&
        currentMetadata.size >= previous.byteOffset;
      const startingOffset = canResume ? previous.byteOffset : 0;
      let committedOffset = startingOffset;
      let recordIndex = canResume ? previous.recordIndex : 0;
      let nativeSessionId = canResume ? previous.nativeSessionId : null;
      const fallbackSessionId = this.fallbackSessionId(file.absolutePath);

      for await (const line of readCompleteLines(file.absolutePath, startingOffset)) {
        committedOffset = line.nextOffset;
        recordIndex += 1;
        if (line.content.trim().length === 0) {
          result.recordsSkipped += 1;
          continue;
        }

        const parsed = this.parseRecord(
          line.content,
          parsedApproval,
          file.resourcePath,
          nativeSessionId ?? fallbackSessionId,
          recordIndex
        );
        if (parsed.nativeSessionId) {
          nativeSessionId = parsed.nativeSessionId;
        }
        if (parsed.quarantineReason) {
          await quarantine.capture({
            personId: parsedApproval.personId,
            candidateId: parsedApproval.candidateId,
            resourcePath: file.resourcePath,
            recordPosition: String(recordIndex),
            parserVersion: PARSER_VERSION,
            reason: parsed.quarantineReason,
            rawRecord: line.content
          });
          result.recordsQuarantined += 1;
        } else {
          await quarantine.resolve({
            personId: parsedApproval.personId,
            candidateId: parsedApproval.candidateId,
            resourcePath: file.resourcePath,
            recordPosition: String(recordIndex)
          });
        }
        if (parsed.events.length === 0) {
          result.recordsSkipped += 1;
          continue;
        }
        for (const event of parsed.events) {
          await service.ingestEvent(event);
          result.messagesProcessed += 1;
        }
      }

      result.bytesProcessed += committedOffset - startingOffset;
      await this.store.saveImportCheckpoint(ImportCheckpointSchema.parse({
        id: checkpointId,
        personId: parsedApproval.personId,
        candidateId: parsedApproval.candidateId,
        resourcePath: file.resourcePath,
        fileIdentity: currentIdentity,
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
    approval: HistorySourceApproval,
    resourcePath: string,
    currentSessionId: string,
    recordIndex: number
  ): ParsedCodexRecord {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return { events: [], quarantineReason: "malformed_json" };
    }

    const root = asObject(record);
    const payload = asObject(root?.payload);
    if (!root || !payload || typeof root.type !== "string") {
      return { events: [], quarantineReason: "unsupported_record" };
    }

    if (root.type === "session_meta" && typeof payload.id === "string") {
      return { nativeSessionId: payload.id, events: [] };
    }

    if (root.type === "event_msg" || root.type === "turn_context") {
      return { events: [] };
    }
    if (root.type !== "response_item") return { events: [], quarantineReason: "unsupported_record" };

    const timestamp = IsoDateTimeSchema.safeParse(root.timestamp);
    if (!timestamp.success) return { events: [], quarantineReason: "unsupported_record" };
    const metadata: JsonObject = {
      sourceResource: resourcePath,
      recordIndex,
      recordType: "response_item"
    };

    if (payload.type === "function_call" && typeof payload.name === "string") {
      const callId = typeof payload.call_id === "string"
        ? payload.call_id
        : typeof payload.id === "string" ? payload.id : undefined;
      return {
        events: [createToolCallEvent({
          call: {
            ...(callId ? { id: callId } : {}),
            name: payload.name,
            arguments: payload.arguments
          },
          fallbackId: `${currentSessionId}:${recordIndex}:tool`,
          host: "codex",
          profileId: approval.profileId,
          sessionId: currentSessionId,
          sequence: recordIndex,
          createdAt: timestamp.data,
          metadata,
          sanitizeContent: this.sanitizeContent
        })]
      };
    }

    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      return { events: [] };
    }
    if (payload.type === "function_call") {
      return { events: [], quarantineReason: "unsupported_record" };
    }

    if (payload.type !== "message") {
      return { events: [], quarantineReason: "unsupported_record" };
    }

    const role = payload.role === "user" || payload.role === "assistant" ? payload.role : null;
    const content = extractMessageContent(payload.content);
    if (!role) return { events: [] };
    if (content === null) {
      return { events: [], quarantineReason: "unsupported_record" };
    }

    const nativeEventId = typeof payload.id === "string"
      ? payload.id
      : `${currentSessionId}:${recordIndex}`;
    return {
      events: [{
        id: `${approval.candidateId}:${currentSessionId}:${nativeEventId}`,
        nativeEventId,
        host: "codex",
        profileId: approval.profileId,
        hostSessionId: currentSessionId,
        sequence: recordIndex,
        type: "conversation_turn",
        eventKind: "message",
        role,
        content: this.sanitizeContent(content),
        createdAt: timestamp.data,
        metadata
      }]
    };
  }

  private checkpointId(approval: HistorySourceApproval, resourcePath: string): string {
    const digest = createHash("sha256")
      .update(JSON.stringify([approval.personId, approval.candidateId, resourcePath]))
      .digest("hex");
    return `checkpoint_${digest}`;
  }

  private fallbackSessionId(filePath: string): string {
    return basename(filePath).replace(/^rollout-/u, "").replace(/\.jsonl$/u, "");
  }
}

export async function commitStagedGrantBatch(
  store: MemoryStore,
  staging: MemoryStore,
  grant: SourceGrant,
  clock: () => string,
  options: ApprovedGrantBatchOptions = {}
): Promise<ImportBatchReceipt> {
  const authority = WriteAuthoritySchema.parse(options.authority);
  assertImportAuthority(authority, grant.personId);
  const checkpoints = (await staging.listImportCheckpoints(grant.personId))
    .filter((checkpoint) => checkpoint.candidateId === grant.candidateId)
    .sort((left, right) => left.resourcePath.localeCompare(right.resourcePath));
  if (checkpoints.length === 0) throw new Error("Approved source produced no import checkpoint");

  const sources = (await staging.listSources(grant.personId))
    .filter((source) => source.instanceId === grant.candidateId);
  const stagedEvents = await staging.listCanonicalEvents(grant.personId);
  const existing = new Map((await store.listCanonicalEvents(grant.personId)).map((event) => [event.id, event]));
  const quarantines = await staging.listQuarantineRecords(grant.personId, grant.candidateId);
  const stagedTurns = await collectStagedTurns(staging, stagedEvents);
  const receipts: ImportBatchReceipt[] = [];

  // Pre-bucket staged events by resource path and staged turns by canonical event id ONCE. The
  // checkpoint loop below runs per source file; re-filtering the full staged-event/turn arrays
  // inside it was O(files * events), which dominates a many-file bootstrap import (e.g. one
  // JSONL file per Claude Code session). Grouping first makes the loop O(events + turns).
  const eventsByResource = new Map<string, typeof stagedEvents>();
  for (const event of stagedEvents) {
    const resource = sourceResource(event);
    if (resource === null) continue;
    const bucket = eventsByResource.get(resource);
    if (bucket) bucket.push(event);
    else eventsByResource.set(resource, [event]);
  }
  const turnsByEventId = new Map<string, typeof stagedTurns>();
  for (const turn of stagedTurns) {
    const eventId = String(turn.metadata.canonicalEventId);
    const bucket = turnsByEventId.get(eventId);
    if (bucket) bucket.push(turn);
    else turnsByEventId.set(eventId, [turn]);
  }

  await options.beforeCommit?.();

  for (const checkpoint of checkpoints) {
    const resourceEvents = eventsByResource.get(checkpoint.resourcePath) ?? [];
    const changed = resourceEvents.filter((event) => materiallyChanged(existing.get(event.id), event))
      .sort(compareCanonical);
    const turns = changed
      .flatMap((event) => turnsByEventId.get(event.id) ?? [])
      .map((turn) => ({ ...turn, threadId: `person:${grant.personId}` }));
    const committedAt = clock();
    const orderKeys = changed.map((event) => ({
      occurredAt: event.occurredAt,
      nativeSequence: event.nativeSequence,
      id: event.id
    }));
    const receipt: ImportBatchReceipt = {
      id: `receipt_${digest([grant.id, checkpoint.id, checkpoint.fileIdentity, checkpoint.byteOffset, checkpoint.recordIndex, changed.map((event) => event.id)])}`,
      personId: grant.personId,
      grantId: grant.id,
      candidateId: grant.candidateId,
      scopeId: grant.scopeId,
      canonicalEventIds: changed.map((event) => event.id),
      canonicalOrderKeys: orderKeys,
      checkpointIds: [checkpoint.id],
      committedAt
    };
    await store.commitImportBatch({
      authority,
      personId: grant.personId,
      expectedGrant: {
        id: grant.id,
        personId: grant.personId,
        candidateId: grant.candidateId,
        updatedAt: grant.updatedAt
      },
      sources: sources as MemorySource[],
      canonicalEvents: changed,
      turns: turns as Turn[],
      quarantineChanges: quarantines.filter((record) => record.resourcePath === checkpoint.resourcePath),
      checkpoint,
      receipt,
      contractionJob: orderKeys.length === 0 ? null : {
        id: `contraction_${digest([grant.personId])}`,
        personId: grant.personId,
        generation: 1,
        earliestAffected: orderKeys[0]!,
        latestAffected: orderKeys.at(-1)!,
        state: "pending",
        attempts: 0,
        immediateDirty: true,
        proposalDirty: true,
        lastProposalRunAt: null,
        lastActivityAt: committedAt,
        nextDueAt: committedAt,
        createdAt: committedAt,
        updatedAt: committedAt
      }
    });
    if (receipt.canonicalEventIds.length > 0) {
      // Non-fatal: emitLocalSyncOperation surfaces a content-free signal internally on
      // non-COMMITTED status (WR-06); this call site does not throw or branch on it.
      await emitLocalSyncOperation(store, {
        personId: grant.personId,
        deviceId: options.syncDeviceId ?? DEFAULT_LOCAL_SYNC_DEVICE_ID,
        operationKind: "canonical_append",
        targetId: receipt.id,
        effectFingerprint: mutationEffectsFingerprint({
          canonicalEventIds: [...receipt.canonicalEventIds].sort(),
          checkpointIds: [...receipt.checkpointIds].sort()
        }),
        committedAt
      });
    }
    receipts.push(receipt);
  }

  if (receipts.length === 1) return receipts[0]!;
  const changed = receipts.flatMap((receipt) => receipt.canonicalOrderKeys).sort(compareOrderKey);
  return {
    id: `receipt_${digest(receipts.map((receipt) => receipt.id))}`,
    personId: grant.personId,
    grantId: grant.id,
    candidateId: grant.candidateId,
    scopeId: grant.scopeId,
    canonicalEventIds: changed.map((key) => key.id),
    canonicalOrderKeys: changed,
    checkpointIds: receipts.flatMap((receipt) => receipt.checkpointIds),
    committedAt: receipts.at(-1)!.committedAt
  };
}

function assertImportAuthority(authority: WriteAuthority, personId: string): void {
  if (authority.kind === "foreground" &&
      (authority.personId !== personId || authority.operation !== "approved-import")) {
    throw new Error("Foreground import requires exact approved-import authority");
  }
}

export async function seedStagingImportState(
  store: MemoryStore,
  staging: MemoryStore,
  grant: SourceGrant
): Promise<void> {
  for (const source of (await store.listSources(grant.personId)).filter((item) => item.instanceId === grant.candidateId)) {
    await staging.saveSource(source);
  }
  for (const checkpoint of (await store.listImportCheckpoints(grant.personId)).filter((item) => item.candidateId === grant.candidateId)) {
    await staging.saveImportCheckpoint(checkpoint);
  }
  for (const record of await store.listQuarantineRecords(grant.personId, grant.candidateId)) {
    await staging.saveQuarantineRecord(record);
  }
}

async function collectStagedTurns(store: MemoryStore, events: CanonicalEvent[]): Promise<Turn[]> {
  const sessionIds = [...new Set(events.map((event) => event.nativeSessionId))];
  return (await Promise.all(sessionIds.map((sessionId) => store.listTurns(sessionId)))).flat();
}

function sourceResource(event: CanonicalEvent): string | null {
  const sourceMetadata = event.metadata.sourceMetadata;
  return sourceMetadata && typeof sourceMetadata === "object" && !Array.isArray(sourceMetadata) &&
    typeof sourceMetadata.sourceResource === "string"
    ? sourceMetadata.sourceResource
    : null;
}

function materiallyChanged(previous: CanonicalEvent | undefined, next: CanonicalEvent): boolean {
  return previous === undefined || previous.contentHash !== next.contentHash ||
    previous.occurredAt !== next.occurredAt || previous.nativeSequence !== next.nativeSequence ||
    previous.parserVersion !== next.parserVersion || previous.role !== next.role ||
    previous.eventKind !== next.eventKind;
}

function compareCanonical(left: CanonicalEvent, right: CanonicalEvent): number {
  return left.occurredAt.localeCompare(right.occurredAt) ||
    left.nativeSequence - right.nativeSequence || left.id.localeCompare(right.id);
}

function compareOrderKey(
  left: ImportBatchReceipt["canonicalOrderKeys"][number],
  right: ImportBatchReceipt["canonicalOrderKeys"][number]
): number {
  return left.occurredAt.localeCompare(right.occurredAt) ||
    left.nativeSequence - right.nativeSequence || left.id.localeCompare(right.id);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const readCompleteLines = async function* (
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
      const content = lineBytes.at(-1) === 0x0d
        ? lineBytes.subarray(0, -1).toString("utf8")
        : lineBytes.toString("utf8");
      yield { content, nextOffset: committedOffset };
      newlineIndex = pending.indexOf(0x0a);
    }
  }
};

const extractMessageContent = (content: unknown): string | null => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const text = content
    .map((part) => asObject(part))
    .filter((part): part is Record<string, unknown> => part !== null)
    .filter((part) =>
      part.type === "input_text" || part.type === "output_text" || part.type === "text"
    )
    .map((part) => typeof part.text === "string" ? part.text : "")
    .filter((part) => part.length > 0)
    .join("\n");

  return text.length > 0 ? text : null;
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
