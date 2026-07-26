import { describe, expect, it } from "vitest";
import { HistoricalBootstrapper } from "../../src/bootstrap/historical-bootstrapper.js";
import type { ContractionSliceResult } from "../../src/daemon/contraction-runner.js";
import type { CanonicalEvent, MemorySource, Person } from "../../src/domain/canonical.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

const NOW = "2026-07-16T15:00:00.000Z";

describe("HistoricalBootstrapper", () => {
  it("delegates immediate work in slices and drains proposals once after completion", async () => {
    const store = new InMemoryStore();
    await seedPerson(store, "person_1");
    await seedEvents(store, "person_1", [
      event("event_1", "session_1", 1, "Alpha planning roadmap.", "10:00"),
      event("event_2", "session_1", 2, "Alpha planning deadline.", "10:01")
    ]);
    const slices: ContractionSliceResult[] = [
      contractionResult("event_1", false, 1),
      contractionResult("event_2", true, 2)
    ];
    const drainCalls: Array<{ personId: string; jobId: string }> = [];
    let proposalCalls = 0;
    const bootstrapper = new HistoricalBootstrapper(store, {
      clock: () => NOW,
      contractionRunnerFactory: ({ authority }) => ({
        drainSlice: async (personId, jobId) => {
          expect(authority).toEqual({
            kind: "foreground",
            personId: "person_1",
            operation: "historical-bootstrap"
          });
          drainCalls.push({ personId, jobId });
          return slices.shift()!;
        }
      }),
      proposalSchedulerFactory: ({ authority }) => ({
        runDue: async () => {
          expect(authority).toMatchObject({ operation: "historical-bootstrap" });
          proposalCalls += 1;
          return { boxProposals: 2, traceProposals: 1, ran: true };
        }
      })
    });

    await expect(bootstrapper.bootstrap("person_1")).resolves.toMatchObject({
      eventsProcessed: 2,
      summariesUpdated: 2,
      anchorsDetected: 2,
      boxProposalsCreated: 2,
      traceProposalsCreated: 1
    });
    expect(drainCalls).toHaveLength(2);
    expect(new Set(drainCalls.map((call) => call.jobId))).toHaveLength(1);
    expect(proposalCalls).toBe(1);
  });

  it("rejects wrong foreground authority before durable mutation", async () => {
    const store = new InMemoryStore();
    await seedPerson(store, "person_1");
    await seedEvents(store, "person_1", [
      event("event_1", "session_1", 1, "Authority boundary.", "10:00")
    ]);
    const before = await bootstrapSnapshot(store);
    const bootstrapper = new HistoricalBootstrapper(store, {
      authority: { kind: "foreground", personId: "person_1", operation: "approved-import" }
    });

    await expect(bootstrapper.bootstrap("person_1")).rejects.toThrow(/historical-bootstrap|authority/i);
    expect(await bootstrapSnapshot(store)).toEqual(before);
  });

  it("turns separate native sessions into one provenance-preserving personal conversation", async () => {
    const store = new InMemoryStore();
    await seedPerson(store, "person_1");
    await seedEvents(store, "person_1", [
      event("event_1", "session_codex", 1, "Let's talk about Alpha planning roadmap.", "10:00"),
      event("event_2", "session_codex", 2, "Alpha planning roadmap deadline and strategy is Friday.", "10:01", "assistant"),
      event("event_3", "session_claude", 1, "Switch to Beta launch rollout.", "10:02"),
      event("event_4", "session_claude", 2, "Beta launch rollout checklist and testing.", "10:03", "assistant"),
      event("event_5", "session_openclaw", 1, "Switch to Alpha planning roadmap.", "10:04"),
      event("event_6", "session_openclaw", 2, "Alpha planning roadmap deadline and strategy follow-up.", "10:05", "assistant")
    ]);

    const result = await new HistoricalBootstrapper(store, { clock: () => NOW }).bootstrap("person_1");

    expect(result).toMatchObject({
      reset: false,
      eventsProcessed: 6,
      summariesUpdated: 3
    });
    const turns = await store.listTurns("person:person_1");
    expect(turns.map((turn) => turn.content)).toEqual([
      "Let's talk about Alpha planning roadmap.",
      "Alpha planning roadmap deadline and strategy is Friday.",
      "Switch to Beta launch rollout.",
      "Beta launch rollout checklist and testing.",
      "Switch to Alpha planning roadmap.",
      "Alpha planning roadmap deadline and strategy follow-up."
    ]);
    expect(turns.map((turn) => turn.metadata.nativeSessionId)).toEqual([
      "session_codex",
      "session_codex",
      "session_claude",
      "session_claude",
      "session_openclaw",
      "session_openclaw"
    ]);

    const summaries = (await store.listSummaries()).filter(
      (summary) => summary.personId === "person_1"
    );
    expect(summaries).toHaveLength(3);
    expect(summaries.every((summary) => summary.origin === "historical_bootstrap")).toBe(true);
    expect(summaries.flatMap((summary) => summary.sourceCanonicalEventIds ?? [])).toEqual([
      "event_1",
      "event_2",
      "event_3",
      "event_4",
      "event_5",
      "event_6"
    ]);
    const anchors = await store.listAnchors();
    expect(anchors.some((anchor) => anchor.canonicalEventId === "event_2")).toBe(true);
    expect(anchors.every((anchor) => anchor.personId === "person_1")).toBe(true);

    const proposals = await store.listProposals({ state: "proposed" });
    expect(proposals.some((proposal) => proposal.proposalType === "box")).toBe(true);
    expect(proposals.some((proposal) => proposal.proposalType === "trace")).toBe(true);
    expect(proposals.every((proposal) => proposal.personId === "person_1")).toBe(true);
    expect((await store.listBoxes()).every((box) => box.state === "proposed")).toBe(true);
  });

  it("is a no-op on rerun and resumes the active topic when history is appended", async () => {
    const store = new InMemoryStore();
    await seedPerson(store, "person_1");
    await seedEvents(store, "person_1", [
      event("event_1", "session_1", 1, "Let's talk about Alpha planning roadmap.", "10:00"),
      event("event_2", "session_1", 2, "Alpha planning roadmap details.", "10:01", "assistant")
    ]);
    const bootstrapper = new HistoricalBootstrapper(store, { clock: () => NOW });
    await bootstrapper.bootstrap("person_1");
    const firstSummaries = await store.listSummaries();

    await expect(bootstrapper.bootstrap("person_1")).resolves.toMatchObject({
      reset: false,
      eventsProcessed: 0,
      summariesUpdated: 0
    });
    await store.saveCanonicalEvent(
      event("event_3", "session_2", 1, "Alpha planning roadmap deadline follow-up.", "10:02", "assistant")
    );
    const appended = await bootstrapper.bootstrap("person_1");

    expect(appended).toMatchObject({ reset: false, eventsProcessed: 1, summariesUpdated: 1 });
    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(firstSummaries.length);
    expect(summaries[0].sourceCanonicalEventIds).toEqual(["event_1", "event_2", "event_3"]);
  });

  it("rewinds after an earlier event while preserving an unaffected summary", async () => {
    const store = new InMemoryStore();
    await seedPerson(store, "person_1");
    await seedEvents(store, "person_1", [
      event("event_2", "session_1", 1, "Let's talk about Alpha planning roadmap.", "10:00"),
      event("event_3", "session_1", 2, "Alpha planning roadmap details.", "10:01", "assistant")
    ]);
    const bootstrapper = new HistoricalBootstrapper(store, { clock: () => NOW });
    await bootstrapper.bootstrap("person_1");
    const previousSummaryId = (await store.listSummaries()).find(
      (summary) => summary.personId === "person_1" && summary.state !== "superseded"
    )!.id;
    await store.saveCanonicalEvent(
      event("event_1", "session_older", 1, "Earlier preface conversation.", "09:59")
    );

    const replayed = await bootstrapper.bootstrap("person_1");

    expect(replayed).toMatchObject({ reset: true, eventsProcessed: 3 });
    const obsolete = (await store.listSummaries()).find(
      (summary) => summary.id === previousSummaryId
    );
    expect(obsolete?.state).toBe("compacted");
    expect((await store.listSummaries()).some(
      (summary) => summary.sourceCanonicalEventIds?.includes("event_1")
    )).toBe(true);
    expect((await store.listTurns("person:person_1")).map((turn) => turn.sequence)).toContain(1);
  });

  it("does not mix derived memory or proposals between people", async () => {
    const store = new InMemoryStore();
    await seedPerson(store, "person_1");
    await seedPerson(store, "person_2");
    await seedEvents(store, "person_1", [
      event("p1_1", "session_1", 1, "Let's talk about Private Alpha strategy.", "10:00"),
      event("p1_2", "session_1", 2, "Switch to Separate Beta planning.", "10:01", "assistant"),
      event("p1_3", "session_1", 3, "Switch to Private Alpha strategy.", "10:02")
    ]);
    await seedEvents(store, "person_2", [
      event("p2_1", "session_2", 1, "Let's talk about Private Alpha strategy.", "10:00", "user", "person_2"),
      event("p2_2", "session_2", 2, "Switch to Separate Beta planning.", "10:01", "assistant", "person_2"),
      event("p2_3", "session_2", 3, "Switch to Private Alpha strategy.", "10:02", "user", "person_2")
    ]);

    const bootstrapper = new HistoricalBootstrapper(store, { clock: () => NOW });
    await bootstrapper.bootstrap("person_1");

    expect(await store.listTurns("person:person_2")).toEqual([]);
    expect((await store.listSummaries()).every((summary) => summary.personId === "person_1")).toBe(true);
    expect((await store.listAnchors()).every((anchor) => anchor.personId === "person_1")).toBe(true);

    await bootstrapper.bootstrap("person_2");
    const boxes = await store.listBoxes();
    const proposals = await store.listProposals();
    expect(new Set(boxes.map((box) => box.id)).size).toBe(boxes.length);
    expect(new Set(proposals.map((proposal) => proposal.id)).size).toBe(proposals.length);
    expect(boxes.some((box) => box.personId === "person_1")).toBe(true);
    expect(boxes.some((box) => box.personId === "person_2")).toBe(true);
  });
});

