import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalEvent, MemorySource } from "../../src/domain/canonical.js";
import type { Box, Summary, Turn } from "../../src/domain/types.js";
import type { ImportCheckpoint } from "../../src/imports/types.js";
import type { SourceGrant } from "../../src/domain/source-lifecycle.js";
import type {
  CommitContractionSliceInput,
  CommitImportBatchInput,
  ContractionCheckpoint,
  ContractionJob,
  DaemonSourceState,
  ImportBatchReceipt
} from "../../src/daemon/types.js";
import { ContractionCheckpointSchema, ContractionJobSchema } from "../../src/daemon/types.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import type { MemoryStore } from "../../src/storage/memory-store.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";
import {
  FIXED_NOW,
  FakeCommandRunner,
  FakeDaemonClock,
  FakeNotificationAdapter,
  FakeTimerQueue,
  FaultBoundaryInjector,
  createSyntheticApprovedSources,
  normalizePersistedDaemonState
} from "./fixtures.js";

const DATABASE_ID = "memory-db-test";
const PERSON_ID = "person_daemon";
const OTHER_PERSON_ID = "person_other";
const CANDIDATE_ID = "codex_candidate_synthetic";
const GRANT_ID = "grant_daemon_test";
const SCOPE_ID = "scope_daemon";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (location: string) => {
    close(): void;
    prepare(sql: string): {
      get(...parameters: unknown[]): unknown;
      run(...parameters: unknown[]): void;
    };
  };
};

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("deterministic daemon fixtures", () => {
  it("advances fake wall and monotonic time and drains timers without sleeping", async () => {
    const clock = new FakeDaemonClock();
    const timers = new FakeTimerQueue(clock);
    const calls: string[] = [];
    timers.setTimeout(() => {
      calls.push("later");
    }, 2_000);

    await timers.advanceBy(1_999);
    expect(calls).toEqual([]);
    await timers.advanceBy(1);
    expect(calls).toEqual(["later"]);
    expect(clock.now()).toBe("2026-07-17T12:00:02.000Z");
    expect(clock.monotonicNow()).toBe(2_000);
  });

  it("builds only temporary approved sources and records notification and command calls", async () => {
    const sources = await createSyntheticApprovedSources();
    cleanupPaths.push(sources.tempRoot);
    const notifier = new FakeNotificationAdapter();
    const commands = new FakeCommandRunner();
    await notifier.notify({ title: "Source degraded", body: "codex_candidate_synthetic", sourceId: "codex" });
    await commands.run("pmset", ["-g", "batt"]);

    expect([sources.codex, sources.claudeCode, sources.openClaw, sources.hermes]
      .map((source) => source.grant.state)).toEqual(["approved", "approved", "approved", "approved"]);
    expect([sources.codex, sources.claudeCode, sources.openClaw, sources.hermes]
      .every((source) => source.rootPath.startsWith(sources.tempRoot))).toBe(true);
    expect(notifier.calls).toEqual([{ title: "Source degraded", body: "codex_candidate_synthetic", sourceId: "codex" }]);
    expect(commands.calls).toEqual([{ command: "pmset", args: ["-g", "batt"] }]);
  });
});

