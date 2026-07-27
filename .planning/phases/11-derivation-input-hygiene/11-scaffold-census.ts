/**
 * Phase 11 Plan 20 — throwaway / phase-local census script (precedent: 11-hygiene-sim.ts,
 * 11-recall-probe.ts). NOT production code.
 *
 * Runs the shipped `classifyEvent` (src/topic/derivation-hygiene.ts) against every canonical
 * event in a READ-ONLY clone of the live corpus and reports:
 *
 *   (a) hit count per existing SYNTHETIC_RULES id, next to 11-CONTEXT.md's measured baseline
 *       (so a rule whose count collapsed or exploded since 2026-07-26 is visible), and
 *   (b) among events classified `conversational`, a frequency ranking of leading-shape
 *       signatures (first 48 chars, digits -> `#`, hex/uuid-looking tokens -> `<id>`,
 *       whitespace collapsed) — the top 60 signatures with role/eventKind/one verbatim example.
 *
 * Plus a second pass: how many `conversational` events CONTAIN `<task-notification>` ANYWHERE
 * (not just as a prefix), and where in the content it sits.
 *
 * Safety: opens a `cp -c` CLONE of ~/.memory/aaron.db via node:sqlite's DatabaseSync in
 * `{ readOnly: true }` mode and never writes. The original's mtime/size are asserted unchanged
 * before and after the run (T-11-64).
 *
 * Import-prefix hazard (11-07-SUMMARY, 11-hygiene-sim.ts, 11-recall-probe.ts): ESM resolves
 * relative imports against THIS FILE's directory
 * (`.planning/phases/11-derivation-input-hygiene/`), not the repo root, and `tsc --noEmit`
 * resolves these differently and will NOT catch a wrong prefix. Verified by running (`npx tsx`),
 * never by typechecking alone. Imports below are `../../../src/...`.
 *
 * Usage:
 *   npx tsx .planning/phases/11-derivation-input-hygiene/11-scaffold-census.ts
 */
import { createRequire } from "node:module";
import { statSync, copyFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyEvent, SYNTHETIC_RULES, type ClassifiableEvent } from "../../../src/topic/derivation-hygiene.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string, o?: unknown) => any };

const LIVE_DB = join(process.env.HOME ?? "", ".memory", "aaron.db");
const PERSON_ID = "aaron";
const TOP_SIGNATURE_COUNT = 60;

// 11-CONTEXT.md "Confirmed synthetic rules (measured hit counts)", 2026-07-26.
const BASELINE_HIT_COUNTS: Record<string, number> = {
  "cron-session-tag": 7909,
  "harness-system": 5561,
  "automated-followup": 2210,
  "system-reminder-only": 1786,
  "skill-invocation": 1038,
  "city-harness-preamble": 274,
  "context-compaction": 262,
  "automated-task-block": 168,
  "skill-body-injection": 127,
  "local-command-stdout": 109,
  "session-continuation": 86,
  "silent-sentinel": 2784,
  "structured-json-emission": 3023
};

interface CanonicalEventRow {
  content: string;
  eventKind: string | null;
  role: string | null;
}

interface SignatureBucket {
  signature: string;
  count: number;
  role: string | null;
  eventKind: string | null;
  example: string;
}

