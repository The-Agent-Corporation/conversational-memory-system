import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BGE_SMALL_EN_V1_5_MANIFEST,
  vendorModel,
  verifyManifest
} from "../../src/embeddings/model-vendor.js";

/**
 * GAP-12-C regression suite. `vendorModel` used to download through
 * `pipeline()` into transformers.js's revision-nested `env.cacheDir` while
 * `verifyManifest` read a flat `${localModelPath}/${repo}/${relPath}` — nothing
 * wrote what it read — and it never requested `special_tokens_map.json` at all.
 * The assertions that would have caught both defects existed, but sat behind
 * `describe.runIf(MEMORY_RUN_NETWORK_TESTS)` and therefore never ran.
 *
 * These cases carry NO network-flag gate: they run in a plain `npm test`. A
 * loopback `node:http` server serves the five pinned files from the vendored
 * fixture, whose bytes hash exactly to `BGE_SMALL_EN_V1_5_MANIFEST`, so this
 * exercises the real fetch, the real flatten, and the real sha256 verification
 * rather than a mock of them. The only gate is fixture presence — the fixture
 * is gitignored, so a fresh clone must stay green (same idiom as
 * `transformer-embedder.golden.test.ts`).
 */
const FIXTURE_ROOT = process.env.MEMORY_MODEL_PATH ?? "tests/fixtures/models";
const FIXTURE_REPO_DIR = join(FIXTURE_ROOT, BGE_SMALL_EN_V1_5_MANIFEST.repo);
const FIXTURE_PRESENT = existsSync(join(FIXTURE_REPO_DIR, "onnx/model.onnx"));

const MANIFEST_FILES = Object.keys(BGE_SMALL_EN_V1_5_MANIFEST.files);
const RESOLVE_PREFIX = `/${BGE_SMALL_EN_V1_5_MANIFEST.repo}/resolve/${BGE_SMALL_EN_V1_5_MANIFEST.revision}/`;

const QUANTIZED_VARIANT_FILES = [
  "onnx/model_fp16.onnx",
  "onnx/model_int8.onnx",
  "onnx/model_uint8.onnx",
  "onnx/model_quantized.onnx",
  "onnx/model_q4.onnx",
  "onnx/model_q4f16.onnx",
  "onnx/model_bnb4.onnx"
];

interface FixtureServerOptions {
  /** Relative manifest paths the server answers 404 for (defect-2 regression pin). */
  omit?: string[];
  /** Relative manifest paths served with a corrupted body (integrity regression pin). */
  corrupt?: string[];
}

interface FixtureServer {
  baseUrl: string;
  requested: string[];
  close: () => Promise<void>;
}

async function startFixtureServer(options: FixtureServerOptions = {}): Promise<FixtureServer> {
  const omit = new Set(options.omit ?? []);
  const corrupt = new Set(options.corrupt ?? []);
  const requested: string[] = [];

  const server: Server = createServer((request, response) => {
    const path = request.url ?? "";
    if (!path.startsWith(RESOLVE_PREFIX)) {
      response.writeHead(404).end("not found");
      return;
    }
    const relPath = path.slice(RESOLVE_PREFIX.length);
    requested.push(relPath);

    if (omit.has(relPath) || !MANIFEST_FILES.includes(relPath)) {
      response.writeHead(404).end("not found");
      return;
    }

    if (corrupt.has(relPath)) {
      // Deliberately no Content-Length: the body is a different length as well
      // as different bytes, so the sha256 check is what must catch it.
      response.writeHead(200).end("{}corrupted-body");
      return;
    }

    const filePath = join(FIXTURE_REPO_DIR, relPath);
    response.writeHead(200, { "content-length": String(statSync(filePath).size) });
    // 133 MB for onnx/model.onnx — streamed, never buffered.
    createReadStream(filePath).pipe(response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requested,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

async function sha256OfFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  return existsSync(path);
}

const VENDOR_TIMEOUT_MS = 180_000;

describe.skipIf(!FIXTURE_PRESENT)("model-vendor offline vendoring (GAP-12-C, REQ-044)", () => {
  let dir: string;
  let server: FixtureServer | null = null;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "model-vendor-offline-"));
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await rm(dir, { recursive: true, force: true });
  });

  it(
    "writes every pinned file into the flat layout verifyManifest reads",
    { timeout: VENDOR_TIMEOUT_MS },
    async () => {
      server = await startFixtureServer();

      await vendorModel(dir, { baseUrl: server.baseUrl });

      const repoDir = join(dir, BGE_SMALL_EN_V1_5_MANIFEST.repo);
      for (const [relPath, expected] of Object.entries(BGE_SMALL_EN_V1_5_MANIFEST.files)) {
        const filePath = join(repoDir, relPath);
        expect(await exists(filePath), `${relPath} missing at flat path`).toBe(true);
        expect(await sha256OfFile(filePath), `${relPath} sha256`).toBe(expected.sha256);
      }

      // The flat layout is the contract; nothing revision-nested is written.
      expect(await exists(join(repoDir, BGE_SMALL_EN_V1_5_MANIFEST.revision))).toBe(false);
      await expect(verifyManifest(dir)).resolves.toBeUndefined();
    }
  );

  it(
    "requests all five manifest files, special_tokens_map.json included (defect 2)",
    { timeout: VENDOR_TIMEOUT_MS },
    async () => {
      server = await startFixtureServer();

      await vendorModel(dir, { baseUrl: server.baseUrl });

      expect([...server.requested].sort()).toEqual([...MANIFEST_FILES].sort());
    }
  );

  it(
    "rejects when special_tokens_map.json is unavailable, leaving nothing verifiable",
    { timeout: VENDOR_TIMEOUT_MS },
    async () => {
      server = await startFixtureServer({ omit: ["special_tokens_map.json"] });

      await expect(vendorModel(dir, { baseUrl: server.baseUrl })).rejects.toThrow(
        /special_tokens_map\.json/
      );

      await expect(verifyManifest(dir)).rejects.toThrow();
      expect(await exists(join(dir, BGE_SMALL_EN_V1_5_MANIFEST.repo, "onnx/model.onnx"))).toBe(false);
    }
  );

  it(
    "rejects a corrupted body with the integrity message and leaves no usable model dir (T-12-30)",
    { timeout: VENDOR_TIMEOUT_MS },
    async () => {
      server = await startFixtureServer({ corrupt: ["tokenizer.json"] });

      await expect(vendorModel(dir, { baseUrl: server.baseUrl })).rejects.toThrow(
        /integrity|sha256|mismatch/i
      );

      // T-12-25/T-12-30: a later run must not be able to pass verification on
      // leftovers from a failed vendor.
      await expect(verifyManifest(dir)).rejects.toThrow();
      const repoParent = join(dir, "Xenova");
      const leftovers = (await exists(repoParent)) ? await readdir(repoParent) : [];
      expect(leftovers).toEqual([]);
    }
  );

  it(
    "does NOT write quantized variant files (D-02 fp32-only)",
    { timeout: VENDOR_TIMEOUT_MS },
    async () => {
      server = await startFixtureServer();

      await vendorModel(dir, { baseUrl: server.baseUrl });

      const repoDir = join(dir, BGE_SMALL_EN_V1_5_MANIFEST.repo);
      for (const relPath of QUANTIZED_VARIANT_FILES) {
        expect(await exists(join(repoDir, relPath))).toBe(false);
      }
    }
  );
});