describe("daemon durable-store contract", () => {
  it("requires current contraction metadata at every strict schema boundary", () => {
    const legacyJob = makeJob();
    const { generation: _generation, lastProposalRunAt: _lastProposalRunAt, ...oldJob } = legacyJob;
    expect(() => ContractionJobSchema.parse(oldJob)).toThrow();
    expect(() => ContractionJobSchema.parse({ ...oldJob, generation: 0 })).toThrow();
    expect(() => ContractionJobSchema.parse({ ...oldJob, lastProposalRunAt: "not-a-date" })).toThrow();
    expect(() => ContractionJobSchema.parse({ ...oldJob, rawContent: "must not persist" })).toThrow();

    const legacyCheckpoint = makeContractionCheckpoint();
    const { processedThroughOrderKey: _processedThroughOrderKey, ...oldCheckpoint } = legacyCheckpoint;
    expect(() => ContractionCheckpointSchema.parse(oldCheckpoint)).toThrow();
    expect(() => ContractionCheckpointSchema.parse({ ...oldCheckpoint, processedThroughOrderKey: { id: "incomplete" } })).toThrow();
    expect(() => ContractionCheckpointSchema.parse({ ...oldCheckpoint, transcript: "must not persist" })).toThrow();
  });

  for (const backend of ["memory", "sqlite"] as const) {
    describe(backend, () => {
      it("reconciles approved grants into an exact person-owned active source registry", async () => {
        const harness = await createHarness(backend);
        await harness.store.savePerson({ id: PERSON_ID, displayName: "Synthetic person", createdAt: FIXED_NOW });
        await harness.store.savePerson({ id: OTHER_PERSON_ID, displayName: "Other synthetic person", createdAt: FIXED_NOW });
        await harness.store.saveSourceGrant(makeGrant());
        await harness.store.saveSourceGrant(makeGrant({
          id: "grant_other_person",
          personId: OTHER_PERSON_ID,
          candidateId: "candidate_other_person",
          sourceLocator: "/synthetic/other/codex"
        }));

        const enrolled = await harness.store.reconcileDaemonSourceStates(PERSON_ID, FIXED_NOW);
        expect(enrolled).toHaveLength(1);
        expect(enrolled[0]).toMatchObject({
          personId: PERSON_ID,
          grantId: GRANT_ID,
          candidateId: CANDIDATE_ID,
          scopeId: SCOPE_ID,
          state: "healthy",
          nextDueAt: FIXED_NOW,
          attemptCount: 0,
          consecutiveFailures: 0
        });
        expect(JSON.stringify(enrolled)).not.toMatch(/sourceLocator|synthetic\/approved|content|errorMessage/);
        await expect(harness.store.listDaemonSourceStates(OTHER_PERSON_ID)).resolves.toEqual([]);

        const firstSnapshot = JSON.stringify(enrolled);
        await expect(harness.store.reconcileDaemonSourceStates(PERSON_ID, "2026-07-17T12:05:00.000Z"))
          .resolves.toEqual(enrolled);
        expect(JSON.stringify(await harness.store.listDaemonSourceStates(PERSON_ID))).toBe(firstSnapshot);

        const degraded = {
          ...enrolled[0],
          state: "degraded" as const,
          nextDueAt: "2026-07-17T12:06:00.000Z",
          attemptCount: 4,
          consecutiveFailures: 4,
          lastAttemptAt: "2026-07-17T12:04:00.000Z",
          firstFailureAt: "2026-07-17T12:01:00.000Z",
          lastFailureAt: "2026-07-17T12:04:00.000Z",
          errorCategory: "permission_denied" as const,
          degradedAt: "2026-07-17T12:04:00.000Z",
          notificationSentAt: "2026-07-17T12:04:00.000Z",
          updatedAt: "2026-07-17T12:04:00.000Z"
        };
        await harness.store.saveDaemonSourceState(degraded);
        await expect(harness.store.reconcileDaemonSourceStates(PERSON_ID, "2026-07-17T12:05:00.000Z"))
          .resolves.toEqual([degraded]);

        await harness.store.saveSourceGrant(makeGrant({
          state: "revoked",
          revokedAt: "2026-07-17T12:07:00.000Z",
          updatedAt: "2026-07-17T12:07:00.000Z"
        }));
        await expect(harness.store.reconcileDaemonSourceStates(PERSON_ID, "2026-07-17T12:07:00.000Z"))
          .resolves.toEqual([]);
        await expect(harness.store.listDaemonSourceStates(PERSON_ID)).resolves.toEqual([]);

        await harness.store.saveSourceGrant(makeGrant({
          id: "grant_replacement",
          updatedAt: "2026-07-17T12:08:00.000Z"
        }));
        const replaced = await harness.store.reconcileDaemonSourceStates(PERSON_ID, "2026-07-17T12:08:00.000Z");
        expect(replaced).toHaveLength(1);
        expect(replaced[0]).toMatchObject({
          grantId: "grant_replacement",
          state: "healthy",
          nextDueAt: "2026-07-17T12:08:00.000Z",
          attemptCount: 0,
          consecutiveFailures: 0,
          lastSuccessAt: null
        });

        await harness.close();
      });

      it("uses compare-and-set lease ownership with a 10-second heartbeat and 30-second expiry", async () => {
        const clock = new FakeDaemonClock();
        const harness = await createHarness(backend);

        await expect(harness.store.acquireDaemonLease({
          databaseId: DATABASE_ID,
          ownerToken: "owner-a",
          pid: 101,
          now: clock.now()
        })).resolves.toMatchObject({ ownerToken: "owner-a", pid: 101 });
        await expect(harness.store.acquireDaemonLease({
          databaseId: DATABASE_ID,
          ownerToken: "owner-b",
          pid: 202,
          now: clock.now()
        })).resolves.toBeNull();

        clock.advanceBy(10_000);
        await expect(harness.store.heartbeatDaemonLease(DATABASE_ID, "wrong-token", clock.now()))
          .resolves.toBeNull();
        await expect(harness.store.heartbeatDaemonLease(DATABASE_ID, "owner-a", clock.now()))
          .resolves.toMatchObject({ ownerToken: "owner-a", heartbeatAt: clock.now() });
        await expect(harness.store.requestDaemonStop(DATABASE_ID, "wrong-token", clock.now()))
          .resolves.toBe(false);
        await expect(harness.store.requestDaemonStop(DATABASE_ID, "owner-a", clock.now()))
          .resolves.toBe(true);
        await expect(harness.store.releaseDaemonLease(DATABASE_ID, "wrong-token"))
          .resolves.toBe(false);

        clock.advanceBy(30_001);
        await expect(harness.store.acquireDaemonLease({
          databaseId: DATABASE_ID,
          ownerToken: "owner-b",
          pid: 202,
          now: clock.now()
        })).resolves.toMatchObject({ ownerToken: "owner-b", pid: 202 });

        await harness.close();
      });

      it("rejects stale lease authority before every atomic daemon mutation and replays under the replacement owner", async () => {
        const clock = new FakeDaemonClock();
        const harness = await createHarness(backend, undefined, clock);
        await harness.store.saveSourceGrant(makeGrant());
        await harness.store.commitImportBatch(makeImportInput());
        const enrolled = await harness.store.reconcileDaemonSourceStates(PERSON_ID, FIXED_NOW);
        await harness.store.acquireDaemonLease({ databaseId: DATABASE_ID, ownerToken: "owner-a", pid: 101, now: clock.now() });
        const staleAuthority = { kind: "daemon" as const, databaseId: DATABASE_ID, ownerToken: "owner-a" };
        clock.advanceBy(30_001);
        await harness.store.acquireDaemonLease({ databaseId: DATABASE_ID, ownerToken: "owner-b", pid: 202, now: clock.now() });
        const replacementAuthority = { kind: "daemon" as const, databaseId: DATABASE_ID, ownerToken: "owner-b" };

        const staleImport = makeRangeImportInput("stale_owner", "2026-07-17T13:00:00.000Z", 2);
        staleImport.authority = staleAuthority;
        const staleContraction = makeContractionInput({ authority: staleAuthority });
        const expectedGrants = [{
          id: GRANT_ID, personId: PERSON_ID, candidateId: CANDIDATE_ID,
          scopeId: SCOPE_ID, state: "approved" as const, updatedAt: FIXED_NOW
        }];
        const nextDue = { ...enrolled[0], nextDueAt: "2026-07-17T12:10:00.000Z", updatedAt: "2026-07-17T12:01:00.000Z" };
        const currentJob = (await harness.store.getContractionJob("job_person_daemon"))!;
        const nextJob = { ...currentJob, state: "failed" as const, attempts: currentJob.attempts + 1, updatedAt: "2026-07-17T12:01:00.000Z" };
        const staleOperations = [
          () => harness.store.commitImportBatch(staleImport),
          () => harness.store.commitContractionSlice(staleContraction),
          () => harness.store.commitApprovedGrantReconciliation({
            authority: staleAuthority, personId: PERSON_ID, expectedGrants, expectedStates: enrolled, nextStates: enrolled
          }),
          () => harness.store.commitDueSourceRefresh({
            authority: staleAuthority, personId: PERSON_ID, expectedStates: enrolled, nextStates: [nextDue]
          }),
          () => harness.store.commitSourceStateOutcome({
            authority: staleAuthority, personId: PERSON_ID, candidateId: CANDIDATE_ID,
            expectedState: enrolled[0], nextState: nextDue
          }),
          () => harness.store.commitProposalRun({
            authority: staleAuthority, personId: PERSON_ID, jobId: currentJob.id,
            expectedJob: currentJob, expectedCheckpoint: null, boxes: [], proposals: [], traces: [],
            nextJob: { ...currentJob, proposalDirty: false, lastProposalRunAt: FIXED_NOW }, nextCheckpoint: null
          }),
          () => harness.store.commitDaemonWorkOutcome({
            authority: staleAuthority, personId: PERSON_ID, jobId: currentJob.id,
            expectedJob: currentJob, nextJob
          })
        ];
        for (const operation of staleOperations) {
          const before = normalizePersistedDaemonState(await persistedState(harness.store));
          await expect(operation()).rejects.toThrow(/authority|stale|expired/i);
          expect(normalizePersistedDaemonState(await persistedState(harness.store))).toEqual(before);
        }

        staleImport.authority = replacementAuthority;
        await expect(harness.store.commitImportBatch(staleImport)).resolves.toEqual(staleImport.receipt);
        await expect(harness.store.commitImportBatch(staleImport)).resolves.toEqual(staleImport.receipt);
        expect((await harness.store.listCanonicalEvents(PERSON_ID)).filter((event) => event.id === staleImport.canonicalEvents[0].id)).toHaveLength(1);

        staleContraction.authority = replacementAuthority;
        await expect(harness.store.commitContractionSlice(staleContraction)).resolves.toEqual(staleContraction.nextCheckpoint);
        await expect(harness.store.commitContractionSlice(staleContraction)).resolves.toEqual(staleContraction.nextCheckpoint);
        await expect(harness.store.commitApprovedGrantReconciliation({
          authority: replacementAuthority, personId: PERSON_ID, expectedGrants, expectedStates: enrolled, nextStates: enrolled
        })).resolves.toEqual(enrolled);
        await expect(harness.store.commitDueSourceRefresh({
          authority: replacementAuthority, personId: PERSON_ID, expectedStates: enrolled, nextStates: [nextDue]
        })).resolves.toEqual([nextDue]);
        await expect(harness.store.commitDueSourceRefresh({
          authority: replacementAuthority, personId: PERSON_ID, expectedStates: enrolled, nextStates: [nextDue]
        })).resolves.toEqual([nextDue]);
        const successfulState = {
          ...nextDue,
          state: "healthy" as const,
          lastSuccessAt: "2026-07-17T12:02:00.000Z",
          updatedAt: "2026-07-17T12:02:00.000Z"
        };
        await expect(harness.store.commitSourceStateOutcome({
          authority: replacementAuthority, personId: PERSON_ID, candidateId: CANDIDATE_ID,
          expectedState: nextDue, nextState: successfulState
        })).resolves.toEqual(successfulState);
        await expect(harness.store.commitSourceStateOutcome({
          authority: replacementAuthority, personId: PERSON_ID, candidateId: CANDIDATE_ID,
          expectedState: nextDue, nextState: successfulState
        })).resolves.toEqual(successfulState);

        const proposalJob = (await harness.store.getContractionJob(currentJob.id))!;
        const proposalCheckpoint = await harness.store.getContractionCheckpoint(staleContraction.nextCheckpoint.id);
        const publishedJob = { ...proposalJob, proposalDirty: false, lastProposalRunAt: "2026-07-17T12:03:00.000Z" };
        const publishedCheckpoint = proposalCheckpoint
          ? { ...proposalCheckpoint, proposalStage: "complete" as const, updatedAt: "2026-07-17T12:03:00.000Z" }
          : null;
        const proposalCommit = {
          authority: replacementAuthority,
          personId: PERSON_ID,
          jobId: proposalJob.id,
          expectedJob: proposalJob,
          expectedCheckpoint: proposalCheckpoint,
          boxes: [], proposals: [], traces: [],
          nextJob: publishedJob,
          nextCheckpoint: publishedCheckpoint
        };
        await expect(harness.store.commitProposalRun(proposalCommit)).resolves.toEqual(publishedCheckpoint);
        await expect(harness.store.commitProposalRun(proposalCommit)).resolves.toEqual(publishedCheckpoint);
        const completedJob = { ...publishedJob, state: "failed" as const, attempts: publishedJob.attempts + 1 };
        const workCommit = {
          authority: replacementAuthority,
          personId: PERSON_ID,
          jobId: publishedJob.id,
          expectedJob: publishedJob,
          nextJob: completedJob
        };
        await expect(harness.store.commitDaemonWorkOutcome(workCommit)).resolves.toEqual(completedJob);
        await expect(harness.store.commitDaemonWorkOutcome(workCommit)).resolves.toEqual(completedJob);
        await harness.close();
      });

      it("rejects database mismatch and forbidden foreground authority with zero mutation", async () => {
        const clock = new FakeDaemonClock();
        const harness = await createHarness(backend, undefined, clock);
        await harness.store.saveSourceGrant(makeGrant());
        await harness.store.acquireDaemonLease({ databaseId: DATABASE_ID, ownerToken: "owner-a", pid: 101, now: clock.now() });
        const before = normalizePersistedDaemonState(await persistedState(harness.store));
        await expect(harness.store.commitImportBatch(makeImportInput({
          authority: { kind: "daemon", databaseId: "other-database", ownerToken: "owner-a" }
        }))).rejects.toThrow(/authority|stale|expired/i);
        await expect(harness.store.commitImportBatch(makeImportInput({
          authority: { kind: "foreground", personId: PERSON_ID, operation: "historical-bootstrap" }
        }))).rejects.toThrow(/foreground|operation/i);
        await expect(harness.store.commitContractionSlice(makeContractionInput({
          authority: { kind: "foreground", personId: PERSON_ID, operation: "approved-import" }
        }))).rejects.toThrow(/foreground|operation/i);
        await expect(harness.store.commitDueSourceRefresh({
          authority: { kind: "foreground", personId: PERSON_ID, operation: "historical-bootstrap" },
          personId: PERSON_ID, expectedStates: [], nextStates: []
        } as never)).rejects.toThrow();
        expect(normalizePersistedDaemonState(await persistedState(harness.store))).toEqual(before);
        await harness.close();
      });

      it("rejects non-proposed review publication before any authoritative mutation", async () => {
        const harness = await createHarness(backend);
        await harness.store.saveSourceGrant(makeGrant());
        await harness.store.commitImportBatch(makeImportInput());
        const job = (await harness.store.getContractionJob("job_person_daemon"))!;
        const before = normalizePersistedDaemonState(await persistedState(harness.store));
        await expect(harness.store.commitProposalRun({
          authority: { kind: "foreground", personId: PERSON_ID, operation: "historical-bootstrap" },
          personId: PERSON_ID,
          jobId: job.id,
          expectedJob: job,
          expectedCheckpoint: null,
          boxes: [makeBox({ state: "approved" })],
          proposals: [],
          traces: [],
          nextJob: { ...job, proposalDirty: false, lastProposalRunAt: FIXED_NOW },
          nextCheckpoint: null
        })).rejects.toThrow(/proposed/i);
        expect(normalizePersistedDaemonState(await persistedState(harness.store))).toEqual(before);
        await harness.close();
      });

      it("revalidates the exact grant and commits import writes, checkpoint, receipt, and job atomically", async () => {
        const harness = await createHarness(backend);
        await harness.store.saveSourceGrant(makeGrant());
        const input = makeImportInput();

        await expect(harness.store.commitImportBatch(input)).resolves.toEqual(input.receipt);
        await expect(harness.store.commitImportBatch(input)).resolves.toEqual(input.receipt);
        expect(await persistedState(harness.store)).toMatchObject({
          eventIds: ["event_daemon_1"],
          turnIds: ["turn_event_daemon_1"],
          checkpointIds: ["checkpoint_daemon_1"],
          receiptIds: ["receipt_daemon_1"],
          jobIds: ["job_person_daemon"]
        });

        await harness.store.saveSourceGrant(makeGrant({
          state: "revoked",
          revokedAt: "2026-07-17T12:01:00.000Z",
          updatedAt: "2026-07-17T12:01:00.000Z"
        }));
        const rejected = makeImportInput({
          canonicalEvents: [makeEvent({ id: "event_daemon_rejected", nativeEventId: "native-rejected" })],
          turns: [makeTurn({ id: "turn_event_daemon_rejected" })],
          checkpoint: makeCheckpoint({ id: "checkpoint_daemon_rejected", recordIndex: 2 }),
          receipt: makeReceipt({ id: "receipt_daemon_rejected" })
        });
        const before = normalizePersistedDaemonState(await persistedState(harness.store));
        await expect(harness.store.commitImportBatch(rejected)).rejects.toThrow(/grant|approved|changed|revoked/i);
        expect(normalizePersistedDaemonState(await persistedState(harness.store))).toEqual(before);

        await harness.close();
      });

      it("keeps append work in-generation and advances one generation for an idempotent late rewind", async () => {
        const harness = await createHarness(backend);
        await harness.store.saveSourceGrant(makeGrant());
        const proposalRunAt = "2026-07-17T12:15:00.000Z";
        await harness.store.commitImportBatch(makeImportInput({
          contractionJob: makeJob({ lastProposalRunAt: proposalRunAt })
        }));
        await harness.store.commitContractionSlice(makeContractionInput({
          nextCheckpoint: makeContractionCheckpoint({
            generation: 1,
            processedThroughOrderKey: { occurredAt: FIXED_NOW, nativeSequence: 1, id: "event_daemon_1" }
          }),
          nextJob: makeJob({
            generation: 1,
            lastProposalRunAt: proposalRunAt,
            state: "complete",
            immediateDirty: false
          })
        }));

        const appendAt = "2026-07-17T13:00:00.000Z";
        const append = makeRangeImportInput("append", appendAt, 2);
        await harness.store.commitImportBatch(append);
        expect(await harness.store.getContractionJob("job_person_daemon")).toMatchObject({
          generation: 1,
          earliestAffected: append.contractionJob!.earliestAffected,
          latestAffected: append.contractionJob!.latestAffected,
          createdAt: FIXED_NOW,
          lastProposalRunAt: proposalRunAt,
          immediateDirty: true,
          proposalDirty: true
        });

        const appendJob = (await harness.store.getContractionJob("job_person_daemon"))!;
        const priorCheckpoint = await harness.store.getContractionCheckpoint("contraction_person_daemon");
        const appendCheckpoint = makeContractionCheckpoint({
          generation: 1,
          processedThroughOrderKey: append.contractionJob!.latestAffected,
          updatedAt: appendAt
        });
        await harness.store.commitContractionSlice(makeContractionInput({
          expectedCheckpoint: priorCheckpoint,
          summaries: [],
          nextCheckpoint: appendCheckpoint,
          nextJob: { ...appendJob, state: "complete", immediateDirty: false, updatedAt: appendAt }
        }));

        const lateAt = "2026-07-17T12:30:00.000Z";
        const late = makeRangeImportInput("late", lateAt, 7);
        await harness.store.commitImportBatch(late);
        const rewound = await harness.store.getContractionJob("job_person_daemon");
        expect(rewound).toMatchObject({
          generation: 2,
          earliestAffected: late.contractionJob!.earliestAffected,
          createdAt: FIXED_NOW,
          lastProposalRunAt: proposalRunAt,
          immediateDirty: true,
          proposalDirty: true,
          state: "pending"
        });
        await expect(harness.store.getContractionCheckpoint("contraction_person_daemon"))
          .resolves.toEqual(appendCheckpoint);

        await harness.store.commitImportBatch(late);
        expect(await harness.store.getContractionJob("job_person_daemon")).toEqual(rewound);
        const repeatedCheckpoint = makeCheckpoint({ id: "checkpoint_daemon_late_repeated", recordIndex: 8, updatedAt: lateAt });
        await harness.store.commitImportBatch({
          ...late,
          checkpoint: repeatedCheckpoint,
          receipt: {
            ...late.receipt,
            id: "receipt_daemon_late_repeated",
            checkpointIds: [repeatedCheckpoint.id]
          }
        });
        expect(await harness.store.getContractionJob("job_person_daemon")).toEqual(rewound);
        await harness.close();
      });

      it("rolls back every import and contraction write when an injected commit boundary fails", async () => {
        for (const boundary of [
          "before_grant_check",
          "after_grant_check",
          "before_import_checkpoint",
          "after_import_checkpoint",
          "before_import_commit"
        ]) {
          const faults = new FaultBoundaryInjector();
          faults.arm(boundary);
          const harness = await createHarness(backend, faults);
          await harness.store.saveSourceGrant(makeGrant());
          const before = normalizePersistedDaemonState(await persistedState(harness.store));
          await expect(harness.store.commitImportBatch(makeImportInput())).rejects.toThrow(/Injected fault/);
          expect(normalizePersistedDaemonState(await persistedState(harness.store))).toEqual(before);
          await harness.close();
        }

        for (const boundary of ["before_contraction_commit", "after_contraction_checkpoint"]) {
          const faults = new FaultBoundaryInjector();
          faults.arm(boundary);
          const harness = await createHarness(backend, faults);
          await harness.store.saveSourceGrant(makeGrant());
          await harness.store.commitImportBatch(makeImportInput());
          const before = normalizePersistedDaemonState(await persistedState(harness.store));
          await expect(harness.store.commitContractionSlice(makeContractionInput()))
            .rejects.toThrow(/Injected fault/);
          expect(normalizePersistedDaemonState(await persistedState(harness.store))).toEqual(before);
          await harness.close();
        }
      });

      it("publishes contraction derivations and the next checkpoint as one idempotent slice", async () => {
        const harness = await createHarness(backend);
        await harness.store.saveSourceGrant(makeGrant());
        await harness.store.commitImportBatch(makeImportInput());
        const input = makeContractionInput();

        await expect(harness.store.commitContractionSlice(input)).resolves.toEqual(input.nextCheckpoint);
        await expect(harness.store.commitContractionSlice(input)).resolves.toEqual(input.nextCheckpoint);
        await expect(harness.store.listSummaries()).resolves.toEqual([input.summaries[0]]);
        await expect(harness.store.getContractionCheckpoint(input.nextCheckpoint.id))
          .resolves.toEqual(input.nextCheckpoint);
        await expect(harness.store.getContractionJob(input.jobId)).resolves.toMatchObject({
          id: input.jobId,
          state: "complete"
        });

        await harness.close();
      });

      it("fails closed when a person attempts to read or mutate another person's daemon state", async () => {
        const harness = await createHarness(backend);
        await harness.store.saveSourceGrant(makeGrant());
        await harness.store.commitImportBatch(makeImportInput());

        await expect(harness.store.listDaemonSourceStates(OTHER_PERSON_ID)).resolves.toEqual([]);
        await expect(harness.store.listImportBatchReceipts(OTHER_PERSON_ID)).resolves.toEqual([]);
        await expect(harness.store.listContractionJobs(OTHER_PERSON_ID)).resolves.toEqual([]);
        await expect(harness.store.saveDaemonSourceState(makeSourceState({ personId: OTHER_PERSON_ID })))
          .rejects.toThrow(/different person|ownership/i);
        await expect(harness.store.commitImportBatch(makeImportInput({ personId: OTHER_PERSON_ID })))
          .rejects.toThrow(/person|grant|ownership/i);

        await harness.close();
      });
    });
  }

  it("reconstructs lease, source health, jobs, receipts, and checkpoints after SQLite close/reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-reopen-"));
    cleanupPaths.push(directory);
    const databasePath = join(directory, "memory.sqlite");
    let store = new SqliteStore(databasePath);
    await store.saveSourceGrant(makeGrant());
    await store.acquireDaemonLease({
      databaseId: DATABASE_ID,
      ownerToken: "owner-a",
      pid: 101,
      now: FIXED_NOW
    });
    await store.saveDaemonSourceState(makeSourceState());
    await store.commitImportBatch(makeImportInput());
    await store.commitContractionSlice(makeContractionInput());
    const clean = normalizePersistedDaemonState(await persistedState(store));
    store.close();

    store = new SqliteStore(databasePath);
    expect(normalizePersistedDaemonState(await persistedState(store))).toEqual(clean);
    await expect(store.getDaemonLease(DATABASE_ID)).resolves.toMatchObject({ ownerToken: "owner-a" });
    await expect(store.listDaemonSourceStates(PERSON_ID)).resolves.toEqual([makeSourceState()]);
    store.close();
  });

  it("revalidates persisted SQLite lease authority after close and reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-authority-reopen-"));
    cleanupPaths.push(directory);
    const databasePath = join(directory, "memory.sqlite");
    const clock = new FakeDaemonClock();
    let store = new SqliteStore(databasePath, { clock });
    await store.saveSourceGrant(makeGrant());
    await store.acquireDaemonLease({ databaseId: DATABASE_ID, ownerToken: "owner-a", pid: 101, now: clock.now() });
    const input = makeImportInput({ authority: { kind: "daemon", databaseId: DATABASE_ID, ownerToken: "owner-a" } });
    await store.commitImportBatch(input);
    store.close();

    store = new SqliteStore(databasePath, { clock });
    await expect(store.commitImportBatch(input)).resolves.toEqual(input.receipt);
    clock.advanceBy(30_001);
    const before = normalizePersistedDaemonState(await persistedState(store));
    await expect(store.commitContractionSlice(makeContractionInput({
      authority: { kind: "daemon", databaseId: DATABASE_ID, ownerToken: "owner-a" }
    }))).rejects.toThrow(/authority|stale|expired/i);
    expect(normalizePersistedDaemonState(await persistedState(store))).toEqual(before);
    store.close();
  });

  it("reconstructs a grants-only active source registry after SQLite close/reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-reconcile-reopen-"));
    cleanupPaths.push(directory);
    const databasePath = join(directory, "memory.sqlite");
    let store = new SqliteStore(databasePath);
    await store.savePerson({ id: PERSON_ID, displayName: "Synthetic person", createdAt: FIXED_NOW });
    await store.saveSourceGrant(makeGrant());
    const expected = await store.reconcileDaemonSourceStates(PERSON_ID, FIXED_NOW);
    store.close();

    store = new SqliteStore(databasePath);
    await expect(store.listDaemonSourceStates(PERSON_ID)).resolves.toEqual(expected);
    await expect(store.reconcileDaemonSourceStates(PERSON_ID, "2026-07-17T12:05:00.000Z"))
      .resolves.toEqual(expected);
    store.close();
  });

  it("makes the same late-range rewind decision in memory and after SQLite reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-rewind-reopen-"));
    cleanupPaths.push(directory);
    const databasePath = join(directory, "memory.sqlite");
    const memory = new InMemoryStore();
    let sqlite = new SqliteStore(databasePath);
    const proposalRunAt = "2026-07-17T11:45:00.000Z";

    for (const store of [memory, sqlite]) {
      await store.saveSourceGrant(makeGrant());
      await store.commitImportBatch(makeImportInput({
        contractionJob: makeJob({ lastProposalRunAt: proposalRunAt })
      }));
      await store.commitContractionSlice(makeContractionInput({
        summaries: [],
        nextCheckpoint: makeContractionCheckpoint({
          generation: 1,
          processedThroughOrderKey: { occurredAt: FIXED_NOW, nativeSequence: 1, id: "event_daemon_1" }
        }),
        nextJob: makeJob({
          generation: 1,
          lastProposalRunAt: proposalRunAt,
          state: "complete",
          immediateDirty: false
        })
      }));
    }
    sqlite.close();
    sqlite = new SqliteStore(databasePath);

    const late = makeRangeImportInput("restart_late", "2026-07-17T11:30:00.000Z", 9);
    await memory.commitImportBatch(late);
    await sqlite.commitImportBatch(late);

    expect(await sqlite.getContractionJob("job_person_daemon"))
      .toEqual(await memory.getContractionJob("job_person_daemon"));
    expect(await sqlite.getContractionCheckpoint("contraction_person_daemon"))
      .toEqual(await memory.getContractionCheckpoint("contraction_person_daemon"));
    expect(await sqlite.getContractionJob("job_person_daemon")).toMatchObject({
      generation: 2,
      earliestAffected: late.contractionJob!.earliestAffected,
      lastProposalRunAt: proposalRunAt,
      immediateDirty: true,
      proposalDirty: true
    });
    sqlite.close();
  });

  it("backfills legacy SQLite contraction payloads transactionally and byte-stably", async () => {
    const directory = await mkdtemp(join(tmpdir(), "daemon-legacy-reopen-"));
    cleanupPaths.push(directory);
    const databasePath = join(directory, "memory.sqlite");
    let store = new SqliteStore(databasePath);
    await store.saveSourceGrant(makeGrant());
    await store.commitImportBatch(makeImportInput());
    await store.saveCanonicalEvent(makeEvent({
      id: "event_daemon_2",
      nativeEventId: "native-2",
      nativeSequence: 2,
      occurredAt: "2026-07-17T13:00:00.000Z"
    }));
    await store.saveContractionCheckpoint(makeContractionCheckpoint({
      nextOrderKey: { occurredAt: "2026-07-17T13:00:00.000Z", nativeSequence: 2, id: "event_daemon_2" }
    }));
    store.close();

    const raw = new DatabaseSync(databasePath);
    const jobPayload = JSON.parse((raw.prepare("select payload from daemon_contraction_job where id = ?")
      .get("job_person_daemon") as { payload: string }).payload) as Record<string, unknown>;
    delete jobPayload.generation;
    delete jobPayload.lastProposalRunAt;
    raw.prepare("update daemon_contraction_job set payload = ? where id = ?")
      .run(JSON.stringify(jobPayload), "job_person_daemon");
    const checkpointPayload = JSON.parse((raw.prepare("select payload from daemon_contraction_checkpoint where id = ?")
      .get("contraction_person_daemon") as { payload: string }).payload) as Record<string, unknown>;
    delete checkpointPayload.processedThroughOrderKey;
    raw.prepare("update daemon_contraction_checkpoint set payload = ? where id = ?")
      .run(JSON.stringify(checkpointPayload), "contraction_person_daemon");
    raw.close();

    store = new SqliteStore(databasePath);
    await expect(store.getContractionJob("job_person_daemon")).resolves.toMatchObject({
      generation: 1,
      lastProposalRunAt: null,
      createdAt: FIXED_NOW
    });
    await expect(store.getContractionCheckpoint("contraction_person_daemon")).resolves.toMatchObject({
      generation: 1,
      processedThroughOrderKey: { occurredAt: FIXED_NOW, nativeSequence: 1, id: "event_daemon_1" }
    });
    store.close();

    const completedRaw = new DatabaseSync(databasePath);
    const completedPayload = JSON.parse((completedRaw.prepare(
      "select payload from daemon_contraction_checkpoint where id = ?"
    ).get("contraction_person_daemon") as { payload: string }).payload) as Record<string, unknown>;
    completedPayload.nextOrderKey = null;
    completedPayload.nextEventId = null;
    delete completedPayload.processedThroughOrderKey;
    completedRaw.prepare("update daemon_contraction_checkpoint set payload = ? where id = ?")
      .run(JSON.stringify(completedPayload), "contraction_person_daemon");
    completedRaw.close();
    store = new SqliteStore(databasePath);
    await expect(store.getContractionCheckpoint("contraction_person_daemon")).resolves.toMatchObject({
      processedThroughOrderKey: {
        occurredAt: "2026-07-17T13:00:00.000Z",
        nativeSequence: 2,
        id: "event_daemon_2"
      }
    });
    store.close();

    const firstReopen = new DatabaseSync(databasePath);
    const firstBytes = (firstReopen.prepare(
      "select (select payload from daemon_contraction_job where id = ?) || char(10) || (select payload from daemon_contraction_checkpoint where id = ?) as payload"
    ).get("job_person_daemon", "contraction_person_daemon") as { payload: string }).payload;
    firstReopen.close();
    store = new SqliteStore(databasePath);
    store.close();
    const secondReopen = new DatabaseSync(databasePath);
    const secondBytes = (secondReopen.prepare(
      "select (select payload from daemon_contraction_job where id = ?) || char(10) || (select payload from daemon_contraction_checkpoint where id = ?) as payload"
    ).get("job_person_daemon", "contraction_person_daemon") as { payload: string }).payload;
    secondReopen.close();
    expect(secondBytes).toBe(firstBytes);
  });
});

