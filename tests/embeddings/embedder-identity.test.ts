import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeModelIdentity } from "../../src/embeddings/embedder-identity.js";
import { DeterministicEmbedder } from "../../src/embeddings/embedder.js";
import { TransformerEmbedder } from "../../src/embeddings/transformer-embedder.js";

const MODEL_PATH = process.env.MEMORY_MODEL_PATH ?? "tests/fixtures/models";
const MODEL_PRESENT = existsSync(join(MODEL_PATH, "Xenova/bge-small-en-v1.5/onnx/model.onnx"));

/**
 * GAP-12-A regression: the vector-key model identity must be composed in exactly
 * one place, so a query key and a write key can never be two strings that only
 * happen to agree. Pure function — no network, no model files, no clock.
 */
describe("composeModelIdentity", () => {
  it("joins a repo id and a non-empty revision with @", () => {
    expect(composeModelIdentity("Xenova/bge-small-en-v1.5", "ea104dae")).toBe(
      "Xenova/bge-small-en-v1.5@ea104dae"
    );
  });

  it("returns the bare repo string when the revision is empty", () => {
    // Every deterministic-embedder assertion and every deterministic row already
    // written to any store keeps its exact key.
    expect(composeModelIdentity("keyword-hash-v1", "")).toBe("keyword-hash-v1");
  });

  it("treats a whitespace-only revision as empty", () => {
    expect(composeModelIdentity("keyword-hash-v1", "   ")).toBe("keyword-hash-v1");
    expect(composeModelIdentity("keyword-hash-v1", "\t\n")).toBe("keyword-hash-v1");
  });

  it("trims surrounding whitespace from a non-empty revision", () => {
    expect(composeModelIdentity("repo", "  r1  ")).toBe("repo@r1");
  });

  it("does not double-suffix an already-composed identity", () => {
    const once = composeModelIdentity("Xenova/bge-small-en-v1.5", "ea104dae");
    expect(composeModelIdentity(once, "ea104dae")).toBe(once);
  });

  it("is idempotent under repeated application", () => {
    let identity = "repo";
    for (let index = 0; index < 5; index += 1) {
      identity = composeModelIdentity(identity, "r1");
    }
    expect(identity).toBe("repo@r1");
  });

  it("still appends when an existing suffix names a different revision", () => {
    // A repo that already carries revision r1 re-composed against r2 is a real
    // identity change, not a re-application — it must not be swallowed.
    expect(composeModelIdentity("repo@r1", "r2")).toBe("repo@r1@r2");
  });

  it("rejects an empty repo id rather than producing a revision-only key", () => {
    expect(() => composeModelIdentity("", "r1")).toThrow();
    expect(() => composeModelIdentity("   ", "r1")).toThrow();
  });

  it("never composes the literal string \"undefined\" from a missing revision", () => {
    // T-12-02: a field-initializer ordering bug used to produce "repo@undefined"
    // as a durable vector key. Defend the composition itself against it.
    expect(composeModelIdentity("repo", undefined as unknown as string)).toBe("repo");
    expect(composeModelIdentity("repo", null as unknown as string)).toBe("repo");
  });
});

/**
 * GAP-12-A itself: an embedder must advertise byte-identically what it stamps.
 * The class-level assertions need no model files; the emitted-vector assertion is
 * skipped (never failed) when the vendored fixture model is absent, mirroring
 * `transformer-embedder.golden.test.ts`.
 */
describe("embedder advertised identity === emitted identity", () => {
  it("TransformerEmbedder advertises the composed repo@revision identity", () => {
    const embedder = new TransformerEmbedder({ localModelPath: MODEL_PATH, revision: "ea104dae" });
    expect(embedder.model).toBe(composeModelIdentity("Xenova/bge-small-en-v1.5", "ea104dae"));
    expect(embedder.model).toBe("Xenova/bge-small-en-v1.5@ea104dae");
  });

  it("TransformerEmbedder with an empty revision advertises the bare repo id", () => {
    const embedder = new TransformerEmbedder({ localModelPath: MODEL_PATH, revision: "" });
    expect(embedder.model).toBe("Xenova/bge-small-en-v1.5");
  });

  it("never advertises the literal string \"undefined\" as a revision (T-12-02)", () => {
    // A `readonly model = composeModelIdentity(this.repo, this.revision)` field
    // initializer would run before the constructor body and compose against an
    // undefined revision, burning "…@undefined" into every persisted vector key.
    const embedder = new TransformerEmbedder({ localModelPath: MODEL_PATH, revision: "r1" });
    expect(embedder.model).not.toContain("undefined");
  });

  it("DeterministicEmbedder's key is unchanged by the composition rule", () => {
    const embedder = new DeterministicEmbedder();
    expect(embedder.model).toBe("keyword-hash-v1");
    expect(composeModelIdentity(embedder.model, "")).toBe("keyword-hash-v1");
  });

  it.runIf(MODEL_PRESENT)(
    "TransformerEmbedder stamps exactly the identity it advertises",
    async () => {
      const embedder = new TransformerEmbedder({ localModelPath: MODEL_PATH, revision: "main" });
      await embedder.init();

      const passage = await embedder.embed("identity check passage");
      expect(passage.model).toBe(embedder.model);
      expect(passage.provider).toBe(embedder.provider);

      const query = await embedder.embedQuery("identity check query");
      expect(query.model).toBe(embedder.model);
    },
    120_000
  );
});
