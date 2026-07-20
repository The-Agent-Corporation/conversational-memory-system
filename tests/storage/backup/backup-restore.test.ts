import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LibsodiumCryptoProvider } from "../../../src/sync/crypto/libsodium-crypto-provider.js";
import { ARGON2ID_REVIEWED_FLOOR } from "../../../src/sync/crypto/crypto-provider.js";
import { SqliteStore } from "../../../src/storage/sqlite-store.js";
import { openBackup, sealBackup } from "../../../src/storage/backup/backup-crypto.js";
import { runBackupCommand } from "../../../src/storage/backup/backup-command.js";
import { runRestoreCommand } from "../../../src/storage/backup/restore-command.js";

/**
 * Encrypted backup/restore round-trip, uniform-failure, ADR 0047 domain
 * separation, and atomic-write coverage (D-07, T-07-17..T-07-21). RED per
 * 07-06-PLAN.md Task 1 — backup-crypto/backup-command/restore-command do not
 * exist yet.
 */

const PASSPHRASE = "correct horse battery staple synthetic test only";
const provider = new LibsodiumCryptoProvider();

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cms-backup-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function seedFixtureStore(dbPath: string): Promise<{ personCount: number; eventCount: number }> {
  const store = new SqliteStore(dbPath);
  try {
    await store.savePerson({ id: "person_1", displayName: "Fixture Person", createdAt: "2026-07-16T10:00:00.000Z" });
    await store.saveSource({
      id: "source_1",
      personId: "person_1",
      application: "codex",
      profileId: "default",
      instanceId: "default",
      createdAt: "2026-07-16T10:00:00.000Z",
      lastImportedAt: "2026-07-16T10:00:00.000Z"
    });
    await store.saveCanonicalEvent({
      id: "event_1",
      personId: "person_1",
      sourceId: "source_1",
      sourceApplication: "codex",
      sourceProfileId: "default",
      nativeSessionId: "session_1",
      nativeEventId: "native_1",
      nativeSequence: 1,
      causalParentId: null,
      role: "user",
      content: "synthetic fixture text",
      occurredAt: "2026-07-16T10:05:00.000Z",
      importedAt: "2026-07-16T10:05:00.000Z",
      provenance: "direct_user_input",
      trustLevel: "high",
      contentHash: "hash_1",
      parserVersion: "codex-jsonl/v1",
      metadata: {}
    });
    return { personCount: 1, eventCount: 1 };
  } finally {
    store.close();
  }
}

