import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerMemoryMutationTools,
  type MemoryMutationToolApplication
} from "./tools/mutation-tools.js";
import {
  registerMemoryReadTools,
  type MemoryReadToolApplication
} from "./tools/read-tools.js";

export interface MemoryToolApplication {
  readonly reads: MemoryReadToolApplication;
  readonly mutations: MemoryMutationToolApplication;
}

/** Register the finite Phase 5 catalog once; authority is already captured by the application. */
export const registerMemoryTools = (
  server: McpServer,
  application: MemoryToolApplication
): void => {
  registerMemoryReadTools(server, application.reads);
  registerMemoryMutationTools(server, application.mutations);
};
