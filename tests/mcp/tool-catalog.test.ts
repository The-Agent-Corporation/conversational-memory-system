import { describe, expect, it } from "vitest";
import {
  MemoryExpandSubjectInputSchema,
  MemoryExpandSubjectOutputSchema,
  MemoryRecallInputSchema,
  MemoryRecallOutputSchema,
  MemoryReviewInputSchema,
  MemoryReviewOutputSchema,
  MemorySearchInputSchema,
  MemorySearchOutputSchema,
  ProposalListInputSchema,
  ProposalListOutputSchema,
  SourceStatusInputSchema,
  SourceStatusOutputSchema
} from "../../src/mcp/tools/read-tools.js";

interface ToolContract {
  name: string;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const annotations = (
  readOnlyHint: boolean,
  destructiveHint: boolean
): ToolContract["annotations"] => ({
  readOnlyHint,
  destructiveHint,
  idempotentHint: readOnlyHint,
  openWorldHint: false
});

export const REQUIRED_MCP_TOOL_CONTRACTS: readonly ToolContract[] = [
  "memory_search",
  "memory_recall",
  "memory_review",
  "memory_expand_subject",
  "source_status",
  "proposal_list"
].map((name) => ({ name, annotations: annotations(true, false) })).concat([
  { name: "history_ingest_preview", annotations: annotations(false, false) },
  { name: "history_ingest_execute", annotations: annotations(false, false) },
  { name: "proposal_approve_preview", annotations: annotations(false, false) },
  { name: "proposal_approve_execute", annotations: annotations(false, true) },
  { name: "proposal_reject_preview", annotations: annotations(false, false) },
  { name: "proposal_reject_execute", annotations: annotations(false, true) },
  { name: "source_revoke_preview", annotations: annotations(false, false) },
  { name: "source_revoke_execute", annotations: annotations(false, true) },
  { name: "source_delete_preview", annotations: annotations(false, false) },
  { name: "source_delete_execute", annotations: annotations(false, true) }
]);

describe("MCP explicit tool catalog contract", () => {
  it("reserves six reads and ten preview or execute mutations with unique task-specific names", () => {
    const names = REQUIRED_MCP_TOOL_CONTRACTS.map((tool) => tool.name);
    expect(names).toHaveLength(16);
    expect(new Set(names).size).toBe(16);
    expect(names.filter((name) => !name.includes("preview") && !name.includes("execute")))
      .toHaveLength(6);
    expect(names).not.toContain("memory_action");
    expect(names).not.toContain("memory_crud");
  });

  it("marks pure reads read-only and every ticket-issuing preview as mutating", () => {
    const reads = REQUIRED_MCP_TOOL_CONTRACTS.slice(0, 6);
    const previews = REQUIRED_MCP_TOOL_CONTRACTS.filter((tool) => tool.name.endsWith("_preview"));
    expect(reads.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect(reads.every((tool) => tool.annotations.idempotentHint)).toBe(true);
    expect(previews.every((tool) => !tool.annotations.readOnlyHint)).toBe(true);
    expect(previews.every((tool) => !tool.annotations.idempotentHint)).toBe(true);
    expect(REQUIRED_MCP_TOOL_CONTRACTS.every((tool) => !tool.annotations.openWorldHint)).toBe(true);
  });

  it("marks destructive durable execute operations conservatively", () => {
    const destructive = REQUIRED_MCP_TOOL_CONTRACTS
      .filter((tool) => tool.annotations.destructiveHint)
      .map((tool) => tool.name);
    expect(destructive).toEqual([
      "proposal_approve_execute",
      "proposal_reject_execute",
      "source_revoke_execute",
      "source_delete_execute"
    ]);
  });

  it("05-06 Task 1 registers all six read schemas with no authority-widening inputs", () => {
    const schemas = [
      MemorySearchInputSchema,
      MemoryRecallInputSchema,
      MemoryReviewInputSchema,
      MemoryExpandSubjectInputSchema,
      SourceStatusInputSchema,
      ProposalListInputSchema
    ];
    const authorityFields = {
      databasePath: "/private/synthetic.sqlite",
      profile: "other-profile",
      personId: "person-other",
      allowedScopeIds: ["scope-other"]
    };

    for (const schema of schemas) {
      expect(schema.safeParse(authorityFields).success).toBe(false);
      expect(Object.keys(schema.shape)).not.toEqual(
        expect.arrayContaining(Object.keys(authorityFields))
      );
    }

    expect(MemorySearchInputSchema.safeParse({ query: "synthetic", limit: 101 }).success).toBe(false);
    expect(MemoryRecallInputSchema.safeParse({ task: "synthetic", tokenBudget: 0 }).success).toBe(false);
    expect(MemoryReviewInputSchema.safeParse({ kinds: ["unknown"], limit: 1 }).success).toBe(false);
    expect(MemoryExpandSubjectInputSchema.safeParse({ subject: "synthetic", tokenBudget: 8, cursor: "x".repeat(4097) }).success).toBe(false);
    expect(ProposalListInputSchema.safeParse({ limit: 101 }).success).toBe(false);

    expect(Object.keys(MemorySearchOutputSchema.shape)).toEqual(
      expect.arrayContaining(["candidates", "restrictedLabels", "disclosure"])
    );
    expect(Object.keys(MemoryRecallOutputSchema.shape)).toEqual(
      expect.arrayContaining(["items", "budget", "continuation", "disclosure"])
    );
    expect(Object.keys(MemoryReviewOutputSchema.shape)).toEqual(
      expect.arrayContaining(["items", "count", "nextCursor", "disclosure"])
    );
    expect(Object.keys(MemoryExpandSubjectOutputSchema.shape)).toEqual(
      expect.arrayContaining(["subject", "events", "budget", "continuation", "disclosure"])
    );
    expect(Object.keys(SourceStatusOutputSchema.shape)).toEqual(
      expect.arrayContaining(["sourceCount", "memoryCount", "synchronization", "disclosure"])
    );
    expect(Object.keys(ProposalListOutputSchema.shape)).toEqual(
      expect.arrayContaining(["proposals", "count", "disclosure"])
    );
  });
  it.todo("05-06 Task 2 exposes all six read contracts through tools/list and tools/call");
  it.todo("05-07 Task 1 registers all ten mutation schemas as explicit preview and execute pairs");
  it.todo("05-07 Task 2 exposes all ten mutation contracts with exact annotations");
  it.todo("05-08 Task 1 composes the complete catalog without duplicate or umbrella tools");
  it.todo("05-08 Task 1 keeps every capability available while daemon status is offline");
});
