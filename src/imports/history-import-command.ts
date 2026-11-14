import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
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
import { approveGrokCliHistory, discoverGrokCliHistory } from "./grok-cli-discovery.js";
import { GrokCliHistoryImporter } from "./grok-cli-importer.js";
import type {
  ClaudeHistoryCandidate,
  CodexHistoryCandidate,
  ConfiguredHistorySource,
  CordisHistoryCandidate,
  GrokHistoryCandidate,
  HermesHistoryCandidate,
  HistoryImportResult,
  OpenClawHistoryCandidate
} from "./types.js";
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
import type { CanonicalEvent } from "../domain/canonical.js";

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

export interface ConfiguredHistoryImportRequest {
  sourceAlias: string;
  source: ConfiguredHistorySource;
  requestedAt: string;
}

type ConfiguredHistoryCandidate = CodexHistoryCandidate | ClaudeHistoryCandidate |
  OpenClawHistoryCandidate | HermesHistoryCandidate | CordisHistoryCandidate | GrokHistoryCandidate;

interface ConfiguredHistoryHandler {
  discover(path: string, requestedAt: string): Promise<ConfiguredHistoryCandidate | undefined>;
  importApproved(
    store: MemoryStore,
    lookupStore: MemoryStore,
    candidate: ConfiguredHistoryCandidate,
    authority: ProfileAuthority,
    approvedAt: string,
    requestedAt: string
  ): Promise<void>;
}

function handler<Application extends ConfiguredHistoryCandidate["application"]>(
  application: Application,
  discover: (path: string, requestedAt: string) => Promise<Extract<ConfiguredHistoryCandidate, { application: Application }> | undefined>,
  importApproved: (
    store: MemoryStore,
    candidate: Extract<ConfiguredHistoryCandidate, { application: Application }>,
    authority: ProfileAuthority,
    approvedAt: string,
    requestedAt: string,
    lookupStore: MemoryStore
  ) => Promise<unknown>
): ConfiguredHistoryHandler {
  return {
    discover,
    async importApproved(store, lookupStore, candidate, authority, approvedAt, requestedAt) {
      if (candidate.application !== application) throw new Error("Configured history source did not match its handler");
      await importApproved(store,
        candidate as Extract<ConfiguredHistoryCandidate, { application: Application }>,
        authority, approvedAt, requestedAt, lookupStore);
    }
  };
}

export const CONFIGURED_HISTORY_HANDLERS = {
  codex: handler("codex", discoverCodexHistory, (store, candidate, authority, approvedAt, requestedAt, lookupStore) =>
    new CodexHistoryImporter(store, { clock: () => requestedAt, quarantineLookupStore: lookupStore })
      .importApprovedSource(approveCodexHistory(candidate, authority.personId, authority.profileName, approvedAt, authority.ingestScopeId))),
  "claude-code": handler("claude-code", discoverClaudeHistory, (store, candidate, authority, approvedAt, requestedAt, lookupStore) =>
    new ClaudeHistoryImporter(store, { clock: () => requestedAt, quarantineLookupStore: lookupStore })
      .importApprovedSource(approveClaudeHistory(candidate, authority.personId, authority.profileName, approvedAt, authority.ingestScopeId))),
  openclaw: handler("openclaw", discoverOpenClawHistory, (store, candidate, authority, approvedAt, requestedAt, lookupStore) =>
    new OpenClawHistoryImporter(store, { clock: () => requestedAt, quarantineLookupStore: lookupStore })
      .importApprovedSource(approveOpenClawHistory(candidate, authority.personId, authority.profileName, approvedAt, authority.ingestScopeId))),
  hermes: handler("hermes", discoverHermesHistory, (store, candidate, authority, approvedAt, requestedAt, lookupStore) =>
    new HermesHistoryImporter(store, { clock: () => requestedAt, quarantineLookupStore: lookupStore })
      .importApprovedSource(approveHermesHistory(candidate, authority.personId, authority.profileName, approvedAt, authority.ingestScopeId))),
  cordis: handler("cordis", discoverCordisHistory, (store, candidate, authority, approvedAt, requestedAt, lookupStore) =>
    new CordisHistoryImporter(store, { clock: () => requestedAt, quarantineLookupStore: lookupStore })
      .importApprovedSource(approveCordisHistory(candidate, authority.personId, authority.profileName, approvedAt, authority.ingestScopeId))),
  "grok-cli": handler("grok-cli", async (path, requestedAt) =>
    (await discoverGrokCliHistory(resolve(path, ".."), requestedAt)).find((item) => item.rootPath === resolve(path)),
  async (store, candidate, authority, approvedAt, requestedAt, lookupStore) => {
    if (candidate.scopeId !== authority.ingestScopeId) throw new Error("UNAUTHORIZED_OR_NOT_FOUND");
    await new GrokCliHistoryImporter(store, { clock: () => requestedAt, quarantineLookupStore: lookupStore })
      .importApprovedSource(approveGrokCliHistory(candidate, authority.personId, authority.profileName, approvedAt));
  })
} satisfies Record<ConfiguredHistorySource, ConfiguredHistoryHandler>;

