import { env } from "@huggingface/transformers";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { TransformerEmbedder } from "./transformer-embedder.js";

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

/** Hugging Face Hub origin. Overridable only so tests can serve the pinned files over loopback. */
export const DEFAULT_MODEL_BASE_URL = "https://huggingface.co";

export interface VendorModelOptions {
  /**
   * Origin to fetch the pinned files from. Defaults to the Hub; the offline
   * regression suite points it at a loopback server serving the same bytes.
   */
  baseUrl?: string;
  /**
   * Post-vendor load proof (defaults to on). Separate from the hash check on
   * purpose: `pipeline()` used to conflate "the files are here" with "the model
   * loads", and that coupling is what produced GAP-12-C's layout mismatch.
   */
  verifyLoad?: boolean;
}

/**
 * The sole code path in this codebase permitted to fetch the model from the
 * network (D-04/T-09-02).
 *
 * GAP-12-C: this used to download through `pipeline()`, which writes into
 * transformers.js's own `env.cacheDir` in a **revision-nested** layout, while
 * `verifyManifest` reads the **flat** `${localModelPath}/${repo}/${relPath}` —
 * nothing wrote what it read — and `pipeline("feature-extraction", …)` never
 * requested `special_tokens_map.json` at all. Both defects are gone because
 * this now fetches each of the manifest's five files directly from
 * `{baseUrl}/{repo}/resolve/{revision}/{file}` straight into the flat layout.
 * The revision is pinned in the URL rather than delegated to library cache
 * semantics, which is the indirection that produced the defect.
 *
 * `env.allowRemoteModels` disposition (D-04/T-09-02): the direct fetch no
 * longer routes through transformers.js, so the flag is irrelevant to the
 * download itself — it is deliberately **never** switched on, and is asserted
 * `false` here so the documented invariant ("transformers.js never loads from
 * the network in this process") still holds for the post-vendor load proof and
 * for anything that runs after this call.
 *
 * Writes are atomic (T-12-30): every file is staged into a temp directory and
 * hash-verified there, and the staged set is moved into place only once all
 * five match. A failed or partial vendor therefore leaves nothing a later
 * `verifyManifest` could pass on.
 */
export async function vendorModel(
  localModelPath: string,
  options: VendorModelOptions = {}
): Promise<void> {
  // Never true. See the disposition note above.
  env.allowRemoteModels = false;

  const baseUrl = (options.baseUrl ?? DEFAULT_MODEL_BASE_URL).replace(/\/+$/, "");
  const { repo, revision, files } = BGE_SMALL_EN_V1_5_MANIFEST;

  await mkdir(localModelPath, { recursive: true });
  // Staged inside the target root so the final move is a same-filesystem rename.
  const stagingRoot = await mkdtemp(join(localModelPath, ".vendor-"));

  try {
    for (const [relPath, expected] of Object.entries(files)) {
      const url = `${baseUrl}/${repo}/resolve/${revision}/${relPath}`;
      await downloadPinnedFile(url, join(stagingRoot, repo, relPath), relPath, expected);
    }

    // Verify the staged set through the same reader the caller will use, before
    // anything is moved into the real path.
    await verifyManifest(stagingRoot);

    const destination = join(localModelPath, repo);
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(join(stagingRoot, repo), destination);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }

  await verifyManifest(localModelPath);

  if (options.verifyLoad !== false) {
    await proveModelLoads(localModelPath, revision);
  }
}

/**
 * "The files are right" and "the model loads" proven separately (GAP-12-C).
 *
 * `env.cacheDir` is repointed at an empty directory for the duration: it
 * otherwise defaults to `node_modules/@huggingface/transformers/.cache`, and a
 * stale copy left there by any earlier run satisfies `pipeline()` **without
 * reading `localModelPath` at all** — measured 2026-07-29: with the stale cache
 * present, loading a model root that does not exist succeeds; with the cache
 * empty, the same call throws `file was not found locally`. That is the very
 * cache-hit mechanism that let GAP-12-C ship, so a load proof served from it
 * would prove nothing about what was just vendored.
 */
async function proveModelLoads(localModelPath: string, revision: string): Promise<void> {
  const previousCacheDir = env.cacheDir;
  const isolatedCacheDir = await mkdtemp(join(localModelPath, ".loadproof-cache-"));
  try {
    env.cacheDir = isolatedCacheDir;
    const embedder = new TransformerEmbedder({ localModelPath, revision });
    await embedder.init();
  } finally {
    env.cacheDir = previousCacheDir;
    await rm(isolatedCacheDir, { recursive: true, force: true });
  }
}

async function downloadPinnedFile(
  url: string,
  destinationPath: string,
  relPath: string,
  expected: { sha256: string; bytes?: number }
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Model file download failed for ${relPath}: HTTP ${response.status} ${response.statusText} (${url})`
    );
  }

  await mkdir(dirname(destinationPath), { recursive: true });

  const hash = createHash("sha256");
  let byteLength = 0;
  // Streamed, never buffered — `onnx/model.onnx` is 133 MB.
  await streamPipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        byteLength += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(destinationPath)
  );

  if (expected.bytes !== undefined && byteLength !== expected.bytes) {
    throw new Error(
      `Model file integrity check failed for ${relPath}: expected ${expected.bytes} bytes, got ${byteLength}`
    );
  }

  const actualHash = hash.digest("hex");
  if (actualHash !== expected.sha256) {
    throw new Error(
      `Model file integrity check failed for ${relPath}: expected ${expected.sha256}, got ${actualHash}`
    );
  }
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
