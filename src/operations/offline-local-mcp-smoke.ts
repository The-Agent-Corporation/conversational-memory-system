import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryMcpServer } from "../mcp/server.js";
import { SqliteStore } from "../storage/sqlite-store.js";

export interface OfflineLocalMcpSmokeResult {
  ok: true;
  offline: true;
  databasePath: string;
  configPath: string;
  profileName: string;
  appended: boolean;
  replayed: boolean;
  searchErrored: boolean;
  eventCount: number;
}

export async function runOfflineLocalMcpSmoke(directory?: string): Promise<OfflineLocalMcpSmokeResult> {
  const root = directory ?? await mkdtemp(join(tmpdir(), "cms-offline-mcp-"));
  if (directory) {
    await mkdir(root, { recursive: true });
    const entries = await readdir(root);
    if (entries.length > 0) {
      throw new Error(`Refusing to write an offline smoke profile into a non-empty directory: ${root}`);
    }
  }
  const databasePath = resolve(root, "memory.sqlite");
  const sourceRoot = resolve(root, "sources");
  const configPath = resolve(root, "profiles.json");
  await mkdir(sourceRoot, { recursive: true });
  const created = new SqliteStore(databasePath);
  created.close();
  await writeFile(configPath, JSON.stringify({
    version: 1,
    profiles: {
      workspace: {
        databasePath,
        personId: "person_example",
        allowedScopeIds: ["personal"],
        ingestScopeId: "personal",
        scopeAliases: { personal: "workspace" },
        sourceRoots: { synthetic: sourceRoot },
        allowInjection: false
      }
    }
  }, null, 2));
  const application = await createMemoryMcpServer({ configPath, profileName: "workspace" });
  const client = new Client({ name: "offline-local-mcp-smoke", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await application.server.connect(serverTransport);
    await client.connect(clientTransport);
    const turn = {
      host: "field-notes",
      hostSessionId: "session_offline",
      turnId: "turn_offline_1",
      sequence: 1,
      role: "user",
      content: "Offline smoke note for the local profile.",
      createdAt: "2026-11-05T18:00:00.000Z"
    };
    const statusOf = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object" || !("status" in value)) return undefined;
      return typeof value.status === "string" ? value.status : undefined;
    };
    const first = await client.callTool({ name: "memory_append_turn", arguments: turn });
    const replay = await client.callTool({ name: "memory_append_turn", arguments: turn });
    const search = await client.callTool({
      name: "memory_search",
      arguments: { query: "Offline smoke note", limit: 5 }
    });
    const store = new SqliteStore(databasePath, { readOnly: true });
    const eventCount = (await store.listCanonicalEvents("person_example")).length;
    store.close();
    return {
      ok: true,
      offline: true,
      databasePath,
      configPath,
      profileName: "workspace",
      appended: statusOf(first.structuredContent) === "APPENDED",
      replayed: statusOf(replay.structuredContent) === "REPLAYED",
      searchErrored: search.isError === true,
      eventCount
    };
  } finally {
    await client.close();
    await application.close();
  }
}

async function main(): Promise<void> {
  const directory = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const result = await runOfflineLocalMcpSmoke(directory);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.appended || !result.replayed || result.searchErrored || result.eventCount !== 1) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
