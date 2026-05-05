import type { Anchor, Turn } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface AnchorDetectionResult {
  anchors: Anchor[];
}

export class AnchorDetector {
  constructor(private readonly store: MemoryStore) {}

  async detectForTurn(turn: Turn): Promise<AnchorDetectionResult> {
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
  return {
    id: `anchor_${turn.id}_${anchorType}`,
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
