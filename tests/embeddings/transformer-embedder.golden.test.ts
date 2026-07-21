import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { TransformerEmbedder } from "../../src/embeddings/transformer-embedder.js";
import goldenTexts from "../fixtures/embedding-golden-set.json" with { type: "json" };
// D-07: committed golden hashes, generated in plan 05 from a real run of the
// vendored model against `embedding-golden-set.json` — never hand-authored.
import goldenHashes from "../fixtures/embedding-golden-hashes.json" with { type: "json" };

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
 * Golden-vector regression (D-07/D-08/REQ-051), run against the real
 * vendored model. Requires `MEMORY_MODEL_PATH` to point at a vendored model
 * dir (see `memory embeddings enable` / `vendorModel`) — `init()` is awaited
 * in `beforeAll` so a missing/broken model fails loudly at suite startup.
 */
describe("TransformerEmbedder golden-vector regression (REQ-051)", () => {
  let embedder: TransformerEmbedder;

  beforeAll(async () => {
    embedder = new TransformerEmbedder({
      localModelPath: process.env.MEMORY_MODEL_PATH ?? "tests/fixtures/models",
      revision: "ea104dacec62c0de699686887e3f920caeb4f3e3"
    });
    await embedder.init();
  });

  it.each(goldenTexts)("quantized-hash golden match: $id ($mode)", async ({ id, text, mode }) => {
    const embedding = mode === "query" ? await embedder.embedQuery(text) : await embedder.embed(text);
    const hash = quantizedHash(embedding.vector);
    expect(hash).toBe((goldenHashes as Record<string, string>)[id]);
  });

  it("exact byte-hash is identical across repeated runs on this machine (REQ-051 determinism claim)", async () => {
    const [first, second] = await Promise.all([
      embedder.embed(goldenTexts[0].text),
      embedder.embed(goldenTexts[0].text)
    ]);
    expect(exactByteHash(second.vector)).toBe(exactByteHash(first.vector));
  });
});
