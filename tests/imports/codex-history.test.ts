import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveCodexHistory,
  discoverCodexHistory
} from "../../src/imports/codex-discovery.js";
import { CodexHistoryImporter } from "../../src/imports/codex-importer.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

const SESSION_PATH = "sessions/2026/07/16/rollout-2026-07-16T10-00-00-session-a.jsonl";

describe("Codex history discovery and import", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codex-history-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("discovers rollout metadata without parsing message bodies", async () => {
    const invalidRollout = "not valid JSON and discovery must not care\n";
    await writeResource(SESSION_PATH, invalidRollout);
    await writeResource("history.jsonl", "duplicate prompt index\n");
    await writeResource("sessions/2026/07/16/not-a-rollout.jsonl", "ignored\n");
    await symlink(
      join(tempRoot, SESSION_PATH),
      join(tempRoot, "sessions/2026/07/16/rollout-symlink.jsonl")
    );

    const candidate = await discoverCodexHistory(
      tempRoot,
      "2026-07-16T12:00:00.000Z"
    );

    expect(candidate.application).toBe("codex");
    expect(candidate.format).toBe("codex-rollout-jsonl");
    expect(candidate.sessionCount).toBe(1);
    expect(candidate.estimatedBytes).toBe(Buffer.byteLength(invalidRollout));
    expect(candidate.earliestModifiedAt).not.toBeNull();
    expect(candidate.latestModifiedAt).not.toBeNull();
  });

  it("requires an approval bound to the discovered root", async () => {
    await writeResource(SESSION_PATH, `${JSON.stringify(sessionMeta("session-a"))}\n`);
    const candidate = await discoverCodexHistory(tempRoot);
    const approval = approveCodexHistory(
      candidate,
      "person_1",
      "default",
      "2026-07-16T12:00:00.000Z"
    );
    const importer = new CodexHistoryImporter(new InMemoryStore());

    await expect(importer.importApprovedSource({
      ...approval,
      candidateId: "codex_wrong_root"
    })).rejects.toThrow("does not match");
  });

  it("imports messages and redacted tool calls while excluding tool results", async () => {
    const records = [
      sessionMeta("session-a"),
      messageRecord(
        "2026-07-16T10:00:00.000Z",
        "user",
        "Remember api_key=sk-abcdefghijklmnopqrstuvwxyz"
      ),
      { timestamp: "2026-07-16T10:00:00.100Z", type: "event_msg", payload: { type: "user_message", message: "duplicate" } },
      messageRecord(
        "2026-07-16T10:00:01.000Z",
        "assistant",
        "I will remember the decision."
      ),
      { timestamp: "2026-07-16T10:00:01.500Z", type: "response_item", payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call-1",
        arguments: JSON.stringify({ cmd: "deploy", api_key: "sk-abcdefghijklmnopqrstuvwxyz" })
      } },
      { timestamp: "2026-07-16T10:00:02.000Z", type: "response_item", payload: { type: "function_call_output", output: "secret-heavy tool output" } }
    ];
    await writeResource(
      SESSION_PATH,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\nmalformed api_key=sk-abcdefghijklmnopqrstuvwxyz\n`
    );
    const store = new InMemoryStore();
    const candidate = await discoverCodexHistory(tempRoot);
    const approval = approveCodexHistory(candidate, "person_1", "default");
    const importer = new CodexHistoryImporter(store, {
      clock: () => "2026-07-16T12:00:00.000Z"
    });

    const result = await importer.importApprovedSource(approval);
    const events = await store.listCanonicalEvents("person_1");
    const sources = await store.listSources("person_1");
    const checkpoints = await store.listImportCheckpoints("person_1");

    expect(result).toMatchObject({
      filesScanned: 1,
      messagesProcessed: 3,
      recordsSkipped: 4,
      recordsQuarantined: 1
    });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      sourceApplication: "codex",
      nativeSessionId: "session-a",
      nativeSequence: 2,
      content: "Remember api_key=[REDACTED]",
      parserVersion: "codex-rollout/v1",
      metadata: {
        sourceMetadata: {
          sourceResource: SESSION_PATH,
          recordIndex: 2,
          recordType: "response_item"
        }
      }
    });
    expect(events[2]).toMatchObject({
      eventKind: "tool_call",
      role: "assistant",
      nativeEventId: "call-1",
      content: "[Tool call: exec_command] {\"cmd\":\"deploy\",\"api_key\":\"[REDACTED]\"}",
      metadata: { sourceMetadata: { toolName: "exec_command", toolCallId: "call-1" } }
    });
    expect(events.map((event) => event.content).join(" ")).not.toContain("secret-heavy tool output");
    await expect(store.listQuarantineRecords("person_1", candidate.id)).resolves.toEqual([
      expect.objectContaining({
        reason: "malformed_json",
        sanitizedRecord: "malformed api_key=[REDACTED]",
        state: "pending"
      })
    ]);
    expect(sources).toEqual([
      expect.objectContaining({
        application: "codex",
        profileId: "default",
        instanceId: candidate.id
      })
    ]);
    expect(checkpoints).toEqual([
      expect.objectContaining({
        candidateId: candidate.id,
        resourcePath: SESSION_PATH,
        recordIndex: 7,
        nativeSessionId: "session-a"
      })
    ]);
  });

  it("resumes from newline-safe offsets and waits for partial records", async () => {
    await writeResource(
      SESSION_PATH,
      `${JSON.stringify(sessionMeta("session-a"))}\n${JSON.stringify(messageRecord(
        "2026-07-16T10:00:00.000Z",
        "user",
        "First message"
      ))}\n`
    );
    const store = new InMemoryStore();
    const candidate = await discoverCodexHistory(tempRoot);
    const approval = approveCodexHistory(candidate, "person_1", "default");
    const importer = new CodexHistoryImporter(store, {
      clock: () => "2026-07-16T12:00:00.000Z"
    });

    await importer.importApprovedSource(approval);
    const partialRecord = JSON.stringify(messageRecord(
      "2026-07-16T10:01:00.000Z",
      "assistant",
      "Second message"
    ));
    await appendFile(join(tempRoot, SESSION_PATH), partialRecord);

    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({
      messagesProcessed: 0,
      bytesProcessed: 0
    });
    await expect(store.listCanonicalEvents("person_1")).resolves.toHaveLength(1);

    await appendFile(join(tempRoot, SESSION_PATH), "\n");
    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({
      messagesProcessed: 1
    });
    await expect(store.listCanonicalEvents("person_1")).resolves.toHaveLength(2);

    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({
      messagesProcessed: 0,
      bytesProcessed: 0
    });
    await expect(store.listCanonicalEvents("person_1")).resolves.toHaveLength(2);
  });

  it("restarts a checkpoint after truncation without duplicating prior events", async () => {
    await writeResource(
      SESSION_PATH,
      `${JSON.stringify(sessionMeta("session-a"))}\n${JSON.stringify(messageRecord(
        "2026-07-16T10:00:00.000Z",
        "user",
        "A deliberately longer first message before rotation"
      ))}\n`
    );
    const store = new InMemoryStore();
    const candidate = await discoverCodexHistory(tempRoot);
    const approval = approveCodexHistory(candidate, "person_1", "default");
    const importer = new CodexHistoryImporter(store, {
      clock: () => "2026-07-16T12:00:00.000Z"
    });

    await importer.importApprovedSource(approval);
    await writeResource(
      SESSION_PATH,
      `${JSON.stringify(sessionMeta("session-b"))}\n${JSON.stringify(messageRecord(
        "2026-07-16T11:00:00.000Z",
        "user",
        "Rotated"
      ))}\n`
    );

    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({
      messagesProcessed: 1
    });
    const events = await store.listCanonicalEvents("person_1");
    expect(events.map((event) => event.nativeSessionId)).toEqual(["session-a", "session-b"]);
  });

  const writeResource = async (resourcePath: string, content: string): Promise<void> => {
    const absolutePath = join(tempRoot, resourcePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  };
});

const sessionMeta = (sessionId: string): object => ({
  timestamp: "2026-07-16T09:59:00.000Z",
  type: "session_meta",
  payload: { id: sessionId }
});

const messageRecord = (timestamp: string, role: string, text: string): object => ({
  timestamp,
  type: "response_item",
  payload: {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }]
  }
});
