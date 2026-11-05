import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { HostNameSchema } from "../../domain/events.js";
import { JsonObjectSchema, RoleSchema } from "../../domain/types.js";
import {
  LiveTurnConflictError,
  LiveTurnHostDeniedError,
  type LiveTurnAppendResult
} from "../live-turn-append.js";
import { createResponseEnvelope } from "../response-envelope.js";

const IdentifierSchema = z.string().trim().min(1).max(512);

export const MemoryAppendTurnInputSchema = z.object({
  host: HostNameSchema,
  hostSessionId: IdentifierSchema,
  turnId: IdentifierSchema,
  sequence: z.number().int().nonnegative().max(1_000_000_000),
  role: RoleSchema,
  content: z.string().max(65_536),
  createdAt: z.string().datetime(),
  eventKind: z.enum(["message", "tool_call"]).optional(),
  metadata: JsonObjectSchema.optional()
}).strict();

export const MemoryAppendTurnOutputSchema = z.object({
  status: z.enum(["APPENDED", "REPLAYED", "QUARANTINED"]),
  turnId: z.string().min(1).max(512).nullable(),
  canonicalEventId: z.string().min(1).max(512).nullable(),
  redacted: z.boolean(),
  disclosure: z.string().min(1).max(2_000)
}).strict();

export const MEMORY_APPEND_TURN_TOOL_NAME = "memory_append_turn" as const;

export const MEMORY_APPEND_TURN_TOOL_ANNOTATIONS: Readonly<ToolAnnotations> = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

export interface MemoryAppendTurnApplication {
  appendTurn(input: z.infer<typeof MemoryAppendTurnInputSchema>): Promise<LiveTurnAppendResult>;
}

export const registerMemoryAppendTurnTool = (
  server: McpServer,
  application: MemoryAppendTurnApplication
): void => {
  server.registerTool(MEMORY_APPEND_TURN_TOOL_NAME, {
    title: "Append one live host turn",
    description: "Append one conversation turn for the startup-authorized profile. Person and write scope come from the profile. Replay of the same host, session, and turn is a no-op. The same key with different content is rejected.",
    inputSchema: MemoryAppendTurnInputSchema,
    outputSchema: MemoryAppendTurnOutputSchema,
    annotations: MEMORY_APPEND_TURN_TOOL_ANNOTATIONS
  }, async (input) => {
    try {
      const envelope = createResponseEnvelope({ ...await application.appendTurn(input) });
      return {
        structuredContent: envelope.structuredContent,
        content: envelope.content.map((item) => ({ ...item }))
      };
    } catch (error) {
      const message = error instanceof LiveTurnConflictError
        ? "LIVE_TURN_CONFLICT"
        : error instanceof LiveTurnHostDeniedError
          ? "LIVE_TURN_HOST_DENIED"
          : "INVALID_REQUEST";
      return {
        isError: true,
        content: [{ type: "text", text: `Live turn was not appended: ${message}` }]
      } satisfies CallToolResult;
    }
  });
};
