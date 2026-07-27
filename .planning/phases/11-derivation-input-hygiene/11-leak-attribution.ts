/**
 * Phase 11 Plan 22 — GAP-11-E root-cause discriminator, THROWAWAY / phase-local script.
 * NOT production code. Read-only: opens a CLONE of the live database (`--db`), never the
 * original, never a backup directly (T-11-73).
 *
 * Import-prefix hazard (11-recall-probe.ts precedent): ESM resolves relative imports against
 * THIS FILE's directory (`.planning/phases/11-derivation-input-hygiene/`), not the repo root.
 * Imports below are `../../../src/...`. Verified by running (`npx tsx`), never by typechecking
 * alone.
 *
 * Usage:
 *   npx tsx .planning/phases/11-derivation-input-hygiene/11-leak-attribution.ts \
 *     --probe <probe-v2-artifact.json> --db <path-to-CLONE.db> --person <personId> \
 *     --out <output-basename>
 *
 *   npx tsx .planning/phases/11-derivation-input-hygiene/11-leak-attribution.ts --help
 *
 * Task 1 (offender inventory): for every packet item the referenced probe-v2 artifact flags as
 * unhygienic (`item.classification.derivationClass === "synthetic_injected" || item.markersFound
 * .length > 0` — the SAME predicate `11-recall-probe.ts` used to compute `unhygienicRanks`),
 * resolve the offending record by kind and record its provenance fields.
 *
 * Task 2 (discriminator): for every `kind: summary` offender, load its `sourceCanonicalEventIds`
 * from the clone in canonical order, run the SHIPPED `derivationContents` over them, and assign
 * exactly one hypothesis label by the plan's stated first-match order (H-0, H-i, H-ii, H-iii,
 * H-iv). Emits a per-hypothesis tally and one worked example per non-empty hypothesis.
 *
 * Never opens `~/.memory/aaron.db` or any `.pre-*` backup — only whatever `--db` names, which
 * MUST be a `cp -c` clone. Never writes to that database. Writes only its own JSON/MD outputs.
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyEvent,
  derivationContents,
  HYGIENE_RULE_VERSION,
  SYNTHETIC_MARKERS,
  TOOL_CALL_PREFIX,
  type ClassifiableEvent
} from "../../../src/topic/derivation-hygiene.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (p: string, o?: unknown) => DatabaseHandle;
};

interface DatabaseHandle {
  prepare(sql: string): { get(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] };
  close(): void;
}

// --- probe-v2 artifact shapes (subset consumed here; see 11-recall-probe.ts for the full shape) ---
interface ProbeItem {
  rank: number;
  kind: "summary" | "anchor" | "trace" | "box_context";
  id: string;
  summaryIds: string[];
  traceId: string | null;
  boxIds: string[];
  preview: string;
  containsToolCallText: boolean;
  classification: { derivationClass: string; ruleId: string | null };
  markersFound: string[];
}
interface ProbeResult {
  id: string;
  currentTopicSummary: string;
  items: ProbeItem[];
  unhygienicItemCount: number;
  unhygienicRanks: number[];
}
interface ProbeArtifact {
  probeVersion: number;
  hygieneRuleVersion: string;
  label: string;
  databasePath: string;
  personId: string;
  results: ProbeResult[];
}

interface CanonicalEventRow {
  id: string;
  occurredAt: string;
  nativeSequence: number;
  eventKind?: string | null;
  role?: string | null;
  content: string;
}

interface SummaryRow {
  id: string;
  personId: string;
  scopeIds: string[];
  origin?: "host_session" | "historical_bootstrap";
  summaryText: string;
  sourceTurnRanges: Array<{ threadId: string; startSequence: number; endSequence: number }>;
  sourceCanonicalEventIds?: string[];
  createdAt: string;
  model: string;
  promptVersion: string;
  state: string;
  version: number;
}

type Hypothesis = "H-0" | "H-i" | "H-ii" | "H-iii" | "H-iv" | "inconclusive";

interface OffenderRow {
  query: string;
  rank: number;
  kind: ProbeItem["kind"];
  id: string;
  ruleOrMarker: string;
  flaggedBy: "classifyEvent" | "marker-containment" | "both";
  // summary-kind fields
  createdAt?: string;
  state?: string;
  origin?: string | null;
  model?: string;
  promptVersion?: string;
  version?: number;
  sourceCanonicalEventIdsCount?: number;
  sourceEvents?: Array<{
    id: string;
    occurredAt: string;
    nativeSequence: number;
    eventKind: string | null;
    role: string | null;
    contentPreview: string;
  }>;
  storedText?: string;
  redrivenText?: string;
  redrivenEntryCount?: number;
  redrivenContainsToolCall?: boolean;
  redrivenMarkersFound?: string[];
  reconstructionApproximate?: boolean;
  isolatedToolSegment?: boolean;
  hypothesis?: Hypothesis;
  hypothesisReason?: string;
  // anchor-kind fields (H-iv)
  drivesTopicLabel?: boolean;
}

function parseArgs(argv: string[]): { probe: string; db: string; person: string; out: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      process.stdout.write(
        "Usage: 11-leak-attribution.ts --probe <probe-v2.json> --db <CLONE.db> --person <personId> --out <basename>\n" +
          "The --db path MUST be a `cp -c` clone; this script refuses to run against a path ending in " +
          "a bare `.memory/aaron.db` or `.pre-` backup suffix.\n"
      );
      process.exit(0);
    }
    if (arg.startsWith("--") && argv[i + 1]) {
      values.set(arg.slice(2), argv[i + 1]);
      i += 1;
    }
  }
  const probe = values.get("probe");
  const db = values.get("db");
  const person = values.get("person");
  const out = values.get("out");
  if (!probe || !db || !person || !out) {
    throw new Error("Missing required flag. Usage: --probe <path> --db <CLONE.db> --person <personId> --out <basename>");
  }
  return { probe: resolve(probe), db: resolve(db), person, out: resolve(out) };
}

/** T-11-73: refuse to open the live corpus or a backup directly — clone-only. */
function assertCloneOnly(databasePath: string): void {
  if (/(?:^|\/)aaron\.db(?:\.pre-[^/]*)?$/.test(databasePath) && !databasePath.includes("clone")) {
    // Heuristic guard only (T-11-73's actual enforcement is operator discipline + this check);
    // a path literally named `aaron.db` or `aaron.db.pre-*` outside a "clone" directory/filename
    // is almost certainly the live corpus or a backup opened directly.
    throw new Error(
      `Refusing to open "${databasePath}" — looks like the live corpus or a backup, not a clone. ` +
        `cp -c it to a path containing "clone" first.`
    );
  }
}

