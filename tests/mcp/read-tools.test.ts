import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContinuationCursorCodec } from "../../src/mcp/continuation-cursor.js";
import { createResponseEnvelope } from "../../src/mcp/response-envelope.js";
import { loadMemoryMcpProfile } from "../../src/mcp/profile-loader.js";
import { registerMemoryReadTools } from "../../src/mcp/tools/read-tools.js";
import { ScopedProposalReviewer } from "../../src/proposals/scoped-proposal-reviewer.js";
import { MemoryQueryService } from "../../src/retrieval/memory-query-service.js";
import { SubjectExpansionService } from "../../src/retrieval/subject-expansion-service.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import {
  createSyntheticMcpFixture,
  snapshotSemanticMemory,
  type SyntheticMcpFixture
} from "./fixtures.js";

interface PlannedReadEnvelope<T extends Record<string, unknown>> {
  structuredContent: T;
  content: readonly { type: "text"; text: string }[];
}

const assertDualEnvelope = <T extends Record<string, unknown>>(
  envelope: PlannedReadEnvelope<T>
): void => {
  expect(envelope.content).toHaveLength(1);
  expect(envelope.content[0].type).toBe("text");
  for (const value of Object.values(envelope.structuredContent)) {
    if (typeof value === "string") expect(envelope.content[0].text).toContain(value);
  }
};

