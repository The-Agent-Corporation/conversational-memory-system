import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BGE_SMALL_EN_V1_5_MANIFEST, vendorModel } from "../../src/embeddings/model-vendor.js";

const QUANTIZED_VARIANT_FILES = [
  "onnx/model_fp16.onnx",
  "onnx/model_int8.onnx",
  "onnx/model_uint8.onnx",
  "onnx/model_quantized.onnx",
  "onnx/model_q4.onnx",
  "onnx/model_q4f16.onnx",
  "onnx/model_bnb4.onnx"
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const RUN_NETWORK_TESTS = process.env.MEMORY_RUN_NETWORK_TESTS === "1";
const NETWORK_TEST_TIMEOUT_MS = 300_000;

/**
 * These cases run `vendorModel` against a fresh temp dir, which performs a
 * real ~127MB Hugging Face download. The default `npm test` run must stay
 * offline-deterministic (REQ-040/REQ-044), so the whole suite is gated
 * behind MEMORY_RUN_NETWORK_TESTS=1 (used by the one-time vendoring flow
 * and available for manual re-verification).
 */
describe.runIf(RUN_NETWORK_TESTS)("model-vendor (REQ-044, network-gated)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "model-vendor-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the pinned fp32 file set under localModelPath", { timeout: NETWORK_TEST_TIMEOUT_MS }, async () => {
    await vendorModel(dir);

    const repoDir = join(dir, BGE_SMALL_EN_V1_5_MANIFEST.repo);
    for (const relPath of Object.keys(BGE_SMALL_EN_V1_5_MANIFEST.files)) {
      expect(await exists(join(repoDir, relPath))).toBe(true);
    }
  });

  it("does NOT write quantized variant files (D-02 fp32-only)", { timeout: NETWORK_TEST_TIMEOUT_MS }, async () => {
    await vendorModel(dir);

    const repoDir = join(dir, BGE_SMALL_EN_V1_5_MANIFEST.repo);
    for (const relPath of QUANTIZED_VARIANT_FILES) {
      expect(await exists(join(repoDir, relPath))).toBe(false);
    }
  });

  it("throws when a vendored file's sha256 does not match the pinned manifest", { timeout: NETWORK_TEST_TIMEOUT_MS }, async () => {
    await expect(vendorModel(dir)).rejects.toThrow();
  });
});
