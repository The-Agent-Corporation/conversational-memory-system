import { describe, expect, it } from "vitest";
import {
  HYGIENE_RULE_VERSION,
  classifyEvent,
  collapseText,
  derivationContents,
  openToolRunStart,
  toolNameOf,
  type ClassifiableEvent
} from "../../src/topic/derivation-hygiene.js";

const conv = (content: string, overrides: Partial<ClassifiableEvent> = {}): ClassifiableEvent => ({
  content,
  role: "user",
  ...overrides
});

const tool = (name: string, args = "{}"): ClassifiableEvent => ({
  content: `[Tool call: ${name}] ${args}`,
  eventKind: "tool_call",
  role: "assistant"
});

describe("classifyEvent", () => {
  describe("classify — synthetic rules", () => {
    const cases: Array<{ ruleId: string; event: ClassifiableEvent }> = [
      { ruleId: "skill-invocation", event: conv("[IMPORTANT: The user has invoked a skill] do the thing") },
      { ruleId: "harness-system", event: conv("[SYSTEM: context injected]") },
      { ruleId: "cron-session-tag", event: conv("[cron: nightly] run the job") },
      { ruleId: "automated-followup", event: conv("### Task: review\nSuggest follow-up questions for the user.") },
      { ruleId: "automated-task-block", event: conv("### Task: review\nDo the thing without follow ups.") },
      { ruleId: "skill-body-injection", event: conv("Base directory for this skill: /some/path") },
      { ruleId: "context-compaction", event: conv("[CONTEXT COMPACTION applied at 10:00]") },
      { ruleId: "session-continuation", event: conv("This session is being continued from a previous conversation that ran out of context.") },
      { ruleId: "local-command-stdout", event: conv("<local-command-stdout>ls -la</local-command-stdout>") },
      { ruleId: "system-reminder-only", event: conv("<system-reminder>Do not forget X</system-reminder>") },
      { ruleId: "city-harness-preamble", event: conv("[roscoe-city] daemon • 2026-07-26: heartbeat") },
      { ruleId: "silent-sentinel", event: conv("[SILENT] no response needed", { role: "assistant" }) },
      { ruleId: "structured-json-emission", event: conv('{"status":"ok","count":3}', { role: "assistant" }) }
    ];

    for (const { ruleId, event } of cases) {
      it(`classify — matches ${ruleId}`, () => {
        const result = classifyEvent(event);
        expect(result.derivationClass).toBe("synthetic_injected");
        expect(result.ruleId).toBe(ruleId);
      });
    }

    it("classify — rule order: automated-followup wins over automated-task-block", () => {
      const result = classifyEvent(conv("### Task: review\nPlease suggest follow-up questions."));
      expect(result.ruleId).toBe("automated-followup");
    });
  });

  describe("classify — non-synthetic cases", () => {
    it("classify — eventKind tool_call yields tool_activity with null ruleId", () => {
      const result = classifyEvent(tool("Bash"));
      expect(result.derivationClass).toBe("tool_activity");
      expect(result.ruleId).toBeNull();
    });

    it("classify — ordinary prose yields conversational with null ruleId", () => {
      const result = classifyEvent(conv("Let's talk about the roadmap."));
      expect(result.derivationClass).toBe("conversational");
      expect(result.ruleId).toBeNull();
    });

    it("classify — content merely CONTAINING [SYSTEM: (not starting with it) stays conversational", () => {
      const result = classifyEvent(conv("The docs mention [SYSTEM: config] somewhere in the middle."));
      expect(result.derivationClass).toBe("conversational");
    });

    it("classify — assistant prose containing a mid-text JSON block stays conversational", () => {
      const result = classifyEvent(
        conv('Here is the result: {"status":"ok"} — let me know if that works.', { role: "assistant" })
      );
      expect(result.derivationClass).toBe("conversational");
    });

    it("classify — assistant-only rules do not fire for non-assistant roles", () => {
      const result = classifyEvent(conv("[SILENT] no response needed", { role: "user" }));
      expect(result.derivationClass).toBe("conversational");
    });
  });

  describe("classify — determinism", () => {
    it("classify — is a pure function: identical input yields identical output across repeated calls", () => {
      const fixtures: ClassifiableEvent[] = [
        conv("Ordinary prose"),
        tool("Bash"),
        conv("[SYSTEM: harness]"),
        conv("[SILENT]", { role: "assistant" }),
        conv('{"a":1}', { role: "assistant" }),
        { content: "row tool result", role: "tool" }
      ];
      const first = fixtures.map((event) => classifyEvent(event));
      for (let i = 0; i < 100; i += 1) {
        const repeat = fixtures.map((event) => classifyEvent(event));
        expect(repeat).toEqual(first);
      }
    });

    it("classify — returned ruleVersion matches HYGIENE_RULE_VERSION", () => {
      const result = classifyEvent(conv("hello"));
      expect(result.ruleVersion).toBe(HYGIENE_RULE_VERSION);
    });
  });

  describe("classify — quarantine contract", () => {
    it("classify — a replayed tool.result record (eventKind tool_call) classifies as tool_activity, never conversational", () => {
      const result = classifyEvent({ content: "some replayed tool result payload", eventKind: "tool_call", role: "assistant" });
      expect(result.derivationClass).toBe("tool_activity");
    });

    it("classify — a record with eventKind undefined but content starting with [Tool call: classifies as tool_activity", () => {
      const result = classifyEvent({ content: "[Tool call: Bash] {\"cmd\":\"ls\"}", role: "assistant" });
      expect(result.derivationClass).toBe("tool_activity");
    });

    it("classify — role tool with no eventKind classifies as tool_activity (live Hermes row shape)", () => {
      const result = classifyEvent({ content: "raw tool row content", role: "tool" });
      expect(result.derivationClass).toBe("tool_activity");
    });
  });
});

