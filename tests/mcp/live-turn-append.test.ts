import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { createProfileAuthority } from "../../src/mcp/authority.js";
import { LiveTurnAppendService } from "../../src/mcp/live-turn-append.js";
import { MemoryAppendTurnInputSchema } from "../../src/mcp/tools/append-turn-tools.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const ROOT = resolve(import.meta.dirname, "../..");
const SECRET = "sk-liveFixtureSecretValue99";
const WHEN = "2026-07-18T12:00:00.000Z";

const turnInput = (overrides: Record<string, unknown> = {}) => ({
  host: "field-notes",
  hostSessionId: "session-field",
  turnId: "turn-field-1",
  sequence: 1,
  role: "user" as const,
  content: `Remember api_key: ${SECRET}`,
  createdAt: WHEN,
  ...overrides
});

describe("live turn append", () => {
  it("rejects caller person, scope, and profile fields", () => {
    expect(MemoryAppendTurnInputSchema.safeParse({
      ...turnInput(),
      personId: "person-other",
      scopeId: "scope-other",
      profileId: "other-profile"
    }).success).toBe(false);
    expect(MemoryAppendTurnInputSchema.safeParse({
      ...turnInput(),
      host: "Not A Host"
    }).success).toBe(false);
  });

  it("redacts before storage, replays the same key, and rejects a different payload", async () => {
    const store = new InMemoryStore();
    const authority = createProfileAuthority({
      profileName: "field-notes",
      databasePath: "/tmp/unused-live-turn.sqlite",
      personId: "person-field",
      allowedScopeIds: ["scope-field"],
      ingestScopeId: "scope-field",
      sourceRoots: { synthetic: "/tmp/unused-live-turn-root" },
      scopeAliases: { "scope-field": "field" },
      allowedHosts: ["field-notes"]
    });
    const service = new LiveTurnAppendService(store, authority, () => WHEN);

    const appended = await service.append(turnInput());
    expect(appended.status).toBe("APPENDED");
    expect(appended.redacted).toBe(true);

    const events = await store.listCanonicalEvents("person-field");
    expect(events).toHaveLength(1);
    expect(events[0].content).not.toContain(SECRET);
    expect(events[0].content).toContain("[REDACTED]");
    expect(events[0].scopeId).toBe("scope-field");
    expect(events[0].personId).toBe("person-field");
    expect(JSON.stringify(events)).not.toContain(SECRET);

    const replayed = await service.append(turnInput());
    expect(replayed.status).toBe("REPLAYED");
    expect(await store.listCanonicalEvents("person-field")).toHaveLength(1);

    await expect(service.append(turnInput({ content: "A different sentence." }))).rejects.toThrow("LIVE_TURN_CONFLICT");
    expect((await store.listCanonicalEvents("person-field"))[0].content).toContain("[REDACTED]");

    await expect(service.append(turnInput({ host: "desk-lamp", turnId: "turn-other" }))).rejects.toThrow("LIVE_TURN_HOST_DENIED");
    expect(await store.listCanonicalEvents("person-field")).toHaveLength(1);

    const quarantined = await service.append(turnInput({
      turnId: "turn-tool",
      sequence: 2,
      role: "tool",
      eventKind: "tool_call",
      content: `{"broken": ${SECRET}}`
    }));
    expect(quarantined.status).toBe("QUARANTINED");
    expect(await store.listCanonicalEvents("person-field")).toHaveLength(1);
    const quarantine = await store.listQuarantineRecords("person-field");
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0].sanitizedRecord).not.toContain(SECRET);
    expect(quarantine[0].sanitizedRecord).toContain("[REDACTED]");
  });
});

