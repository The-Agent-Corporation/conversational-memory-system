/**
 * Persisted embeddings config (D-04): a sidecar JSON file next to the memory
 * database, mirroring `tune-command.ts`'s `${databasePath}.tune.json` pattern.
 * Wave 0 skeleton — read/write bodies land with plan 04's `embedder-resolver`
 * and `memory embeddings enable` CLI wiring.
 */
export interface EmbeddingsConfig {
  enabled: boolean;
  provider: string;
  model: string;
  revision: string;
  modelPath: string;
}

export function embeddingsConfigPath(databasePath: string): string {
  return `${databasePath}.embeddings.json`;
}

export function readEmbeddingsConfig(_databasePath: string): EmbeddingsConfig {
  throw new Error("not implemented: embeddings-config");
}

export function writeEmbeddingsConfig(_databasePath: string, _config: EmbeddingsConfig): void {
  throw new Error("not implemented: embeddings-config");
}
