import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContractionRunner } from "../../src/daemon/contraction-runner.js";
import { ProposalScheduler } from "../../src/daemon/proposal-scheduler.js";
import type { ContractionJob, WriteAuthority } from "../../src/daemon/types.js";
import type { CanonicalEvent, MemorySource, Person } from "../../src/domain/canonical.js";
import type { SourceGrant } from "../../src/domain/source-lifecycle.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { HYGIENE_RULE_VERSION } from "../../src/topic/derivation-hygiene.js";
import { FIXED_NOW, FakeDaemonClock, FaultBoundaryInjector } from "./fixtures.js";

const PERSON_ID = "person_contraction";
const OTHER_PERSON_ID = "person_other";
const SCOPE_ID = "scope_allowed";

describe("ContractionRunner", () => {
  it("rejects append and late-rewind publication after token turnover, then converges under the replacement owner", async () => {
    const clock = new FakeDaemonClock();
    const store = await seededStore({ clock });
    const initial = [
      event("turnover-prefix", 1, "Remember this stable prefix bookmark.", 0),
      event("turnover-alpha", 2, "Switch to Alpha turnover planning.", 10),
      event("turnover-beta", 3, "Switch to Beta turnover rollout.", 20)
    ];
    const initialJob = await commitStableBatch(store, "turnover-initial", initial, clock.now());
    await drain(new ContractionRunner(store, {
      clock,
      authority: foregroundContractionAuthority()
    }), initialJob);
    const prefix = await snapshotPrefix(store, "turnover-prefix");

    await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "token-a", pid: 100, now: clock.now() });
    const appendedJob = await commitStableBatch(
      store,
      "turnover-append",
      [event("turnover-append", 4, "Beta turnover follow-up.", 21)],
      clock.now()
    );
    const beforeAppend = await contractionPublicationSnapshot(store, appendedJob.id);
    await expect(new ContractionRunner(store, {
      clock,
      authority: daemonAuthority("token-a"),
      beforeCommit: async () => {
        await store.releaseDaemonLease("memory-db", "token-a");
        await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "token-b", pid: 101, now: clock.now() });
      }
    }).drainSlice(PERSON_ID, appendedJob.id)).rejects.toThrow(/lease|owner|authority/i);
    expect(await contractionPublicationSnapshot(store, appendedJob.id)).toEqual(beforeAppend);
    await drain(new ContractionRunner(store, { clock, authority: daemonAuthority("token-b") }), appendedJob);

    const late = event("turnover-late", 99, "Late Alpha turnover note.", 11);
    const lateJob = await commitStableBatch(store, "turnover-late", [late], clock.now());
    const beforeLate = await contractionPublicationSnapshot(store, lateJob.id);
    await expect(new ContractionRunner(store, {
      clock,
      authority: daemonAuthority("token-b"),
      beforeCommit: async () => {
        await store.releaseDaemonLease("memory-db", "token-b");
        await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "token-c", pid: 102, now: clock.now() });
      }
    }).drainSlice(PERSON_ID, lateJob.id)).rejects.toThrow(/lease|owner|authority/i);
    expect(await contractionPublicationSnapshot(store, lateJob.id)).toEqual(beforeLate);
    await drain(new ContractionRunner(store, { clock, authority: daemonAuthority("token-c") }), lateJob);

    expect(await snapshotPrefix(store, "turnover-prefix")).toEqual(prefix);
    expect(unique(await store.listTurns(`person:${PERSON_ID}`))).toBe(true);
    expect(unique(await store.listSummaries())).toBe(true);
    expect(unique(await store.listAnchors())).toBe(true);
  });

  it("rejects missing, wrong foreground-operation, and cross-person contraction authority before mutation", async () => {
    const store = await seededStore();
    await seedEvents(store, [event("authority-event", 1, "Authority test event.", 0)]);
    const job = await enqueue(store, "job-authority", "authority-event", "authority-event");
    const before = await contractionPublicationSnapshot(store, job.id);

    await expect(new ContractionRunner(store).drainSlice(PERSON_ID, job.id)).rejects.toThrow(/authority/i);
    await expect(new ContractionRunner(store, {
      authority: { kind: "foreground", personId: PERSON_ID, operation: "approved-import" }
    }).drainSlice(PERSON_ID, job.id)).rejects.toThrow(/historical-bootstrap|authority/i);
    await expect(new ContractionRunner(store, {
      authority: { kind: "foreground", personId: OTHER_PERSON_ID, operation: "historical-bootstrap" }
    }).drainSlice(PERSON_ID, job.id)).rejects.toThrow(/person|authority/i);
    expect(await contractionPublicationSnapshot(store, job.id)).toEqual(before);
  });

  it("contracts an append from the durable suffix and preserves every unaffected prefix object", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("alpha-1", 1, "Alpha planning roadmap introduction.", 0),
      event("alpha-2", 2, "Alpha planning roadmap deadline.", 1, "assistant"),
      event("beta-1", 3, "Switch to Beta launch rollout.", 2),
      event("beta-2", 4, "Beta launch rollout verification.", 3, "assistant")
    ]);
    const firstJob = await enqueue(store, "job-initial", "alpha-1", "beta-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });
    await drain(runner, firstJob);

    const prefix = await snapshotPrefix(store, "alpha-2");
    await store.saveCanonicalEvent(event("beta-3", 5, "Beta launch rollout follow-up.", 4));
    const appendJob = await enqueue(store, "job-append", "beta-3", "beta-3");
    const appended = await drain(runner, appendJob);

    expect(appended.flatMap((slice) => slice.processedEventIds)).toEqual(["beta-3"]);
    expect(await snapshotPrefix(store, "alpha-2")).toEqual(prefix);
  });

  it("rewinds a late insert to the intersecting topic boundary, not the beginning of history", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("prefix-1", 1, "Private preface material.", 0),
      event("alpha-1", 2, "Switch to Alpha planning roadmap.", 10),
      event("alpha-2", 3, "Alpha planning roadmap details.", 12, "assistant"),
      event("beta-1", 4, "Switch to Beta launch rollout.", 20)
    ]);
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });
    await drain(runner, await enqueue(store, "job-before-late", "prefix-1", "beta-1"));
    const prefix = await snapshotPrefix(store, "prefix-1");

    await store.saveCanonicalEvent(event("alpha-late", 99, "Late Alpha roadmap note.", 11));
    const result = await drain(runner, await enqueue(store, "job-late", "alpha-late", "alpha-late"));

    expect(result[0]?.rewindOrderKey).toMatchObject({ id: "alpha-1" });
    expect(result.flatMap((slice) => slice.processedEventIds)).toEqual([
      "alpha-1",
      "alpha-late",
      "alpha-2",
      "beta-1"
    ]);
    expect(await snapshotPrefix(store, "prefix-1")).toEqual(prefix);
  });

  it("rewinds the production stable job when a late event invalidates its checkpoint generation", async () => {
    const store = await seededStore();
    const initialEvents = [
      event("stable-prefix", 1, "Remember this private preface bookmark.", 0),
      event("stable-alpha-1", 2, "Switch to Alpha planning roadmap.", 10),
      event("stable-alpha-2", 3, "Alpha planning roadmap deadline.", 12, "assistant"),
      event("stable-beta-1", 4, "Switch to Beta launch rollout.", 20)
    ];
    const job = await commitStableBatch(store, "initial", initialEvents, FIXED_NOW);
    const clock = new FakeDaemonClock();
    await drain(new ContractionRunner(store, { clock, authority: foregroundContractionAuthority() }), job);
    clock.advanceBy(10 * 60_000);
    await new ProposalScheduler(store, { clock, authority: foregroundContractionAuthority() }).runDue(PERSON_ID);
    const prefix = await snapshotPrefix(store, "stable-prefix");
    const checkpointBeforeLate = await store.getContractionCheckpoint(`contraction_checkpoint_${job.id}`);
    expect(checkpointBeforeLate).toMatchObject({ generation: 1, immediateStage: "complete" });

    const late = event("stable-alpha-late", 99, "Late Alpha planning roadmap note.", 11);
    await commitStableBatch(store, "late", [late], clock.now());
    const invalidated = await store.getContractionJob(job.id);
    expect(invalidated).toMatchObject({ generation: 2, state: "pending", immediateDirty: true });
    expect(await store.getContractionCheckpoint(`contraction_checkpoint_${job.id}`)).toEqual(checkpointBeforeLate);

    // A fresh runner models a daemon restart with only durable job/checkpoint state.
    const replayed = await drain(new ContractionRunner(store, { clock, authority: foregroundContractionAuthority() }), invalidated!);
    expect(replayed[0]?.rewindOrderKey).toMatchObject({ id: "stable-alpha-1" });
    expect(replayed.flatMap((slice) => slice.processedEventIds)).toEqual([
      "stable-alpha-1",
      "stable-alpha-late",
      "stable-alpha-2",
      "stable-beta-1"
    ]);
    expect(replayed.at(-1)?.checkpoint).toMatchObject({ generation: 2, immediateStage: "complete" });
    expect(await snapshotPrefix(store, "stable-prefix")).toEqual(prefix);
    expect(unique(await store.listTurns(`person:${PERSON_ID}`))).toBe(true);
    expect(unique(await store.listSummaries())).toBe(true);
    expect(unique(await store.listAnchors())).toBe(true);
    expect(unique(await store.listBoxes())).toBe(true);
    expect(unique(await store.listTraces())).toBe(true);
    expect(unique(await store.listProposals())).toBe(true);

    await commitStableBatch(store, "late", [late], clock.now());
    expect(await store.getContractionJob(job.id)).toMatchObject({ generation: 2, state: "complete" });
    await expect(new ContractionRunner(store, { clock, authority: foregroundContractionAuthority() }).drainSlice(PERSON_ID, job.id)).resolves.toMatchObject({
      processedEvents: 0,
      complete: true
    });
  });

  it("yields at 250 events and resumes by stable canonical key instead of a count", async () => {
    const store = await seededStore();
    await seedEvents(store, Array.from({ length: 251 }, (_, index) =>
      event(`event-${String(index + 1).padStart(3, "0")}`, index + 1, "Synthetic bounded slice event.", index)
    ));
    const job = await enqueue(store, "job-count-limit", "event-001", "event-251");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });

    const first = await runner.drainSlice(PERSON_ID, job.id);
    expect(first).toMatchObject({ processedEvents: 250, yielded: true, complete: false });
    expect(first.checkpoint).toMatchObject({
      generation: job.generation,
      processedThroughOrderKey: { id: "event-250" }
    });
    expect(first.checkpoint.nextOrderKey).toMatchObject({ id: "event-251" });

    // Inserting before the durable next key must not turn the checkpoint into an array offset.
    await store.saveCanonicalEvent(event("event-late-before-next", 999, "Late stable-key event.", 249.5));
    const second = await runner.drainSlice(PERSON_ID, job.id);
    expect(second.processedEventIds).toEqual(["event-late-before-next", "event-251"]);
    expect(second).toMatchObject({ complete: true });
  });

  it("yields after two injected monotonic seconds even below the event limit", async () => {
    const store = await seededStore();
    await seedEvents(store, [event("timed-1", 1, "Timed event one.", 0), event("timed-2", 2, "Timed event two.", 1)]);
    const clock = new FakeDaemonClock();
    const runner = new ContractionRunner(store, {
      clock,
      authority: foregroundContractionAuthority(),
      afterEvent: () => clock.advanceBy(2_000)
    });
    const job = await enqueue(store, "job-time-limit", "timed-1", "timed-2");

    const first = await runner.drainSlice(PERSON_ID, job.id);
    expect(first).toMatchObject({ processedEvents: 1, yielded: true, complete: false });
    expect(first.checkpoint.nextOrderKey).toMatchObject({ id: "timed-2" });
    await expect(runner.drainSlice(PERSON_ID, job.id)).resolves.toMatchObject({ complete: true });
  });

  it("replays faults around an atomic slice to exactly the clean result without duplicate derivations", async () => {
    const cleanStore = await seededStore();
    const crashStore = await seededStore();
    const items = [
      event("replay-1", 1, "Alpha replay planning.", 0),
      event("replay-2", 2, "Alpha replay planning follow-up.", 1, "assistant"),
      event("replay-3", 3, "Switch to Beta replay work.", 2)
    ];
    await seedEvents(cleanStore, items);
    await seedEvents(crashStore, items);
    const cleanJob = await enqueue(cleanStore, "job-replay", "replay-1", "replay-3");
    await drain(new ContractionRunner(cleanStore, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() }), cleanJob);

    for (const boundary of ["before_contraction_commit", "after_contraction_checkpoint"]) {
      const faults = new FaultBoundaryInjector();
      faults.arm(boundary);
      const crashJob = await enqueue(crashStore, `job-${boundary}`, "replay-1", "replay-3");
      const crashing = new ContractionRunner(crashStore, {
        clock: new FakeDaemonClock(),
        faults,
        authority: foregroundContractionAuthority()
      });
      await expect(crashing.drainSlice(PERSON_ID, crashJob.id)).rejects.toThrow(/Injected fault/);
      await drain(new ContractionRunner(crashStore, {
        clock: new FakeDaemonClock(),
        authority: foregroundContractionAuthority()
      }), crashJob);
    }

    expect(await derivationFingerprint(crashStore)).toEqual(await derivationFingerprint(cleanStore));
    expect(unique(await crashStore.listTurns(`person:${PERSON_ID}`))).toBe(true);
    expect(unique(await crashStore.listSummaries())).toBe(true);
    expect(unique(await crashStore.listAnchors())).toBe(true);
    expect(unique(await crashStore.listBoxes())).toBe(true);
    expect(unique(await crashStore.listTraces())).toBe(true);
    expect(unique(await crashStore.listProposals())).toBe(true);
  });

  it("fails closed rather than contracting cross-person or disallowed-scope dependencies", async () => {
    const store = await seededStore();
    await seedPerson(store, OTHER_PERSON_ID, "scope_other");
    await store.saveCanonicalEvent(event("owned", 1, "Owned event.", 0));
    await store.saveCanonicalEvent(event("foreign", 1, "Foreign event.", 0, "user", OTHER_PERSON_ID, "scope_other"));
    const job = await enqueue(store, "job-owned", "owned", "owned");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });

    await expect(runner.drainSlice(OTHER_PERSON_ID, job.id)).rejects.toThrow(/person|ownership/i);
    await store.saveCanonicalEvent(event("wrong-scope", 2, "Wrong scope.", 1, "user", PERSON_ID, "scope_denied"));
    await expect(runner.drainSlice(PERSON_ID, job.id)).rejects.toThrow(/scope|dependency/i);
    expect(await store.listTurns(`person:${OTHER_PERSON_ID}`)).toEqual([]);
  });

  // --- Derivation input hygiene (REQ-052, REQ-053, REQ-054) -------------------------------------

  it("excludes tool activity from topic labels", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("hygiene-a-1", 1, "Switch to Alpha planning roadmap.", 0),
      toolEvent("hygiene-a-tool-1", 2, "Bash", 1),
      toolEvent("hygiene-a-tool-2", 3, "Read", 2),
      toolEvent("hygiene-a-tool-3", 4, "Write", 3),
      toolEvent("hygiene-a-tool-4", 5, "Grep", 4),
      toolEvent("hygiene-a-tool-5", 6, "Edit", 5),
      event("hygiene-a-2", 7, "Alpha planning roadmap follow-up.", 6, "assistant")
    ]);
    const job = await enqueue(store, "job-hygiene-a", "hygiene-a-1", "hygiene-a-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });
    await drain(runner, job);

    // Today's ungated implementation would open/close three spans (tool activity would each
    // change the topic label); the label gate collapses this stretch to exactly ONE summary.
    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.summaryText.startsWith("Alpha Planning Roadmap")).toBe(true);
  });

  it("excludes synthetic content from summaries", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("hygiene-b-1", 1, "Switch to Beta compliance review.", 0),
      syntheticEvent("hygiene-b-sys", 2, "internal harness marker XYZZY123", 1),
      event("hygiene-b-2", 3, "Beta compliance review follow-up.", 2, "assistant")
    ]);
    const job = await enqueue(store, "job-hygiene-b", "hygiene-b-1", "hygiene-b-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });
    await drain(runner, job);

    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.summaryText).not.toContain("XYZZY123");
    expect(summaries[0]!.summaryText).not.toContain("[SYSTEM:");
  });

  it("collapses a tool run into one activity line", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("hygiene-c-1", 1, "Switch to Gamma incident response.", 0),
      toolEvent("hygiene-c-tool-1", 2, "Bash", 1, "argApple"),
      toolEvent("hygiene-c-tool-2", 3, "Bash", 2, "argBanana"),
      toolEvent("hygiene-c-tool-3", 4, "Read", 3, "argCherry"),
      toolEvent("hygiene-c-tool-4", 5, "Read", 4, "argDate"),
      event("hygiene-c-2", 6, "Gamma incident response follow-up.", 5, "assistant")
    ]);
    const job = await enqueue(store, "job-hygiene-c", "hygiene-c-1", "hygiene-c-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });
    await drain(runner, job);

    const [summary] = await store.listSummaries();
    const activityLines = summary!.summaryText.match(/\[Activity\] ran 4 tool calls:/g) ?? [];
    expect(activityLines).toHaveLength(1);
    for (const arg of ["argApple", "argBanana", "argCherry", "argDate"]) {
      expect(summary!.summaryText).not.toContain(arg);
    }
  });

  it("keeps an isolated single tool call", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("hygiene-d-1", 1, "Switch to Delta migration planning.", 0),
      toolEvent("hygiene-d-tool", 2, "Bash", 1, "argEcho"),
      event("hygiene-d-2", 3, "Delta migration planning follow-up.", 2, "assistant")
    ]);
    const job = await enqueue(store, "job-hygiene-d", "hygiene-d-1", "hygiene-d-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });
    await drain(runner, job);

    const [summary] = await store.listSummaries();
    expect(summary!.summaryText).toContain("[Tool call: Bash]");
    expect(summary!.summaryText).not.toMatch(/\[Activity\]/);
  });

  it("provenance: sourceCanonicalEventIds and sourceTurnRanges cover the full raw window including collapsed and synthetic events", async () => {
    const store = await seededStore();
    const events = [
      event("hygiene-e-1", 1, "Switch to Epsilon renewal tracking.", 0),
      syntheticEvent("hygiene-e-sys", 2, "internal harness marker", 1),
      toolEvent("hygiene-e-tool-1", 3, "Bash", 2),
      toolEvent("hygiene-e-tool-2", 4, "Bash", 3),
      event("hygiene-e-2", 5, "Epsilon renewal tracking follow-up.", 4, "assistant")
    ];
    await seedEvents(store, events);
    const job = await enqueue(store, "job-hygiene-e", "hygiene-e-1", "hygiene-e-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });
    await drain(runner, job);

    const [summary] = await store.listSummaries();
    expect(new Set(summary!.sourceCanonicalEventIds)).toEqual(new Set(events.map((e) => e.id)));
    expect(summary!.sourceTurnRanges[0]).toMatchObject({ startSequence: 1, endSequence: 5 });
  });

  it("slice boundary: a tool run straddling maxEvents persists as one activity line", async () => {
    const store = await seededStore();
    const lead = event("hygiene-f-1", 1, "Switch to Foxtrot deployment rollout.", 0);
    const run = toolRun("hygiene-f-tool", 300, 2, 1);
    const trail = event("hygiene-f-2", 302, "Foxtrot deployment rollout follow-up.", 301, "assistant");
    await seedEvents(store, [lead, ...run, trail]);
    const job = await enqueue(store, "job-hygiene-f", "hygiene-f-1", "hygiene-f-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });
    const slices = await drain(runner, job);

    expect(slices.length).toBeGreaterThan(1);
    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    const activityLines = summaries[0]!.summaryText.match(/\[Activity\] ran \d+ tool calls:/g) ?? [];
    expect(activityLines).toEqual(["[Activity] ran 300 tool calls:"]);
  });

  it("slice boundary: no partial tool count is ever persisted", async () => {
    const store = await seededStore();
    const lead = event("hygiene-f2-1", 1, "Switch to Golf onboarding audit.", 0);
    const run = toolRun("hygiene-f2-tool", 300, 2, 1);
    const trail = event("hygiene-f2-2", 302, "Golf onboarding audit follow-up.", 301, "assistant");
    await seedEvents(store, [lead, ...run, trail]);
    const job = await enqueue(store, "job-hygiene-f2", "hygiene-f2-1", "hygiene-f2-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });

    const noPartialCountPersisted = async (): Promise<boolean> => {
      const summaries = await store.listSummaries();
      return !summaries.some((summary) => /\[Activity\] ran (?!300 )\d+ tool calls/.test(summary.summaryText));
    };

    let result = await runner.drainSlice(job.personId, job.id);
    expect(await noPartialCountPersisted()).toBe(true);
    expect(result.checkpoint.pendingToolRun).toMatchObject({
      startEventId: "hygiene-f2-tool-1",
      ruleVersion: HYGIENE_RULE_VERSION
    });
    expect(result.checkpoint.pendingToolRun!.eventCount).toBeGreaterThan(0);

    while (!result.complete) {
      result = await runner.drainSlice(job.personId, job.id);
      expect(await noPartialCountPersisted()).toBe(true);
    }

    expect(result.checkpoint.pendingToolRun).toBeNull();
    const summaries = await store.listSummaries();
    expect(summaries.some((summary) => summary.summaryText.includes("[Activity] ran 300 tool calls:"))).toBe(true);
  });

  it("slice boundary: a length-1 open tail is withheld, not guessed, and later resolved as part of a run", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("hygiene-f3a-1", 1, "Switch to Hotel provisioning setup.", 0),
      toolEvent("hygiene-f3a-tool-1", 2, "Bash", 1),
      toolEvent("hygiene-f3a-tool-2", 3, "Read", 2)
    ]);
    const job = await enqueue(store, "job-hygiene-f3a", "hygiene-f3a-1", "hygiene-f3a-tool-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });

    const first = await runner.drainSlice(job.personId, job.id, { maxEvents: 2 });
    expect(first.complete).toBe(false);
    expect(first.checkpoint.pendingToolRun).toMatchObject({ startEventId: "hygiene-f3a-tool-1", eventCount: 1 });
    let summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.summaryText).not.toContain("[Tool call: Bash]");
    expect(summaries[0]!.summaryText).not.toMatch(/\[Activity\]/);

    const second = await runner.drainSlice(job.personId, job.id);
    expect(second.complete).toBe(true);
    expect(second.checkpoint.pendingToolRun).toBeNull();
    summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.summaryText).toContain("[Activity] ran 2 tool calls:");
  });

  it("slice boundary: a withheld length-1 tail followed by a conversational event stays an isolated single", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("hygiene-f3b-1", 1, "Switch to India provisioning setup.", 0),
      toolEvent("hygiene-f3b-tool-1", 2, "Bash", 1),
      event("hygiene-f3b-2", 3, "India provisioning setup follow-up.", 2, "assistant")
    ]);
    const job = await enqueue(store, "job-hygiene-f3b", "hygiene-f3b-1", "hygiene-f3b-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });

    const first = await runner.drainSlice(job.personId, job.id, { maxEvents: 2 });
    expect(first.complete).toBe(false);
    expect(first.checkpoint.pendingToolRun).toMatchObject({ startEventId: "hygiene-f3b-tool-1", eventCount: 1 });

    const second = await runner.drainSlice(job.personId, job.id);
    expect(second.complete).toBe(true);
    expect(second.checkpoint.pendingToolRun).toBeNull();
    const [summary] = await store.listSummaries();
    expect(summary!.summaryText).toContain("[Tool call: Bash]");
    expect(summary!.summaryText).not.toMatch(/\[Activity\]/);
  });

  it("pendingToolRun drift guard forces the rewind path instead of emitting a second activity line", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("hygiene-f4-1", 1, "Switch to Juliet incident postmortem.", 0),
      toolEvent("hygiene-f4-tool-1", 2, "Bash", 1),
      toolEvent("hygiene-f4-tool-2", 3, "Read", 2)
    ]);
    const job = await enqueue(store, "job-hygiene-f4", "hygiene-f4-1", "hygiene-f4-tool-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });

    const first = await runner.drainSlice(job.personId, job.id, { maxEvents: 2 });
    expect(first.complete).toBe(false);
    expect(first.checkpoint.pendingToolRun).toMatchObject({ startEventId: "hygiene-f4-tool-1" });

    // Mirrors the existing "resumes by stable canonical key" late-insert fixture: this new event
    // lands (in occurredAt order) between the lead event and the recorded run start, so the
    // recorded startEventId is no longer the first event of the open run at that position.
    await store.saveCanonicalEvent(toolEvent("hygiene-f4-tool-late", 999, "Bash", 0.5));

    const second = await runner.drainSlice(job.personId, job.id);
    expect(second.rewindOrderKey).not.toBeNull();

    const slices = [first, second];
    while (!slices.at(-1)!.complete) slices.push(await runner.drainSlice(job.personId, job.id));

    const summaries = await store.listSummaries();
    const activityLines = summaries.flatMap((summary) => summary.summaryText.match(/\[Activity\] ran \d+ tool calls:/g) ?? []);
    expect(activityLines).toEqual(["[Activity] ran 3 tool calls:"]);
  });

  it("corpus ending inside a run flushes it", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("hygiene-f5-1", 1, "Switch to Kilo cleanup sprint.", 0),
      toolEvent("hygiene-f5-tool-1", 2, "Bash", 1),
      toolEvent("hygiene-f5-tool-2", 3, "Bash", 2),
      toolEvent("hygiene-f5-tool-3", 4, "Read", 3)
    ]);
    const job = await enqueue(store, "job-hygiene-f5", "hygiene-f5-1", "hygiene-f5-tool-3");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });
    const slices = await drain(runner, job);

    expect(slices.at(-1)!.complete).toBe(true);
    expect(slices.at(-1)!.checkpoint.pendingToolRun).toBeNull();
    const [summary] = await store.listSummaries();
    expect(summary!.summaryText).toContain("[Activity] ran 3 tool calls:");
  });

  it("makes progress across a slice with no conversational event", async () => {
    const store = await seededStore();
    const lead = event("hygiene-g-1", 1, "Switch to Lima resilience testing.", 0);
    const run = toolRun("hygiene-g-tool", 600, 2, 1);
    await seedEvents(store, [lead, ...run]);
    const job = await enqueue(store, "job-hygiene-g", "hygiene-g-1", "hygiene-g-tool-600");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });

    let result = await runner.drainSlice(job.personId, job.id);
    let sliceCount = 1;
    expect(result.processedEvents).toBeGreaterThan(0);
    while (!result.complete) {
      result = await runner.drainSlice(job.personId, job.id);
      sliceCount += 1;
      expect(result.processedEvents).toBeGreaterThan(0);
      if (sliceCount > 20) throw new Error("Runaway slice loop — resume cursor is not advancing");
    }
    expect(result.complete).toBe(true);
  });

  it("marks derivations stale when the hygiene rule version changes", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("hygiene-h-1", 1, "Switch to Mike retention policy.", 0),
      event("hygiene-h-2", 2, "Mike retention policy follow-up.", 1, "assistant")
    ]);
    const job = await enqueue(store, "job-hygiene-h", "hygiene-h-1", "hygiene-h-2");
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });
    await drain(runner, job);

    const checkpointId = `contraction_checkpoint_${job.id}`;
    const checkpoint = await store.getContractionCheckpoint(checkpointId);
    await store.saveContractionCheckpoint({ ...checkpoint!, processorVersion: "stale-processor-version" });

    const result = await runner.drainSlice(job.personId, job.id);
    expect(result.rewindOrderKey).not.toBeNull();
  });
});

