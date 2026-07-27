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
 *
 * Plan 11-19 correction (11-MEASUREMENT-CORRECTION.md): the pre-11-19 version of this file
 * classified with a hand-rolled 3-pattern subset (`[SYSTEM:`, `[cron:`, `[SILENT]`) of the 13
 * shipped `SYNTHETIC_RULES`, and reported one packet-wide boolean with no attribution to which
 * selected memory (or rank) carried the offending text. This version classifies via the shipped
 * `classifyEvent` / `SYNTHETIC_MARKERS` and reconstructs the real `selected[]` (the same pure
 * functions `prepareInjection` composes) to attribute every item to a rank, kind, id, and rule —
 * proven faithful by an equality assertion against `packet.selectedMemory` that throws rather
 * than silently reporting a divergent number (T-11-59).
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteStore } from "../../../src/storage/sqlite-store.js";
import {
  MemoryRetriever,
  addParentBoxContext,
  applyRetrievalBoundary,
  rankMemories,
  selectMemories,
  type RankedMemory
} from "../../../src/retrieval/memory-retriever.js";
import { RETRIEVAL_CANDIDATE_STATES } from "../../../src/retrieval/retrievable-state.js";
import { classifyEvent, HYGIENE_RULE_VERSION, SYNTHETIC_MARKERS, TOOL_CALL_PREFIX } from "../../../src/topic/derivation-hygiene.js";
import { resolveEmbedder } from "../../../src/embeddings/embedder-resolver.js";
import type { Embedder } from "../../../src/embeddings/embedder.js";
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

/** Per-selected-item attribution (Plan 11-19) — every item that reached the packet, individually. */
interface ItemResult {
  rank: number;
  kind: RankedMemory["kind"];
  id: string;
  summaryIds: string[];
  traceId: string | null;
  boxIds: string[];
  tokenCount: number;
  score: number;
  /** First 200 chars of the item's raw text — enough to eyeball without dumping the full item. */
  preview: string;
  /** `text.includes(TOOL_CALL_PREFIX)` — the same literal the product uses, imported not re-typed. */
  containsToolCallText: boolean;
  /** classifyEvent({ content: text }) — anchored: catches an item that IS raw synthetic content. */
  classification: { derivationClass: string; ruleId: string | null };
  /** Every SYNTHETIC_MARKERS entry whose marker appears ANYWHERE in the item text — catches
   *  scaffolding embedded mid-summary, which the anchored `classification` above cannot. */
  markersFound: string[];
}

interface QueryResult {
  id: string;
  currentTopicSummary: string;
  elapsedMs: number;
  packetIsNull: boolean;
  sourceSummaryIds: string[];
  confidence: number | null;
  selectedMemory: string | null;
  containsToolCallText: boolean;
  // Recomputed against all 13 SYNTHETIC_RULES (was 3 hand-rolled patterns pre-11-19) — same field
  // name, wider definition. See 11-MEASUREMENT-CORRECTION.md: prior runs' values for this field
  // are non-comparable to values produced by this version.
  containsHarnessText: boolean;
  // --- Plan 11-19: per-item attribution + previously-discarded packet fields ---
  items: ItemResult[];
  unhygienicItemCount: number;
  unhygienicRanks: number[];
  toolCallItemCount: number;
  markerItemCount: number;
  topItemKind: string | null;
  topItemId: string | null;
  relevanceReason: string | null;
  sourceTraceIds: string[];
  boxIds: string[];
}

