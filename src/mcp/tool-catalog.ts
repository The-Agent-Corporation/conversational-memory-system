import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerMemoryMutationTools,
  type MemoryMutationToolApplication
} from "./tools/mutation-tools.js";
import {
  registerMemoryInjectTool,
  type MemoryInjectApplication
} from "./tools/inject-tools.js";
import {
  registerMemoryReadTools,
  type MemoryReadToolApplication
} from "./tools/read-tools.js";

export interface MemoryToolApplication {
  readonly reads: MemoryReadToolApplication;
  readonly mutations: MemoryMutationToolApplication;
  readonly inject: MemoryInjectApplication;
}

/**
 * Register the finite tool catalog once; authority is already captured by the application.
 * Phase 5 fixed six read + ten mutation tools; Phase 7 (07-03, REQ-039) added the seventh
 * read-only `memory_explain` tool, growing the read catalog to seven (17 total).
 */
export const registerMemoryTools = (
  server: McpServer,
  application: MemoryToolApplication
): void => {
  registerMemoryReadTools(server, application.reads);
  registerMemoryInjectTool(server, application.inject);
  registerMemoryMutationTools(server, application.mutations);
};
