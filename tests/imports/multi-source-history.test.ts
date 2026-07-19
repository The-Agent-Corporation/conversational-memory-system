import { createRequire } from "node:module";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveClaudeHistory,
  discoverClaudeHistory
} from "../../src/imports/claude-discovery.js";
import { ClaudeHistoryImporter } from "../../src/imports/claude-importer.js";
import {
  approveHermesHistory,
  discoverHermesHistory
} from "../../src/imports/hermes-discovery.js";
import { HermesHistoryImporter } from "../../src/imports/hermes-importer.js";
import {
  approveOpenClawHistory,
  discoverOpenClawHistory
} from "../../src/imports/openclaw-discovery.js";
import { OpenClawHistoryImporter } from "../../src/imports/openclaw-importer.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

const NOW = "2026-07-16T12:00:00.000Z";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

describe("Claude Code history importer", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "claude-history-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("discovers project transcripts by metadata without opening their bodies", async () => {
    const path = "projects/-workspace/session-1.jsonl";
    await writeResource(root, path, "invalid json is still discoverable\n");
    await writeResource(root, "history.jsonl", "prompt index\n");
    await symlink(join(root, path), join(root, "projects/-workspace/symlink.jsonl"));

    const candidate = await discoverClaudeHistory(root, NOW);

    expect(candidate).toMatchObject({
      application: "claude-code",
      format: "claude-project-jsonl",
      sessionCount: 1
    });
  });

  it("imports text messages, branches, redaction, sidechains, and newline-safe appends", async () => {
    const path = "projects/-workspace/session-1.jsonl";
    await writeResource(root, path, [
      claudeRecord("user", "u1", null, "Remember token=sk-abcdefghijklmnopqrstuvwxyz", false),
      claudeRecord("assistant", "a1", "u1", "Decision recorded.", false, NOW, [{
        type: "tool_use",
        id: "toolu_1",
        name: "Read",
        input: { file_path: "/workspace/notes.md", token: "sk-abcdefghijklmnopqrstuvwxyz" }
      }]),
      { type: "progress", sessionId: "session-1", timestamp: NOW, data: { type: "hook_progress" } },
      "malformed token=sk-abcdefghijklmnopqrstuvwxyz",
      claudeRecord("assistant", "side1", "u1", "Sidechain finding.", true),
      ""
    ].map((record) => typeof record === "string" ? record : JSON.stringify(record)).join("\n"));
    const store = new InMemoryStore();
    const candidate = await discoverClaudeHistory(root, NOW);
    const approval = approveClaudeHistory(candidate, "person_1", "default", NOW);
    const importer = new ClaudeHistoryImporter(store, { clock: () => NOW });

    const first = await importer.importApprovedSource(approval);
    const events = await store.listCanonicalEvents("person_1");

    expect(first).toMatchObject({ filesScanned: 1, messagesProcessed: 4, recordsSkipped: 2, recordsQuarantined: 1 });
    expect(events.map((event) => event.content)).toEqual([
      "Remember token=[REDACTED]",
      "Decision recorded.",
      "[Tool call: Read] {\"file_path\":\"/workspace/notes.md\",\"token\":\"[REDACTED]\"}",
      "Sidechain finding."
    ]);
    expect(events[1].causalParentId).toBe(events[0].id);
    expect(events[2].eventKind).toBe("tool_call");
    expect(events[3].metadata).toMatchObject({ sourceMetadata: { isSidechain: true } });
    await expect(store.listQuarantineRecords("person_1", candidate.id)).resolves.toEqual([
      expect.objectContaining({ sanitizedRecord: "malformed token=[REDACTED]" })
    ]);

    const partial = JSON.stringify(claudeRecord(
      "user", "u2", "a1", "Appended message.", false, "2026-07-16T12:01:00.000Z"
    ));
    await appendFile(join(root, path), partial);
    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({ messagesProcessed: 0 });
    await appendFile(join(root, path), "\n");
    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({ messagesProcessed: 1 });
    await expect(store.listCanonicalEvents("person_1")).resolves.toHaveLength(5);
  });

  it("binds approval to the exact Claude root", async () => {
    await writeResource(root, "projects/-workspace/session.jsonl", "");
    const approval = approveClaudeHistory(await discoverClaudeHistory(root), "person_1", "default");
    await expect(new ClaudeHistoryImporter(new InMemoryStore()).importApprovedSource({
      ...approval,
      candidateId: "claude-code_wrong"
    })).rejects.toThrow(/does not match/);
  });
});

