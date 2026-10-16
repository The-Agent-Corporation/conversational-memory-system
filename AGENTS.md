# Conversational Memory System Agent Instructions

This repo is **conversational-memory-system**: a host-neutral personal memory layer for any agent host (Claude Code, Codex, OpenClaw, Hermes). Each host is a *source*; the durable object is the canonical event timeline, enriched with summarization, anchors, boxes, traces, sleep review, proposals, retrieval, injection, and resume flows. Hermes/Roscoe is the first live consumer, not the home.

These instructions apply to autonomous coding agents working in this repo. `CLAUDE.md` carries the same architecture map plus commands and code conventions; keep the two in sync when the layout changes.

## Product rule

Memory should make agents more continuous without making them reckless. Treat persisted memory as assistive context, not ground truth. Human-approved facts, source citations, explicit approvals, and current files beat recalled summaries.

Do not create behavior that silently injects sensitive or stale memory into unrelated workspaces. Case/client/legal data must stay isolated by workspace/thread boundaries.

## Current architecture map

Data flow: host history files → importers → canonical events → summaries/turns → anchors, boxes, traces, proposals → retrieval → injection packets.

Core:

- `src/domain/` — Zod schemas that define the contract. `canonical.ts` (Person, MemorySource, CanonicalEvent) is the spine; `types.ts` holds the derived objects (Turn, Summary, Anchor, Box, MemoryTrace, MemoryProposal, InjectionPacket); `source-lifecycle.ts` covers grants, revocation, quarantine.
- `src/storage/` — `memory-store.ts` is the single `MemoryStore` interface, implemented in full by both `sqlite-store.ts` (`node:sqlite` `DatabaseSync`) and `in-memory-store.ts`; interface changes must land in both. Multi-row writes go through named `commit*` methods whose contracts live in `mcp-mutation-contracts.ts`, `sync-contracts.ts`, and `daemon/types.ts`. `schema-migrations.ts` owns versioned DDL; `backup/` holds encrypted backup/restore/plaintext-export.
- `src/service/` — `memory-service.ts` orchestration seam (ingest, retrieval, sync emission), plus source-lifecycle service and derivation invalidation.

Ingest and derivation:

- `src/imports/` — discovery + importer pair per host (`claude-`, `codex-`, `openclaw-`, `hermes-`), through `secret-redactor.ts` and `quarantine-service.ts`; source revoke/delete commands.
- `src/bootstrap/` — guided `init`, resumable historical bootstrap, status.
- `src/compaction/` — pre-compaction summaries and budget-aware packing.
- `src/summarization/` — summarizer interface with OpenRouter/runtime selection.
- `src/anchors/`, `src/boxes/`, `src/traces/`, `src/proposals/`, `src/sleep/`, `src/topic/`, `src/resume/` — deterministic derivation subsystems, each with an optional OpenRouter-backed planner. The deterministic path must always work offline.
- `src/retrieval/` — memory retrieval, query service, subject expansion, source deduplication.
- `src/embeddings/` — `embedder-resolver.ts` chooses `DeterministicEmbedder` (hash, default) vs `transformer-embedder.ts` (ONNX, opt-in via the `${dbPath}.embeddings.json` sidecar); vector codec and model vendoring.

Surfaces:

- `src/cli/` — `command-registry.ts` is a closed static subcommand → dynamic-import allow-list behind `bin/memory`.
- `src/mcp/` — generic MCP server: closed catalog of 7 read + 10 mutation tools (`tool-catalog.ts` → `tools/`), with authority, confirmation, disclosure labels, response envelopes, continuation cursors.
- `src/daemon/` — continuous local runner: lease-based single writer, watch controller, contraction and proposal schedulers, macOS notification path; all checkpointed to resume rather than restart.
- `src/sync/` + `src/relay/` — zero-knowledge multi-device sync (ADR 0047). Relay stores opaque ciphertext only; keys stay client-side (`sync/crypto` libsodium, `sync/secrets` macOS Keychain).
- `src/operations/`, `src/audit/` — tune, embeddings enable/backfill, `explain`, and audit-log surfaces (REQ-039).
- `src/integrations/hermes/`, `src/adapters/` — Hermes CLI bridge and host adapter surface.

Supporting:

- `tests/` — Vitest coverage mirroring the subsystem layout (96 test files); most tests drive `InMemoryStore`.
- `docs/adr/` — architecture decision records, currently through ADR 0047.
- `docs/integrations/` — Roscoe/Hermes, Codex history, universal history import, local MCP clients.
- `.planning/` — GSD state, roadmap (v1.0 = Phases 1–7 complete; v1.1 Phases 8–14 in progress), REQ-### requirements, per-phase artifacts.
- `docs/superpowers/`, `tasks/`, `workflows/`, `queue.md`, `PROJECT.md` — legacy/project management notes.
- `example/` — vendored reference memory systems; not production code.

## Graphify repo map

This repo has a Graphify AST/code graph under `graphify-out/`.

Current graph summary from `graphify-out/GRAPH_REPORT.md`:

- Corpus: 1,292 files, about 1,465,973 words.
- Graph: 20,377 nodes, 29,085 edges, 2,449 communities.
- Built from commit: `7f9e2392` — **stale: ~250 commits behind `main`**, predating the CLI, MCP, daemon, sync, relay, and embeddings subsystems. Re-run `graphify update` before trusting it, or fall back to local file search.
- Cost: AST-only/no API tokens.
- `graph.html` is absent/skipped because the graph is too large.

Useful commands:

```bash
# Refresh graph after code changes. No API cost.
uv run --project /Users/aaronwhaley/Github/graphify-7 graphify update . --force

# Query existing graph.
uv run --project /Users/aaronwhaley/Github/graphify-7 graphify explain "<symbol-or-module>" --graph graphify-out/graph.json
```

Note: some `graph.json` node `source_file` values may still contain pre-move absolute paths from before this repo was moved into `Active Projects`. Treat the current repo root as authoritative and use `GRAPH_REPORT.md`, `manifest.json`, and local file search to resolve paths.

Graphify communities worth checking before edits:

- Community 0 — broad test fixtures and agent passage/listing test surface.
- Community 1 — message compaction, message serialization/deserialization, packed message content, LLM request adapter behavior.
- Community 2 — agent step/result creation, rule violation handling, approval/pending tool-call handling.
- Community 3 — SSE/streaming client behavior and Anthropic-style streaming interfaces.
- Community 4 — passage/file import, chunking, embeddings, and import processing.
- Community 5 and 6 — graph memory primitives from example/reference systems: entity/episodic/community nodes and edges, duplicate filters/resolutions.
- Community 10 — logger, packed-message parsing, JSON wrapping, inner-thought tool-call helpers.
- Community 11 — pre-compaction: `PreCompactionResult`, `PreCompactor`, summary/span IDs, embedder/store/summarizer interplay.
- Community 14 — anchor detection and box review.
- Community 15 — entity node deduplication/candidate indexing.
- Community 16 — tool-rule handling: terminal/continue/requires-approval tool checks and rule prompt compilation.
- Community 17 — tool manager and tool registration/upsert/detach behavior.
- Community 18 — agent system message derivation and in-context message initialization.
- Community 21 — sandbox configuration and environment variable handling.
- Community 22 — provider/model syncing and provider initialization tests.
- Community 24 — provider client surfaces including Baseten/OpenAI-compatible endpoints.

Because this graph includes `example/` reference systems, always confirm whether a Graphify hit is in `src/` or `example/` before changing production code.

## Development commands

Use npm scripts from `package.json`:

```bash
npm test
npm run typecheck
npm run hermes:smoke
npm run test:golden   # embedder golden tests; needs vendored model fixtures
```

There is no build step: `bin/memory` runs the TypeScript entry point through `tsx`, and every npm script is a thin `tsx src/**/*-command.ts` wrapper around the same module the `memory` CLI dispatches to. Node 22+ required (`node:sqlite`).

Operator CLI (`memory <cmd>`, or the matching `npm run memory:*` script):

```bash
memory init | status | discover | import | bootstrap | daemon | mcp
memory explain | audit-log | tune | embeddings | backfill-embeddings
memory backup | restore | export
memory quarantine | source:revoke | source:delete
```

Hermes integration commands:

```bash
npm run hermes:ingest
npm run hermes:inject
npm run hermes:resume
npm run hermes:sleep
npm run hermes:proposals:list
npm run hermes:proposals:approve
npm run hermes:proposals:reject
npm run hermes:roscoe-env
```

For targeted changes, run the nearest Vitest file, for example:

```bash
npx vitest run tests/retrieval/memory-retriever.test.ts
npx vitest run tests/integrations/hermes-inject-command.test.ts
npx vitest run tests/compaction/pre-compactor.test.ts
```

## Hard constraints

1. Keep person/scope isolation strict. Retrieval and vector queries take an explicit `personId` + `allowedScopeIds`; unscoped retrieval only via the explicit `allowLegacyUnscopedRetrieval` opt-in. Do not leak memory across users, cases, clients, or operational workspaces.
2. Memory summaries and retrieved context are not authoritative. Preserve source IDs, trace IDs, timestamps, confidence, and provenance where the system already tracks them.
3. Human approval gates matter. Do not auto-approve proposals, box changes, sleep-review conclusions, or injected memory that should require review.
4. Do not store raw secrets, API keys, tokens, passwords, private keys, or client documents in memory artifacts. Redact as `[REDACTED]`.
5. Do not make OpenRouter or any external LLM call mandatory for deterministic/local tests. External summarizer/planner behavior should remain adapter-gated and mockable.
6. Keep budget packing deterministic and testable. When modifying injection, resume, or compaction behavior, include tests for limits, ordering, and fallback/stub behavior.
7. Preserve unrelated dirty work. Run `git status --short` before editing and do not clean or revert files outside the task.
8. Treat `example/` as reference/vendor-style material unless the task explicitly targets it.
9. Changes to the `MemoryStore` interface must land in both `sqlite-store.ts` and `in-memory-store.ts`. Multi-row writes go through a named `commit*` method, not ad-hoc statements.
10. The sync relay must never be able to read plaintext. Keys and materialization stay client-side; nothing decryptable belongs in `src/relay/`.
11. Local imports use the `.js` extension (ESM `NodeNext`), e.g. `./memory-store.js`.

## Integration cautions

- Hermes commands under `src/integrations/hermes/` are the active bridge. Changes here can affect live agent memory behavior.
- Roscoe integration should follow `docs/integrations/roscoe-hermes.md` and ADR 0039.
- Sleep/proposal flows should be reviewable and reversible. Prefer explicit status transitions over silent mutation.
- Retrieval changes should be measured against source deduplication, trace-aware retrieval, revival/decay, and injection budget behavior.

## Required agent behavior

Before editing:

```bash
git status --short
git branch --show-current
```

During work:

- Read the relevant ADR(s) before touching a subsystem.
- Use Graphify to find connected modules/tests when the path is not obvious.
- Keep diffs small and scoped.
- Add/update tests next to the behavior changed.

Before finishing:

```bash
git diff --check
npm test          # or the narrowest relevant Vitest run if full suite is too much
npm run typecheck # when TypeScript surfaces changed
```

Report:

- files changed,
- tests/checks run,
- ADRs/Graphify communities used if relevant,
- privacy/workspace-isolation concerns checked,
- remaining blockers or decisions,
- whether the worktree was dirty before and after.

## Cursor Cloud specific instructions

- Use Node.js 22.23 or newer. `node:sqlite` in Node 22.14 (SQLite 3.47.2) ignores `DatabaseSync`'s `timeout` and its planner does not report `COVERING INDEX` for `idx_summaries_state_id`, so `tests/operations/tune-command.test.ts` and `tests/storage/schema-migrations.test.ts` fail. The image's `/exec-daemon/node` is 22.14.0 and comes before `/usr/local/bin` on `PATH`. This environment shadows it with `node`, `npm`, and `npx` symlinks in `/usr/local/cargo/bin` (earlier on `PATH`) pointing at `~/.nvm/versions/node/v22.23.3`.
- There is no dev server and no build step. `npm ci` installs dependencies. Check the product with `npm test`, `npm run typecheck`, and `./bin/memory status --db <path> --person <id>`. Opening a database path creates the SQLite file.
- `npm run test:golden` needs vendored ONNX fixtures in `tests/fixtures/models/` (gitignored). Without them those tests skip.
- `tests/daemon/macos-adapters.test.ts` assumes Darwin for launchd, `osascript`, and `pmset` (`process.platform === "darwin"`). On Linux only the `/bin/zsh -n` syntax check can pass; the capability tests stay red. `zsh` is installed so that syntax check runs.
- `example/` is vendored reference code. Do not install or run those stacks for this repo.
