/**
 * Derivation input hygiene (REQ-052, REQ-053).
 *
 * The ONE shared, pure, deterministic module that classifies a canonical event / turn
 * into `conversational | tool_activity | synthetic_injected` and turns an ordered window
 * of events into the derivation content that feeds summarization.
 *
 * Pure: no store, no wall-clock reads, no network, no randomness. A pure function of
 * (content, eventKind, role) — classification is recomputed on demand rather than
 * persisted per event, mirroring how `parserVersion` already works for importers.
 *
 * Promoted (rule table, toolNameOf, collapseText) verbatim from the measured
 * `11-hygiene-sim.ts` prototype so output stays comparable to the 55,930-summary /
 * 77.6 MB targets, then extended with the two assistant-role rules confirmed in
 * 11-CONTEXT.md (`silent-sentinel`, `structured-json-emission`) — these two were NOT
 * part of the 2026-07-26 measured run; the manual sim re-run (Plan 06) reports the
 * shifted numbers.
 *
 * Plan 11-20 (rule version bumped to v2): added `task-notification` and `local-command-caveat`,
 * both counted `add-rule` verdicts from a full census of the live 292,407-event corpus —
 * see `.planning/phases/11-derivation-input-hygiene/11-SCAFFOLD-AUDIT.md` and ADR 0048's
 * addendum. The version bump marks every existing contraction checkpoint stale via
 * `PROCESSOR_VERSION` (src/daemon/contraction-runner.ts), per REQ-054.
 */

export const HYGIENE_RULE_VERSION = "hygiene-rules/v3";

export type DerivationClass = "conversational" | "tool_activity" | "synthetic_injected";

/** Accepts both `CanonicalEvent` (has `eventKind`) and `Turn` (does not) without adapters. */
export interface ClassifiableEvent {
  content: string;
  eventKind?: string | null;
  role?: string | null;
}

export interface ClassificationResult {
  derivationClass: DerivationClass;
  ruleId: string | null;
  ruleVersion: string;
}

interface SyntheticRule {
  id: string;
  test: (trimmedContent: string) => boolean;
  /** When present, the rule only fires for events with one of these roles. */
  roles?: readonly string[];
}

const isBareJsonObject = (content: string): boolean => {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
};

/**
 * Literal `startsWith` prefixes of the literal-prefix rules below, exported so a consumer (the
 * Plan 11-19 recall probe) can classify against the SAME markers the rules use instead of
 * hand-rolling a second, driftable pattern list (T-11-60). `city-harness-preamble` (regex) and
 * `structured-json-emission` (JSON.parse) have no literal prefix and are deliberately absent —
 * see the exhaustiveness test in derivation-hygiene.test.ts.
 */
export const SYNTHETIC_MARKERS: readonly { ruleId: string; marker: string }[] = [
  { ruleId: "skill-invocation", marker: "[IMPORTANT: The user has invoked" },
  { ruleId: "harness-system", marker: "[SYSTEM:" },
  { ruleId: "cron-session-tag", marker: "[cron:" },
  { ruleId: "automated-followup", marker: "### Task: follow-up questions" },
  { ruleId: "automated-task-block", marker: "### Task:" },
  { ruleId: "skill-body-injection", marker: "Base directory for this skill:" },
  { ruleId: "context-compaction", marker: "[CONTEXT COMPACTION" },
  { ruleId: "session-continuation", marker: "This session is being continued from a previous conversation" },
  { ruleId: "local-command-stdout", marker: "<local-command-stdout>" },
  { ruleId: "system-reminder-only", marker: "<system-reminder>" },
  { ruleId: "silent-sentinel", marker: "[SILENT]" },
  // Plan 11-20 (11-SCAFFOLD-AUDIT.md): counted census of the live corpus against 292,407
  // events. Both are anchored literal prefixes with an `add-rule` verdict.
  { ruleId: "task-notification", marker: "<task-notification>" },
  { ruleId: "local-command-caveat", marker: "<local-command-caveat>" }
];

/** Looks up a registered marker by rule id, so rule.test bodies never re-type the literal. */
const markerFor = (ruleId: string): string => {
  const entry = SYNTHETIC_MARKERS.find((m) => m.ruleId === ruleId);
  if (!entry) {
    throw new Error(`No SYNTHETIC_MARKERS entry registered for rule "${ruleId}"`);
  }
  return entry.marker;
};

