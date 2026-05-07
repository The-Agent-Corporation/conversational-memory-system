# OpenRouter Sleep Planners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional OpenRouter-backed box and trace proposal planning for sleep review while keeping deterministic planning as the default.

**Architecture:** Extract planner interfaces from existing deterministic planners, add an OpenRouter planner module that validates model JSON into existing proposal schemas, inject planners into `SleepReviewer`, and add `proposal_mode` selection in `hermes:sleep`.

**Tech Stack:** TypeScript, Zod, Vitest, existing OpenRouter fetch pattern, existing `MemoryProposal` schemas, existing SQLite command conventions.

---

## Scope

This plan implements:

- shared box/trace planner interfaces
- OpenRouter proposal planner
- typed OpenRouter planner errors
- sleep reviewer planner injection
- `hermes:sleep` planner mode selection for deterministic/openrouter/hybrid
- tests and ADR documentation

This plan does not implement:

- automatic proposal approval
- live OpenRouter network tests
- dashboard review
- entity/fact graph extraction

## File Structure

- Modify `src/boxes/box-proposal-planner.ts`: export `BoxProposalPlanner` interface.
- Modify `src/traces/trace-proposal-planner.ts`: export `TraceProposalPlanner` interface.
- Create `src/proposals/openrouter-proposal-planner.ts`: OpenRouter-backed planner and factory.
- Modify `src/sleep/sleep-reviewer.ts`: accept optional planner dependencies.
- Modify `src/integrations/hermes/sleep-command.ts`: planner mode parsing and planner factory injection.
- Create `tests/proposals/openrouter-proposal-planner.test.ts`: model output validation and errors.
- Modify `tests/sleep/sleep-reviewer.test.ts`: injected planner behavior.
- Modify `tests/integrations/hermes-sleep-command.test.ts`: proposal mode coverage.
- Create `docs/adr/0038-openrouter-sleep-planners.md`: decision record.

## Task 1: Extract Planner Interfaces

**Files:**
- Modify: `src/boxes/box-proposal-planner.ts`
- Modify: `src/traces/trace-proposal-planner.ts`

- [ ] Export `BoxProposalPlanner` with `proposeBoxes(request): Promise<BoxProposalPlanningResult>`.
- [ ] Make `DeterministicBoxProposalPlanner implements BoxProposalPlanner`.
- [ ] Export `TraceProposalPlanner` with `proposeTraces(request): Promise<TraceProposalPlanningResult>`.
- [ ] Make `DeterministicTraceProposalPlanner implements TraceProposalPlanner`.
- [ ] Run `npm test -- tests/boxes/box-proposal-planner.test.ts tests/traces/trace-proposal-planner.test.ts && npm run typecheck`.
- [ ] Commit with `git commit -m "Extract sleep proposal planner interfaces"`.

## Task 2: Add OpenRouter Proposal Planner

**Files:**
- Create: `src/proposals/openrouter-proposal-planner.ts`
- Create: `tests/proposals/openrouter-proposal-planner.test.ts`

- [ ] Add OpenRouter planner options: `apiKey`, `model`, `endpoint`, `referer`, `title`, `fetch`.
- [ ] Add `OpenRouterProposalPlannerError`.
- [ ] Add Zod schemas for model JSON output.
- [ ] Build request payload from summaries, boxes, proposals, and traces.
- [ ] Convert valid box JSON into `MemoryProposal` records using existing payload schemas.
- [ ] Convert valid parent/child JSON into `MemoryProposal` records.
- [ ] Convert valid trace JSON into `MemoryProposal` records.
- [ ] Validate referenced source summary ids and known/proposed box ids.
- [ ] Skip duplicate proposal ids using existing duplicate helpers.
- [ ] Add tests for valid box, parent/child, trace, unknown summary id, malformed JSON, and non-OK response.
- [ ] Run `npm test -- tests/proposals/openrouter-proposal-planner.test.ts && npm run typecheck`.
- [ ] Commit with `git commit -m "Add OpenRouter sleep proposal planner"`.

## Task 3: Inject Planners into SleepReviewer

**Files:**
- Modify: `src/sleep/sleep-reviewer.ts`
- Modify: `tests/sleep/sleep-reviewer.test.ts`

- [ ] Add constructor options `{ boxPlanner?: BoxProposalPlanner; tracePlanner?: TraceProposalPlanner }`.
- [ ] Use injected planners when present.
- [ ] Keep deterministic planners as defaults.
- [ ] Add tests proving injected planners are called and persisted.
- [ ] Run `npm test -- tests/sleep/sleep-reviewer.test.ts && npm run typecheck`.
- [ ] Commit with `git commit -m "Allow sleep reviewer planner injection"`.

## Task 4: Wire Hermes Sleep Proposal Modes

**Files:**
- Modify: `src/integrations/hermes/sleep-command.ts`
- Modify: `tests/integrations/hermes-sleep-command.test.ts`

- [ ] Extend `proposal_mode` to `"deterministic" | "openrouter" | "hybrid"`.
- [ ] Add injectable planner factory for tests.
- [ ] In deterministic mode, use default `SleepReviewer`.
- [ ] In openrouter mode, require OpenRouter config and use OpenRouter planners.
- [ ] In hybrid mode, use OpenRouter when configured, otherwise deterministic.
- [ ] Add tests for deterministic default, openrouter injected planner, and hybrid no-config fallback.
- [ ] Run `npm test -- tests/integrations/hermes-sleep-command.test.ts && npm run typecheck`.
- [ ] Commit with `git commit -m "Wire OpenRouter proposal mode into Hermes sleep"`.

## Task 5: ADR and Full Verification

**Files:**
- Create: `docs/adr/0038-openrouter-sleep-planners.md`

- [ ] Write ADR 0038 documenting optional OpenRouter sleep planners.
- [ ] Run `npm test -- --run`.
- [ ] Run `npm run typecheck`.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -m "Document OpenRouter sleep planners"`.
- [ ] Push branch and create Forgejo PR titled `Add OpenRouter sleep planners`.

## Self-Review

- Spec coverage: all design requirements map to tasks.
- Placeholder scan: no deferred implementation language remains.
- Type consistency: planner interfaces, OpenRouter planner, and Hermes mode names are introduced before use.
