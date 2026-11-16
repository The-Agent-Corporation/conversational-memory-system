import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
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
  it("proves the deterministic lifecycle while keeping live Hermes commands profile-bound", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");

    const result = await runHermesMemorySmokeHarness({ databasePath });

    expect(result.ok).toBe(true);
    expect(result.databasePath).toBe(databasePath);
    expect(result.ingestedTurnIds).toHaveLength(4);
    expect(result.eventCount).toBe(4);
    expect(result.compaction.status).toBe("COMPACTED");
    expect(result.compaction.summaryId).toBe("summary_profile:default_4_5");
    expect(result.injection.readOnly).toBe(false);
    expect(result.injection.packet.sourceSummaryIds).toEqual(expect.arrayContaining([
      "summary_profile:default_1_2",
      "summary_profile:default_4_5"
    ]));
    expect(result.injectionCount).toBe(1);
    expect(result.resume.turnCount).toBe(4);
    expect(result.resume.contextBlock).toContain("[USER]: Let's talk about Smith PIP provider bill review.");
    expect(result.sleep.ok).toBe(true);
    expect(result.proposals.count).toBeGreaterThanOrEqual(2);
    expect(result.proposals.proposals.every((proposal) => proposal.state === "proposed")).toBe(true);
    // GAP-12-E, plan 13-01, ADR 0061: was a shared-term trace id such as trace_smith_pip_provider_bill.
    expect(result.sleep.proposedTraceIds).toEqual([]);
    expect(result.roscoeEnvironment.HERMES_CONVERSATIONAL_MEMORY_COMMAND).toContain("--config");
    expect(result.roscoeEnvironment.HERMES_CONVERSATIONAL_MEMORY_COMMAND).toContain("--profile hermes");
    expect(result.roscoeEnvironment.HERMES_CONVERSATIONAL_MEMORY_COMMAND).not.toContain("--db");

    const reopened = new SqliteStore(databasePath);
    expect((await reopened.listSummaries()).map((summary) => summary.id)).toEqual(expect.arrayContaining([
      "summary_profile:default_1_2",
      "summary_profile:default_4_5"
    ]));
    reopened.close();
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

  it("uses the selected profile authority for lifecycle writes and emitted commands", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "custom.sqlite");
    const configPath = join(dir, "profiles.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      profiles: {
        custom: {
          databasePath,
          personId: "person_custom",
          allowedScopeIds: ["matter-a"],
          ingestScopeId: "matter-a",
          sourceRoots: {},
          scopeAliases: {},
          allowInjection: true
        }
      }
    }));

    const result = await runHermesMemorySmokeHarness({ databasePath, configPath, profileName: "custom" });
    expect(result.eventCount).toBe(4);
    expect(result.roscoeEnvironment.HERMES_CONVERSATIONAL_MEMORY_PROFILE).toBe("custom");
    expect(result.roscoeEnvironment.HERMES_CONVERSATIONAL_MEMORY_COMMAND).toContain("--profile custom");

    const reopened = new SqliteStore(databasePath);
    expect(await reopened.listCanonicalEvents("person_smoke")).toHaveLength(0);
    expect(await reopened.listCanonicalEvents("person_custom")).toHaveLength(4);
    reopened.close();
  });

  it("rejects a profile bound to a different database", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "smoke.sqlite");
    const configPath = join(dir, "profiles.json");
    await writeFile(configPath, JSON.stringify({
      version: 1,
      profiles: {
        custom: {
          databasePath: join(dir, "other.sqlite"),
          personId: "person_custom",
          allowedScopeIds: ["matter-a"],
          ingestScopeId: "matter-a",
          sourceRoots: {},
          scopeAliases: {}
        }
      }
    }));

    await expect(runHermesMemorySmokeHarness({ databasePath, configPath, profileName: "custom" }))
      .rejects.toThrow("database must match");
  });
});
