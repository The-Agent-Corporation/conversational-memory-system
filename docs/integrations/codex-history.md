# Codex History Bootstrap

For the complete Codex, Claude Code, OpenClaw, and Hermes matrix, see [Universal Agent History Import](./universal-history-import.md).

Codex history bootstrap is a two-command local flow. Discovery reads filesystem metadata only. Import reads message content only after the exact discovered candidate ID is passed back as approval.

## Discover

Use the default `CODEX_HOME` or `~/.codex` root:

```bash
npm run memory:codex:discover
```

Or specify a root:

```bash
npm run memory:codex:discover -- --root /path/to/codex-home
```

The JSON manifest reports the resolved root, rollout count, estimated bytes, modified-time range, and a stable candidate ID. It does not open rollout message bodies.

## Approve and Import

After reviewing the manifest, pass its candidate ID explicitly:

```bash
npm run memory:codex:import -- \
  --root /path/to/codex-home \
  --db /path/to/personal-memory.sqlite \
  --person person_default \
  --scope workspace_example \
  --approve codex_<candidate-hash>
```

Import fails if the approved candidate ID does not match the resolved root. The importer persists the exact person/source/scope grant, reads canonical rollout JSONL files, redacts common secret forms, stores user/assistant messages plus bounded redacted tool-call invocations, and writes durable newline-safe checkpoints for later rescans.

`history.jsonl`, non-rollout files, symlinks, event indexes, system prompts, and tool-result payloads are not imported.

## Build Historical Memory

After import, process all approved Codex events together with any other canonical events already owned by the same person:

```bash
npm run memory:bootstrap -- \
  --db /path/to/personal-memory.sqlite \
  --person person_default
```

This creates one compatibility conversation across native sessions, detects anchors, contracts topic spans into provenance-linked summaries, and creates reviewable box and cross-session trace proposals. It does not approve those proposals. Re-running the command is a no-op until new events arrive; appended events resume from the durable topic checkpoint.

Inspect the local state without changing it:

```bash
npm run memory:status -- \
  --db /path/to/personal-memory.sqlite \
  --person person_default
```

## Current Boundaries

- Approval is durable and revocable; deletion requires separate exact-candidate confirmation.
- Tool names and bounded redacted invocation summaries are retained; tool-result payloads are excluded.
- Bootstrap remains a separate command from import; the future daemon will run both incrementally.
- Strict generic retrieval requires both the person and an explicit allowed-scope list.
- The background synchronization daemon is a later phase.
