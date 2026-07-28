import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { AsymmetricEmbedder } from "./embedder.js";
import { composeModelIdentity } from "./embedder-identity.js";
import type { Embedding } from "../domain/types.js";

/**
 * D-03 bge query instruction string (exact, verbatim, per model card / CONTEXT.md).
 * Applied only to `embedQuery` calls; `embed` (passage mode) is bare.
 * Do NOT paraphrase or reword this string — it is pinned by D-03 and must
 * match the golden-vector fixtures exactly.
 */
export const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

export interface TransformerEmbedderOptions {
  /** Root directory holding the vendored model files (D-04 explicit vendoring, no implicit network). */
  localModelPath: string;
  /** HF revision pinned at vendoring time; recorded in provenance, never used to re-resolve remotely. */
  revision: string;
  createdAt?: () => string;
}

/**
 * Wraps the pinned `Xenova/bge-small-en-v1.5` ONNX model (D-01/D-02) via the
 * Hugging Face transformers.js feature-extraction pipeline. Constructs and
 * awaits exactly one resident pipeline instance in `init()` (Pitfall 3: never
 * lazily on first `embed()`), and reuses it for the process's lifetime.
 *
 * This class never flips `env.allowRemoteModels` on anywhere — the only
 * code path that ever touches the network is `vendorModel()` in
 * `model-vendor.ts` (D-04/T-09-02).
 */
export class TransformerEmbedder implements AsymmetricEmbedder {
  readonly provider = "onnx-transformers";
  /**
   * The vector-key identity: `repo@revision`, byte-identical to the `model` this
   * embedder stamps on every `Embedding` it emits (GAP-12-A). Assigned in the
   * constructor body, NOT as a field initializer — initializers run before the
   * constructor body, so composing there would key every persisted vector as
   * `"…@undefined"` (T-12-02).
   */
  readonly model: string;
  readonly dimensions = 384;

  /** The bare HF repo id. Only `pipeline()` uses this — a composed id would not resolve on disk. */
  private readonly repo = "Xenova/bge-small-en-v1.5";

  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;
  private readonly revision: string;
  private readonly createdAtFn: () => string;

  constructor(private readonly options: TransformerEmbedderOptions) {
    this.revision = options.revision;
    this.model = composeModelIdentity(this.repo, this.revision);
    this.createdAtFn = options.createdAt ?? (() => new Date().toISOString());
  }

  /** Call once at process startup; throws (D-05 hard error) if model files are missing/broken. */
  async init(): Promise<void> {
    env.allowRemoteModels = false;
    env.localModelPath = this.options.localModelPath;

    // pipeline() resolves + loads immediately; awaiting here (not just storing
    // the promise) surfaces load failures at startup, inside init(), rather
    // than lazily on the first embed() call (Pitfall 3 / D-05's "refuse to
    // run" intent). Never call pipeline() anywhere else in this class.
    // `this.repo` (bare), never `this.model` (composed) — a `repo@revision`
    // string would not resolve against the vendored on-disk layout (T-12-01).
    this.pipelinePromise = pipeline("feature-extraction", this.repo, {
      revision: this.revision,
      dtype: "fp32",
      device: "cpu",
      session_options: {
        executionProviders: ["cpu"],
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        graphOptimizationLevel: "disabled",
        executionMode: "sequential"
      }
    }) as Promise<FeatureExtractionPipeline>;

    await this.pipelinePromise;
  }

  async embed(text: string): Promise<Embedding> {
    return this.runPipeline(text);
  }

  async embedQuery(text: string): Promise<Embedding> {
    return this.runPipeline(QUERY_INSTRUCTION + text);
  }

  private async runPipeline(text: string): Promise<Embedding> {
    if (!this.pipelinePromise) {
      throw new Error("TransformerEmbedder.init() must be called and awaited before embed()");
    }

    const extractor = await this.pipelinePromise;

    // bge-small-en-v1.5 uses CLS-token pooling (BAAI's own 1_Pooling/config.json:
    // pooling_mode_cls_token=true, all other modes false) — NOT the "mean" pooling
    // shown in the Xenova model card's copy-pasted usage snippet, which is generic
    // boilerplate incorrect for this specific model. Do not "fix" this back to
    // "mean" — that would silently break the golden-vector determinism test.
    //
    // Truncation: FeatureExtractionPipeline._call() (installed @huggingface/transformers
    // 4.2.0) always tokenizes with `truncation: true` internally and does not accept a
    // pass-through `truncation`/`max_length` option on the extractor() call itself
    // (verified against node_modules/@huggingface/transformers/src/pipelines/feature-extraction.js
    // and its .d.ts — FeatureExtractionPipelineOptions only exposes pooling/normalize/
    // quantize/precision; Assumption A5 resolved). Truncation therefore always applies,
    // bounded by the tokenizer's own configured `model_max_length` (512 for bge-small-en-v1.5's
    // vendored tokenizer_config.json) with no additional option needed here.
    const output = await extractor(text, { pooling: "cls", normalize: true });

    return {
      provider: this.provider,
      model: this.model,
      dimensions: this.dimensions,
      vector: Array.from(output.data as Float32Array),
      createdAt: this.createdAtFn()
    };
  }
}
