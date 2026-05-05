import { describe, expect, it } from "vitest";
import { ConversationTurnEventSchema } from "../../src/domain/events.js";
import { mapHermesTimelineRowToHostEvent } from "../../src/integrations/hermes/contract.js";

describe("Roscoe-Hermes contract", () => {
  it("maps a Hermes unified timeline row to a host event", () => {
    const event = mapHermesTimelineRowToHostEvent({
      id: "42",
      profile_id: "default",
      session_id: "hermes-session",
      sequence: 7,
      role: "user",
      content: "Can we resume the Smith PIP discussion?",
      created_at: "2026-05-04T10:00:00.000Z",
      channel: "telegram",
      metadata_json: "{\"platform\":\"telegram\"}"
    });

    expect(event.host).toBe("roscoe-hermes");
    expect(event.hostSessionId).toBe("hermes-session");
    expect(event.role).toBe("user");
    expect(event.metadata.channel).toBe("telegram");
    expect(event.metadata.sourceMetadata).toEqual({ platform: "telegram" });
    expect(ConversationTurnEventSchema.parse(event)).toEqual(event);
  });

  it("preserves canonical row channel when source metadata conflicts", () => {
    const event = mapHermesTimelineRowToHostEvent({
      id: "45",
      profile_id: "default",
      session_id: "hermes-session",
      sequence: 10,
      role: "user",
      content: "This came from the Telegram gateway.",
      created_at: "2026-05-04T10:03:00.000Z",
      channel: "telegram",
      metadata_json: "{\"channel\":\"web\",\"platform\":\"telegram\"}"
    });

    expect(event.metadata.channel).toBe("telegram");
    expect(event.metadata.sourceMetadata).toEqual({
      channel: "web",
      platform: "telegram"
    });
    expect(ConversationTurnEventSchema.parse(event)).toEqual(event);
  });

  it("keeps invalid metadata JSON from leaking non-JSON values", () => {
    const event = mapHermesTimelineRowToHostEvent({
      id: "43",
      profile_id: "default",
      session_id: "hermes-session",
      sequence: 8,
      role: "assistant",
      content: "Let's pick that back up.",
      created_at: "2026-05-04T10:01:00.000Z",
      channel: null,
      metadata_json: "{not valid JSON"
    });

    expect(event.metadata).toEqual({
      channel: null,
      sourceMetadata: {
        rawMetadata: "{not valid JSON"
      }
    });
    expect(ConversationTurnEventSchema.parse(event)).toEqual(event);
  });

  it("wraps non-object metadata JSON in JSON-safe metadata", () => {
    const event = mapHermesTimelineRowToHostEvent({
      id: "44",
      profile_id: "default",
      session_id: "hermes-session",
      sequence: 9,
      role: "tool",
      content: "lookup result",
      created_at: "2026-05-04T10:02:00.000Z",
      channel: "telegram",
      metadata_json: "\"raw string metadata\""
    });

    expect(event.metadata).toEqual({
      channel: "telegram",
      sourceMetadata: {
        rawMetadata: "raw string metadata"
      }
    });
    expect(ConversationTurnEventSchema.parse(event)).toEqual(event);
  });
});
