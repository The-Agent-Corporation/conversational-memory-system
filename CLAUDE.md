# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` in this repo holds the longer-form agent contract (product rule, hard constraints, Graphify usage, reporting format). Read it before non-trivial work — but note its architecture map predates the CLI/daemon/MCP/sync/embeddings subsystems and stops at ADR 0039; the map below is current.

## Commands

```bash
npm test                     # vitest run (129 test files)
npm run typecheck            # tsc --noEmit
npx vitest run tests/retrieval/memory-retriever.test.ts   # single file
npx vitest run -t "packs within budget"                   # single test by name
npm run test:golden          # embedder golden tests; needs vendored model fixtures
npm run hermes:smoke         # end-to-end Hermes harness
```

There is **no build step**. `bin/memory` is a plain-JS shim that runs the TypeScript entry point through `tsx`; everything ships as source. `npm run <script>` entries in `package.json` are thin `tsx src/**/…-command.ts` wrappers around the same modules the `memory` CLI dispatches to.

Requires Node 22+ — `SqliteStore` uses the built-in `node:sqlite` `DatabaseSync` via `createRequire`, not a native addon.

## Architecture

A host-neutral personal memory layer. Any agent host (Claude Code, Codex, OpenClaw, Hermes) or journal (Cordis) is a *source*; the durable object is the canonical timeline plus derivations over it.

**Data flow:** host history files → importers → canonical events → summaries/turns → anchors, boxes, traces, proposals → retrieval → injection packets.

- `src/domain/` — Zod schemas that define the contract. `canonical.ts` (Person, MemorySource, CanonicalEvent) is the spine: every event carries `personId`, `sourceId`, `scopeId?`, native session/event IDs, `provenance`, `trustLevel`, `contentHash`, `parserVersion`. `types.ts` has the derived objects (Turn, Summary, Anchor, Box, MemoryTrace, MemoryProposal, InjectionPacket).
- `src/storage/` — `memory-store.ts` is the single large `MemoryStore` interface; `sqlite-store.ts` and `in-memory-store.ts` both implement it in full, so **any interface change means editing both**. Multi-row writes go through named `commit*` methods (`commitHistoryImport`, `commitImportBatch`, `commitContractionSlice`, `commitSourceDeletion`, `commitEventDeletion`, `commitLocalSyncOperation`, …) whose input/receipt shapes live in `mcp-mutation-contracts.ts`, `sync-contracts.ts`, and `daemon/types.ts` — never scatter ad-hoc writes. `schema-migrations.ts` owns versioned DDL.
- `src/imports/` — one discovery + importer pair per host (`claude-`, `codex-`, `openclaw-`, `hermes-`, `cordis-`), all funnelling through `secret-redactor.ts` and `quarantine-service.ts` (bounded parser failures are quarantined and replayable, per ADR 0045). Single canonical events can be deleted with `memory event:delete`; a tombstone stops append-only sources such as Cordis from re-importing them (ADR 0058).
- `src/service/memory-service.ts` — orchestration seam: ingest host events, run retrieval, emit sync operations. Holds the effective `personId` / `scopeId` / `syncDeviceId`.
- `src/retrieval/`, `src/compaction/`, `src/sleep/`, `src/boxes/`, `src/anchors/`, `src/traces/`, `src/proposals/`, `src/topic/` — the derivation subsystems. Each has a deterministic core plus an optional OpenRouter-backed planner/summarizer selected at runtime (`src/summarization/summarizer.ts`); the deterministic path must always work with no network.
- `src/openrouter/` — the shared OpenRouter client, spend ledger, and semantic-mode config (ADR 0055/0056). Config lives in a sidecar `${dbPath}.semantic.json`, `enabled:false` by default. When enabled, completed spans are summarized with `summaryModel` (default `anthropic/claude-haiku-5.5`, ADR 0059), `chatModel` drives only the box proposal planner, `semantic-topic-monitor.ts` splits topics by embedding cosine similarity (`topicSimilarityThreshold`, default 0.72), and `dailySpendCapUsd` caps spend. A blank model keeps that stage deterministic.
- `src/embeddings/` — `embedder-resolver.ts` picks between `DeterministicEmbedder` (hash-based, the always-on default), `transformer-embedder.ts` (ONNX, opt-in), and `openrouter-embedder.ts` (`provider: "openrouter"`, opt-in). Config lives in a sidecar `${dbPath}.embeddings.json`, `enabled:false` by default — the hash embedder is a deliberate default, never a silent fallback.
- `src/mcp/` — the generic MCP surface: a closed catalog of 7 read + 12 mutation tools plus `memory_inject` (`tool-catalog.ts` → `tools/`), with `authority.ts`, `confirmation-service.ts`, `disclosure-labels.ts`, and `response-envelope.ts` enforcing what an agent may see and change. `memory_inject` writes an injection packet, so a profile must opt in with `allowInjection` (ADR 0057).
- `src/sync/` + `src/relay/` — zero-knowledge multi-device sync (ADR 0047). The relay stores only opaque ciphertext; `sync/crypto/` (libsodium) and `sync/secrets/` (macOS Keychain) hold keys client-side. Do not add anything relay-side that can read plaintext.
- `src/daemon/` — long-running local runner: lease-based single-writer (`acquireDaemonLease`), watch controller, contraction and proposal schedulers, all checkpointed so restarts resume rather than restart.
- `src/cli/command-registry.ts` — closed static allow-list mapping subcommand → dynamic `import()`. Adding a `memory <cmd>` subcommand means adding an entry here plus a module exporting `main(argv)`.
- `src/integrations/hermes/` — the live agent bridge; changes here affect running agent memory behavior.
- `example/` — vendored reference memory systems. Not production code; confirm a search hit is under `src/` before editing.