describe("ProposalScheduler", () => {
  it("publishes immediate deterministic derivations offline while leaving proposal work dirty", async () => {
    const store = await seededStore();
    await seedEvents(store, [
      event("offline-1", 1, "Alpha offline planning roadmap.", 0),
      event("offline-2", 2, "Alpha offline planning deadline.", 1, "assistant")
    ]);
    const runner = new ContractionRunner(store, { clock: new FakeDaemonClock(), authority: foregroundContractionAuthority() });
    const queued = await enqueue(store, "job-offline", "offline-1", "offline-2");

    // Import/scan completion is independently observable before asynchronous contraction begins.
    expect(await store.getContractionJob(queued.id)).toMatchObject({ state: "pending", immediateDirty: true });
    expect(await store.listSummaries()).toEqual([]);
    expect(await store.listProposals()).toEqual([]);

    const result = await runner.drainSlice(PERSON_ID, queued.id);

    expect(result.immediate).toMatchObject({ summaries: expect.any(Number), anchors: expect.any(Number) });
    expect(await store.listSummaries()).not.toEqual([]);
    expect((await store.getContractionJob("job-offline"))?.proposalDirty).toBe(true);
    expect(await store.listProposals()).toEqual([]);
  });

  it("uses the stable job's durable quiet and hourly proposal cadence under continuous activity", async () => {
    const store = await seededStore();
    const clock = new FakeDaemonClock();
    const initial = [
      event("proposal-1", 1, "Alpha proposal planning roadmap details.", 0),
      event("proposal-2", 2, "Switch to Beta proposal launch rollout.", 1),
      event("proposal-3", 3, "Switch to Alpha proposal planning roadmap.", 2)
    ];
    const job = await commitStableBatch(store, "proposal-initial", initial, clock.now());
    await drain(new ContractionRunner(store, { clock, authority: foregroundContractionAuthority() }), job);
    const scheduler = new ProposalScheduler(store, { clock, authority: foregroundContractionAuthority() });

    expect(await scheduler.isDue(PERSON_ID)).toBe(false);
    for (let minute = 9; minute <= 54; minute += 9) {
      clock.advanceBy(9 * 60_000);
      const active = event(`proposal-active-${minute}`, 100 + minute, "Continued proposal activity.", minute);
      const dirty = await commitStableBatch(store, `proposal-active-${minute}`, [active], clock.now());
      expect(await scheduler.isDue(PERSON_ID)).toBe(false);
      await drain(new ContractionRunner(store, { clock, authority: foregroundContractionAuthority() }), dirty);
    }
    clock.advanceBy(6 * 60_000 - 1);
    expect(await scheduler.isDue(PERSON_ID)).toBe(false);
    clock.advanceBy(1);
    expect(await scheduler.isDue(PERSON_ID)).toBe(true);
    await scheduler.runDue(PERSON_ID);
    expect(await store.getContractionJob(job.id)).toMatchObject({
      lastProposalRunAt: clock.now(),
      proposalDirty: false
    });
    expect((await store.listProposals()).every((proposal) => proposal.state === "proposed")).toBe(true);
    expect((await store.listBoxes()).every((box) => box.state === "proposed")).toBe(true);
    expect((await store.listTraces()).every((trace) => trace.state === "proposed")).toBe(true);

    clock.advanceBy(9 * 60_000);
    let dirty = await commitStableBatch(
      store,
      "proposal-second-cycle",
      [event("proposal-second-cycle", 200, "Second proposal cycle activity.", 69)],
      clock.now()
    );
    expect(await scheduler.isDue(PERSON_ID)).toBe(false);
    await drain(new ContractionRunner(store, { clock, authority: foregroundContractionAuthority() }), dirty);
    clock.advanceBy(49 * 60_000);
    dirty = await commitStableBatch(
      store,
      "proposal-second-active",
      [event("proposal-second-active", 201, "Second cycle remains active.", 118)],
      clock.now()
    );
    await drain(new ContractionRunner(store, { clock, authority: foregroundContractionAuthority() }), dirty);
    clock.advanceBy(2 * 60_000 - 1);
    expect(await scheduler.isDue(PERSON_ID)).toBe(false);
    clock.advanceBy(1);
    expect(await scheduler.isDue(PERSON_ID)).toBe(true);
    await scheduler.runDue(PERSON_ID);
    expect((await store.getContractionJob(job.id))?.lastProposalRunAt).toBe(clock.now());

    clock.advanceBy(60_000);
    dirty = await commitStableBatch(
      store,
      "proposal-quiet-cycle",
      [event("proposal-quiet-cycle", 202, "Quiet cycle activity.", 121)],
      clock.now()
    );
    expect(await scheduler.isDue(PERSON_ID)).toBe(false);
    await drain(new ContractionRunner(store, { clock, authority: foregroundContractionAuthority() }), dirty);
    clock.advanceBy(10 * 60_000 - 1);
    expect(await scheduler.isDue(PERSON_ID)).toBe(false);
    clock.advanceBy(1);
    expect(await scheduler.isDue(PERSON_ID)).toBe(true);
  });
});

