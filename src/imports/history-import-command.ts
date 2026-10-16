import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteStore } from "../storage/sqlite-store.js";
import { approveClaudeHistory, discoverClaudeHistory } from "./claude-discovery.js";
import { ClaudeHistoryImporter } from "./claude-importer.js";
import { approveCordisHistory, discoverCordisHistory } from "./cordis-discovery.js";
import { CordisHistoryImporter } from "./cordis-importer.js";
import { approveHermesHistory, discoverHermesHistory } from "./hermes-discovery.js";
import { HermesHistoryImporter } from "./hermes-importer.js";
import { readFlags, type ImportSource } from "./history-discover-command.js";
import { approveOpenClawHistory, discoverOpenClawHistory } from "./openclaw-discovery.js";
import { OpenClawHistoryImporter } from "./openclaw-importer.js";
import type { HistoryImportResult } from "./types.js";
import { SourceLifecycleService } from "../service/source-lifecycle-service.js";
import type { ProfileAuthority } from "../mcp/authority.js";
import { InMemoryStore } from "../storage/in-memory-store.js";
import type { MemoryStore } from "../storage/memory-store.js";
import {
  CommitHistoryImportInputSchema,
  mutationEffectsFingerprint,
  type CommitHistoryImportInput
} from "../storage/mcp-mutation-contracts.js";
import { discoverCodexHistory, approveCodexHistory } from "./codex-discovery.js";
import { CodexHistoryImporter, seedStagingImportState } from "./codex-importer.js";

export interface HistoryImportCommandOptions {
  source: ImportSource;
  sourcePath: string;
  databasePath: string;
  approvedCandidateId: string;
  personId: string;
  profileId?: string;
  scopeId?: string;
  requestedAt?: string;
}

export interface HistoryImportCommandResult {
  ok: true;
  candidateId: string;
  import: HistoryImportResult;
  canonicalEventCount: number;
  checkpointCount: number;
}

export type ConfiguredHistorySource = "codex" | "claude-code" | "openclaw" | "hermes" | "cordis";

export interface ConfiguredHistoryImportRequest {
  sourceAlias: string;
  source: ConfiguredHistorySource;
  requestedAt: string;
}

