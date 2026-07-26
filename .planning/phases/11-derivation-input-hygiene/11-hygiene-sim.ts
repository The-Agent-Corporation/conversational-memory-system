/**
 * Phase 11 measurement prototype — THROWAWAY, scratchpad only.
 *
 * Replays the live canonical timeline through the REAL TopicMonitor and the
 * REAL DeterministicSummarizer text builder, twice:
 *   baseline  — every event, exactly as production contracts today
 *   hygiene   — synthetic_injected dropped, tool-call runs (>=2) collapsed
 *
 * Reports summary count and summary text volume for each, so Phase 11 planning
 * has measured numbers instead of estimates.
 *
 * Faithfulness notes (see src/daemon/contraction-runner.ts:142-160):
 *   - every event is observed on ONE thread `person:<id>`, not per session
 *   - sequence is the running index (1-based) over the ordered event list
 *   - summaryText = `${span.currentTopicSummary}: ${first 3 non-empty contents}`
 *     (src/summarization/summarizer.ts buildSummaryText)
 */
import { createRequire } from "node:module";
import { TopicMonitor, type CompletedTopicSpan } from "./src/topic/topic-monitor.js";
import {
  HYGIENE_RULE_VERSION,
  classifyEvent,
  collapseText,
  toolNameOf
} from "./src/topic/derivation-hygiene.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string, o?: unknown) => any };

const DB = process.env.MEMORY_DB ?? `${process.env.HOME}/.memory/aaron.db`;
const PERSON = process.env.MEMORY_PERSON ?? "aaron";
const PAGE = 20_000;

type Klass = "conversational" | "tool_activity" | "synthetic_injected";

interface Row {
  id: string;
  occurredAt: string;
  nativeSequence: number;
  role: string;
  eventKind: string;
  content: string;
}

/**
 * Thin adapter over the shared production classifier so the sim and implementation
 * cannot drift. `eventKind` is coalesced to `"message"` by the SQL query below, so a
 * real tool-call row still carries `eventKind: "tool_call"` — pass it straight through.
 */
const classify = (row: Row): { klass: Klass; rule: string | null } => {
  const result = classifyEvent({ content: row.content, eventKind: row.eventKind, role: row.role });
  return { klass: result.derivationClass, rule: result.ruleId };
};

/** Mirrors DeterministicSummarizer.buildSummaryText. */
const summaryTextFor = (span: CompletedTopicSpan, firstThree: string[]): string => {
  const preview = firstThree.map((c) => c.trim()).filter(Boolean).slice(0, 3).join(" ");
  return preview ? `${span.currentTopicSummary}: ${preview}` : span.currentTopicSummary;
};

class Pass {
  private readonly monitor = new TopicMonitor();
  private readonly thread = `person:${PERSON}`;
  private seq = 0;
  private spanPreview: string[] = [];
  summaries = 0;
  chars = 0;
  toolTextSummaries = 0;

  observeContentOnly(content: string): void {
    if (this.spanPreview.length < 3 && content.trim()) this.spanPreview.push(content);
  }

  observe(content: string, role: string, occurredAt: string, id: string): void {
    this.seq += 1;
    const previewBefore = [...this.spanPreview];
    const observed = this.monitor.observe({
      id,
      host: "unknown",
      profileId: PERSON,
      hostSessionId: this.thread,
      sequence: this.seq,
      type: "conversation_turn",
      role: role as never,
      content,
      createdAt: occurredAt,
      metadata: {}
    });
    if (observed.completed) {
      this.finish(observed.completed, previewBefore);
      this.spanPreview = [];
    }
    if (this.spanPreview.length < 3 && content.trim()) this.spanPreview.push(content);
  }

  private finish(span: CompletedTopicSpan, preview: string[]): void {
    const text = summaryTextFor(span, preview);
    this.summaries += 1;
    this.chars += text.length;
    if (text.includes("[Tool call:")) this.toolTextSummaries += 1;
  }

  flush(): void {
    const active = this.monitor.current(this.thread);
    if (active) this.finish({ ...active, completedAt: active.updatedAt }, this.spanPreview);
  }
}

