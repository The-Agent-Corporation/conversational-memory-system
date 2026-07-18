import { describe, expect, it } from "vitest";

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

  it.todo("05-06 Task 1 registers all six read schemas with no authority-widening inputs");
  it.todo("05-06 Task 2 exposes all six read contracts through tools/list and tools/call");
  it.todo("05-07 Task 1 registers all ten mutation schemas as explicit preview and execute pairs");
  it.todo("05-07 Task 2 exposes all ten mutation contracts with exact annotations");
  it.todo("05-08 Task 1 composes the complete catalog without duplicate or umbrella tools");
  it.todo("05-08 Task 1 keeps every capability available while daemon status is offline");
});
