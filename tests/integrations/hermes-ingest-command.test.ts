import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestHermesTimelineRow } from "../../src/integrations/hermes/ingest-command.js";
import { writeHermesMcpProfile } from "../../src/integrations/hermes/profile-file.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

let tempDir: string | null = null;

const makeTempDir = async (): Promise<string> => {
  tempDir = await mkdtemp(join(tmpdir(), "cms-hermes-ingest-"));
  return tempDir;
};

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const row = (overrides: Record<string, unknown>) => JSON.stringify({
  profile_id: "default",
  session_id: "profile:default",
  channel: "telegram",
  metadata_json: null,
  ...overrides
});

describe("Hermes ingest command", () => {
  it("appends a timeline row through the generic MCP profile", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const profile = await writeHermesMcpProfile({
      directory: dir,
      databasePath,
      personId: "person_default",
      scopeId: "personal"
    });

    const result = await ingestHermesTimelineRow({
      configPath: profile.configPath,
      profileName: profile.profileName,
      input: row({
        id: "default:1",
        sequence: 1,
        role: "user",
        content: "Let's talk about Smith PIP.",
        created_at: "2024-05-04T12:40:00.000Z",
        metadata_json: JSON.stringify({ author: "Alice" })
      })
    });

    expect(result.status).toBe("APPENDED");
    expect(result.summaryId).toBeNull();
    expect(result.turnId).toEqual(expect.any(String));

    const store = new SqliteStore(databasePath, { readOnly: true });
    try {
      const events = await store.listCanonicalEvents("person_default");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        personId: "person_default",
        scopeId: "personal",
        sourceApplication: "hermes",
        content: "Let's talk about Smith PIP."
      });
      expect(JSON.stringify(events[0].metadata)).toContain("Alice");
    } finally {
      store.close();
    }
  });

  it("replays the same host session turn without writing another event", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const profile = await writeHermesMcpProfile({
      directory: dir,
      databasePath,
      personId: "person_default",
      scopeId: "personal"
    });
    const input = row({
      id: "default:1",
      sequence: 1,
      role: "user",
      content: "Let's talk about Smith PIP.",
      created_at: "2024-05-04T12:40:00.000Z"
    });
    const target = { configPath: profile.configPath, profileName: profile.profileName, input };
    await ingestHermesTimelineRow(target);
    const replay = await ingestHermesTimelineRow(target);
    expect(replay.status).toBe("REPLAYED");

    const store = new SqliteStore(databasePath, { readOnly: true });
    try {
      expect(await store.listCanonicalEvents("person_default")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("does not store a control signal or invent a summary", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");
    const profile = await writeHermesMcpProfile({
      directory: dir,
      databasePath,
      personId: "person_default",
      scopeId: "personal"
    });
    const result = await ingestHermesTimelineRow({
      configPath: profile.configPath,
      profileName: profile.profileName,
      input: row({
        id: "default:3",
        sequence: 3,
        role: "user",
        content: "/new",
        created_at: "2024-05-04T12:45:00.000Z"
      })
    });

    expect(result).toMatchObject({ ok: true, turnId: null, summaryId: null, status: "IGNORED_CONTROL" });
    expect(existsSync(databasePath)).toBe(false);
  });
});