describe("OpenClaw history importer", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "openclaw-history-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("discovers only per-agent canonical transcript files", async () => {
    await writeResource(root, "agents/main/sessions/session-1.jsonl", "invalid\n");
    await writeResource(root, "agents/main/sessions/sessions.json", "{}\n");
    await writeResource(root, "cron/runs/job-1.jsonl", "ignored\n");
    await writeResource(root, "agents/main/sessions/nested/sidecar.jsonl", "ignored\n");

    await expect(discoverOpenClawHistory(root, NOW)).resolves.toMatchObject({
      application: "openclaw",
      format: "openclaw-session-jsonl",
      sessionCount: 1
    });
  });

  it("imports user/assistant text with tree provenance and excludes tool results", async () => {
    const records = [
      { type: "session", version: 3, id: "session-1", timestamp: NOW, cwd: "/private/workspace" },
      openClawMessage("m1", null, "user", "Plan the launch."),
      openClawMessage("m2", "m1", "assistant", "Use api_key=sk-abcdefghijklmnopqrstuvwxyz", [{
        type: "toolCall",
        id: "tool-1",
        name: "browser.open",
        arguments: { url: "https://example.test", password: "hunter2" }
      }]),
      openClawMessage("m3", "m2", "toolResult", "secret tool output"),
      { type: "compaction", id: "c1", parentId: "m3", timestamp: NOW, summary: "summary" }
      ,{ type: "mystery", password: "hunter2" }
    ];
    await writeResource(
      root,
      "agents/main/sessions/session-1.jsonl",
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
    );
    const store = new InMemoryStore();
    const candidate = await discoverOpenClawHistory(root, NOW);
    const approval = approveOpenClawHistory(candidate, "person_1", "default", NOW);

    const result = await new OpenClawHistoryImporter(store, { clock: () => NOW })
      .importApprovedSource(approval);
    const events = await store.listCanonicalEvents("person_1");

    expect(result).toMatchObject({ messagesProcessed: 3, recordsSkipped: 4, recordsQuarantined: 1 });
    expect(events.map((event) => event.content)).toEqual([
      "Plan the launch.",
      "Use api_key=[REDACTED]",
      "[Tool call: browser.open] {\"url\":\"https://example.test\",\"password\":\"[REDACTED]\"}"
    ]);
    expect(events[1].causalParentId).toBe(events[0].id);
    expect(events[0].sourceProfileId).toBe("default/main");
    expect(events[0].metadata).toMatchObject({
      sourceMetadata: { agentId: "main", sourceResource: "agents/main/sessions/session-1.jsonl" }
    });
    await expect(store.listQuarantineRecords("person_1", candidate.id)).resolves.toEqual([
      expect.objectContaining({
        reason: "unsupported_record",
        sanitizedRecord: expect.stringContaining("[REDACTED]")
      })
    ]);
  });

  it("keeps repeated native entry ids distinct across OpenClaw sessions", async () => {
    for (const sessionId of ["session-a", "session-b"]) {
      await writeResource(root, `agents/main/sessions/${sessionId}.jsonl`, [
        JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: NOW }),
        JSON.stringify(openClawMessage("same-id", null, "user", `Message from ${sessionId}`)),
        ""
      ].join("\n"));
    }
    const store = new InMemoryStore();
    const candidate = await discoverOpenClawHistory(root, NOW);
    const approval = approveOpenClawHistory(candidate, "person_1", "default", NOW);

    await new OpenClawHistoryImporter(store, { clock: () => NOW }).importApprovedSource(approval);

    await expect(store.listCanonicalEvents("person_1")).resolves.toHaveLength(2);
    await expect(store.listTurns("session-a")).resolves.toHaveLength(1);
    await expect(store.listTurns("session-b")).resolves.toHaveLength(1);
  });
});

