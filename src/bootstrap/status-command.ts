import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../storage/sqlite-store.js";
import { historicalBootstrapCheckpointId } from "./historical-bootstrapper.js";
import type { HistoricalBootstrapCheckpoint } from "./types.js";
import type { MemoryStore } from "../storage/memory-store.js";
import type { LaunchAgentStatus } from "../daemon/macos/launch-agent.js";

export interface DaemonStatusSnapshot {
  state: "running" | "stopping" | "stale" | "stopped";
  ownerToken: string | null;
  pid: number | null;
  acquiredAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  stopRequestedAt: string | null;
  lastSuccessfulScanAt: string | null;
  degradedSources: Array<{
    personId: string;
    candidateId: string;
    category: string;
    failures: number;
    degradedAt: string | null;
  }>;
  queues: { contractions: number; proposals: number };
  service: LaunchAgentStatus | null;
}

const OptionsSchema = z.object({
  databasePath: z.string().min(1),
  personId: z.string().min(1)
});

export interface MemoryStatusCommandOptions {
  databasePath: string;
  personId: string;
}

export interface MemoryStatusCommandResult {
  ok: true;
  personId: string;
  sourceCount: number;
  canonicalEventCount: number;
  importCheckpointCount: number;
  approvedSourceGrantCount: number;
  revokedSourceGrantCount: number;
  sourceLifecycleAuditEventCount: number;
  pendingQuarantineRecordCount: number;
  replayRequestedQuarantineRecordCount: number;
  historicalSummaryCount: number;
  anchorCount: number;
  proposedBoxCount: number;
  proposedMemoryChangeCount: number;
  bootstrapCheckpoint: HistoricalBootstrapCheckpoint | null;
  daemon: DaemonStatusSnapshot;
}

export async function readDaemonStatusSnapshot(
  store: MemoryStore,
  now: string,
  serviceStatus: LaunchAgentStatus | null = null,
  personId?: string
): Promise<DaemonStatusSnapshot> {
  const databaseId = "memory-db";
  let lease = await store.getDaemonLease(databaseId);
  // Older callers may have selected a path-derived database ID. There is deliberately
  // one daemon lease per database; the default ID is the portable command contract.
  const people = personId ? (await store.getPerson(personId) ? [{ id: personId }] : []) : await store.listPeople();
  const degradedSources: DaemonStatusSnapshot["degradedSources"] = [];
  let contractions = 0;
  let proposals = 0;
  let latestSourceSuccess: string | null = null;
  for (const person of people) {
    const states = await store.listDaemonSourceStates(person.id);
    for (const source of states) {
      if (source.lastSuccessAt && (!latestSourceSuccess || source.lastSuccessAt > latestSourceSuccess)) {
        latestSourceSuccess = source.lastSuccessAt;
      }
      if (source.state === "degraded") {
        degradedSources.push({
          personId: source.personId,
          candidateId: source.candidateId,
          category: source.errorCategory ?? "unknown",
          failures: source.consecutiveFailures,
          degradedAt: source.degradedAt
        });
      }
    }
    const jobs = await store.listContractionJobs(person.id);
    contractions += jobs.filter((job) => job.state === "pending" || job.state === "failed").length;
    proposals += jobs.filter((job) => job.proposalDirty).length;
  }
  const nowMs = Date.parse(now);
  const fresh = lease !== null && Date.parse(lease.expiresAt) > nowMs;
  const state: DaemonStatusSnapshot["state"] = !lease
    ? "stopped"
    : !fresh
      ? "stale"
      : lease.stopRequestedAt
        ? "stopping"
        : "running";
  return {
    state,
    ownerToken: fresh ? lease?.ownerToken ?? null : null,
    pid: lease?.pid ?? serviceStatus?.pid ?? null,
    acquiredAt: lease?.acquiredAt ?? null,
    heartbeatAt: lease?.heartbeatAt ?? null,
    expiresAt: lease?.expiresAt ?? null,
    stopRequestedAt: lease?.stopRequestedAt ?? null,
    lastSuccessfulScanAt: lease?.lastSuccessfulScanAt ?? latestSourceSuccess,
    degradedSources: degradedSources.sort((left, right) =>
      left.personId.localeCompare(right.personId) || left.candidateId.localeCompare(right.candidateId)),
    queues: { contractions, proposals },
    service: serviceStatus
  };
}

export async function runMemoryStatusCommand(
  options: MemoryStatusCommandOptions
): Promise<MemoryStatusCommandResult> {
  const parsed = OptionsSchema.parse(options);
  const store = new SqliteStore(parsed.databasePath);
  try {
    const [sources, events, imports, grants, audits, quarantine, summaries, anchors, boxes, proposals, checkpoint, daemon] =
      await Promise.all([
        store.listSources(parsed.personId),
        store.listCanonicalEvents(parsed.personId),
        store.listImportCheckpoints(parsed.personId),
        store.listSourceGrants(parsed.personId),
        store.listSourceLifecycleAuditEvents(parsed.personId),
        store.listQuarantineRecords(parsed.personId),
        store.listSummaries(),
        store.listAnchors(),
        store.listBoxes(),
        store.listProposals({ state: "proposed" }),
        store.getBootstrapCheckpoint(historicalBootstrapCheckpointId(parsed.personId)),
        readDaemonStatusSnapshot(store, new Date().toISOString(), null, parsed.personId)
      ]);
    return {
      ok: true,
      personId: parsed.personId,
      sourceCount: sources.length,
      canonicalEventCount: events.length,
      importCheckpointCount: imports.length,
      approvedSourceGrantCount: grants.filter((grant) => grant.state === "approved").length,
      revokedSourceGrantCount: grants.filter((grant) => grant.state === "revoked").length,
      sourceLifecycleAuditEventCount: audits.length,
      pendingQuarantineRecordCount: quarantine.filter((record) => record.state === "pending").length,
      replayRequestedQuarantineRecordCount: quarantine.filter((record) => record.state === "replay_requested").length,
      historicalSummaryCount: summaries.filter(
        (summary) =>
          summary.personId === parsed.personId &&
          summary.origin === "historical_bootstrap" &&
          summary.state !== "superseded"
      ).length,
      anchorCount: anchors.filter((anchor) => anchor.personId === parsed.personId).length,
      proposedBoxCount: boxes.filter(
        (box) => box.personId === parsed.personId && box.state === "proposed"
      ).length,
      proposedMemoryChangeCount: proposals.filter(
        (proposal) => proposal.personId === parsed.personId
      ).length,
      bootstrapCheckpoint: checkpoint,
      daemon
    };
  } finally {
    store.close();
  }
}

function parseArgs(args: string[]): MemoryStatusCommandOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--") && arg.includes("=")) {
      const separator = arg.indexOf("=");
      values.set(arg.slice(0, separator), arg.slice(separator + 1));
    } else if (arg.startsWith("--") && args[index + 1]) {
      values.set(arg, args[index + 1]);
      index += 1;
    }
  }
  const databasePath = values.get("--db");
  const personId = values.get("--person");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  if (!personId) throw new Error("Missing person identity. Pass --person <person-id>.");
  return { databasePath: resolve(databasePath), personId };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runMemoryStatusCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
