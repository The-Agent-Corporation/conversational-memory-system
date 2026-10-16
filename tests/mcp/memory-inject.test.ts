import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { createMemoryMcpServer, type MemoryMcpApplication } from "../../src/mcp/server.js";
import { createSyntheticMcpFixture, type SyntheticMcpFixture } from "./fixtures.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => {
    prepare(sql: string): { get(): { count: number } };
    close(): void;
  };
};

function injectionCount(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number(database.prepare("select count(*) as count from injections").get().count);
  } finally {
    database.close();
  }
}

describe("memory_inject", () => {
  let fixture: SyntheticMcpFixture | undefined;
  let application: MemoryMcpApplication | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await application?.close();
    await fixture?.cleanup();
  });

  it("keeps memory_recall from writing and refuses injection until the profile opts in", async () => {
    fixture = await createSyntheticMcpFixture();
    const injectionsBefore = injectionCount(fixture.databasePath);

    application = await createMemoryMcpServer({
      configPath: fixture.configPath,
      profileName: "alpha-expanded",
      now: fixture.clock.now
    });
    client = new Client({ name: "inject-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);

    const recall = await client.callTool({
      name: "memory_recall",
      arguments: { task: "synthetic coverage", tokenBudget: 40 }
    });
    expect(recall.isError).not.toBe(true);
    expect(injectionCount(fixture.databasePath)).toBe(injectionsBefore);

    const denied = await client.callTool({
      name: "memory_inject",
      arguments: {
        hostSessionId: "session-1",
        currentTopicSummary: "synthetic coverage",
        maxMemoryTokens: 40
      }
    });
    expect(denied.isError).toBe(true);

    const raw = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      profiles: Record<string, { allowInjection?: boolean }>;
    };
    raw.profiles["alpha-expanded"]!.allowInjection = true;
    await writeFile(fixture.configPath, JSON.stringify(raw));
    await application.close();
    application = await createMemoryMcpServer({
      configPath: fixture.configPath,
      profileName: "alpha-expanded",
      now: fixture.clock.now
    });
    await client.close();
    client = new Client({ name: "inject-client", version: "1.0.0" });
    const [nextClient, nextServer] = InMemoryTransport.createLinkedPair();
    await application.server.connect(nextServer);
    await client.connect(nextClient);
    const allowed = await client.callTool({
      name: "memory_inject",
      arguments: {
        hostSessionId: "session-1",
        currentTopicSummary: "synthetic coverage",
        maxMemoryTokens: 40
      }
    });
    expect(allowed.isError).not.toBe(true);
  });
});
