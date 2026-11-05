import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOfflineLocalMcpSmoke } from "../../src/operations/offline-local-mcp-smoke.js";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("offline local MCP smoke", () => {
  it("appends, replays, and searches a fresh profile without a model", async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    delete process.env.OPENROUTER_BASE_URL;
    delete process.env.MEMORY_MODEL_PATH;
    tempDir = await mkdtemp(join(tmpdir(), "cms-offline-smoke-"));
    const result = await runOfflineLocalMcpSmoke(tempDir);
    expect(result).toMatchObject({
      ok: true,
      offline: true,
      profileName: "workspace",
      appended: true,
      replayed: true,
      searchErrored: false,
      eventCount: 1
    });
  });

  it("refuses a supplied directory that already contains files", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cms-offline-smoke-"));
    const profilePath = join(tempDir, "profiles.json");
    await writeFile(profilePath, "{\"keep\":true}\n");
    await expect(runOfflineLocalMcpSmoke(tempDir)).rejects.toThrow(/non-empty directory/);
    expect(await readFile(profilePath, "utf8")).toBe("{\"keep\":true}\n");
    await expect(stat(join(tempDir, "memory.sqlite"))).rejects.toThrow();
  });

  it("rejects an empty directory argument before resolving the working directory", async () => {
    const cwd = process.cwd();
    const targets = ["memory.sqlite", "profiles.json", "sources"].map((name) => join(cwd, name));
    const before = await Promise.all(targets.map(async (path) => stat(path).then((value) => value.mtimeMs).catch(() => null)));
    await expect(runOfflineLocalMcpSmoke("")).rejects.toThrow(/empty directory path/);
    const after = await Promise.all(targets.map(async (path) => stat(path).then((value) => value.mtimeMs).catch(() => null)));
    expect(after).toEqual(before);
  });
});