import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestHermesTimelineRow } from "../../src/integrations/hermes/ingest-command.js";
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

describe("Hermes ingest command", () => {
  it("ingests a bridged Hermes timeline row into the SQLite memory store", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");

    const result = await ingestHermesTimelineRow({
      databasePath,
      input: JSON.stringify({
        id: "default:1",
        profile_id: "default",
        session_id: "profile:default",
        sequence: 1,
        role: "user",
        content: "Let's talk about Smith PIP.",
        created_at: "2024-05-04T12:40:00.000Z",
        channel: "telegram",
        metadata_json: JSON.stringify({
          direction: "inbound",
          platform: "telegram",
          source_chat_id: "chat-1",
          source_thread_id: "thread-1",
          author: "Alice",
          message_id: "m1"
        })
      })
    });

    expect(result).toEqual({
      ok: true,
      turnId: "turn_hermes_default:1",
      completedTopic: null,
      summaryId: null
    });

    const store = new SqliteStore(databasePath);
    const turns = await store.listTurns("profile:default");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: "turn_hermes_default:1",
      threadId: "profile:default",
      sequence: 1,
      role: "user",
      content: "Let's talk about Smith PIP."
    });
    expect(turns[0].metadata).toMatchObject({
      host: "roscoe-hermes",
      profileId: "default",
      sourceMetadata: {
        channel: "telegram",
        sourceMetadata: {
          author: "Alice",
          direction: "inbound"
        }
      }
    });
    store.close();
  });

  it("compacts stored topic turns when a bridged control signal arrives in a fresh process", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");

    await ingestHermesTimelineRow({
      databasePath,
      input: JSON.stringify({
        id: "default:1",
        profile_id: "default",
        session_id: "profile:default",
        sequence: 1,
        role: "user",
        content: "Let's talk about Smith PIP.",
        created_at: "2024-05-04T12:40:00.000Z",
        channel: "telegram",
        metadata_json: null
      })
    });
    await ingestHermesTimelineRow({
      databasePath,
      input: JSON.stringify({
        id: "default:2",
        profile_id: "default",
        session_id: "profile:default",
        sequence: 2,
        role: "assistant",
        content: "The Smith PIP demand deadline is June 1.",
        created_at: "2024-05-04T12:40:10.000Z",
        channel: "telegram",
        metadata_json: null
      })
    });

    const result = await ingestHermesTimelineRow({
      databasePath,
      input: JSON.stringify({
        id: "default:3",
        profile_id: "default",
        session_id: "profile:default",
        sequence: 3,
        role: "user",
        content: "/new",
        created_at: "2024-05-04T12:45:00.000Z",
        channel: "telegram",
        metadata_json: null
      })
    });

    expect(result).toEqual({
      ok: true,
      turnId: null,
      completedTopic: "Smith PIP",
      summaryId: "summary_profile:default_1_2"
    });

    const store = new SqliteStore(databasePath);
    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summaryText).toContain("Smith PIP");
    expect(summaries[0].sourceTurnRanges).toEqual([
      { threadId: "profile:default", startSequence: 1, endSequence: 2 }
    ]);
    store.close();
  });

  it("compacts the full unsummarized tail on control signals even when topic labels drift", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");

    await ingestHermesTimelineRow({
      databasePath,
      input: JSON.stringify({
        id: "memory-test:7",
        profile_id: "memory-test",
        session_id: "profile:memory-test",
        sequence: 7,
        role: "user",
        content: "Let us discuss Alpha Boundary Case. The settlement ledger review deadline is July 9.",
        created_at: "2024-05-04T12:40:00.000Z",
        channel: "api_server",
        metadata_json: null
      })
    });
    await ingestHermesTimelineRow({
      databasePath,
      input: JSON.stringify({
        id: "memory-test:8",
        profile_id: "memory-test",
        session_id: "profile:memory-test",
        sequence: 8,
        role: "assistant",
        content: "To help you effectively with the Alpha Boundary Case and the settlement ledger review deadline on July 9, could you please specify what exactly you'd like to discuss or need assistance with? For example, do you want a summary of the case, key points about the ledger, preparatory steps for the review, or anything else?",
        created_at: "2024-05-04T12:40:10.000Z",
        channel: "api_server",
        metadata_json: null
      })
    });

    const result = await ingestHermesTimelineRow({
      databasePath,
      input: JSON.stringify({
        id: "memory-test:9",
        profile_id: "memory-test",
        session_id: "profile:memory-test",
        sequence: 9,
        role: "user",
        content: "/new",
        created_at: "2024-05-04T12:45:00.000Z",
        channel: "api_server",
        metadata_json: null
      })
    });

    expect(result).toEqual({
      ok: true,
      turnId: null,
      completedTopic: "Alpha Boundary Case",
      summaryId: "summary_profile:memory-test_7_8"
    });

    const store = new SqliteStore(databasePath);
    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].summaryText).toContain("Alpha Boundary Case");
    expect(summaries[0].summaryText).toContain("July 9");
    expect(summaries[0].sourceTurnRanges).toEqual([
      { threadId: "profile:memory-test", startSequence: 7, endSequence: 8 }
    ]);
    store.close();
  });
});
