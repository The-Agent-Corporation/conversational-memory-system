import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRoscoeMemoryEnvironment,
  runHermesMemorySmokeHarness
} from "../../src/integrations/hermes/smoke-harness.js";

let tempDir: string | null = null;

const makeTempDir = async (): Promise<string> => {
  tempDir = await mkdtemp(join(tmpdir(), "cms-hermes-smoke-"));
  return tempDir;
};

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("Hermes memory smoke harness", () => {
  it("proves MCP ingest, read-only search, and resume share one profile without Hermes privileges", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");

    const result = await runHermesMemorySmokeHarness({ databasePath });

    expect(result.ok).toBe(true);
    expect(result.databasePath).toBe(databasePath);
    expect(result.ingestedTurnIds).toHaveLength(4);
    expect(result.replay.status).toBe("REPLAYED");
    expect(result.eventCount).toBe(4);
    expect(result.compaction.status).toBe("IGNORED_CONTROL");
    expect(result.compaction.summaryId).toBeNull();
    expect(result.injection.readOnly).toBe(true);
    expect(result.injection.packet).toBeNull();
    expect(result.injectionCount).toBe(0);
    expect(result.resumeNotFound).toBe(true);
    expect(result.sleep.ok).toBe(true);
    // GAP-12-E, plan 13-01, ADR 0061: was a shared-term trace id such as trace_smith_pip_provider_bill.
    expect(result.sleep.proposedTraceIds).toEqual([]);
    expect(result.roscoeEnvironment.HERMES_CONVERSATIONAL_MEMORY_COMMAND).toContain("--config");
    expect(result.roscoeEnvironment.HERMES_CONVERSATIONAL_MEMORY_COMMAND).toContain("--profile hermes");
    expect(result.roscoeEnvironment.HERMES_CONVERSATIONAL_MEMORY_COMMAND).not.toContain("--db");
  });

  it("prints Roscoe environment commands for the same database path", () => {
    const env = buildRoscoeMemoryEnvironment({
      databasePath: "/tmp/memory.sqlite",
      configPath: "/tmp/profiles.json",
      profileName: "hermes",
      projectRoot: "/repo/conversational-memory-system"
    });

    expect(env.HERMES_CONVERSATIONAL_MEMORY_DB).toBe("/tmp/memory.sqlite");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_ENABLED).toBe("1");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_INJECT_ENABLED).toBe("1");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_COMMAND).toBe(
      "npm --silent --prefix /repo/conversational-memory-system run hermes:ingest -- --config /tmp/profiles.json --profile hermes"
    );
    expect(env.HERMES_CONVERSATIONAL_MEMORY_TIMEOUT).toBe("10");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_INJECT_COMMAND).toBe(
      "npm --silent --prefix /repo/conversational-memory-system run hermes:inject -- --config /tmp/profiles.json --profile hermes"
    );
    expect(env.HERMES_CONVERSATIONAL_MEMORY_INJECT_TIMEOUT).toBe("10");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_MAX_TOKENS).toBe("120");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_RESUME_COMMAND).toBe(
      "npm --silent --prefix /repo/conversational-memory-system run hermes:resume -- --config /tmp/profiles.json --profile hermes"
    );
    expect(env.HERMES_CONVERSATIONAL_MEMORY_RESUME_TIMEOUT).toBe("10");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_SLEEP_COMMAND).toBe(
      "npm --silent --prefix /repo/conversational-memory-system run hermes:sleep -- --db /tmp/memory.sqlite"
    );
    expect(env.HERMES_CONVERSATIONAL_MEMORY_SLEEP_TIMEOUT).toBe("60");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_LIST_COMMAND).toBe(
      "npm --silent --prefix /repo/conversational-memory-system run hermes:proposals:list -- --db /tmp/memory.sqlite"
    );
    expect(env.HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_APPROVE_COMMAND).toBe(
      "npm --silent --prefix /repo/conversational-memory-system run hermes:proposals:approve -- --db /tmp/memory.sqlite"
    );
    expect(env.HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_REJECT_COMMAND).toBe(
      "npm --silent --prefix /repo/conversational-memory-system run hermes:proposals:reject -- --db /tmp/memory.sqlite"
    );
  });
});
