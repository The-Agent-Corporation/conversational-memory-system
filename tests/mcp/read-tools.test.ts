import { afterEach, describe, expect, it } from "vitest";
import {
  createSyntheticMcpFixture,
  snapshotSemanticMemory,
  type SyntheticMcpFixture
} from "./fixtures.js";

interface PlannedReadEnvelope<T extends Record<string, unknown>> {
  structuredContent: T;
  content: Array<{ type: "text"; text: string }>;
}

const assertDualEnvelope = <T extends Record<string, unknown>>(
  envelope: PlannedReadEnvelope<T>
): void => {
  expect(envelope.content).toHaveLength(1);
  expect(envelope.content[0].type).toBe("text");
  for (const value of Object.values(envelope.structuredContent)) {
    if (typeof value === "string") expect(envelope.content[0].text).toContain(value);
  }
};

describe("MCP read application contract", () => {
  let fixture: SyntheticMcpFixture | undefined;

  afterEach(async () => fixture?.cleanup());

  it("snapshots every semantic fixture table deterministically without reading host history", async () => {
    fixture = await createSyntheticMcpFixture();
    const first = await snapshotSemanticMemory(fixture.store);
    const second = await snapshotSemanticMemory(fixture.store);

    expect(second).toBe(first);
    expect(first).toContain("summary-mixed");
    expect(first).toContain("person-beta");
    expect(fixture.tempDir).toMatch(/memory-mcp-synthetic-/);
    expect(fixture.configPath.startsWith(fixture.tempDir)).toBe(true);
  });

  it("defines equivalent structured and rendered disclosure for read results", () => {
    const envelope: PlannedReadEnvelope<Record<string, string>> = {
      structuredContent: {
        disclosure: "Assistive memory; verify against current sources.",
        provenance: "synthetic-source",
        confidence: "0.80"
      },
      content: [{
        type: "text",
        text: "Assistive memory; verify against current sources. provenance=synthetic-source confidence=0.80"
      }]
    };

    assertDualEnvelope(envelope);
  });

  it.todo("05-02 Task 2 memory search returns scoped ranked candidates and causes zero semantic writes");
  it.todo("05-02 Task 2 contextual recall respects budget and causes zero access, strength, revival, or injection writes");
  it.todo("05-02 Task 2 memory review filters every mixed-scope dependency and causes zero semantic writes");
  it.todo("05-02 Task 2 source status reports daemon offline without changing synchronization or memory state");
  it.todo("05-06 Task 2 registers and routes memory_search with equivalent structured and text output");
  it.todo("05-06 Task 2 registers and routes memory_recall with equivalent structured and text output");
  it.todo("05-06 Task 2 registers and routes memory_review with bounded continuation");
  it.todo("05-06 Task 2 registers and routes memory_expand_subject with bounded continuation");
  it.todo("05-06 Task 2 registers and routes source_status while the daemon is offline");
  it.todo("05-06 Task 2 registers and routes proposal_list with profile-scoped review pagination");
});