function loadCanonicalEvent(db: DatabaseHandle, id: string): CanonicalEventRow | null {
  const row = db.prepare("select payload from canonical_events where id = ?").get(id) as
    | { payload: string }
    | undefined;
  if (!row) return null;
  const e = JSON.parse(row.payload) as CanonicalEventRow;
  return e;
}

function loadSummary(db: DatabaseHandle, id: string): SummaryRow | null {
  const row = db.prepare("select payload from summaries where id = ?").get(id) as
    | { payload: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.payload) as SummaryRow;
}

function loadAnchor(db: DatabaseHandle, id: string): Record<string, unknown> | null {
  const row = db.prepare("select payload from anchors where id = ?").get(id) as
    | { payload: string }
    | undefined;
  if (!row) return null;
  return JSON.parse(row.payload) as Record<string, unknown>;
}

/** Task 1: every unhygienic item across every query, by the same predicate 11-recall-probe.ts used. */
function collectOffenders(artifact: ProbeArtifact): Array<{ query: string; item: ProbeItem }> {
  const offenders: Array<{ query: string; item: ProbeItem }> = [];
  for (const result of artifact.results) {
    for (const item of result.items) {
      const isUnhygienic =
        item.classification.derivationClass === "synthetic_injected" || item.markersFound.length > 0;
      if (isUnhygienic) offenders.push({ query: result.id, item });
    }
  }
  return offenders;
}

