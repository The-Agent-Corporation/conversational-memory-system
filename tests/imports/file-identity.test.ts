import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveClaudeHistory, discoverClaudeHistory } from "../../src/imports/claude-discovery.js";
import { ClaudeHistoryImporter } from "../../src/imports/claude-importer.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import {
  FILE_IDENTITY_PREFIX,
  composeFileIdentity,
  fileIdentityMatches
} from "../../src/imports/file-identity.js";

/**
 * Regression cover for the defect that silently disabled import resume across the whole corpus:
 * `fileIdentity` was `${st.dev}:${st.ino}`, and macOS APFS reassigns `st_dev` at mount time. A
 * single reboot moved every file `16777234 -> 16777232`, invalidating all 6,758 checkpoints with
 * the inodes unchanged, so each scan re-read ~9.2 GB from offset 0 and imported nothing.
 */
describe("file identity", () => {
  const file = { ino: 117357492, birthtimeMs: 1783954886901.4133 };

  it("is unchanged when only the device number moves", () => {
    // The exact live transition, as two full stat results for the same file. Passed through
    // variables so the extra `dev` reaches the function: if any device-derived value ever re-enters
    // the identity, these stop being equal and the corpus-wide resume failure returns.
    const statBeforeReboot = { dev: 16777234, ino: file.ino, birthtimeMs: file.birthtimeMs, size: 4096 };
    const statAfterReboot = { dev: 16777232, ino: file.ino, birthtimeMs: file.birthtimeMs, size: 4096 };
    expect(composeFileIdentity(statAfterReboot)).toBe(composeFileIdentity(statBeforeReboot));
    expect(fileIdentityMatches(composeFileIdentity(statBeforeReboot), statAfterReboot)).toBe(true);
  });

  it("never embeds a device number", () => {
    expect(composeFileIdentity(file)).toBe(`${FILE_IDENTITY_PREFIX}117357492:1783954886901`);
    expect(composeFileIdentity(file)).not.toContain("16777234");
  });

  it("truncates sub-millisecond birthtime so an identity compares equal to itself", () => {
    expect(composeFileIdentity({ ino: 1, birthtimeMs: 10.9999 }))
      .toBe(composeFileIdentity({ ino: 1, birthtimeMs: 10.0001 }));
  });

  it("tolerates a filesystem that reports no birthtime", () => {
    expect(composeFileIdentity({ ino: 7, birthtimeMs: Number.NaN })).toBe(`${FILE_IDENTITY_PREFIX}7:0`);
  });

  describe("legacy dev:ino checkpoints", () => {
    it("resumes when the inode still matches, ignoring the stored device", () => {
      // This is what rescues the 6,758 existing checkpoints. Without it, shipping the fix would
      // invalidate every one of them and force exactly the full re-parse it exists to prevent.
      expect(fileIdentityMatches("16777234:117357492", file)).toBe(true);
      expect(fileIdentityMatches("16777232:117357492", file)).toBe(true);
    });

    it("does not resume when the inode genuinely differs", () => {
      expect(fileIdentityMatches("16777234:999", file)).toBe(false);
    });

    it("rejects malformed stored values rather than resuming from a wrong offset", () => {
      for (const stored of ["", "117357492", "a:b:c", ":"]) {
        expect(fileIdentityMatches(stored, file)).toBe(false);
      }
    });
  });

  describe("inode reuse", () => {
    it("does not resume when a new file inherits a deleted file's inode", () => {
      // The one thing `dev` nominally guarded. A replacement file has a later birthtime, so it is
      // re-read from offset 0 rather than resumed mid-file at a meaningless byte offset.
      const original = composeFileIdentity(file);
      const replacement = { ino: file.ino, birthtimeMs: file.birthtimeMs + 5_000 };
      expect(fileIdentityMatches(original, replacement)).toBe(false);
    });
  });
});

/**
 * The end-to-end half. The unit tests above prove the comparison; this proves the importer actually
 * resumes across the failure that occurred in production, and — critically — that it does so for
 * the legacy `dev:ino` checkpoints already sitting in the live store.
 *
 * The discriminator is `messagesProcessed`, not the event count. Content-hash dedupe hides a
 * re-read from the event count entirely, which is exactly why this bug survived unnoticed: the
 * corpus stayed correct while every scan re-parsed 9.2 GB.
 */
describe("import resume across a device-number change", () => {
  const NOW = "2026-07-16T12:00:00.000Z";
  let root: string;

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "file-identity-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  const record = (uuid: string, parentUuid: string | null, text: string, timestamp = NOW) =>
    JSON.stringify({
      type: "user", uuid, parentUuid, sessionId: "session-1", timestamp, isSidechain: false,
      message: { role: "user", content: [{ type: "text", text }] }
    });

  it("resumes a legacy dev:ino checkpoint instead of re-reading the file", async () => {
    const resourcePath = "projects/-workspace/session-1.jsonl";
    const absolutePath = join(root, resourcePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${record("u1", null, "First message.")}\n`);

    const store = new InMemoryStore();
    const candidate = await discoverClaudeHistory(root, NOW);
    const approval = approveClaudeHistory(candidate, "person_1", "default", NOW);
    const importer = new ClaudeHistoryImporter(store, { clock: () => NOW });

    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({ messagesProcessed: 1 });

    // Rewrite the checkpoint the way it exists in the live store today: the legacy `dev:ino` format,
    // carrying the pre-reboot device number. The inode is real and unchanged — the only thing that
    // moved is the device, which is precisely the production failure.
    const [checkpoint] = await store.listImportCheckpoints("person_1");
    expect(checkpoint.byteOffset).toBeGreaterThan(0);
    const { ino } = await stat(absolutePath);
    await store.saveImportCheckpoint({ ...checkpoint, fileIdentity: `16777234:${ino}` });

    await appendFile(absolutePath, `${record("u2", "u1", "Second message.", "2026-07-16T12:01:00.000Z")}\n`);

    // 1, not 2. Under the old identity the legacy value could never match, the file was re-read from
    // offset 0, and this reported 2.
    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({ messagesProcessed: 1 });
    await expect(store.listCanonicalEvents("person_1")).resolves.toHaveLength(2);

    // ...and the checkpoint has migrated itself to the stable format, so it never pays this again.
    const [migrated] = await store.listImportCheckpoints("person_1");
    expect(migrated.fileIdentity.startsWith(FILE_IDENTITY_PREFIX)).toBe(true);
    expect(migrated.fileIdentity).toBe(composeFileIdentity(await stat(absolutePath)));
  });

  it("re-reads from zero when the inode genuinely differs", async () => {
    const resourcePath = "projects/-workspace/session-1.jsonl";
    const absolutePath = join(root, resourcePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${record("u1", null, "First message.")}\n`);

    const store = new InMemoryStore();
    const approval = approveClaudeHistory(await discoverClaudeHistory(root, NOW), "person_1", "default", NOW);
    const importer = new ClaudeHistoryImporter(store, { clock: () => NOW });
    await importer.importApprovedSource(approval);

    const [checkpoint] = await store.listImportCheckpoints("person_1");
    await store.saveImportCheckpoint({ ...checkpoint, fileIdentity: "16777234:999999999" });

    // A different file entirely: resuming at the stored offset would be silent corruption, so the
    // importer must start over. Dedupe then collapses it back to one event.
    await expect(importer.importApprovedSource(approval)).resolves.toMatchObject({ messagesProcessed: 1 });
    await expect(store.listCanonicalEvents("person_1")).resolves.toHaveLength(1);
  });
});
