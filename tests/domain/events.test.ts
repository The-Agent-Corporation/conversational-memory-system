import { describe, expect, it } from "vitest";
import { HostEventSchema } from "../../src/domain/events.js";

describe("host events", () => {
  it("parses inbound and outbound conversation events", () => {
    const inbound = HostEventSchema.parse({
      id: "event_1",
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      sequence: 1,
      type: "conversation_turn",
      role: "user",
      content: "Let's talk about Smith PIP.",
      createdAt: "2026-05-04T10:00:00.000Z",
      metadata: { channel: "telegram" }
    });

    const outbound = HostEventSchema.parse({
      id: "event_2",
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      sequence: 2,
      type: "conversation_turn",
      role: "assistant",
      content: "We can pick up the Smith PIP analysis.",
      createdAt: "2026-05-04T10:00:03.000Z",
      metadata: { channel: "telegram" }
    });

    expect(inbound.type).toBe("conversation_turn");
    expect(outbound.type).toBe("conversation_turn");

    if (inbound.type !== "conversation_turn" || outbound.type !== "conversation_turn") {
      throw new Error("Expected conversation turn events");
    }

    expect(inbound.role).toBe("user");
    expect(outbound.role).toBe("assistant");
  });

  it("parses host control signals", () => {
    const parsed = HostEventSchema.parse({
      id: "event_3",
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      sequence: 3,
      type: "control_signal",
      signal: "new_conversation",
      createdAt: "2026-05-04T10:05:00.000Z",
      metadata: { command: "/new" }
    });

    expect(parsed.type).toBe("control_signal");

    if (parsed.type !== "control_signal") {
      throw new Error("Expected control signal event");
    }

    expect(parsed.signal).toBe("new_conversation");
  });

  it("rejects non-plain object host event metadata values", () => {
    const parsed = HostEventSchema.safeParse({
      id: "event_4",
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      sequence: 4,
      type: "conversation_turn",
      role: "user",
      content: "Let's talk about Smith PIP.",
      createdAt: "2026-05-04T10:06:00.000Z",
      metadata: { pattern: /not-json/ }
    });

    expect(parsed.success).toBe(false);
  });
});
