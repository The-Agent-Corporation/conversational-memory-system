import type { ConversationTurnEvent } from "../domain/events.js";
import type { JsonObject } from "../domain/types.js";

const MAX_ARGUMENT_SUMMARY_LENGTH = 2_000;

export interface ToolCallDescriptor {
  id?: string;
  name: string;
  arguments?: unknown;
}

interface ToolCallEventInput {
  call: ToolCallDescriptor;
  fallbackId: string;
  host: ConversationTurnEvent["host"];
  profileId: string;
  sessionId: string;
  sequence: number;
  createdAt: string;
  parentId?: string | null;
  metadata: JsonObject;
  sanitizeContent: (content: string) => string;
}

export function createToolCallEvent(input: ToolCallEventInput): ConversationTurnEvent {
  const nativeEventId = input.call.id ?? input.fallbackId;
  const argumentSummary = summarizeArguments(input.call.arguments, input.sanitizeContent);
  return {
    id: nativeEventId,
    nativeEventId,
    host: input.host,
    profileId: input.profileId,
    hostSessionId: input.sessionId,
    sequence: input.sequence,
    type: "conversation_turn",
    eventKind: "tool_call",
    role: "assistant",
    content: argumentSummary === null
      ? `[Tool call: ${input.call.name}]`
      : `[Tool call: ${input.call.name}] ${argumentSummary}`,
    createdAt: input.createdAt,
    nativeParentEventId: input.parentId ?? null,
    metadata: {
      ...input.metadata,
      eventKind: "tool_call",
      toolName: input.call.name,
      ...(input.call.id ? { toolCallId: input.call.id } : {})
    }
  };
}

export function extractToolCalls(content: unknown): ToolCallDescriptor[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    const block = asObject(value);
    if (!block || (block.type !== "tool_use" && block.type !== "toolCall" && block.type !== "tool_call")) {
      return [];
    }
    const name = typeof block.name === "string" ? block.name : null;
    if (!name) return [];
    return [{
      ...(typeof block.id === "string" ? { id: block.id } : {}),
      name,
      arguments: block.input ?? block.arguments ?? block.args
    }];
  });
}

export function parseSerializedToolCalls(value: unknown): ToolCallDescriptor[] {
  if (value === null || value === undefined || value === "") return [];
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((value) => {
    const call = asObject(value);
    if (!call) return [];
    const fn = asObject(call.function);
    const name = typeof call.name === "string"
      ? call.name
      : typeof fn?.name === "string" ? fn.name : null;
    if (!name) return [];
    return [{
      ...(typeof call.id === "string" ? { id: call.id } : {}),
      name,
      arguments: call.arguments ?? fn?.arguments ?? call.input
    }];
  });
}

export function serializedToolCallsAreMalformed(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return true;
    }
  }
  if (!Array.isArray(parsed)) return true;
  return parsed.some((value) => {
    const call = asObject(value);
    if (!call) return true;
    const fn = asObject(call.function);
    return typeof call.name !== "string" && typeof fn?.name !== "string";
  });
}

function summarizeArguments(
  value: unknown,
  sanitizeContent: (content: string) => string
): string | null {
  if (value === undefined || value === null || value === "") return null;
  let serialized: string;
  if (typeof value === "string") {
    serialized = normalizeJsonString(value);
  } else {
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = String(value);
    }
  }
  const sanitized = sanitizeContent(serialized);
  return sanitized.length <= MAX_ARGUMENT_SUMMARY_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_ARGUMENT_SUMMARY_LENGTH)}...[truncated]`;
}

function normalizeJsonString(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