/** Builds one deterministic per-resource import batch without mutating durable state. */
export async function planConfiguredHistoryImport(
  store: MemoryStore,
  authority: ProfileAuthority,
  request: ConfiguredHistoryImportRequest
): Promise<CommitHistoryImportInput> {
  const configuredPath = authority.sourceRoots[request.sourceAlias];
  if (!configuredPath) throw new Error("UNAUTHORIZED_OR_NOT_FOUND");
  const candidate = request.source === "codex"
    ? await discoverCodexHistory(configuredPath, request.requestedAt)
    : request.source === "claude-code"
      ? await discoverClaudeHistory(configuredPath, request.requestedAt)
      : request.source === "openclaw"
        ? await discoverOpenClawHistory(configuredPath, request.requestedAt)
        : await discoverHermesHistory(configuredPath, request.requestedAt);
  const locator = "rootPath" in candidate ? candidate.rootPath : candidate.databasePath;
  const grant = (await store.listSourceGrants(authority.personId)).find((item) =>
    item.candidateId === candidate.id && item.state === "approved" &&
    item.application === candidate.application && item.format === candidate.format &&
    item.sourceLocator === locator && item.profileId === authority.profileName &&
    item.scopeId === authority.ingestScopeId
  );
  if (!grant || !authority.allowedScopeIds.includes(grant.scopeId)) throw new Error("UNAUTHORIZED_OR_NOT_FOUND");

  const staging = new InMemoryStore();
  await seedStagingImportState(store, staging, grant);
  if (request.source === "codex") {
    await new CodexHistoryImporter(staging, { clock: () => request.requestedAt, quarantineLookupStore: store })
      .importApprovedSource(approveCodexHistory(candidate as Awaited<ReturnType<typeof discoverCodexHistory>>, authority.personId, authority.profileName, grant.approvedAt, authority.ingestScopeId));
  } else if (request.source === "claude-code") {
    await new ClaudeHistoryImporter(staging, { clock: () => request.requestedAt, quarantineLookupStore: store })
      .importApprovedSource(approveClaudeHistory(candidate as Awaited<ReturnType<typeof discoverClaudeHistory>>, authority.personId, authority.profileName, grant.approvedAt, authority.ingestScopeId));
  } else if (request.source === "openclaw") {
    await new OpenClawHistoryImporter(staging, { clock: () => request.requestedAt, quarantineLookupStore: store })
      .importApprovedSource(approveOpenClawHistory(candidate as Awaited<ReturnType<typeof discoverOpenClawHistory>>, authority.personId, authority.profileName, grant.approvedAt, authority.ingestScopeId));
  } else {
    await new HermesHistoryImporter(staging, { clock: () => request.requestedAt, quarantineLookupStore: store })
      .importApprovedSource(approveHermesHistory(candidate as Awaited<ReturnType<typeof discoverHermesHistory>>, authority.personId, authority.profileName, grant.approvedAt, authority.ingestScopeId));
  }

  const existingCheckpoints = (await store.listImportCheckpoints(authority.personId)).filter((item) => item.candidateId === candidate.id);
  const existingById = new Map(existingCheckpoints.map((item) => [item.id, item]));
  const stagedCheckpoints = (await staging.listImportCheckpoints(authority.personId))
    .filter((item) => item.candidateId === candidate.id)
    .sort((left, right) => left.resourcePath.localeCompare(right.resourcePath));
  const nextCheckpoint = stagedCheckpoints.find((item) => JSON.stringify(existingById.get(item.id) ?? null) !== JSON.stringify(item)) ?? stagedCheckpoints[0];
  if (!nextCheckpoint) throw new Error("Configured source produced no import checkpoint");

  // Same shape as `commitStagedGrantBatch`: only the staged ids are ever tested against this set,
  // so resolve exactly those rather than loading the person's entire canonical history.
  const stagedEvents = await staging.listCanonicalEvents(authority.personId);
  const existingEvents = new Set(
    (await store.listCanonicalEventsByIds(authority.personId, stagedEvents.map((item) => item.id)))
      .map((item) => item.id)
  );
  const resourceEvents = stagedEvents
    .filter((event) => sourceResource(event) === nextCheckpoint.resourcePath && !existingEvents.has(event.id))
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.nativeSequence - right.nativeSequence || left.id.localeCompare(right.id));
  const nextSources = (await staging.listSources(authority.personId))
    .filter((item) => item.instanceId === candidate.id)
    .sort((left, right) => left.id.localeCompare(right.id));
  const expectedSource = nextSources[0] ? await store.getSource(nextSources[0].id) : null;
  const effects = {
    sourceIds: nextSources.map((item) => item.id),
    eventIds: resourceEvents.map((item) => item.id),
    checkpointIds: [nextCheckpoint.id],
    auditEventIds: [] as string[]
  };
  return CommitHistoryImportInputSchema.parse({
    operation: "history_import",
    personId: authority.personId,
    candidateId: candidate.id,
    normalizedParameters: { sourceAlias: request.sourceAlias, source: request.source, ingestScopeId: authority.ingestScopeId },
    expectedSource,
    expectedSourceStateFingerprint: mutationEffectsFingerprint(expectedSource),
    expectedCheckpoint: existingById.get(nextCheckpoint.id) ?? null,
    expectedGrant: grant,
    targetCanonicalEventIds: effects.eventIds,
    nextSources,
    nextCanonicalEvents: resourceEvents,
    nextCheckpoint,
    auditEvents: [],
    effects,
    effectsFingerprint: mutationEffectsFingerprint(effects),
    receipt: {
      operation: "history_import", status: "COMMITTED", personId: authority.personId,
      targetId: candidate.id,
      effectCounts: { sources: effects.sourceIds.length, events: effects.eventIds.length, checkpoints: 1, audits: 0 },
      committedAt: request.requestedAt
    }
  });
}