`tests/` mirrors `src/` directory-for-directory. Most tests drive `InMemoryStore`; storage-level tests exercise `SqliteStore` against temp files.

## Conventions and constraints

- ESM with `NodeNext` resolution: **imports of local TS files use the `.js` extension** (`./memory-store.js`). Strict TypeScript.
- Zod schemas are the validation boundary — parse at the edge, pass typed values inward.
- Person/scope isolation is a hard invariant. Retrieval and vector queries take an explicit `personId` + `allowedScopeIds`; legacy unscoped retrieval only via the explicit `allowLegacyUnscopedRetrieval` opt-in.
- Determinism: clocks and IDs are injected (`clock`, `now` params) so behavior is reproducible; no external LLM call may be required for a test to pass.
- Proposals, box changes, and sleep-review conclusions move through explicit reviewed status transitions — never auto-approve or silently mutate.
- Redact secrets as `[REDACTED]`; never persist raw keys, tokens, or client documents.
- Each subsystem has an ADR under `docs/adr/` (0001–0059). Read the relevant one before changing a subsystem's behavior, and add a new ADR for a new decision.

## Planning workflow

GSD was retired on 2026-08-09 and its agent/skill symlinks were removed, so `/gsd:*` commands are no longer available. `.planning/` stays as the record: `.planning/ROADMAP.md` is the phase breakdown (v1.0 = Phases 1–7 complete; v1.1 "Vector-Native Traces + Semantic Recall" = Phases 8–14), `.planning/REQUIREMENTS.md` holds the REQ-### IDs referenced throughout code comments, and per-phase artifacts live in `.planning/phases/NN-*/`. `.planning/STATE.md` was last updated 2026-07-29 (Phase 12) and lags later work such as the Phase 14 bakeoff, so check `git log` and the newest ADRs for current state.

Env vars worth knowing: `MEMORY_DB` (database path, used everywhere), `MEMORY_SYNC_*` (device/relay), `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` / `OPENROUTER_BASE_URL` (optional planners/summarizer and semantic mode), `MEMORY_MODEL_PATH` (embedder fixtures).
