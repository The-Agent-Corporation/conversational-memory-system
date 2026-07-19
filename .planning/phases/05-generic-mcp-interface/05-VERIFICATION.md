---
phase: 05-generic-mcp-interface
verified: 2026-07-19T00:40:07Z
status: gaps_found
score: 10/11 must-haves verified
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "Proposal decisions authorize every payload and recursive dependency under the fixed profile and revalidate the exact affected state at execute, with zero writes on drift."
    status: failed
    reason: "ScopedProposalReviewer authorizes proposal.sourceSummaryIds and declared target objects, but approval constructs boxes/traces from payload dependency IDs that are not included in that authorization closure. The atomic proposal commit then revalidates only the proposal row, not dependency scopes or affected boxes/traces. A synthetic alpha-only profile successfully planned a trace containing the unauthorized summary-beta dependency."
    artifacts:
      - path: "src/proposals/scoped-proposal-reviewer.ts"
        issue: "Box/trace payload summary IDs and trace payload box IDs are copied into durable objects without complete profile authorization; authorization occurs only at preview."
      - path: "src/storage/mcp-mutation-contracts.ts"
        issue: "CommitProposalDecisionInput has no expected dependency or expected affected-object state to bind preview to execute."
      - path: "src/storage/sqlite-store.ts"
        issue: "commitProposalDecision re-reads only expectedProposal before writing next boxes/traces/proposal."
      - path: "src/storage/in-memory-store.ts"
        issue: "The in-memory parity implementation likewise revalidates only expectedProposal."
      - path: "tests/mcp/mutation-tools.test.ts"
        issue: "Tests cover matching proposal/payload dependencies and grant/import drift, but not payload-only unauthorized dependencies or proposal dependency/target drift."
    missing:
      - "Authorize the complete payload-derived summary/box/trace dependency closure before preview and again inside execute revalidation."
      - "Bind expected dependency and affected box/trace state into CommitProposalDecisionInput and reject any drift with STATE_CHANGED and zero writes in both adapters."
      - "Add synthetic adversarial tests for proposal-vs-payload dependency mismatch and post-preview dependency/target drift across in-memory and SQLite adapters."
---

# Phase 5: Generic MCP Interface Verification Report

**Phase Goal:** Let any supported local agent use the same personal memory safely.
**Verified:** 2026-07-19T00:40:07Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

The host-neutral STDIO server and almost all safety boundaries are substantive, wired, and behaviorally tested. The goal is not yet achieved because a confirmed proposal approval can persist a derived object containing a dependency outside the startup-fixed profile scopes. This is a must-have isolation failure, not a documentation or Git-metadata issue.

### Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | One local STDIO facade is spawned for an explicit profile and uses the official MCP SDK. | ✓ VERIFIED | `server-command.ts` resolves profile before `StdioServerTransport`; real child-process initialize/list/call/EOF tests pass. |
| 2 | Profile startup fixes database, person, complete scopes, ingest scope, roots, and aliases; missing/unknown authority fails closed and tools cannot alter it. | ✓ VERIFIED | `profile-loader.ts`, `authority.ts`, strict schemas, and profile/tool-catalog tests. |
| 3 | Search, recall, review, expansion, status, and proposal listing are semantically read-only and remain usable while the daemon is stopped. | ✓ VERIFIED | Long-lived `SqliteStore(..., {readOnly:true})`; semantic snapshots remain byte-equivalent; offline status tests pass. |
| 4 | Search/recall/review return bounded assistive context with confidence, timestamps, provenance, scopes, disclosure, and continuation/budget facts. | ✓ VERIFIED | `MemoryQueryService`, shared response envelope, read-tool schemas, and 12 read-tool tests. |
| 5 | Whole-subject expansion is profile-authorized, source-linked, budget-bounded, deterministically ordered, and resumes through authenticated continuation without gaps or duplicates. | ✓ VERIFIED | `SubjectExpansionService`, HMAC cursor codec, and 9 expansion tests. |
| 6 | The complete required capability catalog is explicit and host-neutral, with six read tools and five separate preview/execute mutation pairs. | ✓ VERIFIED | `tool-catalog.ts`; exact 16-name SDK `tools/list` assertions. |
| 7 | Tool schemas are bounded and authority-free, and safety annotations accurately distinguish pure reads, ticket previews, additive ingest, and destructive decisions/lifecycle operations. | ✓ VERIFIED | `read-tools.ts`, `mutation-tools.ts`, and catalog assertions. |
| 8 | Every mutation requires a short-lived exact single-use server confirmation bound to profile, tool, targets, normalized parameters, effects, and expiry; failures consume it. | ✓ VERIFIED | `ConfirmationService`; 10 binding/expiry/replay/consume-before-write tests. |
| 9 | Configured-alias history ingest uses existing read-only importers and atomically revalidates source, checkpoint, grant, parameters, event set, and effects; drift writes nothing. | ✓ VERIFIED | Import planner/application, task-specific store commit, grant/event drift tests, and adapter rollback proof. |
| 10 | Proposal decisions authorize all dependencies and revalidate exact affected state at execute with zero writes on drift. | ✗ FAILED | Payload-only dependency bypass reproduced synthetically; proposal commit revalidates only the proposal row. |
| 11 | Revocation and deletion remain separate confirmed operations; deletion requires exact prior revocation and atomically preserves audit/native-source semantics. | ✓ VERIFIED | Separate tools/application methods, lifecycle service, deletion effect revalidation, and rollback tests. |