function contractionResult(
  eventId: string,
  complete: boolean,
  sliceCount: number
): ContractionSliceResult {
  const orderKey = { occurredAt: NOW, nativeSequence: sliceCount, id: eventId };
  return {
    processedEvents: 1,
    processedEventIds: [eventId],
    rewindOrderKey: null,
    yielded: !complete,
    complete,
    immediate: { summaries: 1, anchors: 1 },
    supersessions: [],
    checkpoint: {
      id: "contraction_checkpoint_test",
      personId: "person_1",
      jobId: "contraction_test",
      processorVersion: "continuous-contraction/v1",
      generation: 1,
      processedThroughOrderKey: orderKey,
      nextOrderKey: complete ? null : orderKey,
      nextEventId: complete ? null : eventId,
      activeTopic: null,
      sliceCount,
      immediateStage: complete ? "complete" : "pending",
      proposalStage: "pending",
      pendingToolRun: null,
      updatedAt: NOW
    }
  };
}

async function bootstrapSnapshot(store: InMemoryStore) {
  return {
    jobs: await store.listContractionJobs("person_1"),
    checkpoint: await store.getBootstrapCheckpoint("bootstrap_person_1"),
    turns: await store.listTurns("person:person_1"),
    summaries: await store.listSummaries(),
    anchors: await store.listAnchors(),
    proposals: await store.listProposals()
  };
}

