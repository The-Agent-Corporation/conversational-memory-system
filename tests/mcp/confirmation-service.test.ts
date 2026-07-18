import { describe, expect, it } from "vitest";
import {
  ConfirmationError,
  ConfirmationService,
  type ConfirmationIntent
} from "../../src/mcp/confirmation-service.js";
import { createFakeClock, createFaultInjector } from "./fixtures.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

const intent = (overrides: Partial<ConfirmationIntent> = {}): ConfirmationIntent => ({
  profileFingerprint: "profile-alpha",
  tool: "proposal_approve_execute",
  targetIds: ["proposal-2", "proposal-1"],
  normalizedParameters: { note: "synthetic", reviewer: "fixture" },
  effectsFingerprint: "effects-alpha",
  ...overrides
});

const expectCode = (call: () => void, code: ConfirmationError["code"]): void => {
  try {
    call();
    throw new Error("Expected confirmation error");
  } catch (error) {
    expect(error).toBeInstanceOf(ConfirmationError);
    expect((error as ConfirmationError).code).toBe(code);
  }
};

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

  it("05-05 Task 1 binds every token to the immutable profile fingerprint", () => {
    const service = new ConfirmationService();
    const preview = service.issue(intent());
    expectCode(() => service.consumeExact(preview.token, intent({ profileFingerprint: "profile-beta" })), "CONFIRMATION_MISMATCH");
  });

  it("05-05 Task 1 rejects a token issued for a different preview or execute tool", () => {
    const service = new ConfirmationService();
    const preview = service.issue(intent());
    expectCode(() => service.consumeExact(preview.token, intent({ tool: "proposal_reject_execute" })), "CONFIRMATION_MISMATCH");
  });

  it("05-05 Task 1 rejects changed target identifiers regardless of ordering tricks", () => {
    const service = new ConfirmationService();
    const reordered = service.issue(intent());
    expect(() => service.consumeExact(reordered.token, intent({ targetIds: ["proposal-1", "proposal-2"] }))).not.toThrow();

    const changed = service.issue(intent());
    expectCode(() => service.consumeExact(changed.token, intent({ targetIds: ["proposal-1", "proposal-3"] })), "CONFIRMATION_MISMATCH");
  });

  it("05-05 Task 1 rejects changed normalized parameters and effects fingerprints", () => {
    const service = new ConfirmationService();
    const changedParameters = service.issue(intent());
    expectCode(() => service.consumeExact(changedParameters.token, intent({ normalizedParameters: { reviewer: "fixture", note: "changed" } })), "CONFIRMATION_MISMATCH");
    const changedEffects = service.issue(intent());
    expectCode(() => service.consumeExact(changedEffects.token, intent({ effectsFingerprint: "effects-beta" })), "CONFIRMATION_MISMATCH");
    expectCode(() => service.consumeExact("", intent()), "CONFIRMATION_MISMATCH");
  });

  it("05-05 Task 1 rejects a token at or after its exact expiry instant", () => {
    const clock = createFakeClock();
    const service = new ConfirmationService({ clock: () => clock.now(), ttlMs: 1_000 });
    const preview = service.issue(intent());
    clock.advance(1_000);
    expectCode(() => service.consumeExact(preview.token, intent()), "CONFIRMATION_EXPIRED");
  });

  it("05-05 Task 1 consumes a token before every execute attempt, including failed attempts", () => {
    const faults = createFaultInjector();
    const service = new ConfirmationService();
    const preview = service.issue(intent());
    service.consumeExact(preview.token, intent());
    faults.failAt("after-ticket-consumption");
    expect(() => faults.reach("after-ticket-consumption")).toThrow();
    expectCode(() => service.consumeExact(preview.token, intent()), "CONFIRMATION_REPLAYED");
  });

  it("05-05 Task 1 rejects replay after successful, drifted, or faulted execution", () => {
    const service = new ConfirmationService();
    for (const outcome of ["successful", "drifted", "faulted"]) {
      const preview = service.issue(intent({ normalizedParameters: { outcome } }));
      service.consumeExact(preview.token, intent({ normalizedParameters: { outcome } }));
      expectCode(() => service.consumeExact(preview.token, intent({ normalizedParameters: { outcome } })), "CONFIRMATION_REPLAYED");
    }
  });

  it("05-05 Task 1 keeps process-local tickets out of durable memory tables", async () => {
    const store = new InMemoryStore();
    const service = new ConfirmationService();
    const before = JSON.stringify(await Promise.all([store.listPeople(), store.listSources("person-alpha"), store.listProposals()]));
    const preview = service.issue(intent());
    const after = JSON.stringify(await Promise.all([store.listPeople(), store.listSources("person-alpha"), store.listProposals()]));
    expect(after).toBe(before);
    expect(after).not.toContain(preview.token);
  });
});