**Score:** 10/11 truths verified (0 present-but-behavior-unverified)

## Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src/mcp/profile-loader.ts`, `authority.ts` | Explicit immutable startup authority | ✓ VERIFIED | Strict versioned config, absolute paths, named profile, fixed person/scopes/roots/aliases. |
| `src/retrieval/memory-query-service.ts` | Pure scoped search/recall/review/status | ✓ VERIFIED | Substantive filtering, ranking, budgets, pagination, disclosure, and offline status. |
| `src/retrieval/subject-expansion-service.ts`, `src/mcp/continuation-cursor.ts` | Bounded source-linked subject expansion | ✓ VERIFIED | Complete dependency closure, whole-event packing, HMAC policy/authority binding. |
| `src/mcp/confirmation-service.ts` | Exact single-use confirmation | ✓ VERIFIED | Process-local hashed tickets, bounded TTL, consume-before-result, timing-safe digest compare. |
| `src/storage/mcp-mutation-contracts.ts` | Exact atomic mutation contracts | ⚠️ PARTIAL | Import/revoke/delete contracts are exact; proposal contract lacks dependency/affected-state expectations. |
| `src/storage/in-memory-store.ts`, `src/storage/sqlite-store.ts` | Adapter-parity atomic commits | ⚠️ PARTIAL | Rollback/fault behavior exists, but proposal execute revalidates only the proposal row. |
| `src/proposals/scoped-proposal-reviewer.ts` | Profile-authorized proposal list/decision planning | ✗ FAILED | Does not authorize payload-derived dependencies before constructing durable box/trace effects. |
| `src/mcp/tools/read-tools.ts`, `mutation-tools.ts` | Explicit bounded tool registrations | ✓ VERIFIED | Six reads and ten mutation tools, strict schemas, controlled envelopes/errors/annotations. |
| `src/mcp/server.ts`, `server-command.ts`, `tool-catalog.ts` | SDK application and clean STDIO command | ✓ VERIFIED | Startup-bound closure, read-only connection, short-lived atomic writers, SDK-owned stdout. |
| `scripts/verify-phase-05-signoff.mjs` | Fail-closed structural signoff | ✓ VERIFIED | Self-test, Vitest JSON, and validation-table modes all passed independently. |
| `docs/integrations/local-mcp-clients.md` | Host registration guidance | ✓ VERIFIED | Codex/OpenClaw explicit-profile examples and safety notes exist. |

## Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `server-command.ts` | `profile-loader.ts` | Required `--config` and `--profile` before transport | ✓ WIRED | Missing/unknown selection exits before protocol startup. |
| `server.ts` | `tool-catalog.ts` | SDK `McpServer` registration | ✓ WIRED | Complete catalog registered once with captured application services. |
| Read tools | Query/expansion/scoped proposal services | One strict service operation per handler | ✓ WIRED | SDK list/call tests and semantic snapshots pass. |
| Mutation tools | `MemoryMutationApplication` | One fixed preview/execute method per handler | ✓ WIRED | Exact routing tests pass. |
| Mutation application | Store commits | Four task-specific atomic methods | ⚠️ PARTIAL | Wiring exists; proposal exact-state revalidation is incomplete. |
| Scoped proposal reviewer | Payload dependencies | Authorization before effect construction | ✗ NOT WIRED | Payload summary/box dependencies are not added to the authorization closure. |

## Data-Flow Trace (Level 4)

