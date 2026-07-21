import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEmbedder, probeEmbedderHealth } from "../../src/embeddings/embedder-resolver.js";
import { embeddingsConfigPath, type EmbeddingsConfig } from "../../src/embeddings/embeddings-config.js";

/**
 * Wave 0 RED scaffold (D-04/D-05/D-06). `resolveEmbedder`/`probeEmbedderHealth`
 * currently throw "not implemented" — every case below is expected to fail
 * until plan 04 lands the real resolution logic. Not skipped: these failures
 * are the pinned contract downstream plans must satisfy.
 */
describe("embedder-resolver (REQ-044)", () => {
  let dir: string;
  let databasePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "embedder-resolver-test-"));
    databasePath = join(dir, "memory.db");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves DeterministicEmbedder by default when no embeddings config exists", async () => {
    const embedder = await resolveEmbedder(databasePath);
    expect(embedder.provider).toBe("deterministic");
  });

  // Uses the locally vendored model (plan 09-05); skipped when absent so the
  // default `npm test` run stays offline-deterministic on machines/CI runners
  // that have not run `memory embeddings enable` yet.
  const VENDORED_MODEL_PATH = resolve("tests/fixtures/models");
  const VENDORED_MODEL_PRESENT = existsSync(
    join(VENDORED_MODEL_PATH, "Xenova/bge-small-en-v1.5/onnx/model.onnx")
  );

  it.skipIf(!VENDORED_MODEL_PRESENT)(
    "resolves TransformerEmbedder when enabled with a present, healthy model",
    { timeout: 60_000 },
    async () => {
      const config: EmbeddingsConfig = {
        enabled: true,
        provider: "onnx-transformers",
        model: "Xenova/bge-small-en-v1.5",
        revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
        modelPath: VENDORED_MODEL_PATH
      };
      await writeFile(embeddingsConfigPath(databasePath), JSON.stringify(config, null, 2), "utf8");

      const embedder = await resolveEmbedder(databasePath);
      expect(embedder.provider).toBe("onnx-transformers");
    }
  );

  it("hard-errors resolveEmbedder and reports unhealthy when enabled-but-broken (D-05/D-06)", async () => {
    const config: EmbeddingsConfig = {
      enabled: true,
      provider: "onnx-transformers",
      model: "Xenova/bge-small-en-v1.5",
      revision: "test-revision",
      modelPath: join(dir, "models-that-do-not-exist")
    };
    await writeFile(embeddingsConfigPath(databasePath), JSON.stringify(config, null, 2), "utf8");

    await expect(resolveEmbedder(databasePath)).rejects.toThrow();

    const health = await probeEmbedderHealth(databasePath);
    expect(health.healthy).toBe(false);
    expect(health.reason).not.toBeNull();
  });
});