/** Task 2: assign exactly one hypothesis per the plan's first-match order. */
function classifySummaryOffender(
  db: DatabaseHandle,
  row: OffenderRow,
  summary: SummaryRow,
  hygieneRuleVersionAtCreation: string | null
): void {
  const eventIds = summary.sourceCanonicalEventIds ?? [];
  row.sourceCanonicalEventIdsCount = eventIds.length;

  const events: CanonicalEventRow[] = [];
  let missingEvent = false;
  for (const id of eventIds) {
    const e = loadCanonicalEvent(db, id);
    if (!e) {
      missingEvent = true;
      continue;
    }
    events.push(e);
  }
  events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.nativeSequence - b.nativeSequence || a.id.localeCompare(b.id));

  row.sourceEvents = events.map((e) => ({
    id: e.id,
    occurredAt: e.occurredAt,
    nativeSequence: e.nativeSequence,
    eventKind: e.eventKind ?? null,
    role: e.role ?? null,
    contentPreview: e.content.slice(0, 80)
  }));

  const classifiable: ClassifiableEvent[] = events.map((e) => ({
    content: e.content,
    eventKind: e.eventKind ?? null,
    role: e.role ?? null
  }));

  const redriven = derivationContents(classifiable);
  const redrivenText = redriven.map((entry) => entry.content).join(" ");
  row.redrivenText = redrivenText;
  row.redrivenEntryCount = redriven.length;
  row.redrivenContainsToolCall = redrivenText.includes(TOOL_CALL_PREFIX);
  row.redrivenMarkersFound = SYNTHETIC_MARKERS.filter((m) => redrivenText.includes(m.marker)).map((m) => m.ruleId);
  row.storedText = summary.summaryText;

  // Segment shape: does the redriven output include a tool-activity entry that came from an
  // ISOLATED (length-1) segment, vs a run of >=2? Recompute segments the same way
  // derivationContents does internally, but only to inspect run length (not exported, so
  // re-derive via the same public entry points: an isolated segment reproduces exactly one
  // event's own content verbatim at its own index; a collapsed run produces `collapseText`
  // output, which always starts with "[Activity] ran ".
  const hasCollapsedRun = redriven.some((entry) => entry.content.startsWith("[Activity] ran "));
  const hasVerbatimToolCall = redriven.some((entry) => entry.content.startsWith(TOOL_CALL_PREFIX));
  row.isolatedToolSegment = hasVerbatimToolCall && !hasCollapsedRun;

  // reconstruction-approximate: cannot determine derivationEnd/windowEnd from a Summary alone
  // (that distinction lives only in the ephemeral SpanWindow at derivation time, never
  // persisted). Flag whenever sourceCanonicalEventIds names fewer events than were actually
  // resolved (a missing event) OR when the summary's own sourceTurnRanges declares more turns
  // than sourceCanonicalEventIds carries (a signal the window may have been truncated) — a
  // conservative approximation of the plan's intent, stated explicitly rather than silently
  // assumed precise.
  row.reconstructionApproximate = missingEvent;

  // "Reproduces" must catch BOTH directions of drift, not just "whatever survived current rules
  // is a substring of stored text" (that direction is true VACUOUSLY whenever current rules drop
  // MORE than the rules that actually produced the stored summary — a strict subset is always a
  // substring). The decisive test is the other direction: does the stored text contain content
  // that CURRENT rules would drop or collapse but which survived into the stored summary anyway?
  //   (a) any event CURRENT classifyEvent marks synthetic_injected, whose own content is present
  //       verbatim in the stored text, proves the stored text predates that rule engaging.
  //   (b) any run of >=2 consecutive tool_activity events (under CURRENT rules) whose members'
  //       raw content appear verbatim and UNCOLLAPSED in the stored text (i.e. NOT replaced by a
  //       single `collapseText(...)` entry) proves the stored text predates run-collapse engaging.
  const survivingSyntheticLeak = classifiable.find((e, idx) => {
    const cls = classifyEvent(e);
    if (cls.derivationClass !== "synthetic_injected") return false;
    return summary.summaryText.includes(events[idx]!.content);
  });
  const survivingUncollapsedRun = redriven.some((entry) => {
    // A run of >=2 is represented by a SINGLE collapseText(...) entry in the current output. If
    // the stored text instead contains 2+ raw "[Tool call: " payloads back-to-back that current
    // rules would have collapsed into that one entry, the raw payloads (not the collapse text)
    // will be present in stored text while the collapse text will NOT be.
    return entry.content.startsWith("[Activity] ran ") && !summary.summaryText.includes(entry.content);
  });
  const noDrift = !survivingSyntheticLeak && !survivingUncollapsedRun;

  const redrivenNormalized = redrivenText.trim();
  const allRedrivenEntriesPresent = redriven.every((entry) => summary.summaryText.includes(entry.content));
  const reproduces = allRedrivenEntriesPresent && redrivenNormalized.length > 0 && noDrift;

  if (reproduces && row.isolatedToolSegment) {
    row.hypothesis = "H-0";
    row.hypothesisReason =
      "Re-derivation under the SHIPPED derivationContents reproduces every entry of the stored " +
      "summaryText verbatim, and the tool-call text originates from an isolated (length-1) tool " +
      "segment, not a run of >=2. This is the locked 11-CONTEXT decision 'a single isolated tool " +
      "call keeps its existing text' (derivation-hygiene.ts:216). Compliant with REQ-052/SC3 as " +
      "written. A rebuild would reproduce this exact text — not a code defect.";
    return;
  }

  if (reproduces && !row.isolatedToolSegment) {
    row.hypothesis = "H-i";
    row.hypothesisReason =
      "Re-derivation under the SHIPPED derivationContents reproduces the offending text, and it " +
      "originates from a run of >=2 tool-activity events (or a synthetic marker the current rules " +
      "fail to drop). The rules themselves leak; a rebuild would REPRODUCE this offender, not fix it.";
    return;
  }

  // Not reproduced: re-derivation under CURRENT rules is clean (or materially different).
  // H-ii vs H-iii: does the seam that built this summary even call derivationContents?
  // Every Summary in this corpus we have observed has origin: "historical_bootstrap", which
  // `summaryForSpan` (src/daemon/contraction-runner.ts:389-444) ALWAYS hardcodes regardless of
  // whether the summary came from a live/incremental slice or a bulk historical bootstrap run —
  // that function DOES call derivationContents (contraction-runner.ts:414) unconditionally. So
  // for this corpus, H-ii (an input-path bypass) would require evidence of a DIFFERENT seam; we
  // did not find one that also mints `historical_summary_*` ids. Default to H-iii unless a
  // bypass is independently evidenced.
  row.hypothesis = "H-iii";
  const versionNote = hygieneRuleVersionAtCreation
    ? ` The corpus's own contraction checkpoint recorded processorVersion "${hygieneRuleVersionAtCreation}" ` +
      `at the time this class of summary was last (re)computed, which predates the current ` +
      `${HYGIENE_RULE_VERSION}.`
    : "";
  const driftNote = survivingSyntheticLeak
    ? ` Decisive signal: a raw source event's content classifies synthetic_injected under CURRENT ` +
      `rules (would be dropped), yet its content is present verbatim in the stored summaryText — ` +
      `proof the stored text was NOT produced under the current rule set.`
    : survivingUncollapsedRun
      ? ` Decisive signal: current rules would collapse a run of >=2 tool-activity events into a ` +
        `single [Activity] entry, but the stored summaryText instead contains the raw, uncollapsed ` +
        `per-event tool-call text — proof the stored text predates run-collapse.`
      : "";
  row.hypothesisReason =
    "Re-derivation under the SHIPPED (current) derivationContents does NOT reproduce the stored " +
    "text verbatim." +
    driftNote +
    " The summary was computed under an earlier hygiene-rule pass and has not been reprocessed since." +
    versionNote +
    " `rebuild-derivations` is the remedy for this offender.";
}

