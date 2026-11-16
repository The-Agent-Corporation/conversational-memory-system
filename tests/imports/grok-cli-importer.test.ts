import { appendFile, mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approveGrokCliHistory, discoverGrokCliHistory } from "../../src/imports/grok-cli-discovery.js";
import { GrokCliHistoryImporter } from "../../src/imports/grok-cli-importer.js";
import { CONFIGURED_HISTORY_HANDLERS, planConfiguredHistoryImport } from "../../src/imports/history-import-command.js";
import { createProfileAuthority } from "../../src/mcp/authority.js";
import { SourceLifecycleService } from "../../src/service/source-lifecycle-service.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { CONFIGURED_HISTORY_SOURCES } from "../../src/imports/types.js";

const NOW = "2026-11-14T12:00:00.000Z";
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Grok CLI history import", () => {
  it("has one configured handler for every wire source", () => {
    expect(Object.keys(CONFIGURED_HISTORY_HANDLERS).sort()).toEqual([...CONFIGURED_HISTORY_SOURCES].sort());
  });

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

  it("never persists malformed encrypted records whose property names use JSON escapes", async () => {
    const fixture = await createFixture();
    const protectedPayloads = [
      "MALFORMED_ENCRYPTED_PAYLOAD", "ESCAPED_PREFIX_PAYLOAD", "ESCAPED_INTERIOR_PAYLOAD", "ESCAPED_ALL_PAYLOAD",
      "ESCAPED_AFTER_BAD_KEY_PAYLOAD", "REASONING_SUMMARY_PAYLOAD", "SYSTEM_PAYLOAD", "UPPERCASE_HEX_PAYLOAD",
      "UPPERCASE_HEX_ENCRYPTED_PAYLOAD"
    ];
    await appendFile(fixture.chatPath,
      `{"type":"reasoning","\\u0065ncrypted_content":"${protectedPayloads[1]}"\n` +
      `{"type":"reasoning","encr\\u0079pted_content":"${protectedPayloads[2]}"\n` +
      `{"type":"reasoning","\\u0065\\u006e\\u0063\\u0072\\u0079\\u0070\\u0074\\u0065\\u0064\\u005f\\u0063\\u006f\\u006e\\u0074\\u0065\\u006e\\u0074":"${protectedPayloads[3]}"\n` +
      `{"bad\\q":"prior malformed key","\\u0065ncrypted_content":"${protectedPayloads[4]}"\n` +
      `{"type":"reasoning","summary":"${protectedPayloads[5]}"\n` +
      `{"role":"system","content":"${protectedPayloads[6]}"\n` +
      `{"type":"reasoning","\\u0065ncrypted_cont\\u0045nt":"${protectedPayloads[7]}"\n` +
      `{"type":"user","encrypted\\u005Fcontent":"${protectedPayloads[8]}"\n` +
      `{"type":"user","content":"SAFE_MALFORMED_PAYLOAD"\n`);
    const candidate = (await discoverGrokCliHistory(fixture.sessionsRoot, NOW))
      .find((item) => item.scopeId === "/workspace/alpha")!;
    const databasePath = join(fixture.root, "encrypted-boundary.sqlite");
    const store = new SqliteStore(databasePath);

    const result = await new GrokCliHistoryImporter(store, { clock: () => NOW })
      .importApprovedSource(approveGrokCliHistory(candidate, "person_1", "default", NOW));
    expect(result.recordsQuarantined).toBe(3);
    const durableBeforeClose = JSON.stringify({
      events: await store.listCanonicalEvents("person_1"),
      quarantine: await store.listQuarantineRecords("person_1", candidate.id)
    });
    expect(durableBeforeClose).toContain("SAFE_MALFORMED_PAYLOAD");
    for (const payload of protectedPayloads) expect(durableBeforeClose).not.toContain(payload);
    store.close();

    const reopened = new SqliteStore(databasePath);
    const durableAfterReopen = JSON.stringify({
      events: await reopened.listCanonicalEvents("person_1"),
      quarantine: await reopened.listQuarantineRecords("person_1", candidate.id)
    });
    for (const payload of protectedPayloads) expect(durableAfterReopen).not.toContain(payload);
    reopened.close();
  });

  it.each(["B", "F", "N", "R", "T", "U"])(
    "quarantines malformed input containing an invalid uppercase \\%s escape",
    async (escape) => {
      const fixture = await createFixture();
      const payload = `INVALID_ESCAPE_${escape}`;
      await appendFile(fixture.chatPath, `{"\\${escape}0065ncrypted_content":"${payload}"\n`);
      const candidate = (await discoverGrokCliHistory(fixture.sessionsRoot, NOW))
        .find((item) => item.scopeId === "/workspace/alpha")!;
      const store = new InMemoryStore();

      await expect(new GrokCliHistoryImporter(store, { clock: () => NOW })
        .importApprovedSource(approveGrokCliHistory(candidate, "person_1", "default", NOW))).resolves.toBeDefined();
      expect(JSON.stringify(await store.listQuarantineRecords("person_1", candidate.id))).toContain(payload);
    }
  );

  it("rejects a candidate whose immutable decoded scope is changed", async () => {
    const fixture = await createFixture();
    const candidate = (await discoverGrokCliHistory(fixture.sessionsRoot, NOW))[0]!;
    const approval = { ...approveGrokCliHistory(candidate, "person_1", "default", NOW), scopeId: "/workspace/other" };
    await expect(new GrokCliHistoryImporter(new InMemoryStore()).importApprovedSource(approval))
      .rejects.toThrow("does not match");
  });

  it("replays checkpointed records when a timestamp sidecar arrives", async () => {
    const fixture = await createFixture();
    await unlink(fixture.eventsPath);
    const candidate = (await discoverGrokCliHistory(fixture.sessionsRoot, NOW))
      .find((item) => item.scopeId === "/workspace/alpha")!;
    const store = new InMemoryStore();
    const importer = new GrokCliHistoryImporter(store, { clock: () => NOW });
    const approval = approveGrokCliHistory(candidate, "person_1", "default", NOW);

    await importer.importApprovedSource(approval);
    expect((await store.listCanonicalEvents("person_1"))[0]?.metadata.sourceMetadata)
      .toMatchObject({ timestampSource: "chat_history_mtime", timestampConfidence: "low" });

    await writeFile(fixture.eventsPath, `${JSON.stringify({ turn_number: 1, ts: "2026-07-01T10:00:00.000Z" })}\n`);
    expect((await importer.importApprovedSource(approval)).messagesProcessed).toBe(4);
    const updated = await store.listCanonicalEvents("person_1");
    expect(updated.slice(0, 3).map((event) => event.occurredAt)).toEqual([
      "2026-07-01T10:00:00.000Z",
      "2026-07-01T10:00:00.000Z",
      "2026-07-01T10:00:00.000Z"
    ]);
    expect(updated[0]?.metadata.sourceMetadata)
      .toMatchObject({ timestampSource: "events_turn", timestampConfidence: "high" });
  });

  it("commits configured timestamp replay updates when a sidecar arrives", async () => {
    const fixture = await createFixture();
    await unlink(fixture.eventsPath);
    const fallbackTime = new Date("2026-07-01T10:00:00.000Z");
    await utimes(fixture.chatPath, fallbackTime, fallbackTime);
    const candidate = (await discoverGrokCliHistory(fixture.sessionsRoot, NOW))
      .find((item) => item.scopeId === "/workspace/alpha")!;
    const databasePath = join(fixture.root, "memory.sqlite");
    const store = new SqliteStore(databasePath);
    await new SourceLifecycleService(store).approve({
      personId: "person_1", candidateId: candidate.id, application: candidate.application,
      format: candidate.format, sourceLocator: candidate.rootPath, profileId: "default",
      scopeId: candidate.scopeId, approvedAt: NOW
    });
    const authority = createProfileAuthority({
      profileName: "default", databasePath, personId: "person_1",
      allowedScopeIds: [candidate.scopeId], ingestScopeId: candidate.scopeId,
      sourceRoots: { grok: candidate.rootPath }, scopeAliases: {}, allowedHosts: null
    });
    const request = { sourceAlias: "grok", source: "grok-cli" as const, requestedAt: NOW };

    const initial = await planConfiguredHistoryImport(store, authority, request);
    await expect(store.commitHistoryImport(initial)).resolves.toMatchObject({ status: "COMMITTED" });
    expect((await store.listCanonicalEvents("person_1"))[0]?.metadata.sourceMetadata)
      .toMatchObject({ timestampSource: "chat_history_mtime", timestampConfidence: "low" });
    expect((await store.listCanonicalEvents("person_1"))[0]?.occurredAt)
      .toBe("2026-07-01T10:00:00.000Z");

    await writeFile(fixture.eventsPath, `${JSON.stringify({ turn_number: 1, ts: "2026-07-01T10:00:00.000Z" })}\n`);
    const replay = await planConfiguredHistoryImport(store, authority, request);
    expect(replay.expectedCanonicalEvents).toHaveLength(3);
    await expect(store.commitHistoryImport(replay)).resolves.toMatchObject({ status: "COMMITTED" });
    const updated = await store.listCanonicalEvents("person_1");
    expect(updated.slice(0, 3).map((event) => event.occurredAt)).toEqual([
      "2026-07-01T10:00:00.000Z",
      "2026-07-01T10:00:00.000Z",
      "2026-07-01T10:00:00.000Z"
    ]);
    expect(updated[0]?.metadata.sourceMetadata)
      .toMatchObject({ timestampSource: "events_turn", timestampConfidence: "high" });
    store.close();

    const reopened = new SqliteStore(databasePath);
    const persisted = await reopened.listCanonicalEvents("person_1");
    expect(persisted[0]?.metadata.sourceMetadata)
      .toMatchObject({ timestampSource: "events_turn", timestampConfidence: "high" });
    expect(persisted[0]?.occurredAt).toBe("2026-07-01T10:00:00.000Z");
    reopened.close();
  });

  it("treats an events sidecar symlink as absent without reading or quarantining its target", async () => {
    const fixture = await createFixture();
    await unlink(fixture.eventsPath);
    await symlink(join(fixture.root, ".grok", "auth.json"), fixture.eventsPath);
    const candidate = (await discoverGrokCliHistory(fixture.sessionsRoot, NOW))
      .find((item) => item.scopeId === "/workspace/alpha")!;
    const store = new InMemoryStore();

    await new GrokCliHistoryImporter(store, { clock: () => NOW })
      .importApprovedSource(approveGrokCliHistory(candidate, "person_1", "default", NOW));

    expect(JSON.stringify(await store.listQuarantineRecords("person_1", candidate.id))).not.toContain("SECRET_AUTH");
    expect((await store.listCanonicalEvents("person_1"))[0]?.metadata.sourceMetadata)
      .toMatchObject({ timestampSource: "chat_history_mtime" });
  });

  it("rejects a durable workspace grant when its directory is replaced by a symlink", async () => {
    const fixture = await createFixture();
    const candidate = (await discoverGrokCliHistory(fixture.sessionsRoot, NOW))
      .find((item) => item.scopeId === "/workspace/alpha")!;
    const store = new InMemoryStore();
    const grant = await new SourceLifecycleService(store).approve({
      personId: "person_1", candidateId: candidate.id, application: candidate.application,
      format: candidate.format, sourceLocator: candidate.rootPath, profileId: "default",
      scopeId: candidate.scopeId, approvedAt: NOW
    });
    const originalWorkspace = `${candidate.rootPath}-approved`;
    const outsideSessions = join(fixture.root, "outside", "sessions");
    const outsideWorkspace = join(outsideSessions, encodeURIComponent(candidate.scopeId));
    await rename(candidate.rootPath, originalWorkspace);
    await mkdir(join(outsideWorkspace, "external-session"), { recursive: true });
    await writeFile(join(outsideWorkspace, "external-session", "chat_history.jsonl"),
      `${JSON.stringify({ type: "user", content: "OUTSIDE_WORKSPACE_CONTENT" })}\n`);
    await symlink(outsideWorkspace, candidate.rootPath);

    await expect(new GrokCliHistoryImporter(store).importApprovedGrantBatch(grant, {
      authority: { kind: "foreground", personId: "person_1", operation: "approved-import" }
    })).rejects.toThrow("regular directory");
    expect(JSON.stringify(await store.listCanonicalEvents("person_1"))).not.toContain("OUTSIDE_WORKSPACE_CONTENT");
  });

  it("allows configured ingestion only for the approved workspace alias and exact authority scope", async () => {
    const fixture = await createFixture();
    const candidate = (await discoverGrokCliHistory(fixture.sessionsRoot, NOW))
      .find((item) => item.scopeId === "/workspace/alpha")!;
    const store = new InMemoryStore();
    await new SourceLifecycleService(store).approve({
      personId: "person_1", candidateId: candidate.id, application: candidate.application,
      format: candidate.format, sourceLocator: candidate.rootPath, profileId: "default",
      scopeId: candidate.scopeId, approvedAt: NOW
    });
    const authority = createProfileAuthority({
      profileName: "default", databasePath: "/tmp/memory.sqlite", personId: "person_1",
      allowedScopeIds: [candidate.scopeId], ingestScopeId: candidate.scopeId,
      sourceRoots: { grok: candidate.rootPath, parent: fixture.sessionsRoot }, scopeAliases: {}, allowedHosts: null
    });

    await expect(planConfiguredHistoryImport(store, authority, {
      sourceAlias: "grok", source: "grok-cli", requestedAt: NOW
    })).resolves.toMatchObject({ candidateId: candidate.id, normalizedParameters: { ingestScopeId: candidate.scopeId } });
    await expect(planConfiguredHistoryImport(store, authority, {
      sourceAlias: "parent", source: "grok-cli", requestedAt: NOW
    })).rejects.toThrow("UNAUTHORIZED_OR_NOT_FOUND");
    const wrongScope = createProfileAuthority({
      ...authority, allowedScopeIds: ["/workspace/other"], ingestScopeId: "/workspace/other"
    });
    await expect(planConfiguredHistoryImport(store, wrongScope, {
      sourceAlias: "grok", source: "grok-cli", requestedAt: NOW
    })).rejects.toThrow("UNAUTHORIZED_OR_NOT_FOUND");
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
    { type: "assistant", content: [] },
    "not-an-object",
    { type: "user", id: "user-2", content: "Second turn" }
  ];
  await writeFile(chatPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n` +
    `{"type":"reasoning","encrypted_content":"MALFORMED_ENCRYPTED_PAYLOAD"\n`);
  const eventsPath = join(alphaSession, "events.jsonl");
  await writeFile(eventsPath, [
    JSON.stringify({ turn_number: 1, ts: "2026-07-01T10:00:00.000Z" }),
    "{malformed"
  ].join("\n") + "\n");
  await writeFile(join(alphaSession, "system_prompt.txt"), "SECRET_SYSTEM_PROMPT");
  await mkdir(join(alphaSession, "nested-sidecar"), { recursive: true });
  await writeFile(join(alphaSession, "nested-sidecar", "chat_history.jsonl"), "NESTED_TRANSCRIPT_MUST_NOT_BE_DISCOVERED");
  await writeFile(join(betaSession, "chat_history.jsonl"), `${JSON.stringify({ type: "user", content: "Beta" })}\n`);
  await writeFile(join(sessionsRoot, "session_search.sqlite"), "not a database");
  await writeFile(join(root, ".grok", "auth.json"), "SECRET_AUTH");
  await symlink(alphaSession, join(beta, "linked-session"));
  return { root, sessionsRoot, chatPath, eventsPath };
}