| Artifact | Data | Source | Produces Real Data | Status |
|---|---|---|---|---|
| Read tools | Search/recall/review/status DTOs | Read-only SQLite through scoped services | Yes, synthetic database-backed | ✓ FLOWING |
| Subject expansion | Canonical events | Person-scoped canonical store plus authorized derived ranges | Yes | ✓ FLOWING |
| History ingest | Previewed events/checkpoint/grant/effects | Existing four source importers staged in memory, then atomic store commit | Yes | ✓ FLOWING |
| Proposal approval | Durable box/trace effects | Stored proposal payload | Yes, but authorization closure is incomplete | ✗ UNSAFE FLOW |
| Revocation/deletion | Exact lifecycle effects and audits | Source lifecycle service plus store-owned effect inspection | Yes | ✓ FLOWING |

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Complete MCP focused suite | `npx vitest run tests/mcp --reporter=verbose` | 7 files, 68 tests passed | ✓ PASS |
| Full workspace regression | `npm test` | 56 files, 380 tests passed | ✓ PASS |
| Type safety | `npm run typecheck` | Exit 0 | ✓ PASS |
| Diff hygiene | `git diff --check` | Exit 0 | ✓ PASS |
| Synthetic out-of-scope proposal payload | `npx tsx -e <synthetic fixture reproduction>` | Alpha-only authority returned a commit plan creating a trace with `summary-beta` | ✗ FAIL |

## Probe Execution

| Probe | Command | Result | Status |
|---|---|---|---|
| Signoff self-test | `node scripts/verify-phase-05-signoff.mjs --self-test` | `PHASE_05_SIGNOFF_OK` | ✓ PASS |
| Machine-readable MCP test result | Vitest JSON reporter followed by `--vitest-json` | 68 passed, zero failed/pending/todo | ✓ PASS |
| Structural phase validation | `--validation .planning/phases/05-generic-mcp-interface/05-VALIDATION.md` | Exactly five green requirement rows and approved frontmatter/signoff | ✓ PASS |

## Requirements Coverage

| Requirement | Source Plans | Status | Evidence |
|---|---|---|---|
| REQ-023 — Layered expansion | 05-01, 05-03, 05-06 | ✓ SATISFIED | Authorized whole-subject source-event expansion, explicit budgets, HMAC continuation, exact pagination tests. |
| REQ-025 — Assistive memory | 05-01, 05-02, 05-03, 05-06 | ✓ SATISFIED | Disclosure, confidence, timestamps, sources/provenance, scopes, budgets, and dual output are enforced and tested. |
| REQ-027 — MCP server | 05-01, 05-08 | ✓ SATISFIED | Local STDIO server uses official SDK and passes real child-process lifecycle tests. |
| REQ-028 — MCP capabilities | 05-01 through 05-08 | ✗ BLOCKED | All required tools exist, but proposal approval can persist an unauthorized payload dependency. |
| REQ-029 — Tool safety metadata/approval | 05-01, 05-04, 05-05, 05-07, 05-08 | ✓ SATISFIED | Accurate annotations and server-enforced exact confirmations are verified independently of host prompts. |

No Phase 5 requirement is orphaned from the plans. Phase 6 synchronization and Phase 7 onboarding do not specifically cover the proposal authorization/revalidation gap, so it is not deferred.

## Anti-Patterns and Disconfirmation Pass

| File | Pattern | Severity | Impact |
|---|---|---|---|
| `src/proposals/scoped-proposal-reviewer.ts` | Authorization checks declared proposal dependencies but writes payload dependencies | 🛑 BLOCKER | Fixed-profile scope can be bypassed by a mismatched stored proposal payload. |
| `src/storage/sqlite-store.ts`, `in-memory-store.ts` | Proposal transaction revalidates only proposal row | 🛑 BLOCKER | Dependency or affected-object drift can commit stale preview effects. |
| `tests/mcp/mutation-tools.test.ts` | Passing scoped-proposal test uses matching fields and only rejects a mixed proposal before a rejection path | ⚠️ WARNING | The green test name overstates approval-path dependency coverage. |

No unreferenced `TBD`, `FIXME`, or `XXX`, no remaining skipped/todo MCP tests, and no production placeholder implementation were found. The uncovered error path is a payload mismatch or dependency/target change between proposal preview and execute.

## Human Verification Required

None required to establish this verdict. The official SDK child-process lifecycle is automated with synthetic data. Optional real Codex/OpenClaw registration UX can be exercised after the blocker is fixed, without using personal histories.

## Gaps Summary

One grouped blocker prevents safe completion: proposal approval is not dependency-closed over the actual payload that becomes durable, and its execute transaction is not exact-state-bound beyond the proposal row. Fix the reviewer, proposal commit contract, both adapters, and adversarial tests before proceeding.

## Repository State Note

The worktree was substantially dirty before verification and remains so. Verification changed only this report. Intermittent inability to create `.git/index.lock` prevented some executor/metadata commits, but that environment limitation is separate from product correctness and does not cause this verdict.

---

_Verified: 2026-07-19T00:40:07Z_
_Verifier: the agent (gsd-verifier)_
