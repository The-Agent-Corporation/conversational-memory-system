import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { TransformerEmbedder } from "../../src/embeddings/transformer-embedder.js";
import goldenTexts from "../fixtures/embedding-golden-set.json" with { type: "json" };

// D-07: committed golden hashes land in plan 05, generated from a real run of
// the vendored model against `embedding-golden-set.json`. Loaded via an
// existsSync guard (not a static import) so this suite fails RED with a
// clear message rather than a compile/import error while the file is absent.
const GOLDEN_HASHES_PATH = resolve("tests/fixtures/embedding-golden-hashes.json");
const goldenHashesAvailable = existsSync(GOLDEN_HASHES_PATH);
const goldenHashes: Record<string, string> = goldenHashesAvailable
  ? (JSON.parse(readFileSync(GOLDEN_HASHES_PATH, "utf8")) as Record<string, string>)
  : {};

function quantizedHash(vector: number[], precision = 4): string {
  // D-07: round each component to a fixed decimal precision before hashing,
  // absorbing legitimate cross-arch float noise while still catching real drift.
  const rounded = vector.map((value) => value.toFixed(precision)).join(",");
  return createHash("sha256").update(rounded).digest("hex");
}

function exactByteHash(vector: number[]): string {
  // Bit-identical repeat-run assertion — same machine, same process run.
  const buffer = new Float32Array(vector).buffer;
  return createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

/**
 * Wave 0 RED scaffold (D-07/D-08/REQ-051). `TransformerEmbedder.init()`/
 * `embed()`/`embedQuery()` currently throw "not implemented", and
 * `tests/fixtures/embedding-golden-hashes.json` does not exist yet (plan 05
 * generates it from a real vendored-model run). Both failure modes are
 * expected RED states, not skips.
 */
describe("TransformerEmbedder golden-vector regression (REQ-051)", () => {
  let embedder: TransformerEmbedder;
  let initError: unknown;

  beforeAll(async () => {
    embedder = new TransformerEmbedder({
      localModelPath: process.env.MEMORY_MODEL_PATH ?? "tests/fixtures/models",
      revision: "PIN_AT_VENDOR_TIME"
    });
    try {
      await embedder.init();
    } catch (error) {
      initError = error;
    }
  });

  it("golden hashes fixture exists (generated in plan 05)", () => {
    expect(
      goldenHashesAvailable,
      "golden hashes not yet generated (plan 05): run the real embedder once against " +
        "tests/fixtures/embedding-golden-set.json and commit tests/fixtures/embedding-golden-hashes.json"
    ).toBe(true);
  });

  it.each(goldenTexts)("quantized-hash golden match: $id ($mode)", async ({ id, text, mode }) => {
    expect(initError, "TransformerEmbedder.init() must succeed before golden assertions").toBeUndefined();
    const embedding = mode === "query" ? await embedder.embedQuery(text) : await embedder.embed(text);
    const hash = quantizedHash(embedding.vector);
    expect(hash).toBe(goldenHashes[id]);
  });

  it("exact byte-hash is identical across repeated runs on this machine (REQ-051 determinism claim)", async () => {
    expect(initError, "TransformerEmbedder.init() must succeed before determinism assertion").toBeUndefined();
    const [first, second] = await Promise.all([
      embedder.embed(goldenTexts[0].text),
      embedder.embed(goldenTexts[0].text)
    ]);
    expect(exactByteHash(second.vector)).toBe(exactByteHash(first.vector));
  });
});