/**
 * Plan 11-24 (GAP-11-E, hypothesis H-i): true if `content` begins with `marker`, or `marker`
 * begins some LATER LINE within `content` — i.e. the marker occupies the start of its own line,
 * not merely appears somewhere inside a sentence.
 *
 * Every literal-prefix rule below used to be a bare `content.startsWith(marker)`, so a scaffolding
 * block embedded mid-event (harness text prepended/appended to real content within the same event)
 * was invisible unless it happened to open the event. Widening this to an unanchored substring scan
 * (`content.includes(marker)`) was considered and rejected: 11-GAP-11-E-FINDING.md traced two
 * offenders where `[SILENT]` appeared inside a markdown table cell, mid-sentence, as the assistant
 * *discussing* the marker as a design concept — not emitting one — and a bare `includes()` would
 * misclassify that conversational prose as scaffolding, exactly the false positive this phase's
 * conservative anchoring exists to prevent.
 *
 * Line-start anchoring is the narrower, evidence-grounded middle ground: it generalizes the SAME
 * discriminator the H-iii offenders already prove is real (a marker occupying the ENTIRE content of
 * its own dedicated event) to a marker occupying its own line inside a larger event, while a marker
 * quoted inline within running prose — never at a line's own start — still reads as conversational.
 */
const matchesEmbedded = (content: string, marker: string): boolean =>
  content.split("\n").some((line) => line.trimStart().startsWith(marker));

/** Deterministic, line-anchored rules. Conservative: unmatched stays conversational. */
export const SYNTHETIC_RULES: readonly SyntheticRule[] = [
  { id: "skill-invocation", test: (c) => matchesEmbedded(c, markerFor("skill-invocation")) },
  { id: "harness-system", test: (c) => matchesEmbedded(c, markerFor("harness-system")) },
  { id: "cron-session-tag", test: (c) => matchesEmbedded(c, markerFor("cron-session-tag")) },
  {
    id: "automated-followup",
    test: (c) => matchesEmbedded(c, markerFor("automated-task-block")) && c.includes("follow-up questions")
  },
  { id: "automated-task-block", test: (c) => matchesEmbedded(c, markerFor("automated-task-block")) },
  { id: "skill-body-injection", test: (c) => matchesEmbedded(c, markerFor("skill-body-injection")) },
  { id: "context-compaction", test: (c) => matchesEmbedded(c, markerFor("context-compaction")) },
  { id: "session-continuation", test: (c) => matchesEmbedded(c, markerFor("session-continuation")) },
  { id: "local-command-stdout", test: (c) => matchesEmbedded(c, markerFor("local-command-stdout")) },
  { id: "system-reminder-only", test: (c) => matchesEmbedded(c, markerFor("system-reminder-only")) },
  { id: "city-harness-preamble", test: (c) => /^\[[a-z0-9-]+-city\]\s+\S+\s+•\s+20\d\d-/.test(c) },
  // Confirmed 2026-07-26 (11-CONTEXT.md), NOT part of the measured 55,930/77.6MB run —
  // the Plan 06 sim re-run reports the shifted numbers with these included.
  { id: "silent-sentinel", test: (c) => matchesEmbedded(c, markerFor("silent-sentinel")), roles: ["assistant"] },
  { id: "structured-json-emission", test: (c) => isBareJsonObject(c), roles: ["assistant"] },
  // Plan 11-20: counted census additions, both anchored literal prefixes, no role gate
  // (mirrors local-command-stdout / system-reminder-only). See 11-SCAFFOLD-AUDIT.md.
  { id: "task-notification", test: (c) => matchesEmbedded(c, markerFor("task-notification")) },
  { id: "local-command-caveat", test: (c) => matchesEmbedded(c, markerFor("local-command-caveat")) }
];

export const TOOL_CALL_PREFIX = "[Tool call: ";
const TOOL_NAME = /^\[Tool call:\s*([^\]]+)\]/;

/** Extracts the bracketed tool name from `[Tool call: NAME] {args}` content. */
export const toolNameOf = (content: string): string => TOOL_NAME.exec(content)?.[1]?.trim() ?? "unknown";