interface StoreHarness {
  store: MemoryStore;
  close(): Promise<void>;
}

async function createHarness(
  backend: "memory" | "sqlite",
  faults?: FaultBoundaryInjector,
  clock?: FakeDaemonClock
): Promise<StoreHarness> {
  if (backend === "memory") {
    return { store: new InMemoryStore({ faultInjector: faults, clock }), close: async () => undefined };
  }
  const directory = await mkdtemp(join(tmpdir(), "daemon-store-"));
  cleanupPaths.push(directory);
  const store = new SqliteStore(join(directory, "memory.sqlite"), { faultInjector: faults, clock });
  return { store, close: async () => store.close() };
}

async function persistedState(store: MemoryStore): Promise<Record<string, unknown>> {
  return {
    lease: await store.getDaemonLease(DATABASE_ID),
    sourceStates: await store.listDaemonSourceStates(PERSON_ID),
    eventIds: (await store.listCanonicalEvents(PERSON_ID)).map((event) => event.id),
    turnIds: (await store.listTurns(`person:${PERSON_ID}`)).map((turn) => turn.id),
    checkpointIds: (await store.listImportCheckpoints(PERSON_ID)).map((checkpoint) => checkpoint.id),
    receiptIds: (await store.listImportBatchReceipts(PERSON_ID)).map((receipt) => receipt.id),
    jobIds: (await store.listContractionJobs(PERSON_ID)).map((job) => job.id),
    jobs: await store.listContractionJobs(PERSON_ID),
    contractionCheckpoint: await store.getContractionCheckpoint("contraction_person_daemon"),
    summaryIds: (await store.listSummaries()).filter((summary) => summary.personId === PERSON_ID).map((summary) => summary.id),
    summaries: (await store.listSummaries()).filter((summary) => summary.personId === PERSON_ID),
    boxes: (await store.listBoxes()).filter((box) => box.personId === PERSON_ID),
    proposals: (await store.listProposals()).filter((proposal) => proposal.personId === PERSON_ID),
    traces: (await store.listTraces()).filter((trace) => trace.personId === PERSON_ID)
  };
}