async function seededStore(options: ConstructorParameters<typeof InMemoryStore>[0] = {}): Promise<InMemoryStore> {
  const store = new InMemoryStore(options);
  await seedPerson(store, PERSON_ID, SCOPE_ID);
  return store;
}

function daemonAuthority(ownerToken: string): WriteAuthority {
  return { kind: "daemon", databaseId: "memory-db", ownerToken };
}

function foregroundContractionAuthority(personId = PERSON_ID): WriteAuthority {
  return { kind: "foreground", personId, operation: "historical-bootstrap" };
}

async function contractionPublicationSnapshot(store: InMemoryStore, jobId: string) {
  return {
    turns: await store.listTurns(`person:${PERSON_ID}`),
    summaries: await store.listSummaries(),
    anchors: await store.listAnchors(),
    boxes: await store.listBoxes(),
    traces: await store.listTraces(),
    proposals: await store.listProposals(),
    checkpoint: await store.getContractionCheckpoint(`contraction_checkpoint_${jobId}`),
    job: await store.getContractionJob(jobId)
  };
}

async function seedPerson(store: InMemoryStore, personId: string, scopeId: string): Promise<void> {
  const person: Person = { id: personId, displayName: null, createdAt: FIXED_NOW };
  const source: MemorySource = {
    id: `source_${personId}`,
    personId,
    application: "synthetic",
    profileId: "default",
    instanceId: "test",
    scopeId,
    createdAt: FIXED_NOW,
    lastImportedAt: FIXED_NOW
  };
  await store.savePerson(person);
  await store.saveSource(source);
  if (personId === PERSON_ID) await store.saveSourceGrant(sourceGrant());
}

