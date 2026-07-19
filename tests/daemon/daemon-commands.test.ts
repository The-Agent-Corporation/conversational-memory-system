import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseDaemonCommandArgs,
  runDaemonCommand,
  signalFreshDaemonOwner,
  type DaemonCommandDependencies
} from "../../src/daemon/daemon-command.js";
import { SqliteStore } from "../../src/storage/sqlite-store.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("daemon lifecycle command parsing", () => {
  it.each(["run", "start", "stop", "restart", "status", "once"] as const)(
    "parses %s with both flag syntaxes",
    (subcommand) => {
      expect(parseDaemonCommandArgs([subcommand, "--db", "relative-memory.sqlite"])).toEqual({
        subcommand,
        databasePath: resolve("relative-memory.sqlite"),
        personId: undefined
      });
      if (subcommand === "status") {
        expect(parseDaemonCommandArgs([subcommand, "--db=relative-memory.sqlite", "--person=person_a"]))
          .toEqual({
            subcommand,
            databasePath: resolve("relative-memory.sqlite"),
            personId: "person_a"
          });
      } else {
        expect(() => parseDaemonCommandArgs([
          subcommand,
          "--db=relative-memory.sqlite",
          "--person=person_a"
        ])).toThrow(/person|status/i);
      }
    }
  );

  it("rejects missing, unknown, and malformed command inputs", () => {
    expect(() => parseDaemonCommandArgs([])).toThrow(/subcommand/i);
    expect(() => parseDaemonCommandArgs(["enable", "--db", "memory.sqlite"])).toThrow(/subcommand/i);
    expect(() => parseDaemonCommandArgs(["status"])).toThrow(/database|--db/i);
    expect(() => parseDaemonCommandArgs(["status", "--db", ""])).toThrow(/database|--db/i);
    expect(() => parseDaemonCommandArgs(["status", "--db", "memory.sqlite", "--unknown", "x"]))
      .toThrow(/unknown/i);
  });
});

describe("daemon lifecycle commands", () => {
  it("keeps autostart behind explicit start and orders restart as graceful stop then start", async () => {
    const calls: string[] = [];
    const dependencies = fakeDependencies(calls);

    await expect(runDaemonCommand({
      subcommand: "run",
      databasePath: resolve("memory.sqlite")
    }, dependencies)).resolves.toMatchObject({ ok: true, subcommand: "run" });
    await expect(runDaemonCommand({
      subcommand: "once",
      databasePath: resolve("memory.sqlite")
    }, dependencies)).resolves.toMatchObject({ ok: true, subcommand: "once" });
    await expect(runDaemonCommand({
      subcommand: "status",
      databasePath: resolve("memory.sqlite")
    }, dependencies)).resolves.toMatchObject({ ok: true, subcommand: "status" });
    expect(calls).toEqual(["loop.run", "loop.once", "status"]);

    await runDaemonCommand({ subcommand: "start", databasePath: resolve("memory.sqlite") }, dependencies);
    expect(calls.at(-1)).toBe("launch.start");
    await runDaemonCommand({ subcommand: "restart", databasePath: resolve("memory.sqlite") }, dependencies);
    expect(calls.slice(-3)).toEqual(["stop.request", "launch.stop", "launch.start"]);
  });

  it("signals only a fresh matching lease and reports PID-only state as stale", async () => {
    const calls: string[] = [];
    const stale = fakeDependencies(calls, {
      status: {
        state: "stale",
        ownerToken: null,
        pid: 8123,
        heartbeatAt: "2026-07-17T11:00:00.000Z",
        expiresAt: "2026-07-17T11:00:30.000Z"
      }
    });
    const result = await runDaemonCommand({
      subcommand: "stop",
      databasePath: resolve("memory.sqlite")
    }, stale);
    expect(result).toMatchObject({ ok: true, subcommand: "stop" });
    expect(calls).toEqual(["stop.request", "launch.stop"]);
    expect(calls).not.toContain("signal:8123");

    calls.length = 0;
    const fresh = fakeDependencies(calls, {
      status: {
        state: "running",
        ownerToken: "fresh-token",
        pid: 8123,
        heartbeatAt: "2026-07-17T12:00:00.000Z",
        expiresAt: "2026-07-17T12:00:30.000Z"
      }
    });
    await runDaemonCommand({ subcommand: "stop", databasePath: resolve("memory.sqlite") }, fresh);
    expect(calls).toContain("signal:8123:fresh-token");
  });

  it("reopens authority immediately before signaling and rejects token, PID, and expiry turnover", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const kill = (pid: number, signal: NodeJS.Signals) => { killed.push({ pid, signal }); };
    const now = "2026-07-17T12:00:01.000Z";

    const matching = await leaseFixture("matching", "owner-a", 9101);
    await expect(signalFreshDaemonOwner(matching, 9101, "owner-a", { now: () => now, kill })).resolves.toBe(true);

    const tokenTurnover = await leaseFixture("token", "owner-old", 9102);
    let store = new SqliteStore(tokenTurnover);
    await store.releaseDaemonLease("memory-db", "owner-old");
    await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "owner-new", pid: 9102, now });
    store.close();
    await expect(signalFreshDaemonOwner(tokenTurnover, 9102, "owner-old", { now: () => now, kill })).resolves.toBe(false);

    const pidTurnover = await leaseFixture("pid", "owner-same", 9103);
    store = new SqliteStore(pidTurnover);
    await store.acquireDaemonLease({ databaseId: "memory-db", ownerToken: "owner-same", pid: 9199, now });
    store.close();
    await expect(signalFreshDaemonOwner(pidTurnover, 9103, "owner-same", { now: () => now, kill })).resolves.toBe(false);

    const expired = await leaseFixture("expired", "owner-expired", 9104);
    await expect(signalFreshDaemonOwner(expired, 9104, "owner-expired", {
      now: () => "2026-07-17T12:00:31.000Z",
      kill
    })).resolves.toBe(false);

    expect(killed).toEqual([{ pid: 9101, signal: "SIGTERM" }]);
    expect(JSON.stringify(killed)).not.toMatch(/transcript|secret|process output/i);
  });

  it("returns stable content-free status and once schemas", async () => {
    const calls: string[] = [];
    const dependencies = fakeDependencies(calls);
    const once = await runDaemonCommand({
      subcommand: "once",
      databasePath: resolve("memory.sqlite")
    }, dependencies);
    const status = await runDaemonCommand({
      subcommand: "status",
      databasePath: resolve("memory.sqlite"),
      personId: "person_a"
    }, dependencies);

    expect(once).toEqual({
      ok: true,
      subcommand: "once",
      result: {
        scannedSources: 2,
        contractionSlices: 1,
        proposalRuns: 0,
        remainingSources: 0,
        remainingContractions: 1,
        remainingProposals: 0
      }
    });
    expect(status).toMatchObject({
      ok: true,
      subcommand: "status",
      status: {
        state: "running",
        pid: 4242,
        degradedSources: [{ candidateId: "candidate-a", category: "permission_denied", failures: 3 }],
        queues: { contractions: 1, proposals: 0 }
      }
    });
    expect(JSON.stringify({ once, status })).not.toMatch(/transcript body|hunter2|raw error/i);
  });

  it("maps lease and capability failures to controlled errors without echoing nested messages", async () => {
    const calls: string[] = [];
    const dependencies: DaemonCommandDependencies = {
      ...fakeDependencies(calls),
      createLoop: () => ({
        run: async () => { throw new Error("lease conflict SECRET transcript body"); },
        runOnce: async () => { throw new Error("lease conflict SECRET transcript body"); }
      })
    };

    const result = await runDaemonCommand({
      subcommand: "run",
      databasePath: resolve("memory.sqlite")
    }, dependencies);
    expect(result).toEqual({
      ok: false,
      subcommand: "run",
      error: { code: "lease_conflict", message: "Memory daemon is already running." }
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|transcript body/);
  });
});

