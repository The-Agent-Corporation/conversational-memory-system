import { env, pipeline } from "@huggingface/transformers";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * D-01/D-02/D-04 pinned model manifest and one-time explicit vendoring flow
 * for `Xenova/bge-small-en-v1.5` (fp32, 384-dim). The `revision` and per-file
 * `sha256` VALUES below are still placeholders — plan 05 captures the real
 * commit SHA and file hashes from a live vendoring run against the Hugging
 * Face Hub and pins them here. Do not guess these values.
 *
 * D-02 explicitly excludes quantized (fp16/int8/uint8/quantized/q4/q4f16/bnb4)
 * variants from this manifest — only the fp32 file set is vendored.
 */
export const BGE_SMALL_EN_V1_5_MANIFEST = {
  repo: "Xenova/bge-small-en-v1.5",
  revision: "PIN_AT_VENDOR_TIME",
  files: {
    "onnx/model.onnx": { sha256: "PIN", bytes: 133_093_490 },
    "tokenizer.json": { sha256: "PIN", bytes: 711_000 },
    "tokenizer_config.json": { sha256: "PIN" },
    "special_tokens_map.json": { sha256: "PIN" },
    "config.json": { sha256: "PIN" }
  }
} as const;

const PLACEHOLDER_SHA256 = "PIN";

/**
 * The sole code path in this codebase permitted to fetch the model from the
 * network (D-04/T-09-02). Flips `env.allowRemoteModels` on only for the
 * duration of the `pipeline()` fetch below, restores it to `false` in a
 * `finally` block even on error, then verifies every fp32 file's sha256
 * against the pinned manifest before returning.
 */
export async function vendorModel(localModelPath: string): Promise<void> {
  env.allowRemoteModels = true;
  env.localModelPath = localModelPath;
  try {
    // Triggers download + local cache write via transformers.js's own
    // resolution/cache logic. Only the fp32 dtype is requested (D-02) —
    // quantized variants are never fetched by this call.
    await pipeline("feature-extraction", BGE_SMALL_EN_V1_5_MANIFEST.repo, {
      revision: BGE_SMALL_EN_V1_5_MANIFEST.revision,
      dtype: "fp32"
    });
  } finally {
    env.allowRemoteModels = false;
  }

  await verifyManifest(localModelPath);
}

async function verifyManifest(localModelPath: string): Promise<void> {
  for (const [relPath, expected] of Object.entries(BGE_SMALL_EN_V1_5_MANIFEST.files)) {
    if (expected.sha256 === PLACEHOLDER_SHA256) {
      throw new Error(
        `Model file manifest for ${relPath} is still unpinned (placeholder sha256) — ` +
          "run the plan-05 vendoring capture to record real hashes before trusting this manifest."
      );
    }

    const bytes = await readFile(`${localModelPath}/${BGE_SMALL_EN_V1_5_MANIFEST.repo}/${relPath}`);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== expected.sha256) {
      throw new Error(
        `Model file integrity check failed for ${relPath}: expected ${expected.sha256}, got ${actualHash}`
      );
    }
  }
}
