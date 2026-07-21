import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
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

const MODEL_PATH = process.env.MEMORY_MODEL_PATH ?? "tests/fixtures/models";
const MODEL_PRESENT = existsSync(join(MODEL_PATH, "Xenova/bge-small-en-v1.5/onnx/model.onnx"));

/**
 * Golden-vector regression (D-07/D-08/REQ-051), run against the real
 * vendored model. Requires `MEMORY_MODEL_PATH` (default
 * `tests/fixtures/models`) to point at a vendored model dir (see
 * `memory embeddings enable` / `vendorModel`). Skipped when the model is not
 * vendored so a fresh clone's default `npm test` stays offline-deterministic;
 * `npm run test:golden` is the explicit gate that requires the model.
 */
// `npm run test:golden` sets MEMORY_REQUIRE_GOLDEN=1 so a missing model is a
// loud failure at the explicit gate instead of a silent skip.
it.runIf(process.env.MEMORY_REQUIRE_GOLDEN === "1" && !MODEL_PRESENT)(
  "golden gate requires the vendored model",
  () => {
    throw new Error(
      `vendored model missing at ${MODEL_PATH} — run \`memory embeddings enable\` before \`npm run test:golden\``
    );
  }
);

describe.skipIf(!MODEL_PRESENT)("TransformerEmbedder golden-vector regression (REQ-051)", () => {
  let embedder: TransformerEmbedder;

  beforeAll(async () => {
    embedder = new TransformerEmbedder({
      localModelPath: MODEL_PATH,
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
