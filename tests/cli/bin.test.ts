import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../../src/cli/bin.js";
import { REGISTRY } from "../../src/cli/command-registry.js";

describe("memory bin dispatcher", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-bin-test-"));
    process.exitCode = 0;
  });

  afterEach(async () => {
    process.exitCode = 0;
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("dispatches a known subcommand to the corresponding module's exported main(argv)", async () => {
    const databasePath = join(tempDir, "memory.db");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    await dispatch(["status", "--db", databasePath, "--person", "person-1"]);

    expect(process.exitCode).toBe(0);
    const output = writes.join("");
    expect(output).toContain("\"ok\": true");
    expect(output).toContain("\"personId\": \"person-1\"");
  });

  it("writes the sorted available-subcommand list to stderr and sets a non-zero exit for an unknown subcommand", async () => {
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await expect(dispatch(["definitely-not-a-real-subcommand"])).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const output = stderrWrites.join("");
    expect(output).toMatch(/Available:/);
    const availableNames = Object.keys(REGISTRY).sort();
    for (const name of availableNames) {
      expect(output).toContain(name);
    }
  });

  it("writes the sorted available-subcommand list to stderr and sets a non-zero exit for a missing subcommand", async () => {
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await expect(dispatch([])).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    expect(stderrWrites.join("")).toMatch(/Available:/);
  });

  it("exposes a callable main(argv) named export on every registered command module", async () => {
    const subcommandNames = Object.keys(REGISTRY);
    expect(subcommandNames.length).toBeGreaterThan(0);

    for (const name of subcommandNames) {
      const module = await REGISTRY[name]();
      expect(typeof module.main, `REGISTRY["${name}"] module must export a callable main`).toBe("function");
    }
  });
});
