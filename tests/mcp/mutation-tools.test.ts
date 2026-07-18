import { afterEach, describe, expect, it } from "vitest";
import {
  createSyntheticMcpFixture,
  snapshotSemanticMemory,
  type SyntheticMcpFixture
} from "./fixtures.js";

describe("MCP mutation application contract", () => {
  let fixture: SyntheticMcpFixture | undefined;

  afterEach(async () => fixture?.cleanup());

  it("starts preview inspection from an unchanged synthetic semantic snapshot", async () => {
    fixture = await createSyntheticMcpFixture();
    const before = await snapshotSemanticMemory(fixture.store);
    const candidate = await fixture.store.getSource("source-alpha");
    const after = await snapshotSemanticMemory(fixture.store);

    expect(candidate).toMatchObject({
      id: "source-alpha",
      personId: "person-alpha",
      scopeId: "scope-alpha"
    });
    expect(after).toBe(before);
  });

  it.todo("05-04 Task 1 exposes exact atomic proposal approve and reject store contracts with rollback");
  it.todo("05-04 Task 1 exposes exact atomic source revoke and delete store contracts with rollback");
  it.todo("05-04 Task 1 preserves backend parity for every atomic mutation contract");
  it.todo("05-04 Task 2 configures bounded concurrent-writer behavior and rejects stale state");
  it.todo("05-04 Task 2 rolls back every durable effect at each injected transaction boundary");
  it.todo("05-05 Task 2 previews history ingestion without opening an unconfigured source root");
  it.todo("05-05 Task 2 executes history ingestion only for the exact confirmed preview effects");
  it.todo("05-05 Task 2 previews and executes scoped proposal approval or rejection atomically");
  it.todo("05-05 Task 3 keeps source revocation distinct from source deletion");
  it.todo("05-05 Task 3 rejects deletion until the exact already-revoked source is confirmed");
  it.todo("05-05 Task 3 revalidates state drift inside the execute transaction");
  it.todo("05-07 Task 2 routes each preview tool to one scoped application operation");
  it.todo("05-07 Task 2 routes each execute tool with exact ticket binding and truthful annotations");
});
