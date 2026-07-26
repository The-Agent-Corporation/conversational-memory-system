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
 */

export const HYGIENE_RULE_VERSION = "hygiene-rules/v1";

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

/** Deterministic, anchored rules. Conservative: unmatched stays conversational. */
export const SYNTHETIC_RULES: readonly SyntheticRule[] = [
  { id: "skill-invocation", test: (c) => c.startsWith("[IMPORTANT: The user has invoked") },
  { id: "harness-system", test: (c) => c.startsWith("[SYSTEM:") },
  { id: "cron-session-tag", test: (c) => c.startsWith("[cron:") },
  { id: "automated-followup", test: (c) => c.startsWith("### Task:") && c.includes("follow-up questions") },
  { id: "automated-task-block", test: (c) => c.startsWith("### Task:") },
  { id: "skill-body-injection", test: (c) => c.startsWith("Base directory for this skill:") },
  { id: "context-compaction", test: (c) => c.startsWith("[CONTEXT COMPACTION") },
  { id: "session-continuation", test: (c) => c.startsWith("This session is being continued from a previous conversation") },
  { id: "local-command-stdout", test: (c) => c.startsWith("<local-command-stdout>") },
  { id: "system-reminder-only", test: (c) => c.startsWith("<system-reminder>") },
  { id: "city-harness-preamble", test: (c) => /^\[[a-z0-9-]+-city\]\s+\S+\s+•\s+20\d\d-/.test(c) },
  // Confirmed 2026-07-26 (11-CONTEXT.md), NOT part of the measured 55,930/77.6MB run —
  // the Plan 06 sim re-run reports the shifted numbers with these included.
  { id: "silent-sentinel", test: (c) => c.startsWith("[SILENT]"), roles: ["assistant"] },
  { id: "structured-json-emission", test: (c) => isBareJsonObject(c), roles: ["assistant"] }
];

const TOOL_CALL_PREFIX = "[Tool call: ";
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
 * summarization: synthetic dropped, a run of >=2 consecutive tool_activity events
 * emitted as ONE `collapseText(...)` entry at the run's first index, an isolated
 * tool event emitted verbatim at its own index, conversational emitted verbatim.
 */
export const derivationContents = (events: readonly ClassifiableEvent[]): DerivationContentEntry[] => {
  const segments = computeSegments(events);
  return segments.map((segment) => {
    if (segment.kind === "conversational") return { index: segment.index, content: segment.content };
    if (segment.entries.length === 1) return segment.entries[0];
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
