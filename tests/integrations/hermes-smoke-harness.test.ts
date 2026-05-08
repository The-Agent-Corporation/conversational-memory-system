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
  it("proves ingest, compaction, injection, resume, sleep, and proposal listing share one SQLite store", async () => {
    const dir = await makeTempDir();
    const databasePath = join(dir, "memory.sqlite");

    const result = await runHermesMemorySmokeHarness({ databasePath });

    expect(result.ok).toBe(true);
    expect(result.databasePath).toBe(databasePath);
    expect(result.compaction.summaryId).toBe("summary_profile:default_4_5");
    expect(result.injection.packet?.sourceSummaryIds).toEqual(expect.arrayContaining([
      "summary_profile:default_1_2",
      "summary_profile:default_4_5"
    ]));
    expect(result.injection.packet?.selectedMemory).toContain("Smith PIP");
    expect(result.injection.packet?.selectedMemory).toContain("provider bill");
    expect(result.injection.contextBlock).toContain("<memory-context>");
    expect(result.injection.contextBlock).toContain("Smith PIP");
    expect(result.resume.turnCount).toBe(4);
    expect(result.resume.contextBlock).toContain("<memory-resume>");
    expect(result.resume.contextBlock).toContain("[USER]: Let's talk about Smith PIP provider bill review.");
    expect(result.resume.contextBlock).toContain("[ASSISTANT]: The Smith PIP provider bill deadline is June 1.");
    expect(result.resume.contextBlock).toContain("[USER]: Returning to Smith PIP provider bill review after new records.");
    expect(result.sleep.ok).toBe(true);
    expect(result.sleep.proposalIds).toEqual(expect.arrayContaining([
      "proposal_box_box_topic_smith_pip",
      "proposal_trace_trace_smith_pip_provider_bill"
    ]));
    expect(result.sleep.proposedTraceIds).toEqual(["trace_smith_pip_provider_bill"]);
    expect(result.proposals.proposals.map((proposal) => proposal.id)).toEqual(expect.arrayContaining([
      "proposal_box_box_topic_smith_pip",
      "proposal_trace_trace_smith_pip_provider_bill"
    ]));
  });

  it("prints Roscoe environment commands for the same database path", () => {
    const env = buildRoscoeMemoryEnvironment({
      databasePath: "/tmp/memory.sqlite",
      projectRoot: "/repo/conversational-memory-system"
    });

    expect(env.HERMES_CONVERSATIONAL_MEMORY_DB).toBe("/tmp/memory.sqlite");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_ENABLED).toBe("1");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_INJECT_ENABLED).toBe("1");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_COMMAND).toBe(
      "npm --silent --prefix /repo/conversational-memory-system run hermes:ingest -- --db /tmp/memory.sqlite"
    );
    expect(env.HERMES_CONVERSATIONAL_MEMORY_TIMEOUT).toBe("10");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_INJECT_COMMAND).toBe(
      "npm --silent --prefix /repo/conversational-memory-system run hermes:inject -- --db /tmp/memory.sqlite"
    );
    expect(env.HERMES_CONVERSATIONAL_MEMORY_INJECT_TIMEOUT).toBe("10");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_MAX_TOKENS).toBe("120");
    expect(env.HERMES_CONVERSATIONAL_MEMORY_RESUME_COMMAND).toBe(
      "npm --silent --prefix /repo/conversational-memory-system run hermes:resume -- --db /tmp/memory.sqlite"
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
