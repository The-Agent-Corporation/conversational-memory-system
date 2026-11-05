import { mkdtemp, rm } from "node:fs/promises";
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
});