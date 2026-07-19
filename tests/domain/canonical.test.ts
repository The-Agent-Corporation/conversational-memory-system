import { describe, expect, it } from "vitest";
import {
  CanonicalEventSchema,
  MemorySourceSchema,
  PersonSchema
} from "../../src/domain/canonical.js";

describe("canonical personal timeline schemas", () => {
  it("parses people, sources, and source-linked canonical events", () => {
    const person = PersonSchema.parse({
      id: "person_1",
      displayName: "Test Person",
      createdAt: "2026-07-16T10:00:00.000Z"
    });
    const source = MemorySourceSchema.parse({
      id: "source_codex_default",
      personId: person.id,
      application: "codex",
      profileId: "default",
      createdAt: "2026-07-16T10:00:00.000Z",
      lastImportedAt: "2026-07-16T10:01:00.000Z"
    });
    const event = CanonicalEventSchema.parse({
      id: "event_1",
      personId: person.id,
      sourceId: source.id,
      sourceApplication: source.application,
      sourceProfileId: source.profileId,
      nativeSessionId: "rollout_1",
      nativeEventId: "native_1",
      nativeSequence: 3,
      causalParentId: null,
      role: "user",
      content: "Continue the personal memory project.",
      occurredAt: "2026-07-16T09:59:00.000Z",
      importedAt: "2026-07-16T10:01:00.000Z",
      provenance: "direct_user_input",
      trustLevel: "high",
      contentHash: "hash_1",
      parserVersion: "codex-jsonl/v1",
      metadata: { sourcePath: "[REDACTED]" }
    });

    expect(event.personId).toBe(person.id);
    expect(event.sourceId).toBe(source.id);
    expect(event.nativeSessionId).toBe("rollout_1");
  });

  it("rejects non-JSON source metadata", () => {
    const parsed = CanonicalEventSchema.safeParse({
      id: "event_1",
      personId: "person_1",
      sourceId: "source_1",
      sourceApplication: "codex",
      sourceProfileId: "default",
      nativeSessionId: "rollout_1",
      nativeEventId: "native_1",
      nativeSequence: 3,
      causalParentId: null,
      role: "user",
      content: "Continue the personal memory project.",
      occurredAt: "2026-07-16T09:59:00.000Z",
      importedAt: "2026-07-16T10:01:00.000Z",
      provenance: "direct_user_input",
      trustLevel: "high",
      contentHash: "hash_1",
      parserVersion: "codex-jsonl/v1",
      metadata: { transform: () => "not persisted JSON" }
    });

    expect(parsed.success).toBe(false);
  });
});