function makeGrant(overrides: Partial<SourceGrant> = {}): SourceGrant {
  return {
    id: GRANT_ID,
    personId: PERSON_ID,
    candidateId: CANDIDATE_ID,
    application: "codex",
    format: "codex-rollout-jsonl",
    sourceLocator: "/synthetic/approved/codex",
    profileId: "default",
    scopeId: SCOPE_ID,
    state: "approved",
    approvedAt: FIXED_NOW,
    revokedAt: null,
    updatedAt: FIXED_NOW,
    ...overrides
  };
}

function makeSource(overrides: Partial<MemorySource> = {}): MemorySource {
  return {
    id: "source_daemon",
    personId: PERSON_ID,
    application: "codex",
    profileId: "default",
    instanceId: CANDIDATE_ID,
    scopeId: SCOPE_ID,
    createdAt: FIXED_NOW,
    lastImportedAt: FIXED_NOW,
    ...overrides
  };
}

function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    id: "event_daemon_1",
    personId: PERSON_ID,
    sourceId: "source_daemon",
    sourceApplication: "codex",
    sourceProfileId: "default",
    scopeId: SCOPE_ID,
    nativeSessionId: "daemon-session",
    nativeEventId: "native-1",
    nativeSequence: 1,
    causalParentId: null,
    role: "user",
    content: "Synthetic daemon import event.",
    occurredAt: FIXED_NOW,
    importedAt: FIXED_NOW,
    provenance: "direct_user_input",
    trustLevel: "high",
    contentHash: "hash-daemon-1",
    parserVersion: "codex-rollout/v1",
    metadata: {},
    ...overrides
  };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn_event_daemon_1",
    threadId: `person:${PERSON_ID}`,
    sequence: 1,
    role: "user",
    content: "Synthetic daemon import event.",
    createdAt: FIXED_NOW,
    provenance: "direct_user_input",
    trustLevel: "high",
    metadata: {
      personId: PERSON_ID,
      scopeId: SCOPE_ID,
      canonicalEventId: "event_daemon_1",
      sourceCandidateId: CANDIDATE_ID
    },
    contentHash: "hash-daemon-1",
    ...overrides
  };
}

