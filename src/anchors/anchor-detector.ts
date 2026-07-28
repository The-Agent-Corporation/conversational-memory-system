import type { Anchor, Turn } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { drivesTopicLabel } from "../topic/derivation-hygiene.js";

export interface AnchorDetectionResult {
  anchors: Anchor[];
}

export interface AnchorDetectionOptions {
  /**
   * The originating canonical event's `eventKind`, when the caller has it. `Turn` deliberately does
   * not carry one (GAP-11-G), so this is how a caller that DOES know hands the missing third
   * classification input to the gate. Omitted or `null` reproduces the pre-11-27 behavior exactly.
   */
  eventKind?: string | null;
}

/**
 * The ONE anchor minter (GAP-11-G). It applies the hygiene gate and returns the anchors a turn
 * earns, without touching a store — so the streaming caller (`AnchorDetector`, which saves one at a
 * time) and the batching caller (`ContractionRunner`, which hands a slice's anchors to
 * `commitContractionSlice`) share a single implementation instead of two copies of the same five
 * regexes. Until this plan there were two, and only this one was gated: `contraction-runner.ts` had
 * its own local `anchorsForTurn` that never imported `AnchorDetector`, so the GAP-11-D forward gate
 * applied to the live Hermes bridge and to nothing else. That is what let a rebuild regenerate 1,330
 * of the anchors Plan 11-18 deleted (11-REBUILD.md).
 *
 * GAP-11-D: anchors are a derivation over turn content, so they answer to the same hygiene
 * classifier as topic labeling and contraction. Without this gate `buildAnchor` stored `turn.content`
 * verbatim, so a `[Tool call: Write] {...}` turn whose argument payload happened to contain planning
 * prose ("decided", "because", "strategy") minted high-scoring anchors that then outranked hygienic
 * summary text in prepareInjection.
 *
 * GAP-11-G: the gate used to classify on content + role ONLY, while `commitUnhygienicAnchorPrune`
 * classifies on content + eventKind + role. That made the prune's inputs a strict SUPERSET of the
 * gate's, which is safe in one direction (the prune can never retain what the gate refused) and
 * unsafe in the other: a `tool_call`-kind event whose content merely CONTAINS `[Tool call: `
 * classified `tool_activity` for the prune and `conversational` for the gate, so the gate minted
 * anchors the prune would delete. Forwarding `eventKind` when the caller has it closes that converse.
 * When no eventKind is supplied the classification inputs are unchanged, so callers that never had
 * the information behave exactly as before.
 */
export function anchorsForTurn(turn: Turn, options: AnchorDetectionOptions = {}): Anchor[] {
  if (!drivesTopicLabel({ content: turn.content, eventKind: options.eventKind, role: turn.role })) {
    return [];
  }
  return detectAnchorTypes(turn.content).map((anchorType) => buildAnchor(turn, anchorType));
}

export class AnchorDetector {
  constructor(private readonly store: MemoryStore) {}

  async detectForTurn(turn: Turn, options: AnchorDetectionOptions = {}): Promise<AnchorDetectionResult> {
    const anchors = anchorsForTurn(turn, options);

    for (const anchor of anchors) {
      await this.store.saveAnchor(anchor);
    }

    return { anchors };
  }
}

function detectAnchorTypes(content: string): Anchor["anchorType"][] {
  const normalized = content.toLowerCase();
  const types: Anchor["anchorType"][] = [];

  if (/\b(deadline|due|expires?|statute|limitations?|calendar|hearing|trial|deposition)\b/.test(normalized)) {
    types.push("deadline");
  }

  if (/\b(decided|decision|we will|we should|strategy is|approved|rejected|agreed)\b/.test(normalized)) {
    types.push("decision");
  }

  if (/\b(key fact|fact is|confirmed|undisputed|liability|coverage limit|policy limit|pip|bodily injury)\b/.test(normalized)) {
    types.push("key_fact");
  }

  if (/\b(strategy|leverage|risk|lesson|insight|because|therefore)\b/.test(normalized)) {
    types.push("strategic_insight");
  }

  if (/\b(bookmark|remember this|save this|come back to this)\b/.test(normalized)) {
    types.push("bookmark");
  }

  return [...new Set(types)];
}

function buildAnchor(turn: Turn, anchorType: Anchor["anchorType"]): Anchor {
  const personId = stringMetadata(turn, "personId");
  const canonicalEventId = stringMetadata(turn, "canonicalEventId");
  const scopeId = stringMetadata(turn, "scopeId");
  return {
    id: `anchor_${turn.id}_${anchorType}`,
    ...(personId ? { personId } : {}),
    ...(canonicalEventId ? { canonicalEventId } : {}),
    ...(scopeId ? { scopeId } : {}),
    turnId: turn.id,
    threadId: turn.threadId,
    boxId: null,
    anchorType,
    content: turn.content,
    embedding: null,
    createdAt: turn.createdAt,
    trustLevel: turn.trustLevel,
    source: turn.provenance
  };
}

function stringMetadata(turn: Turn, key: string): string | null {
  const value = turn.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