describe("Hermes state database importer", () => {
  let root: string;
  let databasePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hermes-history-"));
    databasePath = join(root, "state.db");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      create table sessions (
        id text primary key,
        source text not null,
        started_at real not null
      );
      create table messages (
        id integer primary key autoincrement,
        session_id text not null,
        role text not null,
        content text,
        tool_calls text,
        timestamp real not null
      );
      insert into sessions (id, source, started_at)
        values ('session-1', 'telegram', 1784203200);
      insert into messages (session_id, role, content, timestamp, tool_calls) values
        ('session-1', 'user', 'Hermes request', 1784203200, null),
        ('session-1', 'assistant', 'password=hunter2', 1784203201,
          '[{"id":"hermes-call-1","function":{"name":"search","arguments":"{\\"query\\":\\"token=sk-abcdefghijklmnopqrstuvwxyz\\"}"}}]'),
        ('session-1', 'tool', 'private tool result', 1784203202, null);
    `);
    database.close();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("capability-detects metadata and imports SQLite rows read-only and incrementally", async () => {
    const candidate = await discoverHermesHistory(root, NOW);
    expect(candidate).toMatchObject({
      application: "hermes",
      format: "hermes-state-sqlite",
      sessionCount: 1
    });
    const store = new InMemoryStore();
    const approval = approveHermesHistory(candidate, "person_1", "default", NOW);
    const importer = new HermesHistoryImporter(store, { clock: () => NOW });

    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({
      filesScanned: 1,
      messagesProcessed: 3,
      recordsSkipped: 1
    });
    const events = await store.listCanonicalEvents("person_1");
    expect(events.map((event) => event.content)).toEqual([
      "Hermes request",
      "password=[REDACTED]",
      "[Tool call: search] {\"query\":\"token=[REDACTED]\"}"
    ]);
    expect(events.map((event) => event.content).join(" ")).not.toContain("private tool result");
    expect(events[0].sourceApplication).toBe("hermes");
    expect(events[0].sourceProfileId).toBe("default/telegram");

    const writer = new DatabaseSync(databasePath);
    writer.prepare(
      "insert into messages (session_id, role, content, timestamp) values (?, ?, ?, ?)"
    ).run("session-1", "assistant", "Later response", 1784203203);
    writer.close();

    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({
      messagesProcessed: 1,
      recordsSkipped: 0
    });
    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({
      messagesProcessed: 0
    });
    await expect(store.listCanonicalEvents("person_1")).resolves.toHaveLength(4);

    const verifier = new DatabaseSync(databasePath, { readOnly: true });
    expect((verifier.prepare("select count(*) as count from messages").get() as { count: number }).count).toBe(4);
    verifier.close();
  });

  it("rejects a database without the required Hermes capabilities", async () => {
    const unsupportedPath = join(root, "unsupported.db");
    const database = new DatabaseSync(unsupportedPath);
    database.exec("create table unrelated (id integer primary key)");
    database.close();

    await expect(discoverHermesHistory(unsupportedPath, NOW)).rejects.toThrow(/sessions\/messages/);
  });

  it("quarantines malformed Hermes tool-call metadata without retaining tool results", async () => {
    const writer = new DatabaseSync(databasePath);
    writer.prepare("update messages set tool_calls = ? where id = 2")
      .run('{"password":"hunter2"');
    writer.close();
    const store = new InMemoryStore();
    const candidate = await discoverHermesHistory(root, NOW);
    const approval = approveHermesHistory(candidate, "person_1", "default", NOW);

    const result = await new HermesHistoryImporter(store, { clock: () => NOW })
      .importApprovedSource(approval);

    expect(result).toMatchObject({ recordsQuarantined: 1, messagesProcessed: 2 });
    await expect(store.listQuarantineRecords("person_1", candidate.id)).resolves.toEqual([
      expect.objectContaining({
        reason: "malformed_tool_call",
        sanitizedRecord: expect.stringContaining("[REDACTED]")
      })
    ]);
    expect((await store.listCanonicalEvents("person_1")).map((event) => event.content).join(" "))
      .not.toContain("private tool result");
  });
});

async function writeResource(root: string, resourcePath: string, content: string): Promise<void> {
  const absolutePath = join(root, resourcePath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

function claudeRecord(
  role: "user" | "assistant",
  uuid: string,
  parentUuid: string | null,
  text: string,
  isSidechain: boolean,
  timestamp = NOW,
  extraContent: object[] = []
): object {
  return {
    type: role,
    uuid,
    parentUuid,
    sessionId: "session-1",
    timestamp,
    isSidechain,
    message: { role, content: [{ type: "text", text }, ...extraContent] }
  };
}

function openClawMessage(
  id: string,
  parentId: string | null,
  role: string,
  text: string,
  extraContent: object[] = []
): object {
  return {
    type: "message",
    id,
    parentId,
    timestamp: NOW,
    message: { role, content: [{ type: "text", text }, ...extraContent] }
  };
}
