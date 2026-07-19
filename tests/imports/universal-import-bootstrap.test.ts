import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBootstrapCommand } from "../../src/bootstrap/bootstrap-command.js";
import { runMemoryStatusCommand } from "../../src/bootstrap/status-command.js";
import { runCodexDiscoverCommand } from "../../src/imports/codex-discover-command.js";
import { runCodexImportCommand } from "../../src/imports/codex-import-command.js";
import { runHistoryDiscoverCommand } from "../../src/imports/history-discover-command.js";
import { runHistoryImportCommand } from "../../src/imports/history-import-command.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
const NOW = "2026-07-16T15:00:00.000Z";

describe("universal history import commands", () => {
  let tempRoot: string;
  let memoryDatabasePath: string;
  let codexRoot: string;
  let claudeRoot: string;
  let openClawRoot: string;
  let hermesRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "universal-history-"));
    memoryDatabasePath = join(tempRoot, "memory.sqlite");
    codexRoot = join(tempRoot, "codex");
    claudeRoot = join(tempRoot, "claude");
    openClawRoot = join(tempRoot, "openclaw");
    hermesRoot = join(tempRoot, "hermes");

    await writeResource(codexRoot, "sessions/2026/07/16/rollout-session-codex.jsonl", [
      JSON.stringify({ timestamp: "2026-07-16T10:00:00.000Z", type: "session_meta", payload: { id: "codex-session" } }),
      JSON.stringify({
        timestamp: "2026-07-16T10:01:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex planning context." }] }
      }),
      ""
    ].join("\n"));
    await writeResource(claudeRoot, "projects/-workspace/claude-session.jsonl", `${JSON.stringify({
      type: "assistant",
      uuid: "claude-message-1",
      parentUuid: null,
      sessionId: "claude-session",
      timestamp: "2026-07-16T10:02:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Claude implementation context." }] }
    })}\n`);
    await writeResource(openClawRoot, "agents/main/sessions/openclaw-session.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "openclaw-session", timestamp: "2026-07-16T10:03:00.000Z", cwd: "/workspace" }),
      JSON.stringify({
        type: "message",
        id: "openclaw-message-1",
        parentId: null,
        timestamp: "2026-07-16T10:03:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "OpenClaw operational context." }] }
      }),
      ""
    ].join("\n"));
    await mkdir(hermesRoot, { recursive: true });
    const hermes = new DatabaseSync(join(hermesRoot, "state.db"));
    hermes.exec(`
      create table sessions (id text primary key, source text not null, started_at real not null);
      create table messages (
        id integer primary key autoincrement,
        session_id text not null,
        role text not null,
        content text,
        timestamp real not null
      );
      insert into sessions values ('hermes-session', 'cli', 1784203440);
      insert into messages (session_id, role, content, timestamp)
        values ('hermes-session', 'assistant', 'Hermes follow-up context.', 1784203440);
    `);
    hermes.close();
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("imports every approved source into one chronological conversation and bootstraps it", async () => {
    const codexFile = join(codexRoot, "sessions/2026/07/16/rollout-session-codex.jsonl");
    const originalCodex = await readFile(codexFile, "utf8");
    const codex = await runCodexDiscoverCommand({ rootPath: codexRoot, discoveredAt: NOW });
    await runCodexImportCommand({
      databasePath: memoryDatabasePath,
      rootPath: codexRoot,
      approvedCandidateId: codex.candidate.id,
      personId: "person_1",
      requestedAt: NOW
    });

    for (const source of [
      { source: "claude-code" as const, sourcePath: claudeRoot },
      { source: "openclaw" as const, sourcePath: openClawRoot },
      { source: "hermes" as const, sourcePath: hermesRoot }
    ]) {
      const discovery = await runHistoryDiscoverCommand({ ...source, discoveredAt: NOW });
      await runHistoryImportCommand({
        ...source,
        databasePath: memoryDatabasePath,
        approvedCandidateId: discovery.candidate.id,
        personId: "person_1",
        requestedAt: NOW
      });
    }

    const store = new SqliteStore(memoryDatabasePath);
    const events = await store.listCanonicalEvents("person_1");
    store.close();
    expect(events.map((event) => event.sourceApplication)).toEqual([
      "codex",
      "claude-code",
      "openclaw",
      "hermes"
    ]);
    expect(events.map((event) => event.nativeSessionId)).toEqual([
      "codex-session",
      "claude-session",
      "openclaw-session",
      "hermes-session"
    ]);

    await expect(runBootstrapCommand({
      databasePath: memoryDatabasePath,
      personId: "person_1"
    })).resolves.toMatchObject({ ok: true, bootstrap: { eventsProcessed: 4 } });
    await expect(runMemoryStatusCommand({
      databasePath: memoryDatabasePath,
      personId: "person_1"
    })).resolves.toMatchObject({
      sourceCount: 4,
      canonicalEventCount: 4,
      importCheckpointCount: 4,
      bootstrapCheckpoint: { processedEventCount: 4 }
    });

    expect(await readFile(codexFile, "utf8")).toBe(originalCodex);
    const hermesVerifier = new DatabaseSync(join(hermesRoot, "state.db"), { readOnly: true });
    expect((hermesVerifier.prepare("select count(*) as count from messages").get() as { count: number }).count).toBe(1);
    hermesVerifier.close();
  });

  it("refuses a non-matching approval before opening the memory database", async () => {
    await expect(runHistoryImportCommand({
      source: "openclaw",
      sourcePath: openClawRoot,
      databasePath: memoryDatabasePath,
      approvedCandidateId: "openclaw_wrong",
      personId: "person_1",
      requestedAt: NOW
    })).rejects.toThrow(/requires approval/);
  });
});

async function writeResource(root: string, resourcePath: string, content: string): Promise<void> {
  const absolutePath = join(root, resourcePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}