describe("derivationContents", () => {
  it("collapse — a run of 3 tool calls collapses to one activity entry at the run's first index", () => {
    const events = [conv("hi"), tool("Bash"), tool("Bash"), tool("Read"), conv("bye")];
    const result = derivationContents(events);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ index: 0, content: "hi" });
    expect(result[1]).toEqual({ index: 1, content: "[Activity] ran 3 tool calls: 2 Bash, 1 Read" });
    expect(result[2]).toEqual({ index: 4, content: "bye" });
    expect(result[1].content).not.toContain("cmd");
    expect(result[1].content).not.toContain("{");
  });

  it("isolated — a single tool event between two conversational events keeps its original content verbatim", () => {
    const events = [conv("hi"), tool("Bash", '{"cmd":"ls -la"}'), conv("bye")];
    const result = derivationContents(events);
    expect(result).toHaveLength(3);
    expect(result[1]).toEqual({ index: 1, content: '[Tool call: Bash] {"cmd":"ls -la"}' });
  });

  it("collapse — synthetic events contribute no entry and do not break a surrounding tool run", () => {
    const events = [conv("hi"), tool("Bash"), conv("[SYSTEM: noop]"), tool("Bash"), conv("bye")];
    const result = derivationContents(events);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ index: 0, content: "hi" });
    expect(result[1]).toEqual({ index: 1, content: "[Activity] ran 2 tool calls: 2 Bash" });
    expect(result[2]).toEqual({ index: 4, content: "bye" });
  });

  it("collapse — synthetic_injected events contribute no derivation content at all when standalone", () => {
    const events = [conv("hi"), conv("[SYSTEM: noop]"), conv("bye")];
    const result = derivationContents(events);
    expect(result).toEqual([
      { index: 0, content: "hi" },
      { index: 2, content: "bye" }
    ]);
  });
});

describe("openToolRunStart — open run detection", () => {
  it("open run — [conv, tool, tool] returns index 1", () => {
    expect(openToolRunStart([conv("hi"), tool("Bash"), tool("Read")])).toBe(1);
  });

  it("open run — [conv, tool] returns index 1 (length-1 tail is still open)", () => {
    expect(openToolRunStart([conv("hi"), tool("Bash")])).toBe(1);
  });

  it("open run — [conv, tool, tool, conv] returns null (run already closed)", () => {
    expect(openToolRunStart([conv("hi"), tool("Bash"), tool("Read"), conv("bye")])).toBeNull();
  });

  it("open run — [conv] returns null", () => {
    expect(openToolRunStart([conv("hi")])).toBeNull();
  });

  it("open run — trailing synthetic after a run does not close it: [conv, tool, tool, synthetic] returns index 1", () => {
    const events = [conv("hi"), tool("Bash"), tool("Read"), conv("[SYSTEM: noop]")];
    expect(openToolRunStart(events)).toBe(1);
  });

  it("open run — withholding the open suffix emits no partial activity line", () => {
    const events = [conv("hi"), tool("Bash"), tool("Read")];
    const start = openToolRunStart(events);
    expect(start).not.toBeNull();
    const withheld = derivationContents(events.slice(0, start as number));
    expect(withheld.some((entry) => entry.content.startsWith("[Activity]"))).toBe(false);
  });
});
