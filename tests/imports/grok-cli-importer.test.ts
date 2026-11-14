import { appendFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveGrokCliHistory, discoverGrokCliHistory } from "../../src/imports/grok-cli-discovery.js";
import { GrokCliHistoryImporter } from "../../src/imports/grok-cli-importer.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

const NOW = "2026-11-14T12:00:00.000Z";
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Grok CLI history import", () => {
  it("discovers one metadata-only candidate per decoded workspace and ignores sidecars and symlinks", async () => {
    const fixture = await createFixture();
    const unreadableTranscript = fixture.chatPath;
    const before = await readFile(unreadableTranscript, "utf8");

    const candidates = await discoverGrokCliHistory(fixture.sessionsRoot, NOW);

    expect(candidates.map((candidate) => candidate.scopeId).sort()).toEqual(["/workspace/alpha", "/workspace/beta"]);
    expect(candidates.map((candidate) => candidate.sessionCount).sort()).toEqual([1, 1]);
    expect(candidates.every((candidate) => candidate.rootPath.startsWith(fixture.sessionsRoot))).toBe(true);
    expect(await readFile(unreadableTranscript, "utf8")).toBe(before);
  });

  it("joins turn timestamps, redacts accepted content, excludes hidden content, quarantines bounded failures, and replays idempotently", async () => {
    const fixture = await createFixture();
    const candidate = (await discoverGrokCliHistory(fixture.sessionsRoot, NOW))
      .find((item) => item.scopeId === "/workspace/alpha")!;
    const store = new InMemoryStore();
    const importer = new GrokCliHistoryImporter(store, { clock: () => NOW });
    const approval = approveGrokCliHistory(candidate, "person_1", "default", NOW);

    const first = await importer.importApprovedSource(approval);
    const events = await store.listCanonicalEvents("person_1");
    const quarantine = await store.listQuarantineRecords("person_1", candidate.id);

    expect(first).toMatchObject({ filesScanned: 1, messagesProcessed: 4, recordsQuarantined: 2 });
    expect(events.slice(0, 3).map((event) => event.occurredAt)).toEqual([
      "2026-07-01T10:00:00.000Z",
      "2026-07-01T10:00:00.000Z",
      "2026-07-01T10:00:00.000Z"
    ]);
    expect(events.at(-1)?.occurredAt).not.toBe("2026-07-01T10:00:00.000Z");
    expect(events.map((event) => event.content).join("\n")).toContain("[REDACTED]");
    expect(JSON.stringify(events)).not.toContain("HIDDEN_REASONING");
    expect(JSON.stringify(events)).not.toContain("ENCRYPTED_PAYLOAD");
    expect(JSON.stringify(events)).not.toContain("SECRET_TOOL_RESULT");
    expect(events[0]?.scopeId).toBe("/workspace/alpha");
    expect(events[1]?.metadata.sourceMetadata).toMatchObject({ timestampSource: "events_turn", timestampConfidence: "high" });
    expect(events.at(-1)?.metadata.sourceMetadata).toMatchObject({ timestampSource: "chat_history_mtime", timestampConfidence: "low" });
    expect(quarantine).toHaveLength(2);
    expect(JSON.stringify(quarantine)).not.toContain("ENCRYPTED_PAYLOAD");

    const ids = events.map((event) => event.id);
    const replay = await importer.importApprovedSource(approval);
    expect(replay.messagesProcessed).toBe(0);
    expect((await store.listCanonicalEvents("person_1")).map((event) => event.id)).toEqual(ids);

    await appendFile(fixture.chatPath, JSON.stringify({ type: "assistant", id: "partial", content: "Wait" }));
    expect((await importer.importApprovedSource(approval)).messagesProcessed).toBe(0);
    await appendFile(fixture.chatPath, "\n");
    expect((await importer.importApprovedSource(approval)).messagesProcessed).toBe(1);
    expect((await store.listCanonicalEvents("person_1")).map((event) => event.nativeEventId)).toContain("partial");
  });

  it("rejects a candidate whose immutable decoded scope is changed", async () => {
    const fixture = await createFixture();
    const candidate = (await discoverGrokCliHistory(fixture.sessionsRoot, NOW))[0]!;
    const approval = { ...approveGrokCliHistory(candidate, "person_1", "default", NOW), scopeId: "/workspace/other" };
    await expect(new GrokCliHistoryImporter(new InMemoryStore()).importApprovedSource(approval))
      .rejects.toThrow("does not match");
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "memory-grok-"));
  cleanups.push(root);
  const sessionsRoot = join(root, ".grok", "sessions");
  const alpha = join(sessionsRoot, encodeURIComponent("/workspace/alpha"));
  const beta = join(sessionsRoot, encodeURIComponent("/workspace/beta"));
  const alphaSession = join(alpha, "session-alpha");
  const betaSession = join(beta, "session-beta");
  await mkdir(alphaSession, { recursive: true });
  await mkdir(betaSession, { recursive: true });
  const chatPath = join(alphaSession, "chat_history.jsonl");
  const records = [
    { type: "user", id: "user-1", content: "token=super-secret-value" },
    { type: "assistant", id: "assistant-1", content: [{ type: "text", text: "Visible answer" }], model_id: "grok-4", model_fingerprint: "fp-1",
      tool_calls: [{ id: "call-1", type: "function", function: { name: "shell", arguments: "{\"password\":\"tool-secret\"}" } }] },
    { type: "reasoning", summary: "HIDDEN_REASONING", encrypted_content: "ENCRYPTED_PAYLOAD" },
    { type: "tool", tool_call_id: "call-1", content: "SECRET_TOOL_RESULT" },
    "not-an-object",
    { type: "user", id: "user-2", content: "Second turn" }
  ];
  await writeFile(chatPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  await writeFile(join(alphaSession, "events.jsonl"), [
    JSON.stringify({ turn_number: 1, ts: "2026-07-01T10:00:00.000Z" }),
    "{malformed"
  ].join("\n") + "\n");
  await writeFile(join(alphaSession, "system_prompt.txt"), "SECRET_SYSTEM_PROMPT");
  await writeFile(join(betaSession, "chat_history.jsonl"), `${JSON.stringify({ type: "user", content: "Beta" })}\n`);
  await writeFile(join(sessionsRoot, "session_search.sqlite"), "not a database");
  await writeFile(join(root, ".grok", "auth.json"), "SECRET_AUTH");
  await symlink(alphaSession, join(beta, "linked-session"));
  return { root, sessionsRoot, chatPath };
}