function normalizeSignature(content: string): string {
  const lead = content.slice(0, 48);
  return lead
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function main(): void {
  const before = statSync(LIVE_DB);

  const scratchDir = mkdtempSync(join(tmpdir(), "gsd-11-20-census-"));
  const clonePath = join(scratchDir, "census.db");
  copyFileSync(LIVE_DB, clonePath);
  const cloneStat = statSync(clonePath);

  const raw = new DatabaseSync(clonePath, { readOnly: true });

  const rows = raw
    .prepare("select payload from canonical_events where person_id = ?")
    .all(PERSON_ID) as { payload: string }[];

  const events: CanonicalEventRow[] = rows.map((row) => {
    const parsed = JSON.parse(row.payload) as { content: string; eventKind?: string | null; role?: string | null };
    return { content: parsed.content ?? "", eventKind: parsed.eventKind ?? null, role: parsed.role ?? null };
  });

  const ruleHitCounts = new Map<string, number>();
  for (const rule of SYNTHETIC_RULES) ruleHitCounts.set(rule.id, 0);

  const conversationalSignatures = new Map<string, SignatureBucket>();
  let conversationalCount = 0;
  let toolActivityCount = 0;
  let syntheticCount = 0;

  let taskNotificationContainCount = 0;
  const taskNotificationPositions: string[] = [];

  for (const event of events) {
    const classifiable: ClassifiableEvent = { content: event.content, eventKind: event.eventKind, role: event.role };
    const result = classifyEvent(classifiable);

    if (result.derivationClass === "tool_activity") toolActivityCount += 1;
    else if (result.derivationClass === "synthetic_injected") {
      syntheticCount += 1;
      if (result.ruleId) ruleHitCounts.set(result.ruleId, (ruleHitCounts.get(result.ruleId) ?? 0) + 1);
    } else {
      conversationalCount += 1;
      const sig = normalizeSignature(event.content.trimStart());
      const existing = conversationalSignatures.get(sig);
      if (existing) {
        existing.count += 1;
      } else {
        conversationalSignatures.set(sig, {
          signature: sig,
          count: 1,
          role: event.role,
          eventKind: event.eventKind,
          example: event.content.slice(0, 200)
        });
      }

      if (event.content.includes("<task-notification>")) {
        taskNotificationContainCount += 1;
        const idx = event.content.indexOf("<task-notification>");
        if (taskNotificationPositions.length < 5) {
          taskNotificationPositions.push(
            `index ${idx} of ${event.content.length} chars, role=${event.role ?? "null"}: "${event.content.slice(Math.max(0, idx - 20), idx + 60)}"`
          );
        }
      }
    }
  }

  const after = statSync(LIVE_DB);

  const topSignatures = [...conversationalSignatures.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_SIGNATURE_COUNT);

  writeReport({
    clonePath,
    cloneByteSize: cloneStat.size,
    eventTotal: events.length,
    toolActivityCount,
    conversationalCount,
    syntheticCount,
    beforeMtime: before.mtime.toISOString(),
    beforeSize: before.size,
    afterMtime: after.mtime.toISOString(),
    afterSize: after.size,
    ruleHitCounts,
    topSignatures,
    taskNotificationContainCount,
    taskNotificationPositions
  });

  raw.close?.();

  // eslint-disable-next-line no-console
  console.log(
    `Census complete: ${events.length} events (tool_activity=${toolActivityCount}, conversational=${conversationalCount}, synthetic=${syntheticCount}).`
  );
  // eslint-disable-next-line no-console
  console.log(`Original db unchanged: mtime ${before.mtime.toISOString()} -> ${after.mtime.toISOString()}, size ${before.size} -> ${after.size}`);
}

function writeReport(data: {
  clonePath: string;
  cloneByteSize: number;
  eventTotal: number;
  toolActivityCount: number;
  conversationalCount: number;
  syntheticCount: number;
  beforeMtime: string;
  beforeSize: number;
  afterMtime: string;
  afterSize: number;
  ruleHitCounts: Map<string, number>;
  topSignatures: SignatureBucket[];
  taskNotificationContainCount: number;
  taskNotificationPositions: string[];
}): void {
  const lines: string[] = [];
  lines.push("# 11-SCAFFOLD-AUDIT.md — Plan 11-20 Task 1 census");
  lines.push("");
  lines.push(`**Run date:** 2026-07-27`);
  lines.push(`**Clone path:** \`${data.clonePath}\` (throwaway, in a tmpdir, deleted by OS cleanup — not committed)`);
  lines.push(`**Clone byte size:** ${data.cloneByteSize.toLocaleString()} bytes`);
  lines.push(`**Live db before:** mtime \`${data.beforeMtime}\`, size ${data.beforeSize.toLocaleString()} bytes`);
  lines.push(`**Live db after:** mtime \`${data.afterMtime}\`, size ${data.afterSize.toLocaleString()} bytes`);
  lines.push(`**Unchanged:** ${data.beforeMtime === data.afterMtime && data.beforeSize === data.afterSize ? "YES" : "NO — INVESTIGATE"}`);
  lines.push("");
  lines.push(`**Person:** \`aaron\``);
  lines.push(`**Total canonical events:** ${data.eventTotal.toLocaleString()}`);
  lines.push(
    `**Composition:** tool_activity ${data.toolActivityCount.toLocaleString()} · conversational ${data.conversationalCount.toLocaleString()} · synthetic_injected ${data.syntheticCount.toLocaleString()}`
  );
  lines.push("");
  lines.push(`**\`<task-notification>\` containment (anywhere in content, among \`conversational\`-classified events):** ${data.taskNotificationContainCount.toLocaleString()} events`);
  if (data.taskNotificationPositions.length > 0) {
    lines.push("");
    lines.push("Sample positions:");
    for (const pos of data.taskNotificationPositions) lines.push(`- ${pos}`);
  }
  lines.push("");
  lines.push("## Table (a): existing rule hit counts vs. 11-CONTEXT.md baseline");
  lines.push("");
  lines.push("| Rule id | Current count | Baseline (2026-07-26) | Delta |");
  lines.push("|---|---:|---:|---:|");
  for (const rule of SYNTHETIC_RULES) {
    const current = data.ruleHitCounts.get(rule.id) ?? 0;
    const baseline = BASELINE_HIT_COUNTS[rule.id];
    const baselineStr = baseline === undefined ? "n/a" : baseline.toLocaleString();
    const delta = baseline === undefined ? "n/a" : (current - baseline).toLocaleString();
    lines.push(`| ${rule.id} | ${current.toLocaleString()} | ${baselineStr} | ${delta} |`);
  }
  lines.push("");
  lines.push("## Table (b): top unrecognised-shape signatures among `conversational` events");
  lines.push("");
  lines.push("Verdict legend: `add-rule` = unambiguous anchored harness scaffolding, propose adding a rule.");
  lines.push("`leave` = genuine conversation or too ambiguous to anchor on. `needs-owner` = high-volume and genuinely arguable.");
  lines.push("");
  lines.push("| # | Count | Role | EventKind | Verdict | Signature | Example (200 chars) |");
  lines.push("|---:|---:|---|---|---|---|---|");
  data.topSignatures.forEach((bucket, i) => {
    const verdict = verdictFor(bucket);
    const escapedExample = bucket.example.replace(/\|/g, "\\|").replace(/\n/g, "\\n");
    const escapedSig = bucket.signature.replace(/\|/g, "\\|");
    lines.push(
      `| ${i + 1} | ${bucket.count.toLocaleString()} | ${bucket.role ?? "null"} | ${bucket.eventKind ?? "null"} | ${verdict} | \`${escapedSig}\` | \`${escapedExample}\` |`
    );
  });
  lines.push("");
  lines.push("## Verdict rationale");
  lines.push("");
  lines.push(
    "- `<task-notification>` — **add-rule**. Content beginning `<task-notification>` is an unambiguous harness-injected marker (Q12's post-prune top memory, GAP-11-E anomaly 2). Predicate: `c.startsWith(\"<task-notification>\")`, no role gate (mirrors `local-command-stdout` / `system-reminder-only`)."
  );
  lines.push(
    "- `<local-command-caveat>` — **add-rule**. Same class of Claude Code-injected wrapper tag as the already-covered `<local-command-stdout>` / `<system-reminder>` rules: the body (\"Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages...\") is harness boilerplate, not user-authored content. Predicate: `c.startsWith(\"<local-command-caveat>\")`, no role gate."
  );
  lines.push(
    "- `[phase:draft]` / `[phase:evaluation]` / `[phase:review]` / `[phase:integration]` / `[phase:validation]` / `[phase:response]` (rows 4, 16, 19, 21, 22, 26; combined ~1,676 events) — **needs-owner**. Anchored (`[phase:` bracket prefix) and templated (\"per your seeded instructions\" recurs verbatim), consistent with a multi-agent orchestration harness. But unlike pure metadata noise, a `[phase:X]` line is the literal instruction that drove real work the agent then did — excluding it changes what the derivation remembers about *why* the agent acted, which is a product judgment call, not a pure hygiene one. Flagged for the Plan 11-23 owner checkpoint rather than decided here, per this plan's explicit instruction that a `needs-owner` shape waits."
  );
  lines.push(
    "- `[Mission Control task comment relay]` (row 28, 128 events) and `System: [...] Slack message` (row 38, 90 events) were considered and left **leave**, not `add-rule`, despite the anchored system-relay prefix: both wrap genuine human-authored content underneath the wrapper (an actual Slack message body, an actual task comment with `Author: Aaron`). Excluding the whole event would silently delete the human content along with the relay boilerplate — the worse failure mode this plan's constraints warn against."
  );
  lines.push(
    "- All other top-60 signatures are **leave**: ordinary prose leads (greetings, questions, task descriptions, agent report text like the Roscoe run-log rows) with no anchored structural marker, or short/generic fragments (`HEARTBEAT_OK`, `pong`, `[toolCall]`, `ok`, `Status`) that are genuine reply content following the user's own conventions, not harness injection. Per 11-CONTEXT.md's conservative-by-default stance (\"a rule fires only on unambiguous harness markers\"), no further rule is proposed from this run."
  );
  lines.push("");

  writeFileSync(
    "/Users/aaronwhaley/Agent-Corporation/conversational-memory-system/.planning/phases/11-derivation-input-hygiene/11-SCAFFOLD-AUDIT.md",
    lines.join("\n") + "\n"
  );
}

/**
 * Conservative-by-default verdict function: only the confirmed `<task-notification>` shape is
 * `add-rule`; everything else defaults to `leave` unless it is unambiguous anchored scaffolding.
 * This function is the single place a verdict is decided, so the audit and the implementation
 * task cannot silently disagree about which signatures were approved.
 */
function verdictFor(bucket: SignatureBucket): "add-rule" | "leave" | "needs-owner" {
  if (bucket.signature.startsWith("<task-notification>")) return "add-rule";
  // Same class of Claude Code-injected wrapper tag as the already-covered
  // `<local-command-stdout>` / `<system-reminder>` rules: an anchored XML-like tag whose body
  // ("Caveat: The messages below were generated by the user while running local commands. DO
  // NOT respond...") is boilerplate the harness inserts, not user-authored content.
  if (bucket.signature.startsWith("<local-command-caveat>")) return "add-rule";
  // Templated multi-agent orchestration prompts ("per your seeded instructions" recurs
  // verbatim across [phase:draft]/[phase:evaluation]/[phase:review]/[phase:integration]/
  // [phase:validation]/[phase:response]) are anchored but genuinely arguable: unlike pure
  // metadata noise (cron tags, session banners), a [phase:X] prompt is the literal instruction
  // that drove real work the agent did — excluding it from derivation is a product decision,
  // not just a hygiene one. Deferred to the Plan 11-23 owner checkpoint.
  if (/^\[phase:[a-z]+\]/.test(bucket.signature)) return "needs-owner";
  return "leave";
}

main();
