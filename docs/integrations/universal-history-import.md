# Universal Agent History Import

The local bootstrap supports Codex, Claude Code, OpenClaw, and Hermes. Every source uses a two-step flow: metadata-only discovery, followed by import with the exact candidate ID as explicit approval.

Native files and databases remain in their original locations and are opened read-only. Imported events are copied into the person-level canonical timeline with native session and event provenance.

Tool calls are stored as compact assistant events containing the tool name and a bounded, redacted invocation summary. Tool-result payloads and system prompts are excluded.

## Supported Sources

| Source | Default location | Imported canonical history | Excluded |
| --- | --- | --- | --- |
| Codex | `$CODEX_HOME` or `~/.codex` | `sessions/**/rollout-*.jsonl`, `archived_sessions/**/rollout-*.jsonl` | `history.jsonl`, tool results, event indexes, symlinks |
| Claude Code | `~/.claude` | `projects/**/*.jsonl`, including sidechains | root prompt index, progress/hooks, tool results, symlinks |
| OpenClaw | `~/.openclaw` | `agents/<agentId>/sessions/*.jsonl` | `sessions.json`, cron logs, nested sidecars, tool results, out-of-root overrides |
| Hermes | `~/.hermes/state.db` | `sessions`, user/assistant messages, and capability-detected tool calls | tool-result rows, reasoning columns, legacy JSONL duplicates |

## Source Lifecycle

Every successful import persists an exact person-owned source grant and audit event.

```bash
npm run memory:source:revoke -- --db <memory.sqlite> --person <person-id> --candidate <candidate-id>
npm run memory:source:delete -- --db <memory.sqlite> --person <person-id> --candidate <candidate-id> --confirm <candidate-id>
```

Revocation stops future authorized reads. Deletion is separately confirmed, removes attributable imported memory, supersedes dependent derived memory, and never modifies the native history source.

## Quarantine and Replay

Malformed or unsupported records are retained only as bounded, locally redacted quarantine entries. Recognized tool results and system/index records are excluded rather than quarantined.

```bash
npm run memory:quarantine -- list --db <memory.sqlite> --person <person-id> [--candidate <candidate-id>]
npm run memory:quarantine -- replay --db <memory.sqlite> --person <person-id> --candidate <candidate-id> --confirm <candidate-id>
```

Replay requires an active source grant. It resets only that source's import checkpoints; rerun the normal source import command to process the native history with the current parser.

## Claude Code

```bash
npm run memory:claude:discover -- --root ~/.claude

npm run memory:claude:import -- \
  --root ~/.claude \
  --db /path/to/personal-memory.sqlite \
  --person person_default \
  --scope workspace_example \
  --approve claude-code_<candidate-hash>
```

## OpenClaw

```bash
npm run memory:openclaw:discover -- --root ~/.openclaw

npm run memory:openclaw:import -- \
  --root ~/.openclaw \
  --db /path/to/personal-memory.sqlite \
  --person person_default \
  --scope workspace_example \
  --approve openclaw_<candidate-hash>
```

OpenClaw stores authoritative transcripts on the Gateway host. Run import there, or explicitly copy/export transcripts into a separately approved root. The importer does not follow `sessionFile` overrides outside the approved root.

## Hermes

The root may be the Hermes home directory or the exact `state.db` path:

```bash
npm run memory:hermes:discover -- --root ~/.hermes

npm run memory:hermes:import -- \
  --root ~/.hermes \
  --db /path/to/personal-memory.sqlite \
  --person person_default \
  --scope personal \
  --approve hermes_<candidate-hash>
```

Hermes discovery and import open the source database read-only. New message rows resume from a durable row-ID high-water mark.

## Codex

Codex retains its dedicated commands; see [Codex History Bootstrap](./codex-history.md).

## Contract the Unified Timeline

After any import, process all approved sources for the person as one continuous historical conversation:

```bash
npm run memory:bootstrap -- \
  --db /path/to/personal-memory.sqlite \
  --person person_default

npm run memory:status -- \
  --db /path/to/personal-memory.sqlite \
  --person person_default
```

Bootstrap is incremental and idempotent. Native session boundaries remain source provenance; summaries, anchors, boxes, and traces operate across the unified chronology. Box and trace changes remain proposals until explicitly reviewed.

Each approved source has one scope, defaulting to `personal`. Use stable identifiers such as `workspace:<name>`, `client:<id>`, or `case:<id>` without putting sensitive names or document content into the scope itself. Repeated imports must pass the same scope. Strict retrieval requires a person ID plus an explicit scope allow-list.

## Safety Boundaries

- Approval covers only one canonical root or database path.
- Discovery does not parse message bodies.
- Imports redact common API-key, token, password, and private-key forms.
- Tool outputs and system prompts are excluded pending a dedicated sensitivity policy.
- Unknown record shapes are skipped and counted. Parser-version upgrades replay files deterministically.
- Revocation, source-derived deletion propagation, and inspectable quarantine are not implemented yet.
