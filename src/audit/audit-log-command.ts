import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../storage/sqlite-store.js";
import { readFlags } from "../imports/history-discover-command.js";
import { sanitizeAuditDetail } from "./explain-service.js";

/**
 * D-02: queryable/exportable append-only audit log for bulk/forensic review, complementary to
 * the per-item `explain` trace. Reads the SAME persisted `source_lifecycle_audit` rows explain
 * reads (D-03 — surface, do not re-instrument) and serializes a filterable, metadata-only JSON
 * export. Every field is bounded and no field ever carries verbatim message content (ADR 0044,
 * Pitfall 5) — `details` is passed through `sanitizeAuditDetail`, which only preserves scalar
 * (string/number/boolean/null) values, string-length-bounded.
 */

const IdentifierSchema = z.string().min(1).max(512);
const DetailValueSchema = z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]);
const DetailSchema = z.record(z.string().min(1).max(128), DetailValueSchema);

export const AuditLogActionSchema = z.enum([
  "approved",
  "revoked",
  "deletion_requested",
  "deletion_completed",
  "quarantine_replay_requested"
]);

export const AuditLogEntrySchema = z.object({
  id: IdentifierSchema,
  personId: IdentifierSchema,
  candidateId: IdentifierSchema,
  action: AuditLogActionSchema,
  actor: z.string().min(1).max(256),
  occurredAt: z.string().min(1).max(64),
  detail: DetailSchema
}).strict();
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

const OptionsSchema = z.object({
  databasePath: z.string().min(1),
  personId: z.string().min(1),
  action: AuditLogActionSchema.optional(),
  candidateId: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional()
});

export interface AuditLogCommandOptions {
  databasePath: string;
  personId: string;
  action?: z.infer<typeof AuditLogActionSchema>;
  candidateId?: string;
  from?: string;
  to?: string;
}

export interface AuditLogCommandResult {
  ok: true;
  entries: AuditLogEntry[];
  count: number;
}

export async function runAuditLogCommand(options: AuditLogCommandOptions): Promise<AuditLogCommandResult> {
  const parsed = OptionsSchema.parse(options);
  const store = new SqliteStore(parsed.databasePath, { readOnly: true });
  try {
    const events = await store.listSourceLifecycleAuditEvents(parsed.personId);
    const entries = events
      .filter((event) => !parsed.action || event.action === parsed.action)
      .filter((event) => !parsed.candidateId || event.candidateId === parsed.candidateId)
      .filter((event) => !parsed.from || event.occurredAt >= parsed.from)
      .filter((event) => !parsed.to || event.occurredAt <= parsed.to)
      .map((event) => AuditLogEntrySchema.parse({
        id: event.id,
        personId: event.personId,
        candidateId: event.candidateId,
        action: event.action,
        actor: event.actor,
        occurredAt: event.occurredAt,
        detail: sanitizeAuditDetail(event.details)
      }))
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
    return { ok: true, entries, count: entries.length };
  } finally {
    store.close();
  }
}

function parseArgs(args: string[]): AuditLogCommandOptions {
  const values = readFlags(args);
  const databasePath = values.get("--db");
  const personId = values.get("--person");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  if (!personId) throw new Error("Missing person identity. Pass --person <person-id>.");
  const action = values.get("--action");
  if (action !== undefined && !AuditLogActionSchema.safeParse(action).success) {
    throw new Error(`Invalid --action. Use one of: ${AuditLogActionSchema.options.join(", ")}.`);
  }
  return {
    databasePath: resolve(databasePath),
    personId,
    action: action as AuditLogCommandOptions["action"],
    candidateId: values.get("--candidate"),
    from: values.get("--from"),
    to: values.get("--to")
  };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runAuditLogCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
