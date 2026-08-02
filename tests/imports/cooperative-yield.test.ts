import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeHistoryImporter } from "../../src/imports/claude-importer.js";
import { approveClaudeHistory, discoverClaudeHistory } from "../../src/imports/claude-discovery.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { createEventLoopYielder } from "../../src/imports/cooperative-yield.js";

describe("createEventLoopYielder", () => {
  it("yields only once the interval has elapsed", async () => {
    let clock = 1_000;
    let yields = 0;
    const maybeYield = createEventLoopYielder({
      intervalMs: 50,
      now: () => clock,
      yieldNow: async () => { yields += 1; }
    });

    await maybeYield();
    expect(yields).toBe(0);      // no time has passed
    clock += 49;
    await maybeYield();
    expect(yields).toBe(0);      // still inside the interval
    clock += 1;
    await maybeYield();
    expect(yields).toBe(1);      // interval reached
    await maybeYield();
    expect(yields).toBe(1);      // interval restarts from the yield
    clock += 50;
    await maybeYield();
    expect(yields).toBe(2);
  });

  it("measures the next interval from after the yield, not before it", async () => {
    // A slow yield must not immediately re-arm; otherwise a loaded machine yields continuously.
    let clock = 0;
    let yields = 0;
    const maybeYield = createEventLoopYielder({
      intervalMs: 50,
      now: () => clock,
      yieldNow: async () => { yields += 1; clock += 500; }
    });
    clock = 50;
    await maybeYield();
    expect(yields).toBe(1);
    await maybeYield();
    expect(yields).toBe(1);
  });
});

/**
 * The regression this exists for: the daemon renews its lease from a `setTimeout` heartbeat, and
 * `assertFreshDaemonAuthority` rejects every write once the lease passes its 30 s TTL.
 *
 * `node:sqlite`'s `DatabaseSync` is synchronous, so every `SqliteStore` method is `async` in
 * signature but does its work inline. `commitStagedGrantBatch`'s per-file commit loop therefore
 * never reaches the event loop's timer phase. On the live corpus that expired the lease mid-loop and
 * aborted a `memory daemon once` after it had already committed 21,118 events, still reporting
 * exit 0 and a success-shaped receipt.
 *
 * The timer is armed inside `beforeCommit`, which runs exactly once immediately before that loop, so
 * this measures the commit phase and nothing else.
 *
 * The assertion is deliberately about a *timer* rather than about the yielder being called: a fix
 * that yielded only to microtasks (`await Promise.resolve()`, `queueMicrotask`) would satisfy a
 * call-count assertion while leaving the heartbeat exactly as starved.
 */
describe("the per-file commit loop lets the daemon heartbeat timer fire", () => {
  const NOW = "2026-07-16T12:00:00.000Z";
  let root: string;

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "yield-commit-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("runs a pending setTimeout armed at the start of the commit loop", async () => {
    // One commit per scanned file, so many small files make a long commit loop. Written in
    // parallel: 400 sequential writeFile calls made the SETUP, not the assertion, exceed the
    // suite's default timeout under parallel load.
    const directory = join(root, "projects/-workspace");
    await mkdir(directory, { recursive: true });
    await Promise.all(Array.from({ length: 400 }, (_, index) => writeFile(
      join(directory, `session-${index}.jsonl`),
      `${JSON.stringify({
        type: "user", uuid: `u${index}`, parentUuid: null, sessionId: `session-${index}`,
        timestamp: NOW, isSidechain: false,
        message: { role: "user", content: [{ type: "text", text: `message ${index}` }] }
      })}\n`
    )));

    const store = new InMemoryStore();
    const candidate = await discoverClaudeHistory(root, NOW);
    await store.saveSourceGrant({
      id: "grant_1", personId: "person_1", candidateId: candidate.id, application: "claude-code",
      format: "claude-project-jsonl", sourceLocator: root, profileId: "default", scopeId: "personal",
      state: "approved", approvedAt: NOW, revokedAt: null, updatedAt: NOW
    } as never);
    const grant = (await store.listSourceGrants("person_1"))[0];

    let heartbeatFired = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;

    await new ClaudeHistoryImporter(store, { clock: () => NOW }).importApprovedGrantBatch(grant, {
      authority: { kind: "foreground", personId: "person_1", operation: "approved-import" },
      // Runs once, immediately before the commit loop.
      beforeCommit: () => { heartbeat = setTimeout(() => { heartbeatFired = true; }, 0); }
    });
    if (heartbeat) clearTimeout(heartbeat);

    // Before the fix this stayed false: 400 synchronous commits with no timer-phase turn between
    // them, which is exactly how the daemon lease expired mid-import.
    expect(heartbeatFired).toBe(true);
  });
});

/**
 * Kept as a guard rather than as proof of the fix. It passes with or without the yield, because the
 * record loop reads through a file stream whose real I/O already reaches the timer phase — an
 * earlier version of this test passed against unfixed code, which is how the starvation was traced
 * to the commit loop instead. It exists so that a future change making the record loop fully
 * synchronous fails here.
 */
describe("the record loop leaves the timer phase reachable", () => {
  const NOW = "2026-07-16T12:00:00.000Z";
  let root: string;

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "yield-import-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("runs a pending setTimeout before the import completes", async () => {
    const absolutePath = join(root, "projects/-workspace/session-1.jsonl");
    await mkdir(dirname(absolutePath), { recursive: true });
    const records = Array.from({ length: 4_000 }, (_, index) => JSON.stringify({
      type: "user",
      uuid: `u${index}`,
      parentUuid: index === 0 ? null : `u${index - 1}`,
      sessionId: "session-1",
      timestamp: NOW,
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: `message ${index} ${"x".repeat(200)}` }] }
    }));
    await writeFile(absolutePath, `${records.join("\n")}\n`);

    const store = new InMemoryStore();
    const approval = approveClaudeHistory(await discoverClaudeHistory(root, NOW), "person_1", "default", NOW);
    const importer = new ClaudeHistoryImporter(store, { clock: () => NOW });

    let heartbeatFired = false;
    const heartbeat = setTimeout(() => { heartbeatFired = true; }, 0);

    const result = await importer.importApprovedSource(approval);
    clearTimeout(heartbeat);

    expect(result.messagesProcessed).toBe(4_000);
    expect(heartbeatFired).toBe(true);
  });
});
