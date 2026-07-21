---
phase: 09-embedding-model-embedder
plan: 02
status: complete
completed: 2026-07-21
tasks_completed: 2
tasks_total: 2
key-files:
  created: []
  modified:
    - package.json
    - package-lock.json
provenance:
  transformers: "4.2.0"
  onnxruntime_node_resolved: "1.24.3"
---

# Plan 09-02 Summary — Audited dependency install

## What was built

- `@huggingface/transformers` installed and pinned **exactly** to `4.2.0` in `package.json` (npm's default `^4.2.0` range corrected to exact).
- `onnxruntime-node` arrives transitively only (verified absent from direct dependencies). **Resolved version: `1.24.3`** — note this differs from RESEARCH.md's assumed `1.27.0`; `1.24.3` is what `@huggingface/transformers@4.2.0` pins. Recorded here for the plan 09-03 provenance string and Phase 14 stale-model detection.
- `require.resolve('@huggingface/transformers')` succeeds; `npm run typecheck` exits 0.

## Checkpoint record

- **Task 1 (blocking human-verify, package legitimacy):** presented to the operator by the orchestrator on 2026-07-21 with the official npm page verification steps; operator responded **"Approved"**. Install was authorized before any `npm install` ran. Not auto-advanced.

## Issues encountered

- `npm audit` reports **adm-zip <0.6.0 (high, GHSA-xcpc-8h2w-3j85)** via `onnxruntime-node → adm-zip` — an install-time native-binding tooling dependency. Accepted per threat **T-09-08** (developer/CI install-time network+unzip is expected for native packages; distinct from REQ-040's runtime-network prohibition; the runtime never processes untrusted ZIPs). The npm-suggested "fix" would force-downgrade transformers to 3.8.1 and was rejected.
- Pre-existing moderate advisories (`@hono/node-server` via `@modelcontextprotocol/sdk`) are unrelated to this plan.

## Deviations

- Executed inline by the orchestrator (sequential main-tree plan; checkpoint answered directly by the operator) rather than via a spawned executor — task semantics and acceptance criteria unchanged.