async function seedEvents(store: InMemoryStore, events: CanonicalEvent[]): Promise<void> {
  for (const item of events) await store.saveCanonicalEvent(item);
}

function event(
  id: string,
  nativeSequence: number,
  content: string,
  minuteOffset: number,
  role: CanonicalEvent["role"] = "user",
  personId = PERSON_ID,
  scopeId = SCOPE_ID
): CanonicalEvent {
  const occurredAt = new Date(Date.parse(FIXED_NOW) + minuteOffset * 60_000).toISOString();
  return {
    id,
    personId,
    sourceId: `source_${personId}`,
    sourceApplication: "synthetic",
    sourceProfileId: "default",
    scopeId,
    nativeSessionId: "session-synthetic",
    nativeEventId: id,
    nativeSequence,
    causalParentId: null,
    eventKind: "message",
    role,
    content,
    occurredAt,
    importedAt: FIXED_NOW,
    provenance: role === "user" ? "direct_user_input" : "assistant_output",
    trustLevel: role === "user" ? "high" : "medium",
    contentHash: `hash-${id}`,
    parserVersion: "synthetic/v1",
    metadata: {}
  };
}

/** A tool-activity event: `eventKind: "tool_call"`, role `assistant`, `[Tool call: NAME] {args}` content. */
function toolEvent(
  id: string,
  nativeSequence: number,
  toolName: string,
  minuteOffset: number,
  argSuffix = "value"
): CanonicalEvent {
  return {
    ...event(id, nativeSequence, `[Tool call: ${toolName}] ${JSON.stringify({ arg: argSuffix })}`, minuteOffset, "assistant"),
    eventKind: "tool_call"
  };
}

