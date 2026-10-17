import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SUMMARY_MODEL,
  readSemanticConfig,
  semanticConfigPath,
  semanticPlannerModel,
  semanticSummaryModel
} from "../../src/openrouter/config.js";

const directories: string[] = [];

function databaseWithSidecar(contents?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "semantic-config-"));
  directories.push(directory);
  const databasePath = join(directory, "memory.db");
  if (contents !== undefined) {
    writeFileSync(semanticConfigPath(databasePath), JSON.stringify(contents), "utf8");
  }
  return databasePath;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("semantic config", () => {
  it("defaults the summary model to Haiku and keeps semantic mode off", () => {
    const config = readSemanticConfig(databaseWithSidecar());

    expect(DEFAULT_SUMMARY_MODEL).toBe("anthropic/claude-haiku-5.5");
    expect(config.summaryModel).toBe(DEFAULT_SUMMARY_MODEL);
    expect(config.enabled).toBe(false);
    expect(semanticSummaryModel(config)).toBeNull();
    expect(semanticPlannerModel(config)).toBeNull();
  });

  it("summarizes with Haiku once enabled without touching the box planner", () => {
    const config = readSemanticConfig(databaseWithSidecar({ enabled: true }));

    expect(semanticSummaryModel(config)).toBe("anthropic/claude-haiku-5.5");
    expect(semanticPlannerModel(config)).toBeNull();
  });

  it("keeps chatModel for the planner and summaryModel for summaries", () => {
    const config = readSemanticConfig(databaseWithSidecar({
      enabled: true,
      chatModel: "z-ai/glm-5.3-flash"
    }));

    expect(semanticSummaryModel(config)).toBe("anthropic/claude-haiku-5.5");
    expect(semanticPlannerModel(config)).toBe("z-ai/glm-5.3-flash");
  });

  it("honors an explicit summary model and an explicit opt-out", () => {
    const override = readSemanticConfig(databaseWithSidecar({
      enabled: true,
      summaryModel: "~deepseek/deepseek-flash-latest"
    }));
    const optOut = readSemanticConfig(databaseWithSidecar({ enabled: true, summaryModel: "  " }));

    expect(semanticSummaryModel(override)).toBe("~deepseek/deepseek-flash-latest");
    expect(semanticSummaryModel(optOut)).toBeNull();
  });
});
