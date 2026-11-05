/**
 * A host event is a source record, not an authority claim. This finding was
 * quarantined on Phase 0 and runs here because Phase 1 enforces it.
 */
import { expect, it } from "vitest";
import { HostEventSchema } from "../../src/domain/events.js";

const event = {
  id: "event_1",
  host: "hermes",
  profileId: "default",
  hostSessionId: "session_1",
  sequence: 1,
  type: "conversation_turn" as const,
  role: "user" as const,
  content: "Let's talk about Smith PIP.",
  createdAt: "2026-05-04T10:00:00.000Z",
  metadata: {}
};

it("FINDING host event schema accepts a caller-supplied personId instead of rejecting it", () => {
  const parsed = HostEventSchema.safeParse({
    ...event,
    personId: "person_attacker",
    allowedScopeIds: ["client_secret"]
  });

  expect(
    parsed.success,
    "FINDING host event accepts caller-supplied personId and allowedScopeIds; host is not an authority"
  ).toBe(false);
});