/** A synthetic/harness-injected event using the `[SYSTEM: ...]` rule from derivation-hygiene.ts. */
function syntheticEvent(id: string, nativeSequence: number, body: string, minuteOffset: number): CanonicalEvent {
  return event(id, nativeSequence, `[SYSTEM: ${body}]`, minuteOffset, "assistant");
}

/** A consecutive run of `count` tool-activity events alternating Bash/Read, starting at `startSequence`. */
function toolRun(prefix: string, count: number, startSequence: number, startMinuteOffset: number): CanonicalEvent[] {
  return Array.from({ length: count }, (_, index) =>
    toolEvent(
      `${prefix}-${index + 1}`,
      startSequence + index,
      index % 2 === 0 ? "Bash" : "Read",
      startMinuteOffset + index
    ));
}

async function enqueue(
  store: InMemoryStore,
  id: string,
  earliestId: string,
  latestId: string
): Promise<ContractionJob> {
  const events = await store.listCanonicalEvents(PERSON_ID);
  const byId = new Map(events.map((item) => [item.id, item]));
  const orderKey = (eventId: string) => {
    const item = byId.get(eventId);
    if (!item) throw new Error(`Missing synthetic event ${eventId}`);
    return { occurredAt: item.occurredAt, nativeSequence: item.nativeSequence, id: item.id };
  };
  const job: ContractionJob = {
    id,
    personId: PERSON_ID,
    generation: 1,
    earliestAffected: orderKey(earliestId),
    latestAffected: orderKey(latestId),
    state: "pending",
    attempts: 0,
    immediateDirty: true,
    proposalDirty: true,
    lastProposalRunAt: null,
    lastActivityAt: FIXED_NOW,
    nextDueAt: FIXED_NOW,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW
  };
  await store.saveContractionJob(job);
  return job;
}

