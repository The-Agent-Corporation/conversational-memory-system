/**
 * D-01/D-02/D-04 pinned model manifest and one-time explicit vendoring flow
 * for `Xenova/bge-small-en-v1.5` (fp32, 384-dim). Wave 0 skeleton — the real
 * fetch + sha256 verification lands with plan 02 (dependency install) and
 * plan 03/04 (real vendoring implementation), which must also replace the
 * `"PIN_AT_VENDOR_TIME"` / `"PIN"` placeholders below with real values
 * captured from a live vendoring run against the Hugging Face Hub.
 *
 * D-02 explicitly excludes quantized variants (model_fp16/int8/uint8/quantized/
 * q4/q4f16/bnb4) from this manifest — only the fp32 file set is vendored.
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

export async function vendorModel(_localModelPath: string): Promise<void> {
  throw new Error("not implemented: model-vendor");
}
