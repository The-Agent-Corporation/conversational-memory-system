# Trace and Box Resume Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend resume so hosts can expand approved traces and bounded boxes into verbatim source turns.

**Architecture:** Add trace and box expansion methods to `ConversationResumer`, extend `ResumeResult` provenance fields, then widen `hermes:resume` input parsing to support `trace_id` and `box_id`.

**Tech Stack:** TypeScript, Zod, Vitest, existing `MemoryStore`, existing SQLite-backed Hermes command pattern.

---

## Scope

This plan implements:

- trace resume
- bounded box resume
- child box expansion only when explicitly requested
- expanded provenance fields in resume results
- Hermes command request support
- ADR documentation

This plan does not implement:

- LLM summarization of resumed turns
- automatic child expansion
- UI/dashboard resume controls

## File Structure

- Modify `src/resume/conversation-resumer.ts`: add trace/box resume methods and richer provenance.
- Modify `src/integrations/hermes/resume-command.ts`: add request forms for `trace_id` and `box_id`.
- Modify `tests/resume/conversation-resumer.test.ts`: unit coverage for trace and box expansion.
- Modify `tests/integrations/hermes-resume-command.test.ts`: command coverage for trace and box expansion.
- Create `docs/adr/0037-trace-box-resume-expansion.md`: record resume expansion semantics.

## Task 1: Extend ResumeResult Provenance

**Files:**
- Modify: `src/resume/conversation-resumer.ts`
- Modify: `tests/resume/conversation-resumer.test.ts`
- Modify: `tests/integrations/hermes-resume-command.test.ts`

- [ ] Add `sourceTraceIds` and `sourceBoxIds` to `ResumeResult`.
- [ ] Update `expand` to accept an object with summary ids, trace ids, box ids, ranges, disclosure subject, and cap metadata.
- [ ] Preserve existing summary and injection behavior with empty trace/box arrays.
- [ ] Run `npm test -- tests/resume/conversation-resumer.test.ts tests/integrations/hermes-resume-command.test.ts`.
- [ ] Commit with `git commit -m "Extend resume provenance fields"`.

## Task 2: Add Trace Resume

**Files:**
- Modify: `src/resume/conversation-resumer.ts`
- Modify: `tests/resume/conversation-resumer.test.ts`

- [ ] Add `resumeTrace(traceId: string)`.
- [ ] Use `store.getTrace(traceId)` and throw `Trace ${traceId} was not found.` when missing.
- [ ] Expand `trace.turnRanges`.
- [ ] Return `trace.summaryIds`, `[trace.id]`, `trace.boxIds`, and deduped ranges.
- [ ] Add tests for successful trace expansion and missing trace.
- [ ] Run `npm test -- tests/resume/conversation-resumer.test.ts`.
- [ ] Commit with `git commit -m "Add trace resume expansion"`.

## Task 3: Add Bounded Box Resume

**Files:**
- Modify: `src/resume/conversation-resumer.ts`
- Modify: `tests/resume/conversation-resumer.test.ts`

- [ ] Add `BoxResumeOptions` with `maxTurnRanges?: number` and `includeChildBoxes?: boolean`.
- [ ] Add `resumeBox(boxId: string, options?: BoxResumeOptions)`.
- [ ] Use `store.getBox(boxId)` and throw `Box ${boxId} was not found.` when missing.
- [ ] Expand only the box's own ranges by default.
- [ ] Include child box ranges only when `includeChildBoxes` is true.
- [ ] Cap ranges at `maxTurnRanges`, default `5`.
- [ ] Include capped disclosure text when ranges are truncated.
- [ ] Add tests for own ranges, default child exclusion, explicit child inclusion, cap disclosure, and missing box.
- [ ] Run `npm test -- tests/resume/conversation-resumer.test.ts`.
- [ ] Commit with `git commit -m "Add bounded box resume expansion"`.

## Task 4: Extend Hermes Resume Command

**Files:**
- Modify: `src/integrations/hermes/resume-command.ts`
- Modify: `tests/integrations/hermes-resume-command.test.ts`

- [ ] Extend request schema to accept exactly one of `summary_id`, `trace_id`, `box_id`, or `injection_packet`.
- [ ] Add optional `max_turn_ranges` and `include_child_boxes` only for `box_id` requests.
- [ ] Route trace requests to `resumeTrace`.
- [ ] Route box requests to `resumeBox`.
- [ ] Add integration tests for trace resume, box resume, and a rejected multi-target request.
- [ ] Run `npm test -- tests/integrations/hermes-resume-command.test.ts`.
- [ ] Commit with `git commit -m "Extend Hermes resume command targets"`.

## Task 5: ADR and Full Verification

**Files:**
- Create: `docs/adr/0037-trace-box-resume-expansion.md`

- [ ] Write ADR 0037 documenting trace and bounded box resume expansion.
- [ ] Run `npm test -- --run`.
- [ ] Run `npm run typecheck`.
- [ ] Run `git diff --check`.
- [ ] Commit with `git commit -m "Document trace and box resume expansion"`.
- [ ] Push branch and create Forgejo PR titled `Add trace and box resume expansion`.

## Self-Review

- Spec coverage: trace, box, Hermes, tests, and ADR are covered.
- Placeholder scan: no deferred task details remain.
- Type consistency: `sourceTraceIds`, `sourceBoxIds`, and `BoxResumeOptions` are introduced before use.
