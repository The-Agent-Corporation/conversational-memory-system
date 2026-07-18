import { describe, expect, it } from "vitest";
import { createFakeClock, createFaultInjector } from "./fixtures.js";

interface PlannedConfirmationIntent {
  profileFingerprint: string;
  tool: string;
  targetIds: string[];
  normalizedParameters: Record<string, unknown>;
  effectsFingerprint: string;
}

interface PlannedConfirmationService {
  issue(intent: PlannedConfirmationIntent): { token: string; expiresAt: string };
  consumeExact(token: string, intent: PlannedConfirmationIntent): void;
}

describe("MCP confirmation service contract", () => {
  it("provides deterministic fake time for exact expiry-boundary contracts", () => {
    const clock = createFakeClock("2026-07-18T12:00:00.000Z");
    clock.advance(5 * 60_000);
    expect(clock.now()).toBe("2026-07-18T12:05:00.000Z");
  });

  it("provides a named fault injector for consume-before-execute failure contracts", () => {
    const faults = createFaultInjector();
    faults.failAt("after-ticket-consumption");
    expect(() => faults.reach("before-ticket-consumption")).not.toThrow();
    expect(() => faults.reach("after-ticket-consumption")).toThrow(
      "Synthetic fault at after-ticket-consumption"
    );
    expect(faults.reached).toEqual([
      "before-ticket-consumption",
      "after-ticket-consumption"
    ]);
  });

  it.todo("05-05 Task 1 binds every token to the immutable profile fingerprint");
  it.todo("05-05 Task 1 rejects a token issued for a different preview or execute tool");
  it.todo("05-05 Task 1 rejects changed target identifiers regardless of ordering tricks");
  it.todo("05-05 Task 1 rejects changed normalized parameters and effects fingerprints");
  it.todo("05-05 Task 1 rejects a token at or after its exact expiry instant");
  it.todo("05-05 Task 1 consumes a token before every execute attempt, including failed attempts");
  it.todo("05-05 Task 1 rejects replay after successful, drifted, or faulted execution");
  it.todo("05-05 Task 1 keeps process-local tickets out of durable memory tables");
});

void (undefined as unknown as PlannedConfirmationService);
