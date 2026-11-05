# Local MCP Client Registration

The memory MCP server is a local STDIO child process. Every registration must select an
absolute product configuration file and one named profile. There is no default profile,
database discovery, HTTP listener, or synchronization ownership in this process.

Create the profile file separately and keep its database, person, allowed scopes, ingest
scope, source roots, and disclosure-safe aliases explicit. Do not put API keys, tokens, or
native conversation content in this file. `docs/integrations/sample-local-profile.json` is a
template with placeholder absolute paths and `person_example`. Replace those paths before use.

A profile is local trust. Whoever can read the file and launch the process can use that
person and those scopes on this machine. It is not remote authentication and it does not
identify the operator to another computer.

## Startup command

From any MCP-capable host, use this command shape with absolute paths:

```text
npm --silent --prefix /absolute/path/to/conversational-memory-system run memory:mcp -- --config /absolute/path/to/profiles.json --profile workspace-name
```

Startup fails before STDIO connects when either flag is absent, the config is invalid, or
the profile is unknown. The selected profile fixes the database, person, and complete
allowed-scope list for the lifetime of that child.

## Claude Code

Claude Code reads a project or user MCP config. Use the same command and an absolute profile:

```json
{
  "mcpServers": {
    "personal-memory": {
      "command": "npm",
      "args": [
        "--silent",
        "--prefix",
        "/absolute/path/to/conversational-memory-system",
        "run",
        "memory:mcp",
        "--",
        "--config",
        "/absolute/path/to/profiles.json",
        "--profile",
        "workspace"
      ]
    }
  }
}
```

## Codex command and arguments

Codex accepts a local STDIO server as a command plus argument array. The equivalent
registration values are:

```toml
[mcp_servers.personal_memory]
command = "npm"
args = ["--silent", "--prefix", "/absolute/path/to/conversational-memory-system", "run", "memory:mcp", "--", "--config", "/absolute/path/to/profiles.json", "--profile", "workspace-name"]
```

## Cursor

Cursor uses the same stdio shape in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "personal-memory": {
      "command": "npm",
      "args": [
        "--silent",
        "--prefix",
        "/absolute/path/to/conversational-memory-system",
        "run",
        "memory:mcp",
        "--",
        "--config",
        "/absolute/path/to/profiles.json",
        "--profile",
        "workspace"
      ]
    }
  }
}
```

## OpenClaw command and arguments

Use the same authority selection in OpenClaw's local MCP registry:

```json
{
  "mcpServers": {
    "personal-memory": {
      "command": "npm",
      "args": [
        "--silent",
        "--prefix",
        "/absolute/path/to/conversational-memory-system",
        "run",
        "memory:mcp",
        "--",
        "--config",
        "/absolute/path/to/profiles.json",
        "--profile",
        "workspace-name"
      ]
    }
  }
}
```

Profiles represent workspace or sensitivity boundaries, not host brands. Claude Code,
Codex, Cursor, and OpenClaw should share a profile only when they should have identical
memory access.

Unowned legacy summaries, boxes, traces, and anchors are quarantined with
`memory quarantine-unowned` instead of being assigned to the open profile. See
`local-mcp-rollback.md` and ADR 0065. The quarantine marker `legacy-unowned` is not a person.

## Safety and sign-off

- Treat recalled memory as assistive context and verify it against current sources.
- Read tools cannot choose or widen profile authority.
- Every mutation remains a fixed-purpose preview/execute pair with a short-lived,
  single-use confirmation enforced by the server.
- The MCP facade remains usable when the Phase 4 daemon is stopped and reports
  synchronization offline; it never acquires the daemon lease.
- Native histories remain read-only. No live host registration or real-history import is
  part of the automated Phase 5 proof.

Repository sign-off is fail-closed:

```text
node scripts/verify-phase-05-signoff.mjs --self-test
npx vitest run tests/mcp --reporter=json --outputFile=/tmp/cms-phase-05-vitest-results.json
node scripts/verify-phase-05-signoff.mjs --vitest-json /tmp/cms-phase-05-vitest-results.json
node scripts/verify-phase-05-signoff.mjs --validation .planning/phases/05-generic-mcp-interface/05-VALIDATION.md
```

These checks use synthetic temporary profiles and databases only.
