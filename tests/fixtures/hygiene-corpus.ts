/**
 * Deterministic CI-safe synthetic corpus generator for Phase 11 Plan 06 (REQ-052/053/054).
 *
 * Produces a `CanonicalEvent[]` at the measured 11-MEASUREMENT.md class proportions —
 * 63.8% `tool_activity`, 29.5% `conversational`, 6.7% `synthetic_injected` — arranged so
 * roughly half the tool-activity events sit in runs of >=2 consecutive events (collapsed by
 * hygiene into one activity line) and the rest are isolated singles (kept verbatim), while
 * conversational content rotates through disjoint vocabularies so `TopicMonitor.isTopicChange`
 * (zero-significant-word-overlap) actually fires between unrelated topics and stays quiet
 * within one topic.
 *
 * Pure and deterministic: a seeded LCG only (no `Math.random`, no `Date.now`, no host I/O).
 * The same `(eventCount, seed)` always produces a byte-identical array.
 */

import type { CanonicalEvent } from "../../src/domain/canonical.js";

export interface HygieneCorpusOptions {
  /** Total number of canonical events to generate. */
  eventCount: number;
  /** Seed for the internal deterministic LCG. */
  seed: number;
  /** Optional person/scope/source overrides; defaults are fixture-local constants. */
  personId?: string;
  sourceId?: string;
  scopeId?: string;
}

export interface HygieneCorpusResult {
  events: CanonicalEvent[];
  /** Measured composition of the generated corpus, for assertions/logging. */
  composition: {
    toolActivity: number;
    conversational: number;
    syntheticInjected: number;
    toolRunCount: number;
    toolRunEventCount: number;
    toolSingleCount: number;
  };
}

const BASE_TIME_MS = Date.parse("2026-01-01T00:00:00.000Z");

/** A small deterministic LCG (Numerical Recipes constants) — never `Math.random`. */
function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const CONV_BUCKETS: readonly string[][] = [
  ["kayak", "river", "paddle", "current", "rapids", "gear"],
  ["sourdough", "starter", "flour", "hydration", "bake", "crust"],
  ["telescope", "aperture", "nebula", "eyepiece", "tripod", "magnitude"],
  ["violin", "rosin", "bowing", "vibrato", "fingerboard", "scale"],
  ["greenhouse", "compost", "irrigation", "trellis", "seedling", "mulch"],
  ["glacier", "crevasse", "moraine", "icefall", "cairn", "altimeter"],
  ["ceramics", "glaze", "kiln", "stoneware", "slip", "bisque"],
  ["orienteering", "compass", "bearing", "contour", "waypoint", "pace"],
  ["falconry", "jesses", "mews", "hood", "talon", "mantling"],
  ["cartography", "projection", "datum", "meridian", "legend", "scale"]
];

const TOOL_NAMES = ["Bash", "Read", "Edit", "Grep", "Write"] as const;

/** Fair-share interleave: merges group arrays proportionally to their relative sizes. */
function interleaveByCount<T>(groups: readonly T[][]): T[] {
  const totals = groups.map((group) => group.length);
  const totalAll = totals.reduce((sum, count) => sum + count, 0);
  const consumed = groups.map(() => 0);
  const result: T[] = [];

  for (let i = 0; i < totalAll; i += 1) {
    let bestGroup = -1;
    let bestScore = -Infinity;
    for (let g = 0; g < groups.length; g += 1) {
      if (consumed[g]! >= totals[g]!) continue;
      const score = (i * totals[g]!) / totalAll - consumed[g]!;
      if (score > bestScore) {
        bestScore = score;
        bestGroup = g;
      }
    }
    result.push(groups[bestGroup]![consumed[bestGroup]!]!);
    consumed[bestGroup] += 1;
  }

  return result;
}

type FillerUnit =
  | { kind: "tool_run"; length: number }
  | { kind: "tool_single" }
  | { kind: "synthetic" };

/**
 * Deterministically builds a proportional synthetic corpus matching the measured Phase 11
 * class shares. See module docstring for the shape guarantees.
 */