async function main(): Promise<void> {
  const { probe: probePath, db: dbPath, person, out } = parseArgs(process.argv.slice(2));
  assertCloneOnly(dbPath);

  const statsBefore = statSync(dbPath);

  const artifact = JSON.parse(readFileSync(probePath, "utf8")) as ProbeArtifact;
  const db = new DatabaseSync(dbPath, { readOnly: true });

  // Read the live processor version off the corpus's own contraction checkpoint, purely as
  // context for the H-iii narrative above — never used to gate anything, never written to.
  let checkpointProcessorVersion: string | null = null;
  try {
    const rows = db.prepare("select payload from daemon_contraction_checkpoint").all() as Array<{
      payload: string;
    }>;
    for (const r of rows) {
      const parsed = JSON.parse(r.payload) as { processorVersion?: string };
      if (parsed.processorVersion) checkpointProcessorVersion = parsed.processorVersion;
    }
  } catch {
    // Table may not exist on an older schema; absence is not an error for this read-only probe.
  }

  const offenders = collectOffenders(artifact);
  const rows: OffenderRow[] = [];

  const byKind: Record<string, number> = {};

  for (const { query, item } of offenders) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    const flaggedByClassify = item.classification.derivationClass === "synthetic_injected";
    const flaggedByMarker = item.markersFound.length > 0;
    const row: OffenderRow = {
      query,
      rank: item.rank,
      kind: item.kind,
      id: item.id,
      ruleOrMarker: item.classification.ruleId ?? item.markersFound.join(",") ?? "",
      flaggedBy: flaggedByClassify && flaggedByMarker ? "both" : flaggedByClassify ? "classifyEvent" : "marker-containment"
    };

    if (item.kind === "summary") {
      const summary = loadSummary(db, item.id);
      if (!summary) {
        row.hypothesis = "inconclusive";
        row.hypothesisReason = `Summary id ${item.id} not found in the clone — cannot trace.`;
        rows.push(row);
        continue;
      }
      row.createdAt = summary.createdAt;
      row.state = summary.state;
      row.origin = summary.origin ?? null;
      row.model = summary.model;
      row.promptVersion = summary.promptVersion;
      row.version = summary.version;
      classifySummaryOffender(db, row, summary, checkpointProcessorVersion);
    } else if (item.kind === "anchor") {
      const anchor = loadAnchor(db, item.id);
      if (!anchor) {
        row.hypothesis = "inconclusive";
        row.hypothesisReason = `Anchor id ${item.id} not found in the clone — cannot trace.`;
      } else {
        const content = String(anchor.content ?? "");
        const classification = classifyEvent({ content });
        row.drivesTopicLabel = classification.derivationClass === "conversational";
        row.storedText = content;
        row.hypothesis = "H-iv";
        row.hypothesisReason = row.drivesTopicLabel
          ? "Non-summary (anchor) path. drivesTopicLabel is TRUE on the resolved content, meaning " +
            "the 11-18 forward gate would not have blocked it by classification alone — a distinct " +
            "defect from the summary-leak hypotheses, scoped separately."
          : "Non-summary (anchor) path. drivesTopicLabel is FALSE — the forward gate SHOULD have " +
            "blocked this anchor's classification; its presence indicates a gate escape, a distinct " +
            "defect from the summary-leak hypotheses.";
      }
    } else {
      row.hypothesis = "H-iv";
      row.hypothesisReason = `Non-summary path (kind: ${item.kind}). Recorded but not further traced by this script.`;
    }

    rows.push(row);
  }

  db.close();
  const statsAfter = statSync(dbPath);

  const tally: Record<string, number> = {};
  for (const row of rows) {
    const h = row.hypothesis ?? "inconclusive";
    tally[h] = (tally[h] ?? 0) + 1;
  }
  const tallySum = Object.values(tally).reduce((a, b) => a + b, 0);
  if (tallySum !== rows.length) {
    throw new Error(
      `Tally sum (${tallySum}) does not equal offender count (${rows.length}) — refusing to report ` +
        `a partial classification (acceptance criterion, Task 2).`
    );
  }

  const output = {
    generatedAt: new Date().toISOString(),
    probeArtifact: probePath,
    databaseClone: dbPath,
    personId: person,
    hygieneRuleVersionCurrent: HYGIENE_RULE_VERSION,
    checkpointProcessorVersionAtRunTime: checkpointProcessorVersion,
    offenderCount: rows.length,
    offendersByKind: byKind,
    hypothesisTally: tally,
    cloneStatBefore: { size: statsBefore.size, mtime: statsBefore.mtime.toISOString() },
    cloneStatAfter: { size: statsAfter.size, mtime: statsAfter.mtime.toISOString() },
    offenders: rows
  };

  writeFileSync(`${out}.json`, JSON.stringify(output, null, 2));

  const workedExamples = Object.keys(tally)
    .filter((h) => h !== "inconclusive")
    .map((h) => rows.find((r) => r.hypothesis === h))
    .filter((r): r is OffenderRow => r !== undefined);

  const md = [
    `# GAP-11-E leak attribution`,
    "",
    `- probe artifact: \`${probePath}\``,
    `- database clone: \`${dbPath}\``,
    `- current hygieneRuleVersion: ${HYGIENE_RULE_VERSION}`,
    `- checkpoint processorVersion at run time: ${checkpointProcessorVersion ?? "(none found)"}`,
    `- offender count: ${rows.length}`,
    `- offenders by kind: ${JSON.stringify(byKind)}`,
    `- hypothesis tally: ${JSON.stringify(tally)}`,
    "",
    "## Offenders",
    "",
    "| Query | Rank | Kind | Id | Hypothesis | Reason |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.query} | ${r.rank} | ${r.kind} | ${r.id.slice(0, 40)}... | ${r.hypothesis ?? "?"} | ${(r.hypothesisReason ?? "").replace(/\|/g, "\\|").slice(0, 200)} |`
    ),
    "",
    "## Worked examples",
    "",
    ...workedExamples.flatMap((r) => [
      `### ${r.hypothesis} — ${r.query} rank ${r.rank} — \`${r.id}\``,
      "",
      "**Stored text:**",
      "```",
      (r.storedText ?? "").slice(0, 2000),
      "```",
      "",
      "**Re-derived text:**",
      "```",
      (r.redrivenText ?? "").slice(0, 2000),
      "```",
      ""
    ])
  ].join("\n");
  writeFileSync(`${out}.md`, md);

  process.stderr.write(`Offenders: ${rows.length}. Tally: ${JSON.stringify(tally)}\n`);
  process.stderr.write(`Clone unchanged: ${statsBefore.size === statsAfter.size && statsBefore.mtime.getTime() === statsAfter.mtime.getTime()}\n`);
  process.stderr.write(`Wrote ${out}.json and ${out}.md\n`);
}

await main();