function makeCheckpoint(overrides: Partial<ImportCheckpoint> = {}): ImportCheckpoint {
  return {
    id: "checkpoint_daemon_1",
    personId: PERSON_ID,
    candidateId: CANDIDATE_ID,
    resourcePath: "sessions/2026/07/17/rollout-daemon.jsonl",
    fileIdentity: "synthetic:1",
    byteOffset: 100,
    recordIndex: 1,
    nativeSessionId: "daemon-session",
    parserVersion: "codex-rollout/v1",
    updatedAt: FIXED_NOW,
    ...overrides
  };
}

function makeReceipt(overrides: Partial<ImportBatchReceipt> = {}): ImportBatchReceipt {
  return {
    id: "receipt_daemon_1",
    personId: PERSON_ID,
    grantId: GRANT_ID,
    candidateId: CANDIDATE_ID,
    scopeId: SCOPE_ID,
    canonicalEventIds: ["event_daemon_1"],
    canonicalOrderKeys: [{ occurredAt: FIXED_NOW, nativeSequence: 1, id: "event_daemon_1" }],
    checkpointIds: ["checkpoint_daemon_1"],
    committedAt: FIXED_NOW,
    ...overrides
  };
}

function makeJob(overrides: Partial<ContractionJob> = {}): ContractionJob {
  const key = { occurredAt: FIXED_NOW, nativeSequence: 1, id: "event_daemon_1" };
  return {
    id: "job_person_daemon",
    personId: PERSON_ID,
    generation: 1,
    earliestAffected: key,
    latestAffected: key,
    state: "pending",
    attempts: 0,
    immediateDirty: true,
    proposalDirty: true,
    lastProposalRunAt: null,
    lastActivityAt: FIXED_NOW,
    nextDueAt: FIXED_NOW,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides
  };
}

