import { pathToFileURL } from "node:url";
import { REGISTRY } from "./command-registry.js";

/**
 * Top-level argv dispatcher for the unified `memory` executable (D-04).
 *
 * Routes `memory <subcommand> [...rest]` to the matching existing command
 * module's exported `main(argv)`, in-process (no subprocess spawn). Unknown
 * or missing subcommands print the available list to stderr and set a
 * non-zero exit code without throwing (T-07-02).
 */
export async function dispatch(argv: string[]): Promise<void> {
  const [subcommand, ...rest] = argv;
  const loader = subcommand ? REGISTRY[subcommand] : undefined;
  if (!loader) {
    process.stderr.write(`Unknown or missing subcommand. Available: ${Object.keys(REGISTRY).sort().join(", ")}\n`);
    process.exitCode = 1;
    return;
  }
  const module = await loader();
  await module.main(rest);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dispatch(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
