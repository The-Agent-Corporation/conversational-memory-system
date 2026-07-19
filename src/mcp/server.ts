import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadMemoryMcpProfile, type LoadMemoryMcpProfileOptions } from "./profile-loader.js";
import type { ProfileAuthority } from "./authority.js";
import { ContinuationCursorCodec } from "./continuation-cursor.js";
import { ConfirmationService } from "./confirmation-service.js";
import { MemoryMutationApplication } from "./mutation-application.js";
import { registerMemoryTools } from "./tool-catalog.js";
import { ScopedProposalReviewer } from "../proposals/scoped-proposal-reviewer.js";
import { MemoryQueryService } from "../retrieval/memory-query-service.js";
import { SubjectExpansionService } from "../retrieval/subject-expansion-service.js";
import type { MemoryStore } from "../storage/memory-store.js";
import { SqliteStore } from "../storage/sqlite-store.js";

export const MEMORY_MCP_SERVER_INFO = Object.freeze({
  name: "universal-personal-memory",
  version: "0.1.0"
});

const SERVER_INSTRUCTIONS = [
  "Memory is assistive context, not ground truth; verify against current sources.",
  "Mutation previews issue short-lived single-use confirmations; execute tools enforce the exact previewed intent."
].join(" ");

const ATOMIC_COMMIT_METHODS = new Set<PropertyKey>([
  "commitHistoryImport",
  "commitProposalDecision",
  "commitSourceRevocation",
  "commitSourceDeletion",
  "commitLocalSyncOperation"
]);

export interface CreateMemoryMcpServerOptions extends LoadMemoryMcpProfileOptions {
  readonly now?: () => string;
  readonly cursorSecret?: string | Uint8Array;
  readonly busyTimeoutMs?: number;
}

export interface MemoryMcpApplication {
  readonly server: McpServer;
  readonly authority: ProfileAuthority;
  close(): Promise<void>;
}

export const createMemoryMcpServer = async (
  options: CreateMemoryMcpServerOptions
): Promise<MemoryMcpApplication> => {
  const authority = await loadMemoryMcpProfile(options);
  const readStore = new SqliteStore(authority.databasePath, {
    readOnly: true,
    busyTimeoutMs: options.busyTimeoutMs ?? 5_000
  });
  const mutationStore = createAtomicMutationStore(
    readStore,
    authority.databasePath,
    options.busyTimeoutMs ?? 5_000
  );
  const server = new McpServer(MEMORY_MCP_SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  const now = options.now ?? (() => new Date().toISOString());
  const cursorSecret = options.cursorSecret ?? randomBytes(32);
  let closed = false;

  try {
    registerMemoryTools(server, {
      reads: {
        queries: new MemoryQueryService(readStore, authority),
        expansion: new SubjectExpansionService(
          readStore,
          authority,
          new ContinuationCursorCodec(cursorSecret, { now })
        ),
        proposals: new ScopedProposalReviewer(readStore, authority),
        now
      },
      mutations: new MemoryMutationApplication({
        store: mutationStore,
        authority,
        confirmations: new ConfirmationService({ clock: now })
      })
    });
  } catch (error) {
    readStore.close();
    throw error;
  }

  return {
    server,
    authority,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await server.close();
      } finally {
        readStore.close();
      }
    }
  };
};

/**
 * Preview operations use the long-lived read-only connection. Only the four task-specific
 * atomic commit methods get a short-lived write connection, which is closed after the call.
 */
const createAtomicMutationStore = (
  readStore: SqliteStore,
  databasePath: string,
  busyTimeoutMs: number
): MemoryStore => new Proxy(readStore as MemoryStore, {
  get(target, property) {
    if (ATOMIC_COMMIT_METHODS.has(property)) {
      return async (...args: unknown[]) => {
        const writeStore = new SqliteStore(databasePath, { busyTimeoutMs });
        try {
          const method = Reflect.get(writeStore, property) as (...values: unknown[]) => unknown;
          return await method.apply(writeStore, args);
        } finally {
          writeStore.close();
        }
      };
    }
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  }
});