function makeSourceState(overrides: Partial<DaemonSourceState> = {}): DaemonSourceState {
  return {
    id: "daemon-source-codex",
    personId: PERSON_ID,
    grantId: GRANT_ID,
    candidateId: CANDIDATE_ID,
    scopeId: SCOPE_ID,
    state: "healthy",
    nextDueAt: FIXED_NOW,
    attemptCount: 0,
    consecutiveFailures: 0,
    lastAttemptAt: null,
    lastSuccessAt: FIXED_NOW,
    firstFailureAt: null,
    lastFailureAt: null,
    errorCategory: null,
    degradedAt: null,
    notificationSentAt: null,
    updatedAt: FIXED_NOW,
    ...overrides
  };
}

function makeImportInput(overrides: Partial<CommitImportBatchInput> = {}): CommitImportBatchInput {
  return {
    authority: { kind: "foreground", personId: PERSON_ID, operation: "approved-import" },
    personId: PERSON_ID,
    expectedGrant: {
      id: GRANT_ID,
      personId: PERSON_ID,
      candidateId: CANDIDATE_ID,
      updatedAt: FIXED_NOW
    },
    sources: [makeSource()],
    canonicalEvents: [makeEvent()],
    turns: [makeTurn()],
    quarantineChanges: [],
    checkpoint: makeCheckpoint(),
    receipt: makeReceipt(),
    contractionJob: makeJob(),
    ...overrides
  };
}

