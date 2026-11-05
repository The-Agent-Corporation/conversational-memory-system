import { runOfflineLocalMcpSmoke } from "../src/operations/offline-local-mcp-smoke.js";

const result = await runOfflineLocalMcpSmoke(process.argv[2]);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.appended || !result.replayed || result.searchErrored || result.eventCount !== 1) {
  process.exitCode = 1;
}
