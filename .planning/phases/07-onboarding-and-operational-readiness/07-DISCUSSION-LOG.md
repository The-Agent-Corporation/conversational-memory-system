# Phase 7: Onboarding and Operational Readiness - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-20
**Phase:** 7-onboarding-and-operational-readiness
**Areas discussed:** Audit/"why" surface (REQ-039), Install & entry surface, First-run consent/onboarding, Operational scope (backup/migration/performance)

---

## Audit / "Why" Surface (REQ-039)

| Option | Description | Selected |
|--------|-------------|----------|
| CLI `explain <id>` + MCP read tool | Human-readable per-item trace via CLI plus a read-only MCP tool | ✓ |
| CLI `explain` only | Human-facing CLI only, no MCP surface | |
| Structured audit-log query/export | Queryable/exportable append-only JSON audit log | ✓ |

**User's choice:** "one and three" — both the per-item explain (CLI + MCP) AND the structured audit log.
**Notes:** The two are complementary: explain answers "why this item"; the audit log serves bulk/forensic review.

---

## Install & Entry Surface

| Option | Description | Selected |
|--------|-------------|----------|
| Unified `bin` CLI wrapping existing commands | One `memory` executable with subcommands; npm scripts become aliases | ✓ |
| Keep npm scripts, document them | No new CLI, just polish/docs | |
| Guided `init` only, scripts stay | Add only a first-run init | |

**User's choice:** Unified `bin` CLI wrapping existing commands.
**Notes:** Wrap the existing command modules; do not reimplement logic.

---

## First-Run Consent / Onboarding

| Option | Description | Selected |
|--------|-------------|----------|
| Guided interactive `init` | discover → show findings → per-source consent → bootstrap → offer daemon start | ✓ |
| Minimal setup + docs | Non-interactive setup + written guide | |
| Docs only | Rely on docs and existing commands | |

**User's choice:** Guided interactive `init`.
**Notes:** Consent front-and-center; drives the existing per-source grant path.

---

## Operational Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Health/status inspection | Daemon state, DB size, last import, sync lag, pending proposals | ✓ |
| Backup / export | Back up / export the memory DB | ✓ |
| Schema migration path | Versioned SQLite schema migration | ✓ |
| Performance surfaces | Latency/DB-size/perf reporting or tuning | ✓ |

**User's choice:** All four in scope.

### Backup format (follow-up)
| Option | Description | Selected |
|--------|-------------|----------|
| Encrypted backup + explicit plaintext export | Encrypted by default; separate labeled `export --plaintext` | ✓ |
| Plaintext export only | Simple dump | |
| Encrypted backup only | No plaintext path | |

**User's choice:** Encrypted backup + explicit plaintext export.

### Performance (follow-up)
| Option | Description | Selected |
|--------|-------------|----------|
| Reporting only | Metrics, no tuning | |
| Reporting + tuning knobs | Metrics plus adjustable knobs | ✓ |
| Fold into health, defer standalone perf | Basic metrics only | |

**User's choice:** Reporting + tuning knobs.

---

## Claude's Discretion

- CLI framework/arg-parsing, subcommand naming, npm-script aliasing mechanics.
- Backup encryption scheme details (must reuse libsodium per ADR 0047; no external service).
- Audit-log storage location/format and explain-trace rendering format.

## Deferred Ideas

None — the owner deliberately kept all six surfaces in scope. If combined scope exceeds one phase's budget, the planner should SPLIT into sequenced sub-phases/waves rather than defer (this is the final roadmap phase).