export function buildHygieneCorpus(options: HygieneCorpusOptions): HygieneCorpusResult {
  const { eventCount, seed } = options;
  const personId = options.personId ?? "person_hygiene_corpus";
  const sourceId = options.sourceId ?? `source_${personId}`;
  const scopeId = options.scopeId ?? "scope_hygiene_corpus";

  const rand = makeLcg(seed);

  const toolCount = Math.round(eventCount * 0.638);
  const convCount = Math.round(eventCount * 0.295);
  const synthCount = eventCount - toolCount - convCount;

  // "Roughly half the tool events sit in runs of >=2 ... the rest are isolated singles" (11-06-PLAN Task 1).
  const toolRunEventCount = Math.round(toolCount / 2);
  const toolSingleCount = toolCount - toolRunEventCount;

  const runLengths: number[] = [];
  {
    let remaining = toolRunEventCount;
    while (remaining > 0) {
      let length = Math.min(remaining, 2 + Math.floor(rand() * 5)); // 2..6
      if (remaining - length === 1) length = remaining; // never strand a dangling single as a "run"
      runLengths.push(length);
      remaining -= length;
    }
  }

  const runUnits: FillerUnit[] = runLengths.map((length) => ({ kind: "tool_run", length }));
  const singleUnits: FillerUnit[] = Array.from({ length: toolSingleCount }, () => ({ kind: "tool_single" }));
  const synthUnits: FillerUnit[] = Array.from({ length: synthCount }, () => ({ kind: "synthetic" }));
  const fillerUnits = interleaveByCount([runUnits, singleUnits, synthUnits]);

  const events: CanonicalEvent[] = [];
  let sequence = 0;
  let minuteOffset = 0;
  let toolOrdinal = 0;
  let synthOrdinal = 0;
  let convGroupIndex = 0;
  let convInGroup = 0;
  let convGroupTarget = 3 + Math.floor(rand() * 3); // 3..5 messages per bucket before rotating
  let convOrdinal = 0;

  const push = (partial: {
    idPrefix: string;
    content: string;
    role: CanonicalEvent["role"];
    eventKind?: CanonicalEvent["eventKind"];
  }): void => {
    const id = `${partial.idPrefix}-${sequence}`;
    const occurredAt = new Date(BASE_TIME_MS + minuteOffset * 60_000).toISOString();
    events.push({
      id,
      personId,
      sourceId,
      sourceApplication: "synthetic",
      sourceProfileId: "default",
      scopeId,
      nativeSessionId: "session-hygiene-corpus",
      nativeEventId: id,
      nativeSequence: sequence,
      causalParentId: null,
      eventKind: partial.eventKind,
      role: partial.role,
      content: partial.content,
      occurredAt,
      importedAt: occurredAt,
      provenance: partial.role === "user" ? "direct_user_input" : "assistant_output",
      trustLevel: partial.role === "user" ? "high" : "medium",
      contentHash: `hash-${id}`,
      parserVersion: "hygiene-corpus/v1",
      metadata: {}
    });
    sequence += 1;
    minuteOffset += 1;
  };

  const emitConversational = (): void => {
    if (convInGroup >= convGroupTarget) {
      convGroupIndex += 1;
      convInGroup = 0;
      convGroupTarget = 3 + Math.floor(rand() * 3);
    }
    const bucket = CONV_BUCKETS[convGroupIndex % CONV_BUCKETS.length]!;
    convInGroup += 1;
    convOrdinal += 1;
    const role: CanonicalEvent["role"] = convOrdinal % 2 === 0 ? "assistant" : "user";
    // The topic label comes from `extractTopicLabel`'s first six significant (non-stopword,
    // length>2) keywords, so the content leads with the six bucket words and never uses any of
    // the "explicit topic" trigger phrases ("let's talk", "discuss", "switch to", "resume") that
    // would instead capture a long free-text span full of shared connector words ("session",
    // "note", "continuing") — which would overlap across buckets and defeat isTopicChange's
    // zero-word-overlap rule.
    push({
      idPrefix: "conv",
      role,
      content: `${bucket.join(" ")} session note ${convGroupIndex}.${convInGroup} covering ${bucket[0]} plans.`
    });
  };

  const emitToolEvent = (runLabel: string): void => {
    toolOrdinal += 1;
    const name = TOOL_NAMES[toolOrdinal % TOOL_NAMES.length]!;
    // Plain-text argument payload (never a bare JSON object) so a stripped/relabeled copy of
    // this content can never accidentally match the assistant-role structured-json-emission
    // synthetic rule in derivation-hygiene.ts.
    const payload = `argument payload for ${runLabel} invocation ${toolOrdinal} carrying representative filler text of realistic tool-call length so volume differences are measurable across many runs`;
    push({
      idPrefix: "tool",
      role: "assistant",
      eventKind: "tool_call",
      content: `[Tool call: ${name}] ${payload}`
    });
  };

  const emitSynthetic = (): void => {
    synthOrdinal += 1;
    const templates = [
      `[SYSTEM: harness scaffolding directive #${synthOrdinal} configuring the automated environment for this turn, padded with additional operational detail so its payload length is realistic]`,
      `[cron:${synthOrdinal}] scheduled housekeeping session tag injected by the automation harness with extra descriptive filler text mirroring a realistic cron payload size`
    ];
    const content = templates[synthOrdinal % templates.length]!;
    push({ idPrefix: "synth", role: "user", content });
  };

  const convPerFillerBase = Math.floor(convCount / Math.max(1, fillerUnits.length));
  let convRemainder = convCount - convPerFillerBase * fillerUnits.length;
  let convEmitted = 0;

  for (const unit of fillerUnits) {
    let toEmit = convPerFillerBase;
    if (convRemainder > 0) {
      toEmit += 1;
      convRemainder -= 1;
    }
    for (let i = 0; i < toEmit; i += 1) {
      emitConversational();
      convEmitted += 1;
    }

    if (unit.kind === "tool_run") {
      const runLabel = `run-${sequence}`;
      for (let i = 0; i < unit.length; i += 1) emitToolEvent(runLabel);
    } else if (unit.kind === "tool_single") {
      emitToolEvent("single");
    } else {
      emitSynthetic();
    }
  }

  while (convEmitted < convCount) {
    emitConversational();
    convEmitted += 1;
  }

  return {
    events,
    composition: {
      toolActivity: toolCount,
      conversational: convCount,
      syntheticInjected: synthCount,
      toolRunCount: runLengths.length,
      toolRunEventCount,
      toolSingleCount
    }
  };
}
