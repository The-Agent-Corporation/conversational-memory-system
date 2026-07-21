import type { AsymmetricEmbedder } from "./embedder.js";
import type { Embedding } from "../domain/types.js";

/**
 * D-03 bge query instruction string (exact, verbatim, per model card / CONTEXT.md).
 * Applied only to `embedQuery` calls; `embed` (passage mode) is bare.
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
 * Hugging Face transformers.js feature-extraction pipeline. This is a Wave 0
 * skeleton: it deliberately does NOT import the transformers.js package yet
 * (that dependency lands in plan 02, the real pipeline wiring in plan 03) so
 * this plan typechecks independently of the package install.
 */
export class TransformerEmbedder implements AsymmetricEmbedder {
  readonly provider = "onnx-transformers";
  readonly model = "Xenova/bge-small-en-v1.5";
  readonly dimensions = 384;

  constructor(private readonly options: TransformerEmbedderOptions) {}

  /** Call once at process startup; must throw (D-05 hard error) if model files are missing/broken. */
  async init(): Promise<void> {
    throw new Error("not implemented: transformer-embedder");
  }

  async embed(_text: string): Promise<Embedding> {
    throw new Error("not implemented: transformer-embedder");
  }

  async embedQuery(_text: string): Promise<Embedding> {
    throw new Error("not implemented: transformer-embedder");
  }
}
