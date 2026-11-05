# Local MCP rollback

A local profile is a file on this machine. It selects a database, a person, and allowed scopes for one child process. It is local trust, not a remote login. Removing the host configuration stops new clients. It does not revoke a remote session, because there is not one.

## Stop a host

Remove the `personal-memory` entry from the host's MCP configuration and restart that host. The configurations are in `local-mcp-clients.md` for Claude Code, Codex, Cursor, and OpenClaw. Leave the database in place until you decide whether to restore it.

## Restore a database

`memory quarantine-unowned --apply` removes summaries, boxes, traces, and anchors that have no `personId`. It refuses to run unless `--confirm-backup` names a non-empty file.

To undo that removal:

1. Stop every memory process that has the database open, including MCP children and the daemon.
2. Restore the confirmed encrypted backup to a new database with `memory restore --backup <confirmed-backup> --out <new-database> --passphrase <passphrase>`, then use that restored database in place of the current one. Data written after the backup is lost.
3. Start the host again with the same profile, or delete the profile file if this machine should stop serving that person.

Do not copy a quarantined row onto a person. The quarantine marker `legacy-unowned` is not an owner. `memory quarantine --person legacy-unowned` lists those records for inspection. Their `sanitizedRecord` may be truncated and secrets are redacted. The backup is the copy that still has the original rows.

## Clean-clone check

From a fresh checkout, with `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_BASE_URL`, and `MEMORY_MODEL_PATH` unset:

```bash
npx tsx scripts/offline-local-mcp-smoke.ts
```

The script creates a temporary database and profile, appends one turn, replays it, and searches. A successful run prints `"offline": true`, `"appended": true`, `"replayed": true`, `"searchErrored": false`, and `"eventCount": 1`.
