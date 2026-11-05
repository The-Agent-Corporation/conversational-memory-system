import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ReinforceResult } from "../../retrieval/reinforce.js";
import { createResponseEnvelope } from "../response-envelope.js";

export const MEMORY_REINFORCE_TOOL_NAME = "memory_reinforce" as const;

export const MemoryReinforceInputSchema = z.object({
  summaryId: z.string().trim().min(1).max(512)
}).strict();

export const MemoryReinforceOutputSchema = z.object({
  status: z.enum(["REINFORCED", "RATE_LIMITED", "BOUNDED", "NOT_FOUND"]),
  summaryId: z.string().min(1).max(512),
  strength: z.number().min(0).max(1).nullable(),
  disclosure: z.string().min(1).max(2_000)
}).strict();

export const MEMORY_REINFORCE_TOOL_ANNOTATIONS: Readonly<ToolAnnotations> = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false
});

export interface MemoryReinforceApplication {
  reinforce(summaryId: string): Promise<ReinforceResult>;
}

export const registerMemoryReinforceTool = (
  server: McpServer,
  application: MemoryReinforceApplication
): void => {
  server.registerTool(MEMORY_REINFORCE_TOOL_NAME, {
    title: "Reinforce one authorized summary",
    description: "Raise one summary's strength by a bounded step. Person and scopes come from the profile. Repeated calls inside the rate window do not change strength.",
    inputSchema: MemoryReinforceInputSchema,
    outputSchema: MemoryReinforceOutputSchema,
    annotations: MEMORY_REINFORCE_TOOL_ANNOTATIONS
  }, async (input) => {
    const result = await application.reinforce(input.summaryId);
    if (result.status === "NOT_FOUND") {
      return {
        isError: true,
        content: [{ type: "text", text: "Memory reinforce failed: NOT_FOUND" }]
      } satisfies CallToolResult;
    }
    const envelope = createResponseEnvelope({
      ...result,
      disclosure: "Assistive memory only; verify against current sources."
    });
    return {
      structuredContent: envelope.structuredContent,
      content: envelope.content.map((item) => ({ ...item }))
    };
  });
};
