import { env, pipeline } from "@huggingface/transformers";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * D-01/D-02/D-04 pinned model manifest and one-time explicit vendoring flow
 * for `Xenova/bge-small-en-v1.5` (fp32, 384-dim). The `revision` and per-file
 * `sha256` values below were captured from a real vendoring run against the
 * Hugging Face Hub on 2026-07-21 (plan 05) — the `onnx/model.onnx` sha256
 * matches the repo's own LFS object id for this revision, confirming
 * download integrity independent of this manifest.
 *
 * D-02 explicitly excludes quantized (fp16/int8/uint8/quantized/q4/q4f16/bnb4)
 * variants from this manifest — only the fp32 file set is vendored.
 */
export const BGE_SMALL_EN_V1_5_MANIFEST = {
  repo: "Xenova/bge-small-en-v1.5",
  revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
  files: {
    "onnx/model.onnx": {
      sha256: "828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35",
      bytes: 133_093_490
    },
    "tokenizer.json": {
      sha256: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
      bytes: 711_396
    },
    "tokenizer_config.json": {
      sha256: "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3"
    },
    "special_tokens_map.json": {
      sha256: "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3"
    },
    "config.json": {
      sha256: "fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350"
    }
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

export async function verifyManifest(localModelPath: string): Promise<void> {
  for (const [relPath, expected] of Object.entries(BGE_SMALL_EN_V1_5_MANIFEST.files)) {
    if ((expected.sha256 as string) === PLACEHOLDER_SHA256) {
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
