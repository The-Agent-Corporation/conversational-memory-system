import type { Embedder } from "./embedder.js";

/**
 * D-04/D-05/D-06: resolves the active embedder from the persisted embeddings
 * config. Default (config missing or `enabled: false`) resolves to
 * `DeterministicEmbedder`. `enabled: true` resolves to `TransformerEmbedder`
 * if the vendored model is present and healthy; if enabled-but-broken,
 * `resolveEmbedder` hard-errors (D-05) while `probeEmbedderHealth` reports
 * `healthy: false` for daemon/`memory health` consumption (D-06). Wave 0
 * skeleton — real resolution lands with plan 04.
 */
export interface EmbedderHealth {
  enabled: boolean;
  provider: string;
  model: string;
  revision: string;
  healthy: boolean;
  reason: string | null;
}

export async function resolveEmbedder(_databasePath: string): Promise<Embedder> {
  throw new Error("not implemented: embedder-resolver");
}

export async function probeEmbedderHealth(_databasePath: string): Promise<EmbedderHealth> {
  throw new Error("not implemented: embedder-resolver");
}