/** Builds one deterministic per-resource import batch without mutating durable state. */
export async function planConfiguredHistoryImport(
  store: MemoryStore,
  authority: ProfileAuthority,
  request: ConfiguredHistoryImportRequest
): Promise<CommitHistoryImportInput> {
  const configuredPath = authority.sourceRoots[request.sourceAlias];
  if (!configuredPath) throw new Error("UNAUTHORIZED_OR_NOT_FOUND");
  const handler = CONFIGURED_HISTORY_HANDLERS[request.source];
  const candidate = await handler.discover(configuredPath, request.requestedAt);
  if (!candidate) throw new Error("UNAUTHORIZED_OR_NOT_FOUND");
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
  await handler.importApproved(staging, store, candidate, authority, grant.approvedAt, request.requestedAt);

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
  const existingEvents = new Map(
    (await store.listCanonicalEventsByIds(authority.personId, stagedEvents.map((item) => item.id)))
      .map((item) => [item.id, item])
  );
  const resourceEvents = stagedEvents
    .filter((event) => sourceResource(event) === nextCheckpoint.resourcePath && materiallyChanged(existingEvents.get(event.id), event))
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.nativeSequence - right.nativeSequence || left.id.localeCompare(right.id));
  const expectedCanonicalEvents = resourceEvents.flatMap((event) => {
    const existing = existingEvents.get(event.id);
    return existing ? [existing] : [];
  });
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
    expectedCanonicalEvents,
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

const materiallyChanged = (previous: CanonicalEvent | undefined, next: CanonicalEvent): boolean => {
  if (previous === undefined) return true;
  const { importedAt: _previousImportedAt, ...previousDeterministicFields } = previous;
  const { importedAt: _nextImportedAt, ...nextDeterministicFields } = next;
  return !isDeepStrictEqual(previousDeterministicFields, nextDeterministicFields);
};

export async function runHistoryImportCommand(
  options: HistoryImportCommandOptions
): Promise<HistoryImportCommandResult> {
  const requestedAt = options.requestedAt ?? new Date().toISOString();
  const profileId = options.profileId ?? "default";
  const sourcePath = resolve(options.sourcePath);
  const candidate = options.source === "grok-cli"
    ? (await discoverGrokCliHistory(resolve(sourcePath, ".."), requestedAt)).find((item) => item.rootPath === sourcePath)
    : options.source === "claude-code"
    ? await discoverClaudeHistory(sourcePath, requestedAt)
    : options.source === "openclaw"
      ? await discoverOpenClawHistory(sourcePath, requestedAt)
      : options.source === "hermes"
        ? await discoverHermesHistory(sourcePath, requestedAt)
        : await discoverCordisHistory(sourcePath, requestedAt);
  if (!candidate) throw new Error("Grok history import requires a direct workspace candidate path");
  if (candidate.id !== options.approvedCandidateId) {
    throw new Error(`${options.source} history import requires approval for candidate ${candidate.id}`);
  }

  const store = new SqliteStore(options.databasePath);
  try {
    const scopeId = candidate.application === "grok-cli"
      ? requireGrokScope(candidate.scopeId, options.scopeId)
      : options.scopeId ?? "personal";
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
    } else if (candidate.application === "cordis") {
      imported = await new CordisHistoryImporter(store, { clock: () => requestedAt })
        .importApprovedSource(
          approveCordisHistory(candidate, options.personId, profileId, requestedAt, scopeId)
        );
    } else {
      imported = await new GrokCliHistoryImporter(store, { clock: () => requestedAt })
        .importApprovedSource(approveGrokCliHistory(candidate, options.personId, profileId, requestedAt));
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
  if (source !== "claude-code" && source !== "openclaw" && source !== "hermes" && source !== "cordis" && source !== "grok-cli") {
    throw new Error("Missing or unsupported --source. Use claude-code, openclaw, hermes, cordis, or grok-cli.");
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
    scopeId: values.get("--scope")
  };
}

function requireGrokScope(candidateScope: string, requestedScope: string | undefined): string {
  if (requestedScope !== undefined && requestedScope !== candidateScope) throw new Error("Grok workspace scope cannot be overridden");
  return candidateScope;
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
