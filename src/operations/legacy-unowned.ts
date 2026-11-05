import { createHash } from "node:crypto";
import {
  QuarantineRecordSchema,
  type QuarantineRecord
} from "../domain/source-lifecycle.js";
import { quarantineRecordId } from "../imports/quarantine-service.js";
import { redactKnownSecrets } from "../imports/secret-redactor.js";
import type { LegacyUnownedKind } from "../storage/mcp-mutation-contracts.js";

/**
 * Storage key for quarantine rows that have no known owner.
 * This is not a person, not a profile, and not an authorization to read anyone's memory.
 */
export const LEGACY_UNOWNED_MARKER = "legacy-unowned";

export const isLegacyUnowned = (record: { personId?: string | null }): boolean =>
  !record.personId?.trim();

export function buildLegacyUnownedQuarantineRecord(input: {
  kind: LegacyUnownedKind;
  id: string;
  payload: unknown;
  now: string;
}): QuarantineRecord {
  const raw = JSON.stringify(input.payload);
  const sanitized = redactKnownSecrets(raw);
  const bounded = Buffer.from(sanitized, "utf8").subarray(0, 8192).toString("utf8");
  return QuarantineRecordSchema.parse({
    id: quarantineRecordId(
      LEGACY_UNOWNED_MARKER,
      input.id,
      `legacy://${input.kind}/${input.id}`,
      input.kind
    ),
    personId: LEGACY_UNOWNED_MARKER,
    candidateId: input.id,
    resourcePath: `legacy://${input.kind}/${input.id}`,
    recordPosition: input.kind,
    parserVersion: "legacy-unowned/v1",
    reason: "unsupported_record",
    recordHash: createHash("sha256").update(raw).digest("hex"),
    sanitizedRecord: bounded,
    rawByteLength: Buffer.byteLength(raw),
    state: "pending",
    createdAt: input.now,
    replayRequestedAt: null,
    replayedAt: null
  });
}
