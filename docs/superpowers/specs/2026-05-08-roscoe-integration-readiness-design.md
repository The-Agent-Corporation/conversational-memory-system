# Roscoe Integration Readiness Design

## Purpose

The standalone memory system now has the accordion loop needed by Roscoe-Hermes: ingest, compact, inject, sleep review, proposal review, trace-aware retrieval, and verbatim resume. This phase makes that loop operationally easy to attach to Roscoe without changing the memory system into a Roscoe extension.

## Current Baseline

Roscoe already has:

- `gateway/conversational_memory.py` for optional unified timeline row emission
- `gateway/conversational_memory_context.py` for optional context injection
- `tools/conversational_memory_tool.py` for summary/injection resume
- a live-loop test pointing at this repository

The memory system already has:

- Hermes command scripts
- a smoke harness that proves ingest, compaction, inject, and resume share one SQLite store
- environment generation for core Roscoe commands

Missing:

- Roscoe-ready environment output as a first-class command
- integration documentation with concrete env vars and failure modes
- smoke coverage for sleep/proposals and trace resume
- clear note that Roscoe's resume tool should grow trace/box arguments next

## Design

Add a `hermes:roscoe-env` command that prints either shell exports or JSON for Roscoe.

Inputs:

- `--db <path>`
- `--project-root <path>`
- `--format shell|json`

Outputs:

- all existing Roscoe memory bridge env vars
- timeout defaults
- `HERMES_CONVERSATIONAL_MEMORY_MAX_TOKENS`
- command strings for ingest, inject, resume, sleep, proposals list/approve/reject

Extend the smoke harness to run:

- ingest and compaction
- inject
- resume from injection packet
- sleep review
- proposal listing

The smoke harness should remain deterministic and offline. It should not require OpenRouter credentials.

Add integration docs at `docs/integrations/roscoe-hermes.md` covering:

- prerequisites
- env setup
- smoke verification
- normal runtime flow
- sleep/proposal workflow
- resume workflow
- failure modes
- known Roscoe follow-up for trace/box resume tool arguments

## Out of Scope

This phase does not edit Roscoe-Hermes. Its worktree currently has unrelated local changes, and the existing bridge hooks are already present. The next Roscoe-side slice should update `tools/conversational_memory_tool.py` to expose `trace_id`, `box_id`, `max_turn_ranges`, and `include_child_boxes`.

## Self-Review

- Placeholder scan: no incomplete requirements remain.
- Scope check: this phase is operational readiness in the standalone memory repo.
- Compatibility: existing smoke harness and env fields remain supported.