const main = async (): Promise<void> => {
  const db = new DatabaseSync(DB, { readOnly: true });
  const select = db.prepare(`
    select json_extract(payload,'$.id') id,
           occurred_at occurredAt,
           native_sequence nativeSequence,
           json_extract(payload,'$.role') role,
           coalesce(json_extract(payload,'$.eventKind'),'message') eventKind,
           json_extract(payload,'$.content') content
    from canonical_events
    where person_id = ?
      and (occurred_at, native_sequence, id) > (?, ?, ?)
    order by occurred_at, native_sequence, id
    limit ?`);

  const baseline = new Pass();
  const hygiene = new Pass();
  const convOnly = new Pass();
  const recommended = new Pass();
  const classCounts: Record<Klass, number> = { conversational: 0, tool_activity: 0, synthetic_injected: 0 };
  const ruleCounts = new Map<string, number>();
  let pendingTools: { names: string[]; occurredAt: string; role: string; id: string; content: string } | null = null;
  let total = 0;
  let isolatedSingles = 0;
  let collapsedRuns = 0;
  let collapsedEvents = 0;
  let cursor = { occurredAt: "", nativeSequence: -1, id: "" };

  const flushTools = (): void => {
    if (!pendingTools) return;
    if (pendingTools.names.length === 1) {
      isolatedSingles += 1;
      hygiene.observe(pendingTools.content, pendingTools.role, pendingTools.occurredAt, pendingTools.id);
      recommended.observeContentOnly(pendingTools.content);
    } else {
      collapsedRuns += 1;
      collapsedEvents += pendingTools.names.length;
      hygiene.observe(collapseText(pendingTools.names), "assistant", pendingTools.occurredAt, pendingTools.id);
      recommended.observeContentOnly(collapseText(pendingTools.names));
    }
    pendingTools = null;
  };

  for (;;) {
    const rows = select.all(PERSON, cursor.occurredAt, cursor.nativeSequence, cursor.id, PAGE) as Row[];
    if (rows.length === 0) break;

    for (const row of rows) {
      total += 1;
      const content = row.content ?? "";
      baseline.observe(content, row.role, row.occurredAt, row.id);

      const { klass, rule } = classify({ ...row, content });
      classCounts[klass] += 1;
      if (rule) ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1);

      if (klass === "synthetic_injected") continue;
      if (klass === "tool_activity") {
        if (pendingTools) pendingTools.names.push(toolNameOf(content));
        else pendingTools = { names: [toolNameOf(content)], occurredAt: row.occurredAt, role: row.role, id: row.id, content };
        continue;
      }
      flushTools();
      hygiene.observe(content, row.role, row.occurredAt, row.id);
      convOnly.observe(content, row.role, row.occurredAt, row.id);
      recommended.observe(content, row.role, row.occurredAt, row.id);
    }

    const last = rows[rows.length - 1];
    cursor = { occurredAt: last.occurredAt, nativeSequence: last.nativeSequence, id: last.id };
    process.stderr.write(`  …${total.toLocaleString()} events\n`);
  }

  flushTools();
  baseline.flush();
  convOnly.flush();
  recommended.flush();
  hygiene.flush();
  db.close();

  const pct = (n: number, d: number): string => `${((n / d) * 100).toFixed(1)}%`;
  const mb = (chars: number): string => `${(chars / 1_048_576).toFixed(1)} MB`;

  console.log(`\nHygiene rule version: ${HYGIENE_RULE_VERSION}`);
  console.log(`Note: silent-sentinel and structured-json-emission (assistant-role rules) are new`);
  console.log(`since the 2026-07-26 measurement and will shift these numbers vs. that baseline.`);
  console.log(`\n=== Corpus (${total.toLocaleString()} events) ===`);
  for (const [k, v] of Object.entries(classCounts)) {
    console.log(`  ${k.padEnd(20)} ${v.toLocaleString().padStart(9)}  ${pct(v, total)}`);
  }
  console.log(`\n=== Synthetic rule hits ===`);
  for (const [rule, n] of [...ruleCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rule.padEnd(28)} ${n.toLocaleString().padStart(8)}`);
  }
  console.log(`\n=== Summaries ===`);
  console.log(`  baseline   ${baseline.summaries.toLocaleString().padStart(9)}  ${mb(baseline.chars).padStart(10)}  tool-text: ${baseline.toolTextSummaries.toLocaleString()} (${pct(baseline.toolTextSummaries, baseline.summaries)})`);
  console.log(`  hygiene    ${hygiene.summaries.toLocaleString().padStart(9)}  ${mb(hygiene.chars).padStart(10)}  tool-text: ${hygiene.toolTextSummaries.toLocaleString()} (${pct(hygiene.toolTextSummaries, Math.max(1, hygiene.summaries))})`);
  console.log(`  conv-only  ${convOnly.summaries.toLocaleString().padStart(9)}  ${mb(convOnly.chars).padStart(10)}  (tool activity never drives topic labels)`);
  console.log(`  RECOMMENDED${recommended.summaries.toLocaleString().padStart(8)}  ${mb(recommended.chars).padStart(10)}  tool-text: ${recommended.toolTextSummaries.toLocaleString()} (collapse + singles as content, never labels)`);
  console.log(`\n  tool runs collapsed: ${collapsedRuns.toLocaleString()} runs covering ${collapsedEvents.toLocaleString()} events; isolated singles kept verbatim: ${isolatedSingles.toLocaleString()}`);
  console.log(`\n  summary count   ${pct(hygiene.summaries, baseline.summaries)} of baseline  (${(baseline.summaries - hygiene.summaries).toLocaleString()} fewer)`);
  console.log(`  summary volume  ${pct(hygiene.chars, baseline.chars)} of baseline  (${mb(baseline.chars - hygiene.chars)} less)`);
  console.log(`\n  RECOMMENDED: count ${pct(recommended.summaries, baseline.summaries)} of baseline, volume ${pct(recommended.chars, baseline.chars)} of baseline`);
};

await main();