/** REQ-052 collapse text: names distinct tools and counts, never arguments. */
export const collapseText = (names: string[]): string => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${n} ${name}`);
  return `[Activity] ran ${names.length} tool calls: ${parts.join(", ")}`;
};

export const classifyEvent = (event: ClassifiableEvent): ClassificationResult => {
  const content = event.content ?? "";
  const eventKind = event.eventKind ?? null;
  const role = event.role ?? null;

  const isToolActivity =
    eventKind === "tool_call" ||
    role === "tool" ||
    (eventKind === null && content.trimStart().startsWith(TOOL_CALL_PREFIX));

  if (isToolActivity) {
    return { derivationClass: "tool_activity", ruleId: null, ruleVersion: HYGIENE_RULE_VERSION };
  }

  const trimmed = content.trimStart();
  for (const rule of SYNTHETIC_RULES) {
    if (rule.roles && (role === null || !rule.roles.includes(role))) continue;
    if (rule.test(trimmed)) {
      return { derivationClass: "synthetic_injected", ruleId: rule.id, ruleVersion: HYGIENE_RULE_VERSION };
    }
  }

  return { derivationClass: "conversational", ruleId: null, ruleVersion: HYGIENE_RULE_VERSION };
};

/** The single predicate every call site uses to decide whether an event reaches topic-label extraction. */
export const drivesTopicLabel = (event: ClassifiableEvent): boolean =>
  classifyEvent(event).derivationClass === "conversational";

export interface DerivationContentEntry {
  index: number;
  content: string;
}

type Segment =
  | { kind: "conversational"; index: number; content: string }
  | { kind: "tool_run"; startIndex: number; entries: DerivationContentEntry[] };

/**
 * Shared synthetic-drop + run-detection walk used by both `derivationContents` and
 * `openToolRunStart` so the two can never disagree about where a run begins.
 * Synthetic events are removed before run detection, so they never split a tool run.
 */
const computeSegments = (events: readonly ClassifiableEvent[]): Segment[] => {
  const segments: Segment[] = [];
  let currentRun: DerivationContentEntry[] = [];

  const flush = (): void => {
    if (currentRun.length > 0) {
      segments.push({ kind: "tool_run", startIndex: currentRun[0].index, entries: currentRun });
      currentRun = [];
    }
  };

  events.forEach((event, index) => {
    const { derivationClass } = classifyEvent(event);
    if (derivationClass === "synthetic_injected") return;
    if (derivationClass === "tool_activity") {
      currentRun.push({ index, content: event.content });
      return;
    }
    flush();
    segments.push({ kind: "conversational", index, content: event.content });
  });
  flush();

  return segments;
};

/**
 * Turns an ordered window of events into the derivation content that feeds
 * summarization: synthetic dropped, every tool_activity run — including an isolated
 * single — collapses to ONE `collapseText(...)` entry at the run's first index,
 * conversational emitted verbatim.
 *
 * Plan 11-24 (GAP-11-E H-0, owner override of ROADMAP SC1 recorded 2026-07-27 in
 * 11-REMEDIATION-DECISION.md): a single isolated tool call USED TO be returned verbatim
 * (`segment.entries.length === 1` short-circuit). SC1 explicitly locked that carve-out
 * during Phase 11 planning; the owner chose to revisit and reverse it rather than
 * accept the isolated-call text as an unfixable residue in injection packets. See
 * ROADMAP.md's Phase 11 SC1 entry (amended in place, original text preserved) and
 * ADR 0048's SC1-reversal addendum for the full rationale.
 */
export const derivationContents = (events: readonly ClassifiableEvent[]): DerivationContentEntry[] => {
  const segments = computeSegments(events);
  return segments.map((segment) => {
    if (segment.kind === "conversational") return { index: segment.index, content: segment.content };
    const names = segment.entries.map((entry) => toolNameOf(entry.content));
    return { index: segment.startIndex, content: collapseText(names) };
  });
};

/**
 * Returns the index of the first event of a trailing tool run that may still be
 * growing, or null when the window does not end inside one — so a caller with more
 * events pending can withhold that run instead of emitting a partial count.
 * Reuses `computeSegments`, the same walk `derivationContents` uses.
 */
export const openToolRunStart = (events: readonly ClassifiableEvent[]): number | null => {
  const segments = computeSegments(events);
  const last = segments[segments.length - 1];
  return last && last.kind === "tool_run" ? last.startIndex : null;
};