const sourceResource = (event: { metadata: Record<string, unknown> }): string | null => {
  const sourceMetadata = event.metadata.sourceMetadata;
  if (sourceMetadata && typeof sourceMetadata === "object" && !Array.isArray(sourceMetadata) &&
      typeof (sourceMetadata as Record<string, unknown>).sourceResource === "string") {
    return (sourceMetadata as Record<string, unknown>).sourceResource as string;
  }
  return typeof event.metadata.sourceResource === "string" ? event.metadata.sourceResource : null;
};

export async function runHistoryImportCommand(
  options: HistoryImportCommandOptions
): Promise<HistoryImportCommandResult> {
  const requestedAt = options.requestedAt ?? new Date().toISOString();
  const profileId = options.profileId ?? "default";
  const scopeId = options.scopeId ?? "personal";
  const sourcePath = resolve(options.sourcePath);
  const candidate = options.source === "claude-code"
    ? await discoverClaudeHistory(sourcePath, requestedAt)
    : options.source === "openclaw"
      ? await discoverOpenClawHistory(sourcePath, requestedAt)
      : options.source === "hermes"
        ? await discoverHermesHistory(sourcePath, requestedAt)
        : await discoverCordisHistory(sourcePath, requestedAt);
  if (candidate.id !== options.approvedCandidateId) {
    throw new Error(`${options.source} history import requires approval for candidate ${candidate.id}`);
  }

  const store = new SqliteStore(options.databasePath);
  try {
    const lifecycle = new SourceLifecycleService(store);
    await lifecycle.approve({
      personId: options.personId,
      candidateId: candidate.id,
      application: candidate.application,
      format: candidate.format,
      sourceLocator: "rootPath" in candidate ? candidate.rootPath : candidate.databasePath,
      profileId,
      scopeId,
      approvedAt: requestedAt
    });
    await lifecycle.assertApproved(options.personId, candidate.id);
    let imported: HistoryImportResult;
    if (candidate.application === "claude-code") {
      imported = await new ClaudeHistoryImporter(store, { clock: () => requestedAt })
        .importApprovedSource(
          approveClaudeHistory(candidate, options.personId, profileId, requestedAt, scopeId)
        );
    } else if (candidate.application === "openclaw") {
      imported = await new OpenClawHistoryImporter(store, { clock: () => requestedAt })
        .importApprovedSource(
          approveOpenClawHistory(candidate, options.personId, profileId, requestedAt, scopeId)
        );
    } else if (candidate.application === "hermes") {
      imported = await new HermesHistoryImporter(store, { clock: () => requestedAt })
        .importApprovedSource(
          approveHermesHistory(candidate, options.personId, profileId, requestedAt, scopeId)
        );
    } else {
      imported = await new CordisHistoryImporter(store, { clock: () => requestedAt })
        .importApprovedSource(
          approveCordisHistory(candidate, options.personId, profileId, requestedAt, scopeId)
        );
    }
    const [events, checkpoints] = await Promise.all([
      store.listCanonicalEvents(options.personId),
      store.listImportCheckpoints(options.personId)
    ]);
    return {
      ok: true,
      candidateId: candidate.id,
      import: imported,
      canonicalEventCount: events.length,
      checkpointCount: checkpoints.length
    };
  } finally {
    store.close();
  }
}

function parseArgs(args: string[]): HistoryImportCommandOptions {
  const values = readFlags(args);
  const source = values.get("--source");
  if (source !== "claude-code" && source !== "openclaw" && source !== "hermes" && source !== "cordis") {
    throw new Error("Missing or unsupported --source. Use claude-code, openclaw, hermes, or cordis.");
  }
  const sourcePath = values.get("--root");
  const databasePath = values.get("--db");
  const approvedCandidateId = values.get("--approve");
  const personId = values.get("--person");
  if (!sourcePath) throw new Error("Missing history source path. Pass --root <path>.");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  if (!approvedCandidateId) throw new Error("Missing explicit source approval. Pass --approve <candidate-id>.");
  if (!personId) throw new Error("Missing person identity. Pass --person <person-id>.");
  return {
    source,
    sourcePath,
    databasePath: resolve(databasePath),
    approvedCandidateId,
    personId,
    profileId: values.get("--profile") ?? "default",
    scopeId: values.get("--scope") ?? "personal"
  };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runHistoryImportCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