function makeContractionCheckpoint(
  overrides: Partial<ContractionCheckpoint> = {}
): ContractionCheckpoint {
  return {
    id: "contraction_person_daemon",
    personId: PERSON_ID,
    jobId: "job_person_daemon",
    processorVersion: "daemon-contraction/v1",
    generation: 1,
    processedThroughOrderKey: null,
    nextOrderKey: null,
    nextEventId: null,
    activeTopic: null,
    sliceCount: 1,
    immediateStage: "complete",
    proposalStage: "pending",
    updatedAt: FIXED_NOW,
    ...overrides
  };
}

function makeRangeImportInput(label: string, occurredAt: string, nativeSequence: number): CommitImportBatchInput {
  const eventId = `event_daemon_${label}`;
  const checkpointId = `checkpoint_daemon_${label}`;
  const key = { occurredAt, nativeSequence, id: eventId };
  return makeImportInput({
    canonicalEvents: [makeEvent({ id: eventId, nativeEventId: `native-${label}`, nativeSequence, occurredAt })],
    turns: [makeTurn({
      id: `turn_${eventId}`,
      sequence: nativeSequence,
      createdAt: occurredAt,
      metadata: {
        personId: PERSON_ID,
        scopeId: SCOPE_ID,
        canonicalEventId: eventId,
        sourceCandidateId: CANDIDATE_ID
      }
    })],
    checkpoint: makeCheckpoint({ id: checkpointId, recordIndex: nativeSequence, updatedAt: occurredAt }),
    receipt: makeReceipt({
      id: `receipt_daemon_${label}`,
      canonicalEventIds: [eventId],
      canonicalOrderKeys: [key],
      checkpointIds: [checkpointId],
      committedAt: occurredAt
    }),
    contractionJob: makeJob({
      earliestAffected: key,
      latestAffected: key,
      lastActivityAt: occurredAt,
      nextDueAt: occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt
    })
  });
}

