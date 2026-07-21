import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { BGE_SMALL_EN_V1_5_MANIFEST, vendorModel } from "../embeddings/model-vendor.js";
import {
  readEmbeddingsConfig,
  writeEmbeddingsConfig,
  type EmbeddingsConfig
} from "../embeddings/embeddings-config.js";

/**
 * `memory embeddings enable|disable|show` (D-04). `enable` is the only CLI
 * path that ever touches the network: it runs `vendorModel` first and only
 * flips `enabled: true` after the vendor call resolves (hash-verified) — a
 * failed/partial vendor never writes `enabled: true`, so the resolver keeps
 * returning the hash embedder (D-05 recovery: install-or-revert-config).
 */
const OptionsSchema = z
  .object({
    databasePath: z.string().min(1),
    action: z.enum(["enable", "disable", "show"]),
    modelPath: z.string().optional()
  })
  .strict();

export interface EmbeddingsCommandOptions {
  databasePath: string;
  action: "enable" | "disable" | "show";
  modelPath?: string;
}

export interface EmbeddingsCommandResult {
  ok: true;
  action: "enable" | "disable" | "show";
  config: EmbeddingsConfig;
}

function defaultModelPath(databasePath: string): string {
  return `${databasePath}.models`;
}

export async function runEmbeddingsCommand(
  options: EmbeddingsCommandOptions
): Promise<EmbeddingsCommandResult> {
  const parsed = OptionsSchema.parse(options);
  const databasePath = resolve(parsed.databasePath);

  if (parsed.action === "show") {
    return { ok: true, action: "show", config: readEmbeddingsConfig(databasePath) };
  }

  if (parsed.action === "disable") {
    const current = readEmbeddingsConfig(databasePath);
    const nextConfig: EmbeddingsConfig = { ...current, enabled: false };
    writeEmbeddingsConfig(databasePath, nextConfig);
    return { ok: true, action: "disable", config: nextConfig };
  }

  // action === "enable"
  const modelPath = parsed.modelPath ?? defaultModelPath(databasePath);

  // vendorModel is hash-verified (D-04/D-05 recovery); if it throws, the
  // config is left untouched — enabled:true is never written on a failed
  // or partial vendor, so resolveEmbedder keeps returning the hash embedder.
  await vendorModel(modelPath);

  const nextConfig: EmbeddingsConfig = {
    enabled: true,
    provider: "onnx-transformers",
    model: BGE_SMALL_EN_V1_5_MANIFEST.repo,
    revision: BGE_SMALL_EN_V1_5_MANIFEST.revision,
    modelPath
  };
  writeEmbeddingsConfig(databasePath, nextConfig);

  return { ok: true, action: "enable", config: nextConfig };
}

function parseArgs(args: string[]): EmbeddingsCommandOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--") && arg.includes("=")) {
      const separator = arg.indexOf("=");
      values.set(arg.slice(0, separator), arg.slice(separator + 1));
    } else if (arg.startsWith("--") && args[index + 1]) {
      values.set(arg, args[index + 1]);
      index += 1;
    }
  }
  const databasePath = values.get("--db");
  const action = values.get("--action");
  if (!databasePath) throw new Error("Missing memory database path. Pass --db <path>.");
  if (!action || !["enable", "disable", "show"].includes(action)) {
    throw new Error("Pass --action <enable|disable|show>.");
  }
  const modelPath = values.get("--model-path");
  return {
    databasePath: resolve(databasePath),
    action: action as EmbeddingsCommandOptions["action"],
    modelPath
  };
}

export async function main(argv: string[]): Promise<void> {
  const result = await runEmbeddingsCommand(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
