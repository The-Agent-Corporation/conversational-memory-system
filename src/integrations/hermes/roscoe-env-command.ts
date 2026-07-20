import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { buildRoscoeMemoryEnvironment, type RoscoeMemoryEnvironment } from "./smoke-harness.js";

const OutputFormatSchema = z.enum(["shell", "json"]);

export interface RoscoeEnvCommandOptions {
  databasePath: string;
  projectRoot?: string;
  format?: "shell" | "json";
}

export function renderRoscoeMemoryEnvironment(options: RoscoeEnvCommandOptions): string {
  const format = OutputFormatSchema.parse(options.format ?? "shell");
  const env = buildRoscoeMemoryEnvironment({
    databasePath: options.databasePath,
    projectRoot: options.projectRoot
  });

  if (format === "json") {
    return `${JSON.stringify(env, null, 2)}\n`;
  }

  return `${Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellArg(value)}`)
    .join("\n")}\n`;
}

function parseArgs(args: string[]): RoscoeEnvCommandOptions {
  const options: Partial<RoscoeEnvCommandOptions> = {
    projectRoot: process.cwd(),
    format: "shell"
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--db" && args[index + 1]) {
      options.databasePath = args[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith("--db=")) {
      options.databasePath = arg.slice("--db=".length);
      continue;
    }
    if (arg === "--project-root" && args[index + 1]) {
      options.projectRoot = resolve(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--project-root=")) {
      options.projectRoot = resolve(arg.slice("--project-root=".length));
      continue;
    }
    if (arg === "--format" && args[index + 1]) {
      options.format = OutputFormatSchema.parse(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--format=")) {
      options.format = OutputFormatSchema.parse(arg.slice("--format=".length));
    }
  }

  const databasePath = options.databasePath ?? process.env.HERMES_CONVERSATIONAL_MEMORY_DB;
  if (!databasePath) {
    throw new Error("Missing memory database path. Pass --db <path> or set HERMES_CONVERSATIONAL_MEMORY_DB.");
  }

  return {
    databasePath,
    projectRoot: options.projectRoot,
    format: options.format
  };
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function main(argv: string[]): Promise<void> {
  process.stdout.write(renderRoscoeMemoryEnvironment(parseArgs(argv)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
