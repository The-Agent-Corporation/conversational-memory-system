import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  readFlags,
  runHistoryDiscoverCommand,
  type ImportSource,
  type UniversalHistoryCandidate
} from "../imports/history-discover-command.js";
import { runDaemonCommand } from "../daemon/daemon-command.js";
import { SourceLifecycleService } from "../service/source-lifecycle-service.js";
import { SqliteStore } from "../storage/sqlite-store.js";
import { runBootstrapCommand, type BootstrapCommandResult } from "./bootstrap-command.js";

const DEFAULT_SOURCES: readonly ImportSource[] = ["claude-code", "openclaw", "hermes"];

export interface InitSourceSpec {
  source: ImportSource;
  sourcePath?: string;
}

export interface InitCommandOptions {
  databasePath: string;
  personId: string;
  profileId?: string;
  scopeId?: string;
  sources?: InitSourceSpec[];
  requestedAt?: string;
  /**
   * Explicit per-source consent hook. Called once per DISCOVERED candidate, after discovery
   * completes and before any grant is created. Defaults to an interactive stdin prompt.
   * Tests inject a deterministic decision function instead of real stdin (REQ-040: no
   * external model or hidden network dependency involved in this decision).
   */
  consent?: (candidate: UniversalHistoryCandidate) => boolean | Promise<boolean>;
  /**
   * Offers to start the daemon after bootstrap completes. Defaults to an interactive stdin
   * prompt. Returning false never launches the daemon.
   */
  offerDaemon?: (context: { approvedCandidateIds: string[] }) => boolean | Promise<boolean>;
}

export interface InitDiscoveredSourceOutcome {
  candidateId: string;
  application: UniversalHistoryCandidate["application"];
  sourceLocator: string;
  sessionCount: number;
  approved: boolean;
}

export interface InitCommandResult {
  ok: true;
  discovered: InitDiscoveredSourceOutcome[];
  approvedCandidateIds: string[];
  declinedCandidateIds: string[];
  bootstrap: BootstrapCommandResult["bootstrap"] | null;
  daemonOffered: boolean;
  daemonStarted: boolean;
}

export async function runInitCommand(options: InitCommandOptions): Promise<InitCommandResult> {
  const requestedAt = options.requestedAt ?? new Date().toISOString();
  const profileId = options.profileId ?? "default";
  const scopeId = options.scopeId ?? "personal";
  const sourceSpecs: InitSourceSpec[] = options.sources ?? DEFAULT_SOURCES.map((source) => ({ source }));
  const consent = options.consent ?? defaultConsent;
  const offerDaemon = options.offerDaemon ?? defaultOfferDaemon;

  // Step 1 (discover): enumerate ALL requested sources before any consent decision is made or
  // any grant is created. A source that fails to resolve (e.g. the application was never
  // installed on this machine) is simply absent from discovery, not a fatal error.
  const discoveries: UniversalHistoryCandidate[] = [];
  for (const spec of sourceSpecs) {
    try {
      const discovered = await runHistoryDiscoverCommand({
        source: spec.source,
        sourcePath: spec.sourcePath,
        discoveredAt: requestedAt
      });
      discoveries.push(discovered.candidate);
    } catch {
      // Not present / unreadable on this machine -- skip silently, matches existing importer
      // per-source discovery semantics (T-07-06: no content is read at this stage regardless).
    }
  }

  const store = new SqliteStore(options.databasePath);
  try {
    const lifecycle = new SourceLifecycleService(store);
    const discoveredOutcomes: InitDiscoveredSourceOutcome[] = [];
    const approvedCandidateIds: string[] = [];
    const declinedCandidateIds: string[] = [];

    // Step 2 (per-source consent -> grant): only a candidate the user explicitly approves is
    // ever passed to SourceLifecycleService.approve. A declined candidate is recorded and
    // skipped -- it never reaches the durable grant path or any import (T-07-04).
    for (const candidate of discoveries) {
      const sourceLocator = "rootPath" in candidate ? candidate.rootPath : candidate.databasePath;
      const approved = await consent(candidate);
      if (approved) {
        await lifecycle.approve({
          personId: options.personId,
          candidateId: candidate.id,
          application: candidate.application,
          format: candidate.format,
          sourceLocator,
          profileId,
          scopeId,
          approvedAt: requestedAt
        });
        approvedCandidateIds.push(candidate.id);
      } else {
        declinedCandidateIds.push(candidate.id);
      }
      discoveredOutcomes.push({
        candidateId: candidate.id,
        application: candidate.application,
        sourceLocator,
        sessionCount: candidate.sessionCount,
        approved
      });
    }

    // Step 3 (bootstrap): process whatever canonical history already exists for this person
    // into initial summaries/proposals. Skipped entirely when nothing was approved.
    const bootstrap = approvedCandidateIds.length > 0
      ? (await runBootstrapCommand({ databasePath: options.databasePath, personId: options.personId })).bootstrap
      : null;

    // Step 4 (offer daemon): always ask -- approved sources are picked up going forward by the
    // daemon's periodic import cycle, not by this one-shot init run.
    const daemonOffered = true;
    const accepted = await offerDaemon({ approvedCandidateIds });
    const daemonStarted = accepted
      ? (await runDaemonCommand({ subcommand: "start", databasePath: options.databasePath })).ok
      : false;

    return {
      ok: true,
      discovered: discoveredOutcomes,
      approvedCandidateIds,
      declinedCandidateIds,
      bootstrap,
      daemonOffered,
      daemonStarted
    };
  } finally {
    store.close();
  }
}

async function defaultConsent(candidate: UniversalHistoryCandidate): Promise<boolean> {
  const locator = "rootPath" in candidate ? candidate.rootPath : candidate.databasePath;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Discovered ${candidate.application} history at ${locator} (${candidate.sessionCount} sessions). Import this source? [y/N] `
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function defaultOfferDaemon(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Start the memory daemon now? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function parseArgs(argv: string[]): InitCommandOptions {
  const values = readFlags(argv);
  const databasePath = values.get("--db");
  const personId = values.get("--person");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  if (!personId) throw new Error("Missing person identity. Pass --person <person-id>.");
  return {
    databasePath: resolve(databasePath),
    personId,
    profileId: values.get("--profile") ?? "default",
    scopeId: values.get("--scope") ?? "personal"
  };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runInitCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
