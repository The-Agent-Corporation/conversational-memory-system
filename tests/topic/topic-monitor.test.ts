import { describe, expect, it } from "vitest";
import type { HostEvent } from "../../src/domain/events.js";
import { TopicMonitor } from "../../src/topic/topic-monitor.js";

const event = (overrides: Partial<HostEvent> = {}): HostEvent => ({
  id: "event_1",
  host: "roscoe-hermes",
  profileId: "default",
  hostSessionId: "session_1",
  sequence: 1,
  type: "conversation_turn",
  role: "user",
  content: "Let's talk about Smith PIP.",
  createdAt: "2026-05-04T10:00:00.000Z",
  metadata: {},
  ...overrides
} as HostEvent);

describe("TopicMonitor", () => {
  it("builds a rolling topic summary for a session", () => {
    const monitor = new TopicMonitor();

    monitor.observe(event());
    const result = monitor.observe(event({
      id: "event_2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP issue is about demand timing.",
      createdAt: "2026-05-04T10:00:10.000Z"
    }));

    expect(result.topicChanged).toBe(false);
    expect(result.current?.topicLabel).toBe("Smith PIP");
    expect(result.current?.currentTopicSummary).toBe("Smith PIP (2 turns, seq 1-2)");
    expect(result.current?.sourceTurnRange).toEqual({
      threadId: "session_1",
      startSequence: 1,
      endSequence: 2
    });
  });

  it("emits the completed span when an explicit topic switch occurs", () => {
    const monitor = new TopicMonitor();

    monitor.observe(event());
    monitor.observe(event({
      id: "event_2",
      sequence: 2,
      role: "assistant",
      content: "The Smith PIP issue is about demand timing.",
      createdAt: "2026-05-04T10:00:10.000Z"
    }));
    const result = monitor.observe(event({
      id: "event_3",
      sequence: 3,
      content: "Switch to Jones BI coverage.",
      createdAt: "2026-05-04T10:05:00.000Z"
    }));

    expect(result.topicChanged).toBe(true);
    expect(result.completed?.topicLabel).toBe("Smith PIP");
    expect(result.completed?.sourceTurnRange).toEqual({
      threadId: "session_1",
      startSequence: 1,
      endSequence: 2
    });
    expect(result.current?.topicLabel).toBe("Jones BI Coverage");
    expect(result.current?.sourceTurnRange).toEqual({
      threadId: "session_1",
      startSequence: 3,
      endSequence: 3
    });
  });

  it("ignores control signals without clearing the current topic", () => {
    const monitor = new TopicMonitor();

    monitor.observe(event());
    const result = monitor.observe(event({
      id: "event_2",
      sequence: 2,
      type: "control_signal",
      signal: "compress",
      createdAt: "2026-05-04T10:01:00.000Z"
    }));

    expect(result.topicChanged).toBe(false);
    expect(result.current?.topicLabel).toBe("Smith PIP");
    expect(result.completed).toBeNull();
  });

  it("tracks sessions independently", () => {
    const monitor = new TopicMonitor();

    monitor.observe(event({
      hostSessionId: "session_1",
      content: "Let's talk about Smith PIP."
    }));
    monitor.observe(event({
      id: "event_2",
      hostSessionId: "session_2",
      content: "Let's talk about Jones BI.",
      sequence: 1
    }));

    expect(monitor.current("session_1")?.topicLabel).toBe("Smith PIP");
    expect(monitor.current("session_2")?.topicLabel).toBe("Jones BI");
  });
});
