import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

/**
 * Persisted embeddings config (D-04): a sidecar JSON file next to the memory
 * database, mirroring `tune-command.ts`'s `${databasePath}.tune.json` pattern.
 * `enabled` defaults to `false` so a fresh install with no action taken
 * resolves to `DeterministicEmbedder` (SC1) — the hash embedder is the
 * always-on default and never a silent fallback.
 */
const EmbeddingsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: z.string().default("onnx-transformers"),
    model: z.string().default("Xenova/bge-small-en-v1.5"),
    revision: z.string().default(""),
    modelPath: z.string().default("")
  })
  .strict();

export type EmbeddingsConfig = z.infer<typeof EmbeddingsConfigSchema>;

export function embeddingsConfigPath(databasePath: string): string {
  return `${databasePath}.embeddings.json`;
}

/**
 * Returns the persisted config, or the schema defaults (enabled:false) when
 * no sidecar file has been written yet.
 */
export function readEmbeddingsConfig(databasePath: string): EmbeddingsConfig {
  const path = embeddingsConfigPath(databasePath);
  if (!existsSync(path)) return EmbeddingsConfigSchema.parse({});
  return EmbeddingsConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeEmbeddingsConfig(databasePath: string, config: EmbeddingsConfig): void {
  const validated = EmbeddingsConfigSchema.parse(config);
  writeFileSync(embeddingsConfigPath(databasePath), `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}
