import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ResumeResult } from "../../resume/conversation-resumer.js";
import { createResponseEnvelope } from "../response-envelope.js";

const IdentifierSchema = z.string().trim().min(1).max(512);

export const MemoryResumeInputSchema = z.object({
  summaryId: IdentifierSchema.optional(),
  traceId: IdentifierSchema.optional(),
  boxId: IdentifierSchema.optional(),
  injectionPacketId: IdentifierSchema.optional(),
  maxTurnRanges: z.number().int().positive().max(100).optional(),
  includeChildBoxes: z.boolean().optional()
}).strict().superRefine((request, context) => {
  const targets = [request.summaryId, request.traceId, request.boxId, request.injectionPacketId]
    .filter((target) => target !== undefined);
  if (targets.length !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide exactly one of summaryId, traceId, boxId, or injectionPacketId."
    });
  }
  if (!request.boxId && (request.maxTurnRanges !== undefined || request.includeChildBoxes !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Box resume options require boxId."
    });
  }
});

const TurnRangeSchema = z.object({
  threadId: IdentifierSchema,
  startSequence: z.number().int().nonnegative(),
  endSequence: z.number().int().nonnegative()
}).strict();

export const MemoryResumeOutputSchema = z.object({
  sourceSummaryIds: z.array(IdentifierSchema).max(1_000),
  sourceTraceIds: z.array(IdentifierSchema).max(1_000),
  sourceBoxIds: z.array(IdentifierSchema).max(1_000),
  sourceTurnRanges: z.array(TurnRangeSchema).max(1_000),
  turns: z.array(z.object({
    id: IdentifierSchema,
    threadId: IdentifierSchema,
    sequence: z.number().int().nonnegative(),
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.string().max(65_536)
  }).strict()).max(1_000),
  turnCount: z.number().int().nonnegative(),
  disclosureText: z.string().min(1).max(4_000),
  disclosure: z.string().min(1).max(2_000)
}).strict();

export const MEMORY_RESUME_TOOL_NAME = "memory_resume" as const;

export const MEMORY_RESUME_TOOL_ANNOTATIONS: Readonly<ToolAnnotations> = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

export interface MemoryResumeApplication {
  resume(input: z.infer<typeof MemoryResumeInputSchema>): Promise<ResumeResult>;
}

export const registerMemoryResumeTool = (
  server: McpServer,
  application: MemoryResumeApplication
): void => {
  server.registerTool(MEMORY_RESUME_TOOL_NAME, {
    title: "Resume authorized verbatim turns",
    description: "Expand one authorized summary, trace, box, or saved injection packet. Person and scopes come from the profile. Caller-authored turn ranges are not accepted.",
    inputSchema: MemoryResumeInputSchema,
    outputSchema: MemoryResumeOutputSchema,
    annotations: MEMORY_RESUME_TOOL_ANNOTATIONS
  }, async (input) => {
    try {
      const result = await application.resume(input);
      const envelope = createResponseEnvelope({
        sourceSummaryIds: result.sourceSummaryIds,
        sourceTraceIds: result.sourceTraceIds,
        sourceBoxIds: result.sourceBoxIds,
        sourceTurnRanges: result.sourceTurnRanges,
        turns: result.turns.map((turn) => ({
          id: turn.id,
          threadId: turn.threadId,
          sequence: turn.sequence,
          role: turn.role,
          content: turn.content
        })),
        turnCount: result.turnCount,
        disclosureText: result.disclosureText,
        disclosure: "Assistive memory only; verify against current sources."
      });
      return {
        structuredContent: envelope.structuredContent,
        content: envelope.content.map((item) => ({ ...item }))
      };
    } catch (error) {
      const message = error instanceof Error && /not found/i.test(error.message)
        ? error.message
        : "NOT_FOUND";
      return {
        isError: true,
        content: [{ type: "text", text: `Memory resume failed: ${message}` }]
      } satisfies CallToolResult;
    }
  });
};
