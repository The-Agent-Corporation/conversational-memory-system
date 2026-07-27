/**
 * Phase 11 Plan 13 — deterministic recall probe harness, THROWAWAY / phase-local, lives beside
 * the plan (precedent: 11-hygiene-sim.ts). NOT production code.
 *
 * Drives the REAL retrieval path (`MemoryRetriever.prepareInjection`) against a fixed, frozen
 * query set (`11-RECALL-QUERIES.md`) so a before/after recall comparison is reproducible by
 * re-running one command instead of reconstructed from memory (11-13-PLAN.md).
 *
 * Import-prefix hazard (11-07-SUMMARY, 11-hygiene-sim.ts): ESM resolves relative imports against
 * THIS FILE's directory (`.planning/phases/11-derivation-input-hygiene/`), not the repo root, and
 * `tsc --noEmit` resolves these differently and will NOT catch a wrong prefix. Verified by
 * running (`npx tsx`), never by typechecking alone. Imports below are `../../../src/...`.
 *
 * Usage:
 *   npx tsx .planning/phases/11-derivation-input-hygiene/11-recall-probe.ts \
 *     --db <path-to-sqlite-db> --person <personId> --label <label> --out <output-basename>
 *
 * Never writes to the database beyond what `prepareInjection` itself does (summary access
 * bookkeeping, injection packet persistence, deferred-revival promotion) — those are the real
 * production side effects of the path being probed, not something this script adds.
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteStore } from "../../../src/storage/sqlite-store.js";
import { MemoryRetriever } from "../../../src/retrieval/memory-retriever.js";
import { resolveEmbedder } from "../../../src/embeddings/embedder-resolver.js";
import type { InjectionRequest } from "../../../src/service/memory-service.js";
import type { MemoryState } from "../../../src/domain/types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string, o?: unknown) => any };

// Frozen alongside 11-RECALL-QUERIES.md — do not edit independently of that file.
const HOST_SESSION_ID = "recall-probe-2026-07-27";
const REQUESTED_AT = "2026-07-27T00:00:00.000Z";
const MAX_MEMORY_TOKENS = 800;
const HOST = "recall-probe";
const PROFILE_ID = "aaron";

interface FrozenQuery {
  id: string;
  currentTopicSummary: string;
}

// Mirrors 11-RECALL-QUERIES.md exactly. Any drift between this array and that file invalidates
// the frozen-before-measurement property — keep them in lockstep by construction, not by hand
// re-typing at each probe run.
const FROZEN_QUERIES: FrozenQuery[] = [
  { id: "Q1", currentTopicSummary: "zero-knowledge sync relay design decision" },
  { id: "Q2", currentTopicSummary: "ONNX embedder model choice for semantic recall" },
  { id: "Q3", currentTopicSummary: "macOS Keychain storage for sync device secrets" },
  { id: "Q4", currentTopicSummary: "daemon lease acquisition and single-writer design" },
  { id: "Q5", currentTopicSummary: "contraction checkpoint and summarization pipeline" },
  { id: "Q6", currentTopicSummary: "Hermes agent bridge integration and control commands" },
  { id: "Q7", currentTopicSummary: "importer discovery for Claude Code and Codex host history" },
  { id: "Q8", currentTopicSummary: "pruning superseded derivations and the backup gate decision" },
  { id: "Q9", currentTopicSummary: "ADR decision records for the conversational memory system" },
  { id: "Q10", currentTopicSummary: "person and scope isolation boundary for memory retrieval" },
  {
    id: "Q11",
    currentTopicSummary: "deterministic hash embedder as the default with no external model"
  },
  {
    id: "Q12",
    currentTopicSummary: "quantum-encrypted recipe database for an interstellar spacecraft galley"
  }
];

interface QueryResult {
  id: string;
  currentTopicSummary: string;
  elapsedMs: number;
  packetIsNull: boolean;
  sourceSummaryIds: string[];
  confidence: number | null;
  selectedMemory: string | null;
  containsToolCallText: boolean;
  containsHarnessText: boolean;
}

interface ProbeArtifact {
  label: string;
  databasePath: string;
  personId: string;
  embedderProvider: string;
  embedderModel: string;
  summaryCountsByState: Record<string, number>;
  totalElapsedMs: number;
  results: QueryResult[];
}

function parseArgs(argv: string[]): { db: string; person: string; label: string; out: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      process.stdout.write(
        "Usage: 11-recall-probe.ts --db <path> --person <personId> --label <label> --out <basename>\n"
      );
      process.exit(0);
    }
    if (arg.startsWith("--") && argv[i + 1]) {
      values.set(arg.slice(2), argv[i + 1]);
      i += 1;
    }
  }
  const db = values.get("db");
  const person = values.get("person");
  const label = values.get("label");
  const out = values.get("out");
  if (!db || !person || !label || !out) {
    throw new Error("Missing required flag. Usage: --db <path> --person <personId> --label <label> --out <basename>");
  }
  return { db: resolve(db), person, label, out };
}

/** Read-only, opened outside SqliteStore so no migration or write touches the target file. */
function summaryCountsByState(databasePath: string): Record<string, number> {
  const raw = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = raw
      .prepare(`select json_extract(payload,'$.state') state, count(*) c from summaries group by state`)
      .all() as Array<{ state: string; c: number }>;
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.state ?? "unknown"] = row.c;
    return counts;
  } finally {
    raw.close();
  }
}