async function seedPerson(store: InMemoryStore, personId: string): Promise<void> {
  const person: Person = { id: personId, displayName: null, createdAt: NOW };
  const source: MemorySource = {
    id: `source_${personId}`,
    personId,
    application: "synthetic",
    profileId: "default",
    instanceId: "test",
    createdAt: NOW,
    lastImportedAt: NOW
  };
  await store.savePerson(person);
  await store.saveSource(source);
}

async function seedEvents(
  store: InMemoryStore,
  personId: string,
  events: CanonicalEvent[]
): Promise<void> {
  for (const item of events) {
    await store.saveCanonicalEvent({
      ...item,
      personId,
      sourceId: `source_${personId}`
    });
  }
}

function event(
  id: string,
  nativeSessionId: string,
  nativeSequence: number,
  content: string,
  time: string,
  role: CanonicalEvent["role"] = "user",
  personId = "person_1"
): CanonicalEvent {
  return {
    id,
    personId,
    sourceId: `source_${personId}`,
    sourceApplication: "synthetic",
    sourceProfileId: "default",
    nativeSessionId,
    nativeEventId: id,
    nativeSequence,
    causalParentId: null,
    role,
    content,
    occurredAt: `2026-07-16T${time}:00.000Z`,
    importedAt: NOW,
    provenance: role === "user" ? "direct_user_input" : "assistant_output",
    trustLevel: role === "user" ? "high" : "medium",
    contentHash: `hash_${id}`,
    parserVersion: "synthetic/v1",
    metadata: {}
  };
}
