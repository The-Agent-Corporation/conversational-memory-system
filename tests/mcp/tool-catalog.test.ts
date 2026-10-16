import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryMcpServer, type MemoryMcpApplication } from "../../src/mcp/server.js";
import { createSyntheticMcpFixture, type SyntheticMcpFixture } from "./fixtures.js";
import {
  MemoryExpandSubjectInputSchema,
  MemoryExpandSubjectOutputSchema,
  MemoryRecallInputSchema,
  MemoryRecallOutputSchema,
  MemoryReviewInputSchema,
  MemoryReviewOutputSchema,
  MemorySearchInputSchema,
  MemorySearchOutputSchema,
  MEMORY_READ_TOOL_ANNOTATIONS,
  MEMORY_READ_TOOL_NAMES,
  ProposalListInputSchema,
  ProposalListOutputSchema,
  SourceStatusInputSchema,
  SourceStatusOutputSchema
} from "../../src/mcp/tools/read-tools.js";
import {
  HistoryIngestExecuteInputSchema,
  HistoryIngestExecuteOutputSchema,
  HistoryIngestPreviewInputSchema,
  HistoryIngestPreviewOutputSchema,
  MEMORY_MUTATION_TOOL_ANNOTATIONS,
  MEMORY_MUTATION_TOOL_NAMES,
  ProposalApproveExecuteInputSchema,
  ProposalApproveExecuteOutputSchema,
  ProposalApprovePreviewInputSchema,
  ProposalApprovePreviewOutputSchema,
  ProposalRejectExecuteInputSchema,
  ProposalRejectExecuteOutputSchema,
  ProposalRejectPreviewInputSchema,
  ProposalRejectPreviewOutputSchema,
  SourceDeleteExecuteInputSchema,
  SourceDeleteExecuteOutputSchema,
  SourceDeletePreviewInputSchema,
  SourceDeletePreviewOutputSchema,
  SourceRevokeExecuteInputSchema,
  SourceRevokeExecuteOutputSchema,
  SourceRevokePreviewInputSchema,
  SourceRevokePreviewOutputSchema
} from "../../src/mcp/tools/mutation-tools.js";

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
  "proposal_list",
  "memory_explain"
].map((name) => ({ name, annotations: annotations(true, false) })).concat([
  { name: "memory_inject", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "history_ingest_preview", annotations: annotations(false, false) },
  { name: "history_ingest_execute", annotations: annotations(false, false) },
  { name: "proposal_approve_preview", annotations: annotations(false, false) },
  { name: "proposal_approve_execute", annotations: annotations(false, true) },
  { name: "proposal_reject_preview", annotations: annotations(false, false) },
  { name: "proposal_reject_execute", annotations: annotations(false, true) },
  { name: "source_revoke_preview", annotations: annotations(false, false) },
  { name: "source_revoke_execute", annotations: annotations(false, true) },
  { name: "source_delete_preview", annotations: annotations(false, false) },
  { name: "source_delete_execute", annotations: annotations(false, true) },
  { name: "event_delete_preview", annotations: annotations(false, false) },
  { name: "event_delete_execute", annotations: annotations(false, true) }
]);

