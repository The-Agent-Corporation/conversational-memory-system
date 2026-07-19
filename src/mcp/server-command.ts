import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryMcpServer } from "./server.js";

interface MemoryMcpCommandOptions {
  readonly configPath: string;
  readonly profileName: string;
}

export const runMemoryMcpServerCommand = async (args: readonly string[]): Promise<void> => {
  const options = parseMemoryMcpCommandOptions(args);
  // Profile authority and the read-only database must resolve before STDIO transport starts.
  const application = await createMemoryMcpServer({
    configPath: options.configPath,
    profileName: options.profileName
  });
  const transport = new StdioServerTransport();
  let cleanupPromise: Promise<void> | undefined;

  const cleanup = (): Promise<void> => {
    cleanupPromise ??= application.close();
    return cleanupPromise;
  };
  const onInputEnd = (): void => { void cleanup(); };
  const onSignal = (): void => { void cleanup(); };
  const onStdoutError = (error: NodeJS.ErrnoException): void => {
    if (error.code === "EPIPE") void cleanup();
  };

  process.stdin.once("end", onInputEnd);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.stdout.on("error", onStdoutError);

  try {
    await application.server.connect(transport);
  } catch (error) {
    process.stdin.off("end", onInputEnd);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.stdout.off("error", onStdoutError);
    await cleanup();
    throw error;
  }
};

const parseMemoryMcpCommandOptions = (args: readonly string[]): MemoryMcpCommandOptions => {
  let configPath: string | undefined;
  let profileName: string | undefined;

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || (flag !== "--config" && flag !== "--profile")) {
      throw new Error("Invalid memory MCP startup arguments");
    }
    if (flag === "--config") {
      if (configPath) throw new Error("Duplicate memory MCP config selection");
      configPath = value;
    } else {
      if (profileName) throw new Error("Duplicate memory MCP profile selection");
      profileName = value;
    }
  }
  if (!configPath || !profileName) throw new Error("Explicit config and profile are required");
  return { configPath, profileName };
};

const isMain = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  runMemoryMcpServerCommand(process.argv.slice(2)).catch(() => {
    process.stderr.write("MEMORY_MCP_STARTUP_FAILED\n");
    process.exitCode = 1;
  });
}
