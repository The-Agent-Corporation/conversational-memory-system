import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { OpenRouterProviderPolicy } from "./types.js";

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const ProviderPolicySchema = z.object({
  only: z.array(z.string().min(1)).optional(),
  order: z.array(z.string().min(1)).optional(),
  ignore: z.array(z.string().min(1)).optional(),
  allow_fallbacks: z.boolean().optional(),
  data_collection: z.enum(["deny", "allow"]).default("deny"),
  zdr: z.boolean().optional()
}).strict();

const SemanticRuntimeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  chatModel: z.string().default(""),
  embeddingModel: z.string().default(""),
  dimensions: z.number().int().positive().nullable().default(null),
  baseUrl: z.string().default(""),
  dailySpendCapUsd: z.number().nonnegative().default(10),
  traceDiscoveryEnabled: z.boolean().default(false),
  topicSimilarityThreshold: z.number().min(0).max(1).default(0.72),
  boundaryVersion: z.string().min(1).default("semantic-boundary/v1"),
  maxReviewCandidates: z.number().int().positive().default(2000),
  provider: ProviderPolicySchema.default({ data_collection: "deny" })
}).strict();

export type SemanticRuntimeConfig = z.infer<typeof SemanticRuntimeConfigSchema>;

export function semanticConfigPath(databasePath: string): string {
  return `${databasePath}.semantic.json`;
}

export function readSemanticConfig(databasePath: string): SemanticRuntimeConfig {
  const path = semanticConfigPath(databasePath);
  if (!existsSync(path)) return SemanticRuntimeConfigSchema.parse({});
  return SemanticRuntimeConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeSemanticConfig(databasePath: string, config: SemanticRuntimeConfig): void {
  const validated = SemanticRuntimeConfigSchema.parse(config);
  writeFileSync(semanticConfigPath(databasePath), `${JSON.stringify(validated, null, 2)}\n`, "utf8");
}

export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env, configured = ""): string {
  const fromEnv = env.OPENROUTER_BASE_URL?.trim();
  return (fromEnv || configured || DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
}

/** The public OpenRouter host injects nothing; a credential proxy may. */
export function openRouterApiKeyRequired(baseUrl: string): boolean {
  const host = new URL(baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`).hostname;
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

export function providerPolicyFromConfig(config: SemanticRuntimeConfig): OpenRouterProviderPolicy {
  return { ...config.provider };
}