describe("MCP explicit tool catalog contract", () => {
  let fixture: SyntheticMcpFixture | undefined;
  let application: MemoryMcpApplication | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await application?.close();
    await fixture?.cleanup();
  });
  it("reserves six reads and ten preview or execute mutations with unique task-specific names", () => {
    const names = REQUIRED_MCP_TOOL_CONTRACTS.map((tool) => tool.name);
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(20);
    expect(names.filter((name) => !name.includes("preview") && !name.includes("execute")))
      .toHaveLength(8);
    expect(names).not.toContain("memory_action");
    expect(names).not.toContain("memory_crud");
  });

  it("marks pure reads read-only and every ticket-issuing preview as mutating", () => {
    const reads = REQUIRED_MCP_TOOL_CONTRACTS.slice(0, 7);
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
      "source_delete_execute",
      "event_delete_execute"
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
  it("05-06 Task 2 exposes all six read contracts through tools/list and tools/call", () => {
    expect(MEMORY_READ_TOOL_NAMES).toEqual(
      REQUIRED_MCP_TOOL_CONTRACTS.slice(0, 7).map((tool) => tool.name)
    );
    expect(MEMORY_READ_TOOL_ANNOTATIONS).toEqual(annotations(true, false));
  });
  it("05-07 Task 1 registers all ten mutation schemas as explicit preview and execute pairs", () => {
    const inputPairs = [
      [HistoryIngestPreviewInputSchema, HistoryIngestExecuteInputSchema],
      [ProposalApprovePreviewInputSchema, ProposalApproveExecuteInputSchema],
      [ProposalRejectPreviewInputSchema, ProposalRejectExecuteInputSchema],
      [SourceRevokePreviewInputSchema, SourceRevokeExecuteInputSchema],
      [SourceDeletePreviewInputSchema, SourceDeleteExecuteInputSchema]
    ] as const;
    const outputPairs = [
      [HistoryIngestPreviewOutputSchema, HistoryIngestExecuteOutputSchema],
      [ProposalApprovePreviewOutputSchema, ProposalApproveExecuteOutputSchema],
      [ProposalRejectPreviewOutputSchema, ProposalRejectExecuteOutputSchema],
      [SourceRevokePreviewOutputSchema, SourceRevokeExecuteOutputSchema],
      [SourceDeletePreviewOutputSchema, SourceDeleteExecuteOutputSchema]
    ] as const;
    const forbidden = ["action", "databasePath", "path", "profile", "personId", "allowedScopeIds"];

    for (const [preview, execute] of inputPairs) {
      expect(Object.keys(preview.shape)).not.toEqual(expect.arrayContaining(forbidden));
      expect(Object.keys(execute.shape)).not.toEqual(expect.arrayContaining(forbidden));
      expect(Object.keys(execute.shape)).toEqual(expect.arrayContaining([...Object.keys(preview.shape), "token"]));
      expect(Object.keys(execute.shape)).toHaveLength(Object.keys(preview.shape).length + 1);
      expect(execute.safeParse({ action: "delete", token: "x".repeat(32) }).success).toBe(false);
    }

    for (const [preview, execute] of outputPairs) {
      expect(Object.keys(preview.shape)).toEqual(
        expect.arrayContaining(["token", "expiresAt", "effectsFingerprint", "effectCounts"])
      );
      expect(Object.keys(execute.shape)).toEqual(
        expect.arrayContaining(["operation", "status", "targetId", "effectCounts", "committedAt"])
      );
      expect(Object.keys(preview.shape)).not.toContain("content");
      expect(Object.keys(execute.shape)).not.toContain("personId");
    }

    expect(HistoryIngestPreviewInputSchema.safeParse({
      sourceAlias: "/tmp/synthetic", source: "codex", requestedAt: "2026-07-18T12:00:00.000Z"
    }).success).toBe(false);
    expect(HistoryIngestPreviewInputSchema.safeParse({
      sourceAlias: "codex", source: "unknown", requestedAt: "2026-07-18T12:00:00.000Z"
    }).success).toBe(false);
  });
  it("05-07 Task 2 exposes all ten mutation contracts with exact annotations", () => {
    expect(MEMORY_MUTATION_TOOL_NAMES).toEqual(
      REQUIRED_MCP_TOOL_CONTRACTS.slice(8).map((tool) => tool.name)
    );
    expect(MEMORY_MUTATION_TOOL_ANNOTATIONS).toEqual(
      Object.fromEntries(REQUIRED_MCP_TOOL_CONTRACTS.slice(8).map((tool) => [tool.name, tool.annotations]))
    );
  });
  it("05-08 Task 1 composes the complete catalog without duplicate or umbrella tools", async () => {
    fixture = await createSyntheticMcpFixture();
    application = await createMemoryMcpServer({
      configPath: fixture.configPath,
      profileName: "alpha-expanded",
      now: fixture.clock.now
    });
    client = new Client({ name: "synthetic-catalog-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);

    const catalog = await client.listTools();
    expect(catalog.tools.map((tool) => tool.name)).toEqual(
      REQUIRED_MCP_TOOL_CONTRACTS.map((tool) => tool.name)
    );
    expect(catalog.tools.map((tool) => tool.annotations)).toEqual(
      REQUIRED_MCP_TOOL_CONTRACTS.map((tool) => tool.annotations)
    );
    expect(new Set(catalog.tools.map((tool) => tool.name)).size).toBe(20);
  });

  it("05-08 Task 1 keeps every capability available while daemon status is offline", async () => {
    fixture = await createSyntheticMcpFixture();
    application = await createMemoryMcpServer({
      configPath: fixture.configPath,
      profileName: "alpha-expanded",
      now: fixture.clock.now
    });
    client = new Client({ name: "synthetic-offline-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);

    const status = await client.callTool({ name: "source_status", arguments: {} });
    expect(status.structuredContent).toEqual(expect.objectContaining({
      synchronization: { online: false, state: "stopped" }
    }));
    await expect(client.callTool({
      name: "memory_search",
      arguments: { query: "Synthetic alpha", limit: 20 }
    })).resolves.not.toMatchObject({ isError: true });
    await expect(client.callTool({
      name: "memory_recall",
      arguments: { task: "Synthetic alpha decision", tokenBudget: 100 }
    })).resolves.not.toMatchObject({ isError: true });
    await expect(client.callTool({
      name: "memory_review",
      arguments: { limit: 10 }
    })).resolves.not.toMatchObject({ isError: true });

    const preview = await client.callTool({
      name: "proposal_reject_preview",
      arguments: {
        proposalId: "proposal-mixed",
        decidedAt: "2026-07-18T12:01:00.000Z",
        reviewer: "synthetic-reviewer"
      }
    });
    expect(preview.isError).not.toBe(true);
    const token = (preview.structuredContent as { token?: string } | undefined)?.token;
    expect(token).toBeTypeOf("string");
    const execute = await client.callTool({
      name: "proposal_reject_execute",
      arguments: {
        proposalId: "proposal-mixed",
        decidedAt: "2026-07-18T12:01:00.000Z",
        reviewer: "synthetic-reviewer",
        token
      }
    });
    expect(execute.structuredContent).toEqual(expect.objectContaining({
      operation: "proposal_decision",
      status: "COMMITTED"
    }));
  });
});