describe("encrypted backup / restore round-trip (D-07)", () => {
  it("restores a logically equivalent dataset from an encrypted backup", async () => {
    const dbPath = join(workDir, "source.sqlite");
    await seedFixtureStore(dbPath);

    const backupOut = join(workDir, "backup.cms-backup");
    await runBackupCommand({ databasePath: dbPath, outPath: backupOut, passphrase: PASSPHRASE });

    const restoreOut = join(workDir, "restored.sqlite");
    await runRestoreCommand({ backupPath: backupOut, outPath: restoreOut, passphrase: PASSPHRASE });

    const restored = new SqliteStore(restoreOut, { readOnly: true });
    try {
      const people = await restored.listPeople();
      const events = await restored.listCanonicalEvents("person_1");
      expect(people).toHaveLength(1);
      expect(people[0]!.id).toBe("person_1");
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe("event_1");
    } finally {
      restored.close();
    }
  });

  it("fails wrong-passphrase and single-byte-tampered ciphertext identically (uniform, content-free)", async () => {
    const dbPath = join(workDir, "source.sqlite");
    await seedFixtureStore(dbPath);
    const backupOut = join(workDir, "backup.cms-backup");
    await runBackupCommand({ databasePath: dbPath, outPath: backupOut, passphrase: PASSPHRASE });

    const envelopeRaw = JSON.parse(await readFile(backupOut, "utf8"));

    let wrongPassphraseError: unknown;
    try {
      openBackup(provider, "definitely not the passphrase", envelopeRaw);
    } catch (error) {
      wrongPassphraseError = error;
    }
    expect(wrongPassphraseError).toBeInstanceOf(Error);

    const tampered = { ...envelopeRaw, ciphertext: tamperBase64Url(envelopeRaw.ciphertext) };
    let tamperedError: unknown;
    try {
      openBackup(provider, PASSPHRASE, tampered);
    } catch (error) {
      tamperedError = error;
    }
    expect(tamperedError).toBeInstanceOf(Error);

    expect((wrongPassphraseError as Error).message).toBe((tamperedError as Error).message);
    // Content-free: the error must not embed the passphrase, plaintext, or path.
    expect((wrongPassphraseError as Error).message).not.toMatch(/passphrase|synthetic fixture|source\.sqlite/i);
  });

  it("keeps backup cryptographically inert against the sync passphrase-recovery domain, and vice versa", async () => {
    const dbPath = join(workDir, "source.sqlite");
    await seedFixtureStore(dbPath);
    const backupOut = join(workDir, "backup.cms-backup");
    await runBackupCommand({ databasePath: dbPath, outPath: backupOut, passphrase: PASSPHRASE });
    const backupEnvelope = JSON.parse(await readFile(backupOut, "utf8"));
    expect(backupEnvelope.domain).toBe("cms.backup.v1/passphrase-package");

    // A sync-domain passphrase package must not open as a backup envelope.
    const salt = provider.randomBytes(16);
    const syncPackage = provider.wrapWithPassphrase(PASSPHRASE, provider.randomBytes(32), {
      opsLimit: ARGON2ID_REVIEWED_FLOOR.opsLimit,
      memLimit: ARGON2ID_REVIEWED_FLOOR.memLimit,
      salt
    });
    expect(() =>
      openBackup(provider, PASSPHRASE, {
        domain: "cms.backup.v1/passphrase-package",
        opsLimit: syncPackage.opsLimit,
        memLimit: syncPackage.memLimit,
        salt: Buffer.from(syncPackage.salt).toString("base64url"),
        nonce: Buffer.from(syncPackage.nonce).toString("base64url"),
        ciphertext: Buffer.from(syncPackage.ciphertext).toString("base64url"),
        schemaVersion: 1,
        createdAt: "2026-07-16T10:00:00.000Z"
      })
    ).toThrow();

    // A backup envelope must not open under the sync unwrap path (different domain AAD).
    const sealed = sealBackup(provider, PASSPHRASE, new TextEncoder().encode("synthetic"), 1, "2026-07-16T10:00:00.000Z");
    expect(() =>
      provider.unwrapWithPassphrase(PASSPHRASE, {
        algorithm: "argon2id",
        opsLimit: sealed.opsLimit,
        memLimit: sealed.memLimit,
        salt: Buffer.from(sealed.salt, "base64url"),
        nonce: Buffer.from(sealed.nonce, "base64url"),
        ciphertext: Buffer.from(sealed.ciphertext, "base64url")
      })
    ).toThrow();
  });

  it("never imports the sync wrapWithPassphrase/unwrapWithPassphrase wrapper into backup code", async () => {
    const backupCryptoSource = await readFile(new URL("../../../src/storage/backup/backup-crypto.ts", import.meta.url), "utf8");
    const backupCommandSource = await readFile(new URL("../../../src/storage/backup/backup-command.ts", import.meta.url), "utf8");
    const restoreCommandSource = await readFile(new URL("../../../src/storage/backup/restore-command.ts", import.meta.url), "utf8");
    for (const source of [backupCryptoSource, backupCommandSource, restoreCommandSource]) {
      expect(source).not.toMatch(/\bwrapWithPassphrase\b/);
      expect(source).not.toMatch(/\bunwrapWithPassphrase\b/);
    }
  });

  it("never leaves a truncated final backup file when a write is interrupted (atomic temp+rename)", async () => {
    const dbPath = join(workDir, "source.sqlite");
    await seedFixtureStore(dbPath);
    const backupOut = join(workDir, "backup.cms-backup");

    // Simulate an interrupted write: a partial .tmp file exists, but no
    // rename ever occurred, so the final path must never exist as a
    // truncated/partial artifact.
    await writeFile(`${backupOut}.tmp`, "PARTIAL-NOT-A-REAL-BACKUP");

    await runBackupCommand({ databasePath: dbPath, outPath: backupOut, passphrase: PASSPHRASE });

    // After a real (non-interrupted) run, the final file must be complete
    // and openable — the leftover stale .tmp must not have corrupted it.
    const finalContents = JSON.parse(await readFile(backupOut, "utf8"));
    const opened = openBackup(provider, PASSPHRASE, finalContents);
    expect(opened.length).toBeGreaterThan(0);

    // Directly verify the rename-on-complete discipline: writing to a temp
    // path then renaming must never leave the destination truncated even if
    // the process were killed between write and rename — assert by
    // construction that runBackupCommand's on-disk temp file is gone after
    // success (no orphaned partial artifact remains beside the final file).
    let tmpStillExists = true;
    try {
      await readFile(`${backupOut}.tmp`);
    } catch {
      tmpStillExists = false;
    }
    // The final rename() must have replaced/removed the .tmp path.
    expect(tmpStillExists).toBe(false);
  });
});

function tamperBase64Url(value: string): string {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] = bytes[0]! ^ 0xff;
  return bytes.toString("base64url");
}
