import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCodexDiscoverCommand } from "../../src/imports/codex-discover-command.js";
import { runCodexImportCommand } from "../../src/imports/codex-import-command.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import { runSourceRevokeCommand } from "../../src/imports/source-revoke-command.js";
import { runSourceDeleteCommand } from "../../src/imports/source-delete-command.js";
import { runBootstrapCommand } from "../../src/bootstrap/bootstrap-command.js";
import {
  runQuarantineListCommand,
  runQuarantineReplayCommand
} from "../../src/imports/quarantine-command.js";

const RESOURCE_PATH = "sessions/2026/07/16/rollout-test-session.jsonl";

describe("Codex import commands", () => {
  let tempRoot: string;
  let databasePath: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "codex-command-"));
    databasePath = join(tempRoot, "memory.sqlite");
    const rolloutPath = join(tempRoot, RESOURCE_PATH);
    await mkdir(dirname(rolloutPath), { recursive: true });
    await writeFile(rolloutPath, [
      JSON.stringify({
        timestamp: "2026-07-16T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "session-1" }
      }),
      JSON.stringify({
        timestamp: "2026-07-16T10:01:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Build personal memory." }]
        }
      }),
      ""
    ].join("\n"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("returns an approval-required manifest before import", async () => {
    const result = await runCodexDiscoverCommand({
      rootPath: tempRoot,
      discoveredAt: "2026-07-16T12:00:00.000Z"
    });

    expect(result).toMatchObject({
      ok: true,
      approvalRequired: true,
      candidate: {
        application: "codex",
        sessionCount: 1
      }
    });
  });

  it("refuses import until the exact discovered candidate is approved", async () => {
    await expect(runCodexImportCommand({
      databasePath,
      rootPath: tempRoot,
      approvedCandidateId: "codex_unapproved",
      personId: "person_1",
      requestedAt: "2026-07-16T12:00:00.000Z"
    })).rejects.toThrow("requires approval");
  });

  it("imports an approved candidate into persistent personal memory", async () => {
    const discovery = await runCodexDiscoverCommand({
      rootPath: tempRoot,
      discoveredAt: "2026-07-16T12:00:00.000Z"
    });
    const result = await runCodexImportCommand({
      databasePath,
      rootPath: tempRoot,
      approvedCandidateId: discovery.candidate.id,
      personId: "person_1",
      scopeId: "workspace_alpha",
      requestedAt: "2026-07-16T12:00:00.000Z"
    });

    expect(result).toMatchObject({
      ok: true,
      candidateId: discovery.candidate.id,
      import: { messagesProcessed: 1 },
      canonicalEventCount: 1,
      checkpointCount: 1
    });
    await runBootstrapCommand({ databasePath, personId: "person_1" });

    const store = new SqliteStore(databasePath);
    await expect(store.listCanonicalEvents("person_1")).resolves.toEqual([
      expect.objectContaining({
        sourceApplication: "codex",
        nativeSessionId: "session-1",
        scopeId: "workspace_alpha",
        content: "Build personal memory."
      })
    ]);
    await expect(store.listSources("person_1")).resolves.toEqual([
      expect.objectContaining({ scopeId: "workspace_alpha" })
    ]);
    await expect(store.listSourceGrants("person_1")).resolves.toEqual([
      expect.objectContaining({ scopeId: "workspace_alpha" })
    ]);
    await expect(store.listSummaries()).resolves.toEqual([
      expect.objectContaining({ personId: "person_1", scopeIds: ["workspace_alpha"] })
    ]);
    store.close();
  });

  it("deletes imported and derived memory after revocation without modifying native history", async () => {
    const discovery = await runCodexDiscoverCommand({ rootPath: tempRoot });
    await runCodexImportCommand({
      databasePath,
      rootPath: tempRoot,
      approvedCandidateId: discovery.candidate.id,
      personId: "person_1",
      requestedAt: "2026-07-16T12:00:00.000Z"
    });
    await runBootstrapCommand({ databasePath, personId: "person_1" });
    const rolloutPath = join(tempRoot, RESOURCE_PATH);
    const nativeHistoryBefore = await readFile(rolloutPath, "utf8");

    await runSourceRevokeCommand({
      databasePath,
      personId: "person_1",
      candidateId: discovery.candidate.id,
      requestedAt: "2026-07-16T12:05:00.000Z"
    });
    const deletion = await runSourceDeleteCommand({
      databasePath,
      personId: "person_1",
      candidateId: discovery.candidate.id,
      confirmedCandidateId: discovery.candidate.id,
      requestedAt: "2026-07-16T12:06:00.000Z"
    });

    expect(deletion.deletion).toMatchObject({
      deletedCanonicalEventCount: 1,
      deletedSourceCount: 1,
      supersededSummaryCount: 1
    });
    await expect(readFile(rolloutPath, "utf8")).resolves.toBe(nativeHistoryBefore);
    const store = new SqliteStore(databasePath);
    await expect(store.listCanonicalEvents("person_1")).resolves.toEqual([]);
    await expect(store.listSources("person_1")).resolves.toEqual([]);
    await expect(store.listSummaries()).resolves.toEqual([
      expect.objectContaining({ state: "superseded" })
    ]);
    await expect(store.listSourceLifecycleAuditEvents("person_1")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "revoked" }),
        expect.objectContaining({ action: "deletion_requested" }),
        expect.objectContaining({ action: "deletion_completed" })
      ])
    );
    store.close();
  });

  it("replays quarantined records only after exact confirmation and a source re-import", async () => {
    const rolloutPath = join(tempRoot, RESOURCE_PATH);
    await appendFile(rolloutPath, "malformed token=sk-abcdefghijklmnopqrstuvwxyz\n");
    const discovery = await runCodexDiscoverCommand({ rootPath: tempRoot });
    await runCodexImportCommand({
      databasePath,
      rootPath: tempRoot,
      approvedCandidateId: discovery.candidate.id,
      personId: "person_1",
      requestedAt: "2026-07-16T12:00:00.000Z"
    });
    await expect(runQuarantineReplayCommand({
      databasePath,
      personId: "person_1",
      candidateId: discovery.candidate.id,
      confirmedCandidateId: "wrong"
    })).rejects.toThrow(/confirmation/);
    await expect(runQuarantineReplayCommand({
      databasePath,
      personId: "person_1",
      candidateId: discovery.candidate.id,
      confirmedCandidateId: discovery.candidate.id,
      requestedAt: "2026-07-16T12:05:00.000Z"
    })).resolves.toMatchObject({ recordCount: 1 });

    const beforeReplay = await runQuarantineListCommand({ databasePath, personId: "person_1" });
    expect(beforeReplay.records[0]).toMatchObject({
      state: "replay_requested",
      sanitizedRecord: "malformed token=[REDACTED]"
    });
    const originalLines = (await readFile(rolloutPath, "utf8")).trimEnd().split("\n").slice(0, 2);
    await writeFile(rolloutPath, `${originalLines.join("\n")}\n${JSON.stringify({
      timestamp: "2026-07-16T10:02:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "search",
        call_id: "replayed-call",
        arguments: JSON.stringify({ query: "memory design" })
      }
    })}\n`);
    await runCodexImportCommand({
      databasePath,
      rootPath: tempRoot,
      approvedCandidateId: discovery.candidate.id,
      personId: "person_1",
      requestedAt: "2026-07-16T12:06:00.000Z"
    });

    const afterReplay = await runQuarantineListCommand({ databasePath, personId: "person_1" });
    expect(afterReplay.records[0]).toMatchObject({ state: "replayed" });
    const store = new SqliteStore(databasePath);
    await expect(store.listCanonicalEvents("person_1")).resolves.toEqual([
      expect.objectContaining({ eventKind: "message" }),
      expect.objectContaining({ eventKind: "tool_call", nativeEventId: "replayed-call" })
    ]);
    await expect(store.listSourceLifecycleAuditEvents("person_1")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "quarantine_replay_requested" })])
    );
    store.close();
  });
});