describe("live turn append over stdio", () => {
  const clients: Client[] = [];
  const transports: StdioClientTransport[] = [];
  let tempDir: string | undefined;

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(transports.splice(0).map((transport) => transport.close()));
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("appends two invented hosts on separate profiles, replays, redacts, and stays isolated while offline", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cms-live-turn-"));
    const databasePath = join(tempDir, "memory.sqlite");
    const sourceRoot = join(tempDir, "sources");
    const setup = new SqliteStore(databasePath);
    setup.close();
    const configPath = join(tempDir, "profiles.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      profiles: {
        "field-notes": {
          databasePath,
          personId: "person-field",
          allowedScopeIds: ["scope-field"],
          ingestScopeId: "scope-field",
          allowedHosts: ["field-notes"],
          scopeAliases: { "scope-field": "field" },
          sourceRoots: { synthetic: sourceRoot }
        },
        "desk-lamp": {
          databasePath,
          personId: "person-desk",
          allowedScopeIds: ["scope-desk"],
          ingestScopeId: "scope-desk",
          scopeAliases: { "scope-desk": "desk" },
          sourceRoots: { synthetic: sourceRoot }
        }
      }
    }));

    const field = await connect(configPath, "field-notes");
    const status = await field.callTool({ name: "source_status", arguments: {} });
    expect(status.structuredContent).toEqual(expect.objectContaining({
      synchronization: { online: false, state: "stopped" },
      personId: "person-field"
    }));

    const appended = await field.callTool({ name: "memory_append_turn", arguments: turnInput() });
    expect(appended.isError).not.toBe(true);
    expect(appended.structuredContent).toEqual(expect.objectContaining({ status: "APPENDED", redacted: true }));

    const replayed = await field.callTool({ name: "memory_append_turn", arguments: turnInput() });
    expect(replayed.structuredContent).toEqual(expect.objectContaining({ status: "REPLAYED" }));

    const conflict = await field.callTool({
      name: "memory_append_turn",
      arguments: turnInput({ content: "A different sentence." })
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("LIVE_TURN_CONFLICT") })
    ]);

    const override = await field.callTool({
      name: "memory_append_turn",
      arguments: { ...turnInput({ turnId: "turn-override" }), personId: "person-desk", scopeId: "scope-desk" }
    });
    expect(override.isError).toBe(true);

    const deniedHost = await field.callTool({
      name: "memory_append_turn",
      arguments: turnInput({ host: "desk-lamp", turnId: "turn-denied", content: "Should not store." })
    });
    expect(deniedHost.isError).toBe(true);
    expect(deniedHost.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("LIVE_TURN_HOST_DENIED") })
    ]);

    await field.close();

    const desk = await connect(configPath, "desk-lamp");
    const deskAppend = await desk.callTool({
      name: "memory_append_turn",
      arguments: turnInput({
        host: "desk-lamp",
        hostSessionId: "session-desk",
        turnId: "turn-desk-1",
        content: "Desk lamp only."
      })
    });
    expect(deskAppend.structuredContent).toEqual(expect.objectContaining({ status: "APPENDED", redacted: false }));
    await desk.close();

    const store = new SqliteStore(databasePath, { readOnly: true });
    try {
      const fieldEvents = await store.listCanonicalEvents("person-field");
      const deskEvents = await store.listCanonicalEvents("person-desk");
      expect(fieldEvents.map((event) => event.content)).toEqual([expect.stringContaining("[REDACTED]")]);
      expect(fieldEvents.every((event) => event.scopeId === "scope-field" && event.sourceApplication === "field-notes")).toBe(true);
      expect(deskEvents.map((event) => event.content)).toEqual(["Desk lamp only."]);
      expect(deskEvents.every((event) => event.personId === "person-desk" && event.scopeId === "scope-desk")).toBe(true);
      expect(JSON.stringify(fieldEvents)).not.toContain("Desk lamp only.");
      expect(JSON.stringify(deskEvents)).not.toContain("[REDACTED]");
    } finally {
      store.close();
    }

    const databaseBytes = await readFile(databasePath);
    expect(databaseBytes.includes(Buffer.from(SECRET))).toBe(false);
  });

  const connect = async (configPath: string, profile: string): Promise<Client> => {
    const transport = new StdioClientTransport({
      command: "npm",
      args: ["--silent", "--prefix", ROOT, "run", "memory:mcp", "--", "--config", configPath, "--profile", profile],
      cwd: ROOT,
      stderr: "pipe",
      env: { NODE_NO_WARNINGS: "1" }
    });
    const client = new Client({ name: `live-${profile}`, version: "1.0.0" });
    transports.push(transport);
    clients.push(client);
    await client.connect(transport);
    return client;
  };
});
