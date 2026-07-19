# Conversational Memory System Agent Instructions

This repo is **conversational-memory-system**: a standalone/resumable conversation memory layer for Hermes/Roscoe-style agents. The durable object is the conversation thread, enriched with summarization, anchors, boxes, sleep review, proposals, retrieval, injection, and resume flows.

These instructions apply to autonomous coding agents working in this repo.

## Product rule

Memory should make agents more continuous without making them reckless. Treat persisted memory as assistive context, not ground truth. Human-approved facts, source citations, explicit approvals, and current files beat recalled summaries.

Do not create behavior that silently injects sensitive or stale memory into unrelated workspaces. Case/client/legal data must stay isolated by workspace/thread boundaries.

## Current architecture map

Primary directories:

- `src/domain/` — shared domain types and events.
- `src/service/` — memory service orchestration.
- `src/storage/` — storage adapters: SQLite, memory, in-memory.
- `src/summarization/` — summarizer interface and OpenRouter/runtime selection.
- `src/compaction/` — pre-compaction summaries and budget-aware packing.
- `src/anchors/` — deterministic anchor detection.
- `src/boxes/` — box assignment, review, and box proposal planning.
- `src/proposals/` — proposal utilities, reviewer, OpenRouter proposal planner.
- `src/retrieval/` — memory retrieval, trace-aware retrieval, source deduplication.
- `src/resume/` — conversation resume expansion.
- `src/sleep/` — sleep review and memory decay/revival workflows.
- `src/topic/` — topic monitor.
- `src/traces/` — trace proposal planner.
- `src/embeddings/` — embedder abstraction and embedding-backed retrieval.
- `src/integrations/hermes/` — Hermes CLI commands and adapter contract.
- `src/adapters/` — host adapter surface.
- `tests/` — Vitest coverage mirroring the subsystem layout.
- `docs/adr/` — architecture decision records, currently through ADR 0039.
- `docs/integrations/roscoe-hermes.md` — Roscoe/Hermes integration readiness notes.
- `docs/superpowers/` — plans/specs from the build process.
- `tasks/`, `workflows/`, `queue.md`, `PROJECT.md` — project management notes.

## Graphify repo map

This repo has a Graphify AST/code graph under `graphify-out/`.

Current graph summary from `graphify-out/GRAPH_REPORT.md`:

- Corpus: 1,292 files, about 1,465,973 words.
- Graph: 20,377 nodes, 29,085 edges, 2,449 communities.
- Built from commit: `7f9e2392`.
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

1. Keep workspace/thread isolation strict. Do not leak memory across users, cases, clients, or operational workspaces.
2. Memory summaries and retrieved context are not authoritative. Preserve source IDs, trace IDs, timestamps, confidence, and provenance where the system already tracks them.
3. Human approval gates matter. Do not auto-approve proposals, box changes, sleep-review conclusions, or injected memory that should require review.
4. Do not store raw secrets, API keys, tokens, passwords, private keys, or client documents in memory artifacts. Redact as `[REDACTED]`.
5. Do not make OpenRouter or any external LLM call mandatory for deterministic/local tests. External summarizer/planner behavior should remain adapter-gated and mockable.
6. Keep budget packing deterministic and testable. When modifying injection, resume, or compaction behavior, include tests for limits, ordering, and fallback/stub behavior.
7. Preserve unrelated dirty work. Run `git status --short` before editing and do not clean or revert files outside the task.
8. Treat `example/` as reference/vendor-style material unless the task explicitly targets it.

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