async function commitStableBatch(
  store: InMemoryStore,
  label: string,
  events: CanonicalEvent[],
  committedAt: string
): Promise<ContractionJob> {
  if (events.length === 0) throw new Error("Synthetic stable batch must contain events");
  const sorted = [...events].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt) || left.nativeSequence - right.nativeSequence || left.id.localeCompare(right.id)
  );
  const keys = sorted.map((item) => ({ occurredAt: item.occurredAt, nativeSequence: item.nativeSequence, id: item.id }));
  const checkpointId = `checkpoint_${label}`;
  const jobId = stableJobId(PERSON_ID);
  await store.commitImportBatch({
    authority: { kind: "foreground", personId: PERSON_ID, operation: "approved-import" },
    personId: PERSON_ID,
    expectedGrant: {
      id: "grant_contraction",
      personId: PERSON_ID,
      candidateId: "candidate_contraction",
      updatedAt: FIXED_NOW
    },
    sources: [],
    canonicalEvents: sorted,
    turns: [],
    quarantineChanges: [],
    checkpoint: {
      id: checkpointId,
      personId: PERSON_ID,
      candidateId: "candidate_contraction",
      resourcePath: `synthetic/${label}.jsonl`,
      fileIdentity: `synthetic:${label}`,
      byteOffset: label.length + events.length,
      recordIndex: events.length,
      nativeSessionId: "session-synthetic",
      parserVersion: "synthetic/v1",
      updatedAt: committedAt
    },
    receipt: {
      id: `receipt_${label}`,
      personId: PERSON_ID,
      grantId: "grant_contraction",
      candidateId: "candidate_contraction",
      scopeId: SCOPE_ID,
      canonicalEventIds: keys.map((key) => key.id),
      canonicalOrderKeys: keys,
      checkpointIds: [checkpointId],
      committedAt
    },
    contractionJob: {
      id: jobId,
      personId: PERSON_ID,
      generation: 1,
      earliestAffected: keys[0]!,
      latestAffected: keys.at(-1)!,
      state: "pending",
      attempts: 0,
      immediateDirty: true,
      proposalDirty: true,
      lastProposalRunAt: null,
      lastActivityAt: committedAt,
      nextDueAt: committedAt,
      createdAt: committedAt,
      updatedAt: committedAt
    }
  });
  const job = await store.getContractionJob(jobId);
  if (!job) throw new Error("Stable synthetic contraction job was not committed");
  return job;
}

