import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { discoverCordisHistory } from "../../src/imports/cordis-discovery.js";
import { CordisHistoryImporter } from "../../src/imports/cordis-importer.js";
import { approveCordisHistory } from "../../src/imports/cordis-discovery.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void };
};

describe("Cordis journal importer", () => {
  it("imports message and tool rows, skips tool results, and forgets in the same batch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cordis-"));
    const databasePath = join(directory, "journal.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      create table journal (
        seq integer primary key,
        session_key text not null,
        kind text not null,
        origin text,
        schema_version integer not null,
        payload text,
        created_at text not null
      );
      insert into journal values
        (1, 'agent:ada', 'session.start', null, 1, '{}', '2026-10-16T00:00:00.000Z'),
        (2, 'agent:ada', 'message.user', null, 1, '{"text":"remember the garden"}', '2026-10-16T00:00:01.000Z'),
        (3, 'agent:ada', 'tool.call', null, 1, '{"text":"lookup"}', '2026-10-16T00:00:02.000Z'),
        (4, 'agent:ada', 'tool.result', null, 1, '{"text":"secret result"}', '2026-10-16T00:00:03.000Z'),
        (5, 'agent:ada', 'message.assistant', 'cron', 1, '{"text":"heartbeat note"}', '2026-10-16T00:00:04.000Z'),
        (6, 'agent:ada', 'weird.kind', null, 1, '{}', '2026-10-16T00:00:05.000Z'),
        (7, 'agent:ada', 'forget', null, 1, '{"seq":2}', '2026-10-16T00:00:06.000Z');
    `);
    database.close();

    const candidate = await discoverCordisHistory(databasePath, "2026-10-16T00:01:00.000Z");
    expect(candidate.application).toBe("cordis");
    const store = new InMemoryStore();
    await store.savePerson({ id: "person-ada", displayName: "Ada", createdAt: "2026-10-16T00:00:00.000Z" });
    const importer = new CordisHistoryImporter(store, { clock: () => "2026-10-16T00:01:00.000Z" });
    const result = await importer.importApprovedSource(approveCordisHistory(candidate, "person-ada", "ada", "2026-10-16T00:01:00.000Z", "agent:ada"));
    expect(result.recordsSkipped).toBeGreaterThan(0);
    expect(result.recordsQuarantined).toBe(1);
    const events = await store.listCanonicalEvents("person-ada");
    expect(events.some((event) => event.content.includes("secret result"))).toBe(false);
    expect(events.some((event) => event.eventKind === "tool_call")).toBe(true);
    expect(importer.forgetNativeEventIds).toEqual(["2"]);
    const remembered = events.find((event) => event.nativeEventId === "2");
    expect(remembered).toBeTruthy();
    await store.commitEventDeletion({
      personId: "person-ada",
      canonicalEventId: remembered!.id,
      deletedAt: "2026-10-16T00:02:00.000Z",
      actor: "cordis-journal",
      reason: "journal forget"
    });
    expect(await store.listCanonicalEvents("person-ada")).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nativeEventId: "2" })
    ]));
    const again = await importer.importApprovedSource(approveCordisHistory(candidate, "person-ada", "ada", "2026-10-16T00:03:00.000Z", "agent:ada"));
    expect(again.messagesProcessed).toBe(0);
    expect((await store.listCanonicalEvents("person-ada")).some((event) => event.content.includes("garden"))).toBe(false);
  });
});
