import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createResponseEnvelope } from "../response-envelope.js";

export const MemoryInjectInputSchema = z.object({
  hostSessionId: z.string().trim().min(1).max(512),
  currentTopicSummary: z.string().trim().min(1).max(8_000),
  maxMemoryTokens: z.number().int().min(1).max(8_000)
}).strict();

export const MemoryInjectOutputSchema = z.object({
  injected: z.boolean(),
  packetId: z.string().min(1).max(512).nullable(),
  disclosure: z.string().min(1).max(2_000)
}).strict();

export const MEMORY_INJECT_TOOL_ANNOTATIONS: Readonly<ToolAnnotations> = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
});

export interface MemoryInjectApplication {
  inject(input: z.infer<typeof MemoryInjectInputSchema>): Promise<{
    injected: boolean;
    packetId: string | null;
    disclosure: string;
  }>;
}

export const registerMemoryInjectTool = (
  server: McpServer,
  application: MemoryInjectApplication
): void => {
  server.registerTool("memory_inject", {
    title: "Inject scoped memory into the current session",
    description: "Prepare an assistive injection packet for the startup-authorized profile. Person, scopes, and host come from the profile, not the tool input.",
    inputSchema: MemoryInjectInputSchema,
    outputSchema: MemoryInjectOutputSchema,
    annotations: MEMORY_INJECT_TOOL_ANNOTATIONS
  }, async (input) => {
    try {
      const envelope = createResponseEnvelope(await application.inject(input));
      return {
        structuredContent: envelope.structuredContent,
        content: envelope.content.map((item) => ({ ...item }))
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "INVALID_REQUEST";
      return {
        isError: true,
        content: [{ type: "text", text: `Memory mutation failed: ${message}` }]
      } satisfies CallToolResult;
    }
  });
};