async function main(): Promise<void> {
  const { db: databasePath, person: personId, label, out } = parseArgs(process.argv.slice(2));

  const countsBefore = summaryCountsByState(databasePath);
  const embedder = await resolveEmbedder(databasePath);

  const store = new SqliteStore(databasePath);
  const retriever = new MemoryRetriever(store, { embedder });

  const results: QueryResult[] = [];
  let totalElapsedMs = 0;

  try {
    for (const query of FROZEN_QUERIES) {
      const request: InjectionRequest = {
        host: HOST,
        profileId: PROFILE_ID,
        hostSessionId: HOST_SESSION_ID,
        currentTopicSummary: query.currentTopicSummary,
        requestedAt: REQUESTED_AT,
        maxMemoryTokens: MAX_MEMORY_TOKENS,
        personId,
        allowedScopeIds: ["personal"]
      };

      const start = performance.now();
      // No abort timeout by design (T-11-53) — a slow run must be visible, not silently truncated.
      const packet = await retriever.prepareInjection(request);
      const elapsedMs = performance.now() - start;
      totalElapsedMs += elapsedMs;

      process.stderr.write(
        `[${label}] ${query.id} — ${elapsedMs.toFixed(1)}ms — packet: ${packet ? "yes" : "null"}\n`
      );

      const selectedMemory = packet?.selectedMemory ?? null;
      results.push({
        id: query.id,
        currentTopicSummary: query.currentTopicSummary,
        elapsedMs,
        packetIsNull: packet === null,
        sourceSummaryIds: packet?.sourceSummaryIds ?? [],
        confidence: packet?.confidence ?? null,
        selectedMemory,
        containsToolCallText: selectedMemory !== null && selectedMemory.includes("[Tool call:"),
        containsHarnessText:
          selectedMemory !== null &&
          (selectedMemory.includes("[SYSTEM:") ||
            selectedMemory.includes("[cron:") ||
            selectedMemory.includes("[SILENT]"))
      });
    }
  } finally {
    store.close();
  }

  const artifact: ProbeArtifact = {
    label,
    databasePath,
    personId,
    embedderProvider: embedder.provider,
    embedderModel: embedder.model,
    summaryCountsByState: countsBefore,
    totalElapsedMs,
    results
  };

  writeFileSync(`${out}.json`, JSON.stringify(artifact, null, 2));

  const mdRows = results
    .map((r) => {
      const preview = (r.selectedMemory ?? "").replace(/\n/g, " ").slice(0, 160);
      return `| ${r.id} | ${r.packetIsNull ? "null" : "packet"} | ${r.confidence?.toFixed(2) ?? "-"} | ${r.elapsedMs.toFixed(1)} | ${r.containsToolCallText} | ${r.containsHarnessText} | ${r.sourceSummaryIds.length} | ${preview} |`;
    })
    .join("\n");
  const md = [
    `# Probe run: ${label}`,
    "",
    `- database: \`${databasePath}\``,
    `- personId: \`${personId}\``,
    `- embedder: ${embedder.provider} / ${embedder.model}`,
    `- summary counts by state: ${JSON.stringify(countsBefore)}`,
    `- total elapsed: ${totalElapsedMs.toFixed(1)}ms`,
    "",
    "| Query | Packet | Confidence | Elapsed ms | containsToolCallText | containsHarnessText | sourceSummaryIds | selectedMemory preview |",
    "|---|---|---|---|---|---|---|---|",
    mdRows,
    ""
  ].join("\n");
  writeFileSync(`${out}.md`, md);

  process.stderr.write(`\n[${label}] total elapsed: ${totalElapsedMs.toFixed(1)}ms across ${results.length} queries\n`);
  process.stderr.write(`[${label}] wrote ${out}.json and ${out}.md\n`);
}

await main();
