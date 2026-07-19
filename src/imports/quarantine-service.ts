import { createHash } from "node:crypto";
import {
  QuarantineRecordSchema,
  type QuarantineRecord
} from "../domain/source-lifecycle.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { redactKnownSecrets } from "./secret-redactor.js";

const MAX_QUARANTINE_RECORD_BYTES = 8_192;

export type QuarantineReason = QuarantineRecord["reason"];

export class QuarantineService {
  constructor(
    private readonly store: MemoryStore,
    private readonly clock: () => string = () => new Date().toISOString()
  ) {}

  async capture(input: {
    personId: string;
    candidateId: string;
    resourcePath: string;
    recordPosition: string;
    parserVersion: string;
    reason: QuarantineReason;
    rawRecord: string;
  }): Promise<QuarantineRecord> {
    const id = quarantineRecordId(
      input.personId,
      input.candidateId,
      input.resourcePath,
      input.recordPosition
    );
    const existing = await this.store.getQuarantineRecord(id);
    const sanitized = redactKnownSecrets(input.rawRecord);
    const bounded = Buffer.from(sanitized, "utf8").subarray(0, MAX_QUARANTINE_RECORD_BYTES).toString("utf8");
    const record = QuarantineRecordSchema.parse({
      id,
      personId: input.personId,
      candidateId: input.candidateId,
      resourcePath: input.resourcePath,
      recordPosition: input.recordPosition,
      parserVersion: input.parserVersion,
      reason: input.reason,
      recordHash: createHash("sha256").update(input.rawRecord).digest("hex"),
      sanitizedRecord: bounded,
      rawByteLength: Buffer.byteLength(input.rawRecord),
      state: existing?.state === "replay_requested" ? "replay_requested" : "pending",
      createdAt: existing?.createdAt ?? this.clock(),
      replayRequestedAt: existing?.replayRequestedAt ?? null,
      replayedAt: null
    });
    await this.store.saveQuarantineRecord(record);
    return record;
  }

  async resolve(input: {
    personId: string;
    candidateId: string;
    resourcePath: string;
    recordPosition: string;
  }): Promise<void> {
    const id = quarantineRecordId(
      input.personId,
      input.candidateId,
      input.resourcePath,
      input.recordPosition
    );
    const existing = await this.store.getQuarantineRecord(id);
    if (!existing || existing.state === "replayed" || existing.state === "discarded") return;
    await this.store.saveQuarantineRecord(QuarantineRecordSchema.parse({
      ...existing,
      state: "replayed",
      replayedAt: this.clock()
    }));
  }
}

export function quarantineRecordId(
  personId: string,
  candidateId: string,
  resourcePath: string,
  recordPosition: string
): string {
  return `quarantine_${createHash("sha256")
    .update(JSON.stringify([personId, candidateId, resourcePath, recordPosition]))
    .digest("hex")}`;
}
