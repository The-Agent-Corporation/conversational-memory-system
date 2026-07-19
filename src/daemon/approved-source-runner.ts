import { WriteAuthoritySchema, type ImportBatchReceipt, type DaemonErrorCategory, type WriteAuthority } from "./types.js";
import type { ApprovedGrantBatchOptions } from "../imports/codex-importer.js";
import type { SourceGrant } from "../domain/source-lifecycle.js";
import { SourceLifecycleService } from "../service/source-lifecycle-service.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { CodexHistoryImporter } from "../imports/codex-importer.js";
import { ClaudeHistoryImporter } from "../imports/claude-importer.js";
import { OpenClawHistoryImporter } from "../imports/openclaw-importer.js";
import { HermesHistoryImporter } from "../imports/hermes-importer.js";

interface BatchImporter {
  importApprovedGrantBatch(grant: SourceGrant, options: ApprovedGrantBatchOptions): Promise<ImportBatchReceipt>;
}

export interface ApprovedSourceRunnerImporters {
  codex: BatchImporter;
  claudeCode: BatchImporter;
  openClaw: BatchImporter;
  hermes: BatchImporter;
}

export interface ApprovedSourceRunnerOptions {
  lifecycle?: SourceLifecycleService;
  importers?: ApprovedSourceRunnerImporters;
  clock?: () => string;
  authority?: WriteAuthority;
  beforeCommit?: () => void | Promise<void>;
}

export type ApprovedSourceOutcome =
  | { ok: true; personId: string; candidateId: string; receipt: ImportBatchReceipt }
  | { ok: false; personId: string; candidateId: string; category: DaemonErrorCategory };

export class ApprovedSourceRunner {
  private readonly lifecycle: SourceLifecycleService;
  private readonly importers: ApprovedSourceRunnerImporters;
  private readonly authority: WriteAuthority | undefined;
  private readonly beforeCommit: (() => void | Promise<void>) | undefined;

  constructor(
    private readonly store: MemoryStore,
    options: ApprovedSourceRunnerOptions = {}
  ) {
    this.lifecycle = options.lifecycle ?? new SourceLifecycleService(store);
    this.authority = options.authority;
    this.beforeCommit = options.beforeCommit;
    const importerOptions = options.clock ? { clock: options.clock } : {};
    this.importers = options.importers ?? {
      codex: new CodexHistoryImporter(store, importerOptions),
      claudeCode: new ClaudeHistoryImporter(store, importerOptions),
      openClaw: new OpenClawHistoryImporter(store, importerOptions),
      hermes: new HermesHistoryImporter(store, importerOptions)
    };
  }

  async runGrant(personId: string, candidateId: string): Promise<ApprovedSourceOutcome> {
    try {
      const grant = await this.lifecycle.assertApproved(personId, candidateId);
      const authority = WriteAuthoritySchema.parse(this.authority);
      if (authority.kind === "foreground" &&
          (authority.personId !== personId || authority.operation !== "approved-import")) {
        throw new Error("Foreground source runner requires exact approved-import authority");
      }
      const importer = this.resolveExactImporter(grant);
      if (!importer) {
        return { ok: false, personId, candidateId, category: "unsupported_format" };
      }
      const receipt = await importer.importApprovedGrantBatch(grant, {
        authority,
        beforeCommit: this.beforeCommit
      });
      return { ok: true, personId, candidateId, receipt };
    } catch (error) {
      return { ok: false, personId, candidateId, category: categorize(error) };
    }
  }

  async runAllApproved(personId?: string): Promise<ApprovedSourceOutcome[]> {
    if (!personId) return [];
    const grants = (await this.store.listSourceGrants(personId))
      .filter((grant) => grant.state === "approved")
      .sort((left, right) => left.id.localeCompare(right.id));
    const outcomes: ApprovedSourceOutcome[] = [];
    for (const grant of grants) outcomes.push(await this.runGrant(grant.personId, grant.candidateId));
    return outcomes;
  }

  private resolveExactImporter(grant: SourceGrant): BatchImporter | null {
    const pair = `${grant.application}/${grant.format}`;
    if (pair === "codex/codex-rollout-jsonl") return this.importers.codex;
    if (pair === "claude-code/claude-project-jsonl") return this.importers.claudeCode;
    if (pair === "openclaw/openclaw-session-jsonl") return this.importers.openClaw;
    if (pair === "hermes/hermes-state-sqlite") return this.importers.hermes;
    return null;
  }
}

function categorize(error: unknown): DaemonErrorCategory {
  if (error instanceof Error && "code" in error) {
    if (error.code === "ENOENT") return "temporarily_absent";
    if (error.code === "EACCES" || error.code === "EPERM") return "permission_denied";
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("enoent") || message.includes("no such file") ||
      message.includes("no import checkpoint")) return "temporarily_absent";
  if (message.includes("not durably approved") || message.includes("not approved") ||
      message.includes("revoked") || message.includes("grant changed")) return "grant_revoked";
  if (message.includes("malformed") || message.includes("required") || message.includes("sqlite")) {
    return "malformed_source";
  }
  return "unknown";
}