async function leaseFixture(name: string, ownerToken: string, pid: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `daemon-signal-${name}-`));
  cleanup.push(directory);
  const databasePath = join(directory, "memory.sqlite");
  const store = new SqliteStore(databasePath);
  await store.acquireDaemonLease({
    databaseId: "memory-db",
    ownerToken,
    pid,
    now: "2026-07-17T12:00:00.000Z"
  });
  store.close();
  return databasePath;
}

function fakeDependencies(
  calls: string[],
  overrides: Partial<{ status: Record<string, unknown> }> = {}
): DaemonCommandDependencies {
  const status = overrides.status ?? {
    state: "running",
    ownerToken: "fresh-token",
    pid: 4242,
    heartbeatAt: "2026-07-17T12:00:00.000Z",
    expiresAt: "2026-07-17T12:00:30.000Z",
    lastSuccessfulScanAt: "2026-07-17T11:59:00.000Z",
    degradedSources: [{ candidateId: "candidate-a", category: "permission_denied", failures: 3 }],
    queues: { contractions: 1, proposals: 0 }
  };
  return {
    createLoop: () => ({
      run: async () => { calls.push("loop.run"); return { stopped: true }; },
      runOnce: async () => {
        calls.push("loop.once");
        return {
          scannedSources: 2,
          contractionSlices: 1,
          proposalRuns: 0,
          remainingSources: 0,
          remainingContractions: 1,
          remainingProposals: 0
        };
      }
    }),
    launchAgent: {
      start: async () => { calls.push("launch.start"); return { capable: true, loaded: true, pid: 4242 }; },
      stop: async () => { calls.push("launch.stop"); return { capable: true, loaded: false, pid: null }; },
      status: async () => ({ capable: true, loaded: true, pid: 4242 })
    },
    readStatus: async () => { calls.push("status"); return status; },
    requestStop: async () => { calls.push("stop.request"); return status; },
    signal: async (pid, ownerToken) => { calls.push(`signal:${pid}:${ownerToken}`); }
  };
}