function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    id: "summary_daemon_1",
    personId: PERSON_ID,
    scopeIds: [SCOPE_ID],
    sourceCanonicalEventIds: ["event_daemon_1"],
    summaryText: "Synthetic daemon import event.",
    sourceTurnRanges: [{ threadId: `person:${PERSON_ID}`, startSequence: 1, endSequence: 1 }],
    sourceSummaryIds: [],
    boxIds: [],
    embedding: null,
    createdAt: FIXED_NOW,
    model: "deterministic-test",
    promptVersion: "v1",
    confidence: 1,
    state: "active",
    detailLevel: "brief",
    tokenCount: 5,
    lastAccessedAt: null,
    version: 1,
    strength: 1,
    retrievalCount: 0,
    retrievedAt: null,
    halfLifeHours: 168,
    outcomeScore: null,
    ...overrides
  };
}

function makeBox(overrides: Partial<Box> = {}): Box {
  return {
    id: "box_daemon_proposal",
    personId: PERSON_ID,
    title: "Synthetic proposed box",
    description: "Synthetic review-only metadata.",
    parentBoxId: null,
    childBoxIds: [],
    summaryIds: ["summary_daemon_1"],
    turnRanges: [{ threadId: `person:${PERSON_ID}`, startSequence: 1, endSequence: 1 }],
    state: "proposed",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    caseId: null,
    boxType: "topic",
    summary: "Synthetic review-only metadata.",
    lastActivityAt: FIXED_NOW,
    ...overrides
  };
}

function makeContractionInput(
  overrides: Partial<CommitContractionSliceInput> = {}
): CommitContractionSliceInput {
  return {
    authority: { kind: "foreground", personId: PERSON_ID, operation: "historical-bootstrap" },
    personId: PERSON_ID,
    jobId: "job_person_daemon",
    expectedCheckpoint: null,
    turns: [],
    summaries: [makeSummary()],
    anchors: [],
    boxes: [],
    proposals: [],
    traces: [],
    supersessions: [],
    nextCheckpoint: makeContractionCheckpoint(),
    nextJob: makeJob({ state: "complete", immediateDirty: false }),
    ...overrides
  };
}
