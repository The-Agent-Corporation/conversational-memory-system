# Roscoe-Hermes Integration

This repository stays standalone. Roscoe-Hermes talks to it through command-line contracts and a shared SQLite database.

## Prerequisites

- This repository is installed locally.
- `npm install` has been run in this repository.
- Roscoe-Hermes has the optional conversational memory bridge modules:
  - `gateway/conversational_memory.py`
  - `gateway/conversational_memory_context.py`
  - `tools/conversational_memory_tool.py`

## Generate Roscoe Environment

From this repository:

```bash
npm run hermes:roscoe-env -- --db /Users/aaronwhaley/.hermes/conversational-memory.sqlite
```

For JSON:

```bash
npm run hermes:roscoe-env -- --db /Users/aaronwhaley/.hermes/conversational-memory.sqlite --format json
```

The shell output can be sourced before starting Roscoe.

## Runtime Flow

Roscoe emits unified timeline rows to:

```bash
npm --silent --prefix /Users/aaronwhaley/Github/conversational-memory-system run hermes:ingest -- --db <memory.sqlite>
```

Before an agent turn, Roscoe asks for quiet recall through:

```bash
npm --silent --prefix /Users/aaronwhaley/Github/conversational-memory-system run hermes:inject -- --db <memory.sqlite>
```

When the agent needs verbatim history, Roscoe calls:

```bash
npm --silent --prefix /Users/aaronwhaley/Github/conversational-memory-system run hermes:resume -- --db <memory.sqlite>
```

Background organization uses:

```bash
npm --silent --prefix /Users/aaronwhaley/Github/conversational-memory-system run hermes:sleep -- --db <memory.sqlite>
```

Proposal review uses:

```bash
npm --silent --prefix /Users/aaronwhaley/Github/conversational-memory-system run hermes:proposals:list -- --db <memory.sqlite>
npm --silent --prefix /Users/aaronwhaley/Github/conversational-memory-system run hermes:proposals:approve -- --db <memory.sqlite>
npm --silent --prefix /Users/aaronwhaley/Github/conversational-memory-system run hermes:proposals:reject -- --db <memory.sqlite>
```

## Smoke Test

Run:

```bash
npm run hermes:smoke -- --db /tmp/roscoe-memory-smoke.sqlite
```

The smoke harness proves that one SQLite store supports ingest, compaction, injection, resume, sleep review, and proposal listing.

## OpenRouter Sleep Planning

Deterministic planning is the default. For richer sleep proposals:

```bash
export OPENROUTER_API_KEY=...
export OPENROUTER_MODEL=...
```

Then call `hermes:sleep` with:

```json
{ "proposal_mode": "hybrid" }
```

`hybrid` uses OpenRouter when configured and deterministic planning otherwise. `openrouter` requires OpenRouter configuration and fails clearly if missing.

## Failure Modes

- Missing DB path: commands fail with a database path error.
- Missing command env in Roscoe: Roscoe skips that memory surface.
- Empty recall: `hermes:inject` returns `packet: null` and no context block.
- No sleep changes: `hermes:sleep` returns `noopReason`.
- No proposals: `hermes:proposals:list` returns an empty proposal list.
- Missing OpenRouter config in `openrouter` mode: sleep review fails before persistence.
- Malformed model output: OpenRouter planners fail before persistence.

## Roscoe-Side Follow-Up

Roscoe's `conversational_memory_resume` tool currently supports `summary_id` and `injection_packet`. The memory command now also supports:

- `trace_id`
- `box_id`
- `max_turn_ranges`
- `include_child_boxes`

The next Roscoe-side slice should expose those fields in `tools/conversational_memory_tool.py` so an agent can explicitly expand a trace or bounded box from a recalled injection packet.
