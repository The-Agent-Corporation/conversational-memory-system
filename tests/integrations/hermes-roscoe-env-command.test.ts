import { describe, expect, it } from "vitest";
import { renderRoscoeMemoryEnvironment } from "../../src/integrations/hermes/roscoe-env-command.js";

describe("Hermes Roscoe env command", () => {
  it("renders shell exports for Roscoe memory commands", () => {
    const output = renderRoscoeMemoryEnvironment({
      databasePath: "/tmp/memory.sqlite",
      projectRoot: "/repo/conversational-memory-system",
      format: "shell"
    });

    expect(output).toContain("export HERMES_CONVERSATIONAL_MEMORY_ENABLED='1'");
    expect(output).toContain("export HERMES_CONVERSATIONAL_MEMORY_COMMAND='npm --silent --prefix /repo/conversational-memory-system run hermes:ingest -- --db /tmp/memory.sqlite'");
    expect(output).toContain("export HERMES_CONVERSATIONAL_MEMORY_MAX_TOKENS='120'");
    expect(output).toContain("export HERMES_CONVERSATIONAL_MEMORY_SLEEP_COMMAND='npm --silent --prefix /repo/conversational-memory-system run hermes:sleep -- --db /tmp/memory.sqlite'");
  });

  it("renders JSON for programmatic configuration", () => {
    const output = renderRoscoeMemoryEnvironment({
      databasePath: "/tmp/memory.sqlite",
      projectRoot: "/repo/conversational-memory-system",
      format: "json"
    });

    expect(JSON.parse(output)).toMatchObject({
      HERMES_CONVERSATIONAL_MEMORY_DB: "/tmp/memory.sqlite",
      HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_LIST_COMMAND: "npm --silent --prefix /repo/conversational-memory-system run hermes:proposals:list -- --db /tmp/memory.sqlite"
    });
  });
});
