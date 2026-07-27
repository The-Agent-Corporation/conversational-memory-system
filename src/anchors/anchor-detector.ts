import type { Anchor, Turn } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { drivesTopicLabel } from "../topic/derivation-hygiene.js";

export interface AnchorDetectionResult {
  anchors: Anchor[];
}

export class AnchorDetector {
  constructor(private readonly store: MemoryStore) {}

  async detectForTurn(turn: Turn): Promise<AnchorDetectionResult> {
    // GAP-11-D: anchors are a derivation over turn content, so they answer to the same hygiene
    // classifier as topic labeling and contraction. Without this gate `buildAnchor` stored
    // `turn.content` verbatim, so a `[Tool call: Write] {...}` turn whose argument payload happened
    // to contain planning prose ("decided", "because", "strategy") minted high-scoring anchors that
    // then outranked hygienic summary text in prepareInjection. The gate lives here rather than at
    // the call site so every caller inherits it.
    if (!drivesTopicLabel({ content: turn.content, role: turn.role })) {
      return { anchors: [] };
    }

    const anchorTypes = detectAnchorTypes(turn.content);
    const anchors = anchorTypes.map((anchorType) => buildAnchor(turn, anchorType));

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