describe("MCP read application contract", () => {
  let fixture: SyntheticMcpFixture | undefined;
  let client: Client | undefined;
  let server: McpServer | undefined;

  afterEach(async () => {
    await client?.close();
    await server?.close();
    await fixture?.cleanup();
  });

  const openReadProtocol = async (): Promise<Client> => {
    fixture = await createSyntheticMcpFixture();
    const authority = await loadMemoryMcpProfile({
      configPath: fixture.configPath,
      profileName: "alpha-workspace"
    });
    server = new McpServer({ name: "synthetic-memory-read", version: "1.0.0" });
    registerMemoryReadTools(server, {
      queries: new MemoryQueryService(fixture.store, authority),
      expansion: new SubjectExpansionService(
        fixture.store,
        authority,
        new ContinuationCursorCodec("synthetic-read-cursor-secret-32-bytes", { now: fixture.clock.now })
      ),
      proposals: new ScopedProposalReviewer(fixture.store, authority),
      now: fixture.clock.now
    });
    client = new Client({ name: "synthetic-memory-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  };

  const expectEquivalentToolEnvelope = (result: unknown): Record<string, unknown> => {
    const parsed = result as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      content?: Array<{ type: string; text?: string }>;
    };
    expect(parsed.isError).not.toBe(true);
    expect(parsed.structuredContent).toBeDefined();
    const text = parsed.content?.find((item) => item.type === "text");
    expect(text?.type).toBe("text");
    if (text?.type === "text" && text.text) {
      expect(text.text).toContain(JSON.stringify(parsed.structuredContent, null, 2));
    }
    return parsed.structuredContent ?? {};
  };

  it("snapshots every semantic fixture table deterministically without reading host history", async () => {
    fixture = await createSyntheticMcpFixture();
    const first = await snapshotSemanticMemory(fixture.store);
    const second = await snapshotSemanticMemory(fixture.store);

    expect(second).toBe(first);
    expect(first).toContain("summary-mixed");
    expect(first).toContain("person-beta");
    expect(fixture.tempDir).toMatch(/memory-mcp-synthetic-/);
    expect(fixture.configPath.startsWith(fixture.tempDir)).toBe(true);
  });

  it("defines equivalent structured and rendered disclosure for read results", () => {
    const envelope = createResponseEnvelope({
      disclosure: "Assistive memory; verify against current sources.",
      provenance: "synthetic-source",
      confidence: "0.80"
    });

    assertDualEnvelope(envelope);
  });

  it("05-02 Task 2 memory search returns scoped ranked candidates and causes zero semantic writes", async () => {
    fixture = await createSyntheticMcpFixture();
    const authority = await loadMemoryMcpProfile({
      configPath: fixture.configPath,
      profileName: "alpha-workspace"
    });
    const service = new MemoryQueryService(fixture.store, authority);
    const before = await snapshotSemanticMemory(fixture.store);

    const result = await service.search({ query: "Synthetic alpha", limit: 20 });

    expect(result.candidates.map((candidate) => candidate.id)).toContain("summary-alpha");
    expect(result.candidates.map((candidate) => candidate.id)).not.toEqual(
      expect.arrayContaining(["summary-beta", "summary-mixed", "summary-other", "trace-mixed", "box-mixed"])
    );
    expect(result.restrictedLabels).toEqual(["context-two"]);
    expect(result.disclosure).toMatch(/assistive/i);
    const envelope = createResponseEnvelope(result);
    expect(envelope.content[0].text).toContain("summary-alpha");
    expect(await snapshotSemanticMemory(fixture.store)).toBe(before);

    const inMemoryStore = new InMemoryStore();
    for (const summary of await fixture.store.listSummaries()) await inMemoryStore.saveSummary(summary);
    for (const anchor of await fixture.store.listAnchors()) await inMemoryStore.saveAnchor(anchor);
    for (const box of await fixture.store.listBoxes()) await inMemoryStore.saveBox(box);
    for (const trace of await fixture.store.listTraces()) await inMemoryStore.saveTrace(trace);
    const inMemoryResult = await new MemoryQueryService(inMemoryStore, authority)
      .search({ query: "Synthetic alpha" });
    expect(inMemoryResult).toEqual(result);
  });

  it("05-02 Task 2 contextual recall respects budget and causes zero access, strength, revival, or injection writes", async () => {
    fixture = await createSyntheticMcpFixture();
    const authority = await loadMemoryMcpProfile({
      configPath: fixture.configPath,
      profileName: "alpha-workspace"
    });
    const service = new MemoryQueryService(fixture.store, authority);
    const before = await snapshotSemanticMemory(fixture.store);

    const result = await service.recall({ task: "Synthetic alpha decision", tokenBudget: 12 });

    expect(result.budget).toEqual({ requested: 12, used: expect.any(Number), unit: "estimated_tokens", estimatorVersion: "words-v1" });
    expect(result.budget.used).toBeLessThanOrEqual(12);
    expect(result.items.every((item) => item.scopeIds.every((scope) => scope === "scope-alpha"))).toBe(true);
    expect(await snapshotSemanticMemory(fixture.store)).toBe(before);
  });

  it("05-02 Task 2 memory review filters every mixed-scope dependency and causes zero semantic writes", async () => {
    fixture = await createSyntheticMcpFixture();
    const authority = await loadMemoryMcpProfile({
      configPath: fixture.configPath,
      profileName: "alpha-workspace"
    });
    const service = new MemoryQueryService(fixture.store, authority);
    const before = await snapshotSemanticMemory(fixture.store);

    const first = await service.review({ limit: 1 });
    const second = await service.review({ limit: 100, cursor: first.nextCursor ?? undefined });
    const combined = [...first.items, ...second.items];
    const all = await service.review({ limit: 100 });

    expect(combined).toEqual(all.items);
    expect(new Set(combined.map((item) => item.id)).size).toBe(combined.length);
    expect(combined.map((item) => item.id)).not.toEqual(
      expect.arrayContaining(["summary-beta", "summary-mixed", "summary-other", "trace-mixed", "box-mixed"])
    );
    await expect(service.review({ kinds: ["summary"], limit: 1, cursor: first.nextCursor ?? undefined }))
      .rejects.toThrow("Invalid review cursor");
    const otherAuthority = await loadMemoryMcpProfile({
      configPath: fixture.configPath,
      profileName: "alpha-expanded"
    });
    await expect(new MemoryQueryService(fixture.store, otherAuthority).review({
      limit: 1,
      cursor: first.nextCursor ?? undefined
    })).rejects.toThrow("Invalid review cursor");
    expect(await snapshotSemanticMemory(fixture.store)).toBe(before);
  });

  it("05-02 Task 2 source status reports daemon offline without changing synchronization or memory state", async () => {
    fixture = await createSyntheticMcpFixture();
    const authority = await loadMemoryMcpProfile({
      configPath: fixture.configPath,
      profileName: "alpha-workspace"
    });
    const service = new MemoryQueryService(fixture.store, authority);
    const before = await snapshotSemanticMemory(fixture.store);

    const result = await service.status("2026-07-18T12:00:00.000Z");

    expect(result.synchronization).toEqual({ online: false, state: "stopped" });
    expect(result.personId).toBe("person-alpha");
    expect(result.sourceCount).toBe(1);
    expect(await snapshotSemanticMemory(fixture.store)).toBe(before);

    expect(() => new SqliteStore(join(fixture!.tempDir, "missing.sqlite"), { readOnly: true }))
      .toThrow();
    const readOnlyStore = new SqliteStore(fixture.databasePath, { readOnly: true, busyTimeoutMs: 250 });
    try {
      const sqliteResult = await new MemoryQueryService(readOnlyStore, authority).search({ query: "Synthetic alpha" });
      expect(sqliteResult.candidates.map((candidate) => candidate.id)).toContain("summary-alpha");
    } finally {
      readOnlyStore.close();
    }
  });
  it("05-06 Task 2 registers and routes memory_search with equivalent structured and text output", async () => {
    const protocol = await openReadProtocol();
    const before = await snapshotSemanticMemory(fixture!.store);
    const catalog = await protocol.listTools();
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_recall",
      "memory_review",
      "memory_expand_subject",
      "source_status",
      "proposal_list"
    ]);
    expect(catalog.tools.every((tool) => tool.annotations?.readOnlyHint === true &&
      tool.annotations.destructiveHint === false && tool.annotations.idempotentHint === true &&
      tool.annotations.openWorldHint === false)).toBe(true);

    const result = await protocol.callTool({ name: "memory_search", arguments: { query: "Synthetic alpha", limit: 20 } });
    const structured = expectEquivalentToolEnvelope(result);
    expect(JSON.stringify(structured)).toContain("summary-alpha");
    expect(JSON.stringify(structured)).not.toContain("summary-beta");
    expect(await snapshotSemanticMemory(fixture!.store)).toBe(before);
  });

  it("05-06 Task 2 registers and routes memory_recall with equivalent structured and text output", async () => {
    const protocol = await openReadProtocol();
    const before = await snapshotSemanticMemory(fixture!.store);
    const result = await protocol.callTool({
      name: "memory_recall",
      arguments: { task: "Synthetic alpha decision", tokenBudget: 100 }
    });
    const structured = expectEquivalentToolEnvelope(result);
    expect(structured.budget).toEqual(expect.objectContaining({ requested: 100, unit: "estimated_tokens" }));
    expect(await snapshotSemanticMemory(fixture!.store)).toBe(before);
  });

  it("05-06 Task 2 registers and routes memory_review with bounded continuation", async () => {
    const protocol = await openReadProtocol();
    const before = await snapshotSemanticMemory(fixture!.store);
    const first = expectEquivalentToolEnvelope(await protocol.callTool({
      name: "memory_review",
      arguments: { limit: 1 }
    }));
    expect(typeof first.nextCursor).toBe("string");
    const second = expectEquivalentToolEnvelope(await protocol.callTool({
      name: "memory_review",
      arguments: { limit: 100, cursor: first.nextCursor }
    }));
    const direct = await new MemoryQueryService(fixture!.store, await loadMemoryMcpProfile({
      configPath: fixture!.configPath,
      profileName: "alpha-workspace"
    })).review({ limit: 100 });
    expect([...(first.items as unknown[]), ...(second.items as unknown[])]).toEqual(direct.items);
    const invalidCursor = "synthetic-raw-restricted-cursor";
    const rejected = await protocol.callTool({
      name: "memory_review",
      arguments: { limit: 1, cursor: invalidCursor }
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain("INVALID_CONTINUATION");
    expect(JSON.stringify(rejected)).not.toContain(invalidCursor);
    expect(await snapshotSemanticMemory(fixture!.store)).toBe(before);
  });

  it("05-06 Task 2 registers and routes memory_expand_subject with bounded continuation", async () => {
    const protocol = await openReadProtocol();
    const before = await snapshotSemanticMemory(fixture!.store);
    const structured = expectEquivalentToolEnvelope(await protocol.callTool({
      name: "memory_expand_subject",
      arguments: { subject: "Synthetic alpha summary", tokenBudget: 1_000 }
    }));
    expect(structured.count).toBe(2);
    expect(structured.budget).toEqual(expect.objectContaining({ requested: 1_000, unit: "estimated_tokens" }));
    expect(await snapshotSemanticMemory(fixture!.store)).toBe(before);
  });

  it("05-06 Task 2 registers and routes source_status while the daemon is offline", async () => {
    const protocol = await openReadProtocol();
    const before = await snapshotSemanticMemory(fixture!.store);
    const structured = expectEquivalentToolEnvelope(await protocol.callTool({ name: "source_status", arguments: {} }));
    expect(structured.synchronization).toEqual({ online: false, state: "stopped" });
    expect(await snapshotSemanticMemory(fixture!.store)).toBe(before);
  });

  it("05-06 Task 2 registers and routes proposal_list with profile-scoped review pagination", async () => {
    const protocol = await openReadProtocol();
    const before = await snapshotSemanticMemory(fixture!.store);
    const structured = expectEquivalentToolEnvelope(await protocol.callTool({
      name: "proposal_list",
      arguments: { state: "proposed", limit: 1 }
    }));
    expect(structured.count).toBe(0);
    expect(JSON.stringify(structured)).not.toContain("proposal-mixed");
    expect(await snapshotSemanticMemory(fixture!.store)).toBe(before);
  });
});