interface ProbeArtifact {
  /** Bumped from the implicit v1 (no field) so a JSON reader can tell old artifacts from new
   *  without inspecting individual fields. See 11-MEASUREMENT-CORRECTION.md. */
  probeVersion: number;
  hygieneRuleVersion: string;
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

/**
 * Reconstructs `prepareInjection`'s `selected[]` by composing the same exported pure functions in
 * the same order (`memory-retriever.ts:29-93`): boundary -> rank -> primary-select -> parent-box.
 * Must be called BEFORE `prepareInjection` for the same request — `prepareInjection` writes
 * (saveInjection, summary access bookkeeping, deferred-revival promotion) and reconstructing
 * afterwards would rank against mutated state (T-11-59).
 */
async function reconstructSelected(
  store: SqliteStore,
  request: InjectionRequest,
  embedder: Embedder
): Promise<RankedMemory[]> {
  const summaryFilter =
    request.personId !== undefined
      ? { personId: request.personId, scopeIds: request.allowedScopeIds, states: RETRIEVAL_CANDIDATE_STATES }
      : { states: RETRIEVAL_CANDIDATE_STATES as readonly MemoryState[] };
  const [allSummaries, allAnchors, allTraces, allBoxes] = await Promise.all([
    store.listSummaries(summaryFilter),
    store.listAnchors(),
    store.listTraces({ state: "approved" }),
    store.listBoxes()
  ]);
  const { summaries, anchors, traces, boxes } = applyRetrievalBoundary(
    request,
    allSummaries,
    allAnchors,
    allTraces,
    allBoxes,
    false
  );

  const topicEmbedding = await embedder.embed(request.currentTopicSummary);
  const rankingOptions = { embedder, topicEmbedding };
  const ranked = rankMemories(request.currentTopicSummary, summaries, anchors, traces, rankingOptions);
  if (ranked.length === 0) {
    return [];
  }

  const primarySelected = selectMemories(ranked, request.maxMemoryTokens);
  return addParentBoxContext(primarySelected, boxes, request.maxMemoryTokens);
}

function attributeItems(reconstructed: RankedMemory[]): ItemResult[] {
  return reconstructed.map((memory, rank) => {
    const classification = classifyEvent({ content: memory.text });
    const markersFound = SYNTHETIC_MARKERS.filter((marker) => memory.text.includes(marker.marker)).map(
      (marker) => marker.ruleId
    );
    return {
      rank,
      kind: memory.kind,
      id: memory.id,
      summaryIds: memory.summaryIds,
      traceId: memory.traceId,
      boxIds: memory.boxIds,
      tokenCount: memory.tokenCount,
      score: memory.score,
      preview: memory.text.slice(0, 200),
      containsToolCallText: memory.text.includes(TOOL_CALL_PREFIX),
      classification: { derivationClass: classification.derivationClass, ruleId: classification.ruleId },
      markersFound
    };
  });
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

      // Reconstruction happens strictly BEFORE prepareInjection (T-11-59) — see reconstructSelected's docstring.
      const reconstructed = await reconstructSelected(store, request, embedder);

      // No abort timeout by design (T-11-53) — a slow run must be visible, not silently truncated.
      const packet = await retriever.prepareInjection(request);
      const elapsedMs = performance.now() - start;
      totalElapsedMs += elapsedMs;

      process.stderr.write(
        `[${label}] ${query.id} — ${elapsedMs.toFixed(1)}ms — packet: ${packet ? "yes" : "null"}\n`
      );

      // Fidelity guard: a reconstruction that does not exactly reproduce the real packet's text
      // fails the run loudly instead of reporting a number nobody can trust (T-11-59).
      const reconstructedJoin = reconstructed.map((memory) => memory.text).join("\n\n");
      if (packet !== null && reconstructedJoin !== packet.selectedMemory) {
        throw new Error(
          `[${label}] ${query.id} — reconstruction fidelity guard FAILED: reconstructed selected[] ` +
            `does not match packet.selectedMemory. Refusing to report an unattributable number.`
        );
      }
      if (packet === null && reconstructed.length !== 0) {
        throw new Error(
          `[${label}] ${query.id} — reconstruction fidelity guard FAILED: prepareInjection returned ` +
            `null but the reconstruction produced ${reconstructed.length} item(s).`
        );
      }

      const items = attributeItems(reconstructed);
      const unhygienicRanks = items
        .filter(
          (item) => item.classification.derivationClass === "synthetic_injected" || item.markersFound.length > 0
        )
        .map((item) => item.rank);
      const toolCallItemCount = items.filter((item) => item.containsToolCallText).length;
      const markerItemCount = items.filter((item) => item.markersFound.length > 0).length;
      const anySyntheticClassified = items.some(
        (item) => item.classification.derivationClass === "synthetic_injected"
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
        containsToolCallText: toolCallItemCount > 0,
        containsHarnessText: markerItemCount > 0 || anySyntheticClassified,
        items,
        unhygienicItemCount: unhygienicRanks.length,
        unhygienicRanks,
        toolCallItemCount,
        markerItemCount,
        topItemKind: reconstructed[0]?.kind ?? null,
        topItemId: reconstructed[0]?.id ?? null,
        relevanceReason: packet?.relevanceReason ?? null,
        sourceTraceIds: packet?.sourceTraceIds ?? [],
        boxIds: packet?.boxIds ?? []
      });
    }
  } finally {
    store.close();
  }

  const artifact: ProbeArtifact = {
    probeVersion: 2,
    hygieneRuleVersion: HYGIENE_RULE_VERSION,
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
      return `| ${r.id} | ${r.packetIsNull ? "null" : "packet"} | ${r.confidence?.toFixed(2) ?? "-"} | ${r.elapsedMs.toFixed(1)} | ${r.containsToolCallText} | ${r.containsHarnessText} | ${r.unhygienicItemCount}/${r.items.length} | ${r.sourceSummaryIds.length} | ${preview} |`;
    })
    .join("\n");
  const itemRows = results
    .flatMap((r) =>
      r.items.map((item) => {
        const itemPreview = item.preview.replace(/\n/g, " ");
        return `| ${r.id} | ${item.rank} | ${item.kind} | ${item.id} | ${item.classification.derivationClass} | ${item.classification.ruleId ?? "-"} | ${item.markersFound.join(",") || "-"} | ${item.containsToolCallText} | ${itemPreview} |`;
      })
    )
    .join("\n");
  const md = [
    `# Probe run: ${label}`,
    "",
    `- database: \`${databasePath}\``,
    `- personId: \`${personId}\``,
    `- embedder: ${embedder.provider} / ${embedder.model}`,
    `- probeVersion: 2 (hygieneRuleVersion: ${HYGIENE_RULE_VERSION})`,
    `- summary counts by state: ${JSON.stringify(countsBefore)}`,
    `- total elapsed: ${totalElapsedMs.toFixed(1)}ms`,
    "",
    "| Query | Packet | Confidence | Elapsed ms | containsToolCallText | containsHarnessText | unhygienic/total items | sourceSummaryIds | selectedMemory preview |",
    "|---|---|---|---|---|---|---|---|---|",
    mdRows,
    "",
    "## Per-item attribution",
    "",
    "| Query | Rank | Kind | Id | derivationClass | ruleId | markersFound | containsToolCallText | preview |",
    "|---|---|---|---|---|---|---|---|---|",
    itemRows,
    ""
  ].join("\n");
  writeFileSync(`${out}.md`, md);

  process.stderr.write(`\n[${label}] total elapsed: ${totalElapsedMs.toFixed(1)}ms across ${results.length} queries\n`);
  process.stderr.write(`[${label}] wrote ${out}.json and ${out}.md\n`);
}

await main();
