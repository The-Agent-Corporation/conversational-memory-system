import { DeterministicEmbedder, type Embedder } from "./embedder.js";
import { readEmbeddingsConfig } from "./embeddings-config.js";
import { TransformerEmbedder } from "./transformer-embedder.js";

/**
 * D-04/D-05/D-06: resolves the active embedder from the persisted embeddings
 * config. Default (config missing or `enabled: false`) resolves to
 * `DeterministicEmbedder`. `enabled: true` resolves to `TransformerEmbedder`
 * if the vendored model is present and healthy; if enabled-but-broken,
 * `resolveEmbedder` hard-errors (D-05) while `probeEmbedderHealth` reports
 * `healthy: false` for daemon/`memory health` consumption (D-06).
 */
export interface EmbedderHealth {
  enabled: boolean;
  provider: string;
  model: string;
  revision: string;
  healthy: boolean;
  reason: string | null;
}

/**
 * Resolves the active embedder. Never falls back to `DeterministicEmbedder`
 * when `enabled: true` — an enabled-but-broken model rejects (D-05), so a
 * mixed-provider vector store is never silently written.
 */
export async function resolveEmbedder(databasePath: string): Promise<Embedder> {
  const config = readEmbeddingsConfig(databasePath);

  if (!config.enabled) {
    return new DeterministicEmbedder();
  }

  const embedder = new TransformerEmbedder({
    localModelPath: config.modelPath,
    revision: config.revision
  });
  await embedder.init();
  return embedder;
}

/**
 * Non-throwing health probe (D-06) consumed by the daemon/`memory health`
 * surface. Unlike `resolveEmbedder`, this never rejects — an enabled-but-
 * broken model resolves to `{ healthy: false, reason }` instead of throwing.
 */
export async function probeEmbedderHealth(databasePath: string): Promise<EmbedderHealth> {
  let config;
  try {
    config = readEmbeddingsConfig(databasePath);
  } catch (error) {
    // A corrupt or invalid sidecar must not crash health consumers (D-06) —
    // it reports as enabled-unknown/unhealthy instead.
    return {
      enabled: true,
      provider: "unknown",
      model: "unknown",
      revision: "unknown",
      healthy: false,
      reason: `embeddings config unreadable: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!config.enabled) {
    return {
      enabled: false,
      provider: config.provider,
      model: config.model,
      revision: config.revision,
      healthy: true,
      reason: null
    };
  }

  try {
    const embedder = new TransformerEmbedder({
      localModelPath: config.modelPath,
      revision: config.revision
    });
    await embedder.init();
    return {
      enabled: true,
      provider: config.provider,
      model: config.model,
      revision: config.revision,
      healthy: true,
      reason: null
    };
  } catch (error) {
    return {
      enabled: true,
      provider: config.provider,
      model: config.model,
      revision: config.revision,
      healthy: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