function sourceGrant(): SourceGrant {
  return {
    id: "grant_contraction",
    personId: PERSON_ID,
    candidateId: "candidate_contraction",
    application: "codex",
    format: "codex-rollout-jsonl",
    sourceLocator: "/synthetic/contraction",
    profileId: "default",
    scopeId: SCOPE_ID,
    state: "approved",
    approvedAt: FIXED_NOW,
    revokedAt: null,
    updatedAt: FIXED_NOW
  };
}

function stableJobId(personId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([personId])).digest("hex");
  return `contraction_${digest}`;
}

async function drain(runner: ContractionRunner, job: ContractionJob) {
  const slices = [];
  for (;;) {
    const result = await runner.drainSlice(job.personId, job.id);
    slices.push(result);
    if (result.complete) return slices;
  }
}

async function snapshotPrefix(store: InMemoryStore, lastEventId: string) {
  const summaries = await store.listSummaries();
  const prefixSummaries = summaries.filter((summary) => summary.sourceCanonicalEventIds?.includes(lastEventId));
  const prefixSummaryIds = new Set(prefixSummaries.map((summary) => summary.id));
  return {
    summaries: prefixSummaries,
    anchors: (await store.listAnchors()).filter((anchor) => anchor.canonicalEventId === lastEventId),
    boxes: (await store.listBoxes()).filter((box) => box.summaryIds.some((id) => prefixSummaryIds.has(id))),
    traces: (await store.listTraces()).filter((trace) => trace.summaryIds.some((id) => prefixSummaryIds.has(id))),
    proposals: (await store.listProposals()).filter((proposal) =>
      proposal.sourceSummaryIds.some((id) => prefixSummaryIds.has(id))
    )
  };
}

async function derivationFingerprint(store: InMemoryStore) {
  return {
    turns: await store.listTurns(`person:${PERSON_ID}`),
    summaries: await store.listSummaries(),
    anchors: await store.listAnchors(),
    boxes: await store.listBoxes(),
    traces: await store.listTraces(),
    proposals: await store.listProposals()
  };
}

function unique(items: Array<{ id: string }>): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}
