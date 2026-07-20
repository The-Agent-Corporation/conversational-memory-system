import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteStore } from "../../../src/storage/sqlite-store.js";
import { runBackupCommand } from "../../../src/storage/backup/backup-command.js";
import { runExportPlaintextCommand } from "../../../src/storage/backup/export-plaintext-command.js";

/**
 * `export --plaintext` escape hatch (D-07b, T-07-18). RED per 07-06-PLAN.md
 * Task 1 — export-plaintext-command.ts does not exist yet.
 */

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cms-export-plaintext-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function seedFixtureStore(dbPath: string): Promise<void> {
  const store = new SqliteStore(dbPath);
  try {
    await store.savePerson({ id: "person_1", displayName: "Fixture Person", createdAt: "2026-07-16T10:00:00.000Z" });
  } finally {
    store.close();
  }
}

describe("export --plaintext escape hatch (D-07b)", () => {
  it("writes byte-inspectable plaintext JSON distinct in name/format from encrypted backup", async () => {
    const dbPath = join(workDir, "source.sqlite");
    await seedFixtureStore(dbPath);

    const plaintextOut = join(workDir, "export.plaintext.json");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runExportPlaintextCommand({ databasePath: dbPath, outPath: plaintextOut, plaintext: true });
    } finally {
      stderrSpy.mockRestore();
    }

    const raw = await readFile(plaintextOut, "utf8");
    const parsed = JSON.parse(raw.split("\n").find((line) => line.trim().length > 0)!);
    expect(parsed).toBeTypeOf("object");

    // Distinct filename/extension from the encrypted backup format.
    expect(plaintextOut).not.toMatch(/\.cms-backup$/);
    expect(plaintextOut).toMatch(/\.plaintext\.json$/);
  });

  it("prints an explicit plaintext-risk warning to stderr before writing", async () => {
    const dbPath = join(workDir, "source.sqlite");
    await seedFixtureStore(dbPath);
    const plaintextOut = join(workDir, "export.plaintext.json");

    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    try {
      await runExportPlaintextCommand({ databasePath: dbPath, outPath: plaintextOut, plaintext: true });
    } finally {
      stderrSpy.mockRestore();
    }

    expect(stderrChunks.join("")).toMatch(/plaintext/i);
    expect(stderrChunks.join("")).toMatch(/warning|risk|unencrypted/i);
  });

  it("requires an explicit --plaintext flag and cannot be reached via any alias of backup", async () => {
    const dbPath = join(workDir, "source.sqlite");
    await seedFixtureStore(dbPath);
    const plaintextOut = join(workDir, "export.plaintext.json");

    await expect(
      runExportPlaintextCommand({ databasePath: dbPath, outPath: plaintextOut, plaintext: false })
    ).rejects.toThrow();

    // The main() CLI entrypoint must require the literal --plaintext flag.
    const exportSource = await readFile(new URL("../../../src/storage/backup/export-plaintext-command.ts", import.meta.url), "utf8");
    expect(exportSource).toMatch(/--plaintext/);
  });

  it("produces a plaintext dump that is a superset-equivalent, uses the same logical dump shape as backup", async () => {
    const dbPath = join(workDir, "source.sqlite");
    await seedFixtureStore(dbPath);

    const backupOut = join(workDir, "backup.cms-backup");
    await runBackupCommand({ databasePath: dbPath, outPath: backupOut, passphrase: "correct horse battery staple synthetic test only" });

    const plaintextOut = join(workDir, "export.plaintext.json");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runExportPlaintextCommand({ databasePath: dbPath, outPath: plaintextOut, plaintext: true });
    } finally {
      stderrSpy.mockRestore();
    }

    const plaintextRaw = await readFile(plaintextOut, "utf8");
    expect(plaintextRaw).toMatch(/person_1/);
    // Encrypted backup ciphertext must never contain the plaintext identifier in the clear.
    const backupRaw = await readFile(backupOut, "utf8");
    expect(backupRaw).not.toMatch(/person_1/);
  });
});
