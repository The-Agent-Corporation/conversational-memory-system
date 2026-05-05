import type { HostEvent, ConversationTurnEvent } from "../domain/events.js";
import type { TurnRange } from "../domain/types.js";

export interface RollingTopicState {
  host: string;
  profileId: string;
  hostSessionId: string;
  topicLabel: string;
  currentTopicSummary: string;
  sourceTurnRange: TurnRange;
  turnCount: number;
  lastEventId: string;
  updatedAt: string;
}

export interface CompletedTopicSpan extends RollingTopicState {
  completedAt: string;
}

export interface TopicMonitorResult {
  current: RollingTopicState | null;
  topicChanged: boolean;
  completed: CompletedTopicSpan | null;
}

export class TopicMonitor {
  private readonly states = new Map<string, RollingTopicState>();

  observe(event: HostEvent): TopicMonitorResult {
    if (event.type === "control_signal") {
      return {
        current: this.states.get(event.hostSessionId) ?? null,
        topicChanged: false,
        completed: null
      };
    }

    const topicLabel = extractTopicLabel(event);
    const existing = this.states.get(event.hostSessionId);

    if (!existing) {
      const current = createTopicState(event, topicLabel);
      this.states.set(event.hostSessionId, current);

      return { current, topicChanged: false, completed: null };
    }

    if (isTopicChange(existing.topicLabel, topicLabel)) {
      const completed: CompletedTopicSpan = {
        ...existing,
        completedAt: event.createdAt
      };
      const current = createTopicState(event, topicLabel);
      this.states.set(event.hostSessionId, current);

      return { current, topicChanged: true, completed };
    }

    const current = extendTopicState(existing, event);
    this.states.set(event.hostSessionId, current);

    return { current, topicChanged: false, completed: null };
  }

  current(hostSessionId: string): RollingTopicState | null {
    return this.states.get(hostSessionId) ?? null;
  }
}

function createTopicState(event: ConversationTurnEvent, topicLabel: string): RollingTopicState {
  return {
    host: event.host,
    profileId: event.profileId,
    hostSessionId: event.hostSessionId,
    topicLabel,
    currentTopicSummary: summarizeTopic(topicLabel, 1, event.sequence, event.sequence),
    sourceTurnRange: {
      threadId: event.hostSessionId,
      startSequence: event.sequence,
      endSequence: event.sequence
    },
    turnCount: 1,
    lastEventId: event.id,
    updatedAt: event.createdAt
  };
}

function extendTopicState(existing: RollingTopicState, event: ConversationTurnEvent): RollingTopicState {
  const startSequence = Math.min(existing.sourceTurnRange.startSequence, event.sequence);
  const endSequence = Math.max(existing.sourceTurnRange.endSequence, event.sequence);
  const turnCount = existing.turnCount + 1;

  return {
    ...existing,
    currentTopicSummary: summarizeTopic(existing.topicLabel, turnCount, startSequence, endSequence),
    sourceTurnRange: {
      threadId: existing.hostSessionId,
      startSequence,
      endSequence
    },
    turnCount,
    lastEventId: event.id,
    updatedAt: event.createdAt
  };
}

function summarizeTopic(
  topicLabel: string,
  turnCount: number,
  startSequence: number,
  endSequence: number
): string {
  return `${topicLabel} (${turnCount} turn${turnCount === 1 ? "" : "s"}, seq ${startSequence}-${endSequence})`;
}

function extractTopicLabel(event: ConversationTurnEvent): string {
  const explicitTopic = extractExplicitTopic(event.content);

  if (explicitTopic) {
    return explicitTopic;
  }

  const keywords = event.content
    .replace(/['"]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 2)
    .filter((word) => !STOP_WORDS.has(word.toLowerCase()))
    .slice(0, 6);

  if (keywords.length === 0) {
    return "general conversation";
  }

  return titleCase(keywords.join(" "));
}

function extractExplicitTopic(content: string): string | null {
  const patterns = [
    /\b(?:let'?s|lets)\s+(?:talk|discuss)\s+(?:about\s+)?([^.!?\n]{3,90})/i,
    /\b(?:talk(?:ing)?|discuss)\s+(?:about\s+)?([^.!?\n]{3,90})/i,
    /\b(?:switch(?:ing)?(?:\s+over)?|move(?:ing)?|now)\s+(?:to|about|on)\s+([^.!?\n]{3,90})/i,
    /\bresume\s+(?:the\s+)?([^.!?\n]{3,90})/i
  ];
  const match = patterns.map((pattern) => content.match(pattern)).find(Boolean);

  if (!match) {
    return null;
  }

  return titleCase(match[1].trim().replace(/\s+/g, " "));
}

function isTopicChange(currentTopicLabel: string, nextTopicLabel: string): boolean {
  if (currentTopicLabel === nextTopicLabel) {
    return false;
  }

  const currentWords = significantWords(currentTopicLabel);
  const nextWords = significantWords(nextTopicLabel);

  if (currentWords.size === 0 || nextWords.size === 0) {
    return false;
  }

  return intersectionSize(currentWords, nextWords) === 0;
}

function significantWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2)
      .filter((word) => !STOP_WORDS.has(word))
  );
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;

  for (const value of left) {
    if (right.has(value)) {
      count += 1;
    }
  }

  return count;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const STOP_WORDS = new Set([
  "about",
  "again",
  "analysis",
  "and",
  "are",
  "can",
  "coverage",
  "discuss",
  "for",
  "from",
  "have",
  "into",
  "lets",
  "our",
  "please",
  "resume",
  "switch",
  "talk",
  "that",
  "the",
  "this",
  "with"
]);
