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
  registerMemoryAppendTurnTool,
  type MemoryAppendTurnApplication
} from "./tools/append-turn-tools.js";
import {
  registerMemoryResumeTool,
  type MemoryResumeApplication
} from "./tools/resume-tools.js";
import {
  registerMemoryReadTools,
  type MemoryReadToolApplication
} from "./tools/read-tools.js";

export interface MemoryToolApplication {
  readonly reads: MemoryReadToolApplication;
  readonly mutations: MemoryMutationToolApplication;
  readonly inject: MemoryInjectApplication;
  readonly appendTurn: MemoryAppendTurnApplication;
  readonly resume: MemoryResumeApplication;
}

/**
 * Register the finite tool catalog once; authority is already captured by the application.
 * Phase 5 fixed six read + ten mutation tools; Phase 7 (07-03, REQ-039) added the seventh
 * read-only `memory_explain` tool, growing the read catalog to seven (17 total). ADR 0057
 * added the opt-in `memory_inject` tool and ADR 0058 the `event_delete_*` mutation pair
 * (twelve mutations). ADR 0063 added `memory_append_turn` and ADR 0064 added the
 * read-only `memory_resume` tool (22 total).
 */
export const registerMemoryTools = (
  server: McpServer,
  application: MemoryToolApplication
): void => {
  registerMemoryReadTools(server, application.reads);
  registerMemoryInjectTool(server, application.inject);
  registerMemoryAppendTurnTool(server, application.appendTurn);
  registerMemoryResumeTool(server, application.resume);
  registerMemoryMutationTools(server, application.mutations);
};
