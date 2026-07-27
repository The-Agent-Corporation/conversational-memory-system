/**
 * Static subcommand -> dynamic import() map for the unified `memory` CLI (D-04).
 *
 * Every entry wraps an EXISTING command module; no command logic lives here.
 * This is a closed static allow-list keyed by exact subcommand name — the
 * dispatcher (src/cli/bin.ts) rejects unknown names before any import runs,
 * so no dynamic path is ever constructed from untrusted input (T-07-01).
 *
 * Only commands that already exist on disk are registered here. Later-wave
 * plans (init, explain, audit-log, backup, restore, export, tune) add their
 * own entries when those modules are built; adding a forward reference to a
 * module that doesn't exist yet fails `tsc` (TS2307).
 */
export const REGISTRY: Record<string, () => Promise<{ main(argv: string[]): Promise<void> }>> = {
  backup: () => import("../storage/backup/backup-command.js"),
  restore: () => import("../storage/backup/restore-command.js"),
  export: () => import("../storage/backup/export-plaintext-command.js"),
  bootstrap: () => import("../bootstrap/bootstrap-command.js"),
  status: () => import("../bootstrap/status-command.js"),
  daemon: () => import("../daemon/daemon-command.js"),
  "daemon:notification-smoke": () => import("../daemon/macos/notification-smoke-command.js"),
  "codex:discover": () => import("../imports/codex-discover-command.js"),
  "codex:import": () => import("../imports/codex-import-command.js"),
  discover: () => import("../imports/history-discover-command.js"),
  init: () => import("../bootstrap/init-command.js"),
  explain: () => import("../audit/explain-command.js"),
  "audit-log": () => import("../audit/audit-log-command.js"),
  import: () => import("../imports/history-import-command.js"),
  quarantine: () => import("../imports/quarantine-command.js"),
  "source:delete": () => import("../imports/source-delete-command.js"),
  "source:revoke": () => import("../imports/source-revoke-command.js"),
  mcp: () => import("../mcp/server-command.js"),
  "hermes:ingest": () => import("../integrations/hermes/ingest-command.js"),
  "hermes:inject": () => import("../integrations/hermes/inject-command.js"),
  "hermes:proposals:approve": () => import("../integrations/hermes/proposals-approve-command.js"),
  "hermes:proposals:list": () => import("../integrations/hermes/proposals-list-command.js"),
  "hermes:proposals:reject": () => import("../integrations/hermes/proposals-reject-command.js"),
  "hermes:resume": () => import("../integrations/hermes/resume-command.js"),
  "hermes:roscoe-env": () => import("../integrations/hermes/roscoe-env-command.js"),
  "hermes:sleep": () => import("../integrations/hermes/sleep-command.js"),
  tune: () => import("../operations/tune-command.js"),
  embeddings: () => import("../operations/embeddings-command.js"),
  "backfill-embeddings": () => import("../operations/backfill-embeddings-command.js"),
  "rebuild-derivations": () => import("../operations/rebuild-derivations-command.js"),
  "prune-superseded": () => import("../operations/prune-superseded-command.js")
};
