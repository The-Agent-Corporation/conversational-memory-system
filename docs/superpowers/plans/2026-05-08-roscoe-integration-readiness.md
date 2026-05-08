# Roscoe Integration Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Roscoe-Hermes attachment operationally ready through env generation, documentation, and deterministic smoke coverage.

**Architecture:** Extend the existing Hermes smoke harness and environment builder, add a command wrapper that prints Roscoe-ready env, and document the runtime contract.

**Tech Stack:** TypeScript, Vitest, existing Hermes command scripts, SQLite.

---

## Scope

This plan implements:

- `hermes:roscoe-env`
- richer Roscoe environment output
- smoke harness coverage for sleep/proposals
- integration documentation
- ADR

This plan does not implement:

- Roscoe code changes
- production scheduler automation
- OpenRouter live calls

## File Structure

- Modify `src/integrations/hermes/smoke-harness.ts`
- Create `src/integrations/hermes/roscoe-env-command.ts`
- Modify `tests/integrations/hermes-smoke-harness.test.ts`
- Create `tests/integrations/hermes-roscoe-env-command.test.ts`
- Modify `package.json`
- Create `docs/integrations/roscoe-hermes.md`
- Create `docs/adr/0039-roscoe-integration-readiness.md`

## Tasks

- [ ] Extend `RoscoeMemoryEnvironment` with timeout/max-token defaults.
- [ ] Extend smoke harness to run sleep review and proposal list.
- [ ] Add `hermes:roscoe-env` command with shell and JSON formats.
- [ ] Document Roscoe-Hermes integration.
- [ ] Add ADR 0039.
- [ ] Run focused integration tests.
- [ ] Run full test suite, typecheck, and diff check.
- [ ] Push branch and create Forgejo PR.

## Self-Review

- Spec coverage: env generation, smoke coverage, docs, and ADR are covered.
- Placeholder scan: no deferred implementation language remains.
