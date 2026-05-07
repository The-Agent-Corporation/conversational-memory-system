# Trace-Aware Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make memory injection retrieve approved traces and bounded parent box context while preserving deterministic, auditable summary and anchor retrieval.

**Architecture:** Extend the injection packet schema with `sourceTraceIds`, then evolve `MemoryRetriever` into a structured candidate ranker that loads summaries, anchors, boxes, and approved traces. Trace candidates rank as primary memory; parent box context is appended only after a child-specific match and only within budget.

**Tech Stack:** TypeScript, Node.js, Zod, Vitest, existing `MemoryStore`, existing Hermes command scripts, deterministic keyword ranking.

---

## Scope

This plan implements:

- `sourceTraceIds` on injection packets
- approved trace retrieval candidates
- trace-specific relevance reasons
- linked summary strengthening when a trace is selected
- bounded parent box context
- tests for specificity, budget behavior, and ignored non-approved traces
- Hermes inject integration coverage
- ADR documentation

This plan does not implement:

- trace embeddings
- LLM retrieval judgment
- verbatim turn expansion
- memory dashboard
- automatic proposal approval
- cross-profile retrieval

## File Structure

- Modify `src/domain/types.ts`: add `sourceTraceIds` to `InjectionPacketSchema`.
- Modify `src/retrieval/memory-retriever.ts`: load traces and boxes, build trace candidates, add parent context, emit trace ids.
- Modify `tests/retrieval/memory-retriever.test.ts`: add trace and hierarchy retrieval tests.
- Modify `tests/integrations/hermes-inject-command.test.ts`: cover trace-aware command output and update packet expectations.
- Modify any test fixtures that construct injection packets: add `sourceTraceIds: []`.
- Create `docs/adr/0036-trace-aware-retrieval.md`: record deterministic trace/hierarchy retrieval decision.

## Task 1: Add Trace Provenance to Injection Packets

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `tests/**/*.test.ts` files that directly construct `InjectionPacket`

- [ ] **Step 1: Find direct injection packet fixtures**

Run:

```bash
rg "sourceSummaryIds|InjectionPacket" tests src -n
```

Expected: identify tests and command fixtures that construct or assert full injection packets.

- [ ] **Step 2: Write the failing schema expectation**

In the most focused injection packet schema test, or in an existing retrieval test if no schema-only test exists, add an assertion that retrieved packets include trace provenance:

```ts
expect(packet).toMatchObject({
  sourceTraceIds: []
});
```

If a test constructs an injection packet fixture directly, add:

```ts
sourceTraceIds: []
```

to the fixture after `sourceSummaryIds`.

- [ ] **Step 3: Run the focused tests**

Run:

```bash
npm test -- tests/retrieval/memory-retriever.test.ts
```

Expected: FAIL because `sourceTraceIds` is not emitted by the retriever or schema.

- [ ] **Step 4: Update the schema**

In `src/domain/types.ts`, add `sourceTraceIds` after `sourceSummaryIds`:

```ts
sourceTraceIds: z.array(z.string().min(1)),
```

- [ ] **Step 5: Emit empty trace ids from current retrieval**

In `src/retrieval/memory-retriever.ts`, add `traceId` to `RankedMemory`:

```ts
traceId: string | null;
```

Set `traceId: null` in `rankSummary` and `rankAnchor`.

In `prepareInjection`, add:

```ts
sourceTraceIds: selected
  .map((memory) => memory.traceId)
  .filter((traceId): traceId is string => traceId !== null),
```

after `sourceSummaryIds`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
npm test -- tests/retrieval/memory-retriever.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/retrieval/memory-retriever.ts tests
git commit -m "Add trace provenance to injection packets"
```

## Task 2: Retrieve Approved Trace Candidates

**Files:**
- Modify: `src/retrieval/memory-retriever.ts`
- Modify: `tests/retrieval/memory-retriever.test.ts`

- [ ] **Step 1: Add test builders**

In `tests/retrieval/memory-retriever.test.ts`, import `Box` and `MemoryTrace`:

```ts
import type { Anchor, Box, MemoryTrace, Summary } from "../../src/domain/types.js";
```

Add builders near the existing `makeSummary` and `makeAnchor` helpers:

```ts
const makeBox = (overrides: Partial<Box> = {}): Box => ({
  id: "box_smith_pip",
  title: "Smith PIP",
  description: "Smith no-fault benefits and provider bills.",
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: ["summary_1", "summary_provider_bill"],
  turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 12 }],
  state: "approved",
  createdAt: "2026-05-04T10:00:00.000Z",
  updatedAt: "2026-05-04T10:05:00.000Z",
  caseId: "case_smith",
  boxType: "topic",
  summary: "Smith PIP coverage and provider bill issues.",
  lastActivityAt: "2026-05-04T10:05:00.000Z",
  ...overrides
});

const makeTrace = (overrides: Partial<MemoryTrace> = {}): MemoryTrace => ({
  id: "trace_smith_pip_provider_bills",
  title: "Smith PIP Provider Bills",
  description: "Recurring Smith PIP provider bill dispute and no-fault payment timing.",
  traceType: "case_issue",
  state: "approved",
  summaryIds: ["summary_1", "summary_provider_bill"],
  boxIds: ["box_smith_pip"],
  turnRanges: [
    { threadId: "session_1", startSequence: 1, endSequence: 2 },
    { threadId: "session_1", startSequence: 10, endSequence: 12 }
  ],
  createdAt: "2026-05-04T10:05:00.000Z",
  updatedAt: "2026-05-04T10:05:00.000Z",
  lastActivityAt: "2026-05-04T10:05:00.000Z",
  confidence: 0.88,
  rationale: "The same provider bill issue recurred across separated turns.",
  ...overrides
});
```

- [ ] **Step 2: Write failing approved trace retrieval test**

Add this test:

```ts
it("retrieves approved traces with linked summary provenance", async () => {
  const store = new InMemoryStore();
  await store.saveSummary(makeSummary({
    id: "summary_provider_bill",
    summaryText: "Smith PIP provider bill review needs the ledger before demand finalization.",
    sourceTurnRanges: [{ threadId: "session_1", startSequence: 10, endSequence: 12 }],
    boxIds: ["box_smith_pip"],
    tokenCount: 12
  }));
  await store.saveTrace(makeTrace());

  const retriever = new MemoryRetriever(store);
  const packet = await retriever.prepareInjection({
    host: "roscoe-hermes",
    profileId: "default",
    hostSessionId: "session_1",
    currentTopicSummary: "Smith PIP provider bill ledger",
    requestedAt: "2026-05-04T10:10:00.000Z",
    maxMemoryTokens: 80
  });

  expect(packet?.sourceTraceIds).toEqual(["trace_smith_pip_provider_bills"]);
  expect(packet?.sourceSummaryIds).toContain("summary_provider_bill");
  expect(packet?.selectedMemory).toContain("[Trace: Smith PIP Provider Bills]");
  expect(packet?.relevanceReason).toContain("Top trace match trace_smith_pip_provider_bills");
});
```

- [ ] **Step 3: Write failing non-approved trace test**

Add this test:

```ts
it("ignores traces that are not approved", async () => {
  const store = new InMemoryStore();
  await store.saveSummary(makeSummary({
    id: "summary_provider_bill",
    summaryText: "Smith PIP provider bill review needs the ledger.",
    tokenCount: 8
  }));
  await store.saveTrace(makeTrace({ state: "proposed" }));
  await store.saveTrace(makeTrace({
    id: "trace_rejected_provider_bills",
    state: "rejected"
  }));

  const retriever = new MemoryRetriever(store);
  const packet = await retriever.prepareInjection({
    host: "roscoe-hermes",
    profileId: "default",
    hostSessionId: "session_1",
    currentTopicSummary: "Smith PIP provider bill ledger",
    requestedAt: "2026-05-04T10:10:00.000Z",
    maxMemoryTokens: 80
  });

  expect(packet?.sourceTraceIds).toEqual([]);
  expect(packet?.relevanceReason).toContain("Top summary match summary_provider_bill");
});
```

- [ ] **Step 4: Run failing trace tests**

Run:

```bash
npm test -- tests/retrieval/memory-retriever.test.ts -t "trace"
```

Expected: FAIL because traces are not loaded or ranked.

- [ ] **Step 5: Load approved traces**

In `prepareInjection`, change the store load to:

```ts
const [summaries, anchors, traces, boxes] = await Promise.all([
  this.store.listSummaries(),
  this.store.listAnchors(),
  this.store.listTraces({ state: "approved" }),
  this.store.listBoxes()
]);
```

Pass `traces` and `boxes` into ranking. The `boxes` parameter will be used in Task 3.

- [ ] **Step 6: Extend types and ranking**

In `src/retrieval/memory-retriever.ts`, import trace and box types:

```ts
import type { Anchor, Box, InjectionPacket, MemoryTrace, Summary, TurnRange } from "../domain/types.js";
```

Change `RankedMemory.kind` to:

```ts
kind: "summary" | "anchor" | "trace" | "box_context";
```

Add fields:

```ts
summaryIds: string[];
traceId: string | null;
```

Set `summaryIds: [summary.id]` and `traceId: null` for summaries. Set `summaryIds: []` and `traceId: null` for anchors.

Add `rankTrace`:

```ts
function rankTrace(topicWords: Set<string>, trace: MemoryTrace, linkedSummaries: Summary[]): RankedMemory | null {
  const traceText = [
    trace.title,
    trace.description,
    trace.rationale,
    ...linkedSummaries.map((summary) => summary.summaryText)
  ].join(" ");
  const overlap = overlappingWords(topicWords, significantWords(traceText));

  if (overlap.length < 2) {
    return null;
  }

  const linkedSummaryText = linkedSummaries
    .slice(0, 3)
    .map((summary) => `- ${summary.summaryText}`)
    .join("\n");
  const text = [
    `[Trace: ${trace.title}]`,
    trace.description,
    linkedSummaryText ? `Linked summaries:\n${linkedSummaryText}` : "",
    `Rationale: ${trace.rationale}`
  ].filter(Boolean).join("\n");

  return {
    kind: "trace",
    id: trace.id,
    text,
    score: scoreText(topicWords, traceText) * trace.confidence,
    tokenCount: estimateTokenCount(text),
    canUseStub: true,
    scoringMethod: "keyword overlap",
    summaryId: linkedSummaries[0]?.id ?? null,
    summaryIds: trace.summaryIds,
    traceId: trace.id,
    sourceTurnRanges: trace.turnRanges,
    boxIds: trace.boxIds
  };
}
```

Add helper:

```ts
function overlappingWords(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((word) => right.has(word));
}
```

Update `rankMemories` to accept traces, build a `Map<string, Summary>`, and include trace candidates:

```ts
const summariesById = new Map(summaries.map((summary) => [summary.id, summary]));
const traceCandidates = traces
  .map((trace) => rankTrace(
    topicWords,
    trace,
    trace.summaryIds.map((summaryId) => summariesById.get(summaryId)).filter((summary): summary is Summary => summary !== undefined)
  ))
  .filter((memory): memory is RankedMemory => memory !== null);
```

Then include `...traceCandidates` in the ranked array.

- [ ] **Step 7: Use all selected summary ids**

In `prepareInjection`, replace `sourceSummaryIds` construction with:

```ts
sourceSummaryIds: [...new Set(selected.flatMap((memory) => memory.summaryIds))],
```

In `recordSelectedSummaryAccess`, use `flatMap`:

```ts
const selectedSummaryIds = new Set(selected.flatMap((memory) => memory.summaryIds));
```

- [ ] **Step 8: Run focused tests**

Run:

```bash
npm test -- tests/retrieval/memory-retriever.test.ts -t "trace"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/retrieval/memory-retriever.ts tests/retrieval/memory-retriever.test.ts
git commit -m "Retrieve approved memory traces"
```

## Task 3: Add Bounded Parent Box Context

**Files:**
- Modify: `src/retrieval/memory-retriever.ts`
- Modify: `tests/retrieval/memory-retriever.test.ts`

- [ ] **Step 1: Write failing parent context test**

Add this test:

```ts
it("adds bounded parent box context for selected child memories", async () => {
  const store = new InMemoryStore();
  await store.saveBox(makeBox({
    id: "box_case_smith",
    title: "Smith Case",
    description: "Smith car accident matter.",
    childBoxIds: ["box_smith_pip"],
    summaryIds: ["summary_case_smith"],
    boxType: "case",
    summary: "Smith car accident case with PIP and BI coverage issues.",
    turnRanges: [{ threadId: "session_1", startSequence: 1, endSequence: 20 }]
  }));
  await store.saveBox(makeBox({
    id: "box_smith_pip",
    parentBoxId: "box_case_smith"
  }));
  await store.saveSummary(makeSummary({
    id: "summary_provider_bill",
    summaryText: "Smith PIP provider bill review needs the ledger before demand finalization.",
    boxIds: ["box_smith_pip"],
    tokenCount: 10
  }));

  const retriever = new MemoryRetriever(store);
  const packet = await retriever.prepareInjection({
    host: "roscoe-hermes",
    profileId: "default",
    hostSessionId: "session_1",
    currentTopicSummary: "Smith PIP provider bill ledger",
    requestedAt: "2026-05-04T10:10:00.000Z",
    maxMemoryTokens: 80
  });

  expect(packet?.selectedMemory).toContain("[Parent Box: Smith Case]");
  expect(packet?.selectedMemory).toContain("Smith car accident case");
  expect(packet?.boxIds).toEqual(["box_smith_pip", "box_case_smith"]);
  expect(packet?.disclosureText).toContain("parent box context");
});
```

- [ ] **Step 2: Write failing parent budget test**

Add this test:

```ts
it("omits parent box context when the explicit token budget is too small", async () => {
  const store = new InMemoryStore();
  await store.saveBox(makeBox({
    id: "box_case_smith",
    title: "Smith Case",
    childBoxIds: ["box_smith_pip"],
    summary: "Smith car accident case with PIP and BI coverage issues."
  }));
  await store.saveBox(makeBox({
    id: "box_smith_pip",
    parentBoxId: "box_case_smith"
  }));
  await store.saveSummary(makeSummary({
    id: "summary_provider_bill",
    summaryText: "Smith PIP provider bill ledger.",
    boxIds: ["box_smith_pip"],
    tokenCount: 5
  }));

  const retriever = new MemoryRetriever(store);
  const packet = await retriever.prepareInjection({
    host: "roscoe-hermes",
    profileId: "default",
    hostSessionId: "session_1",
    currentTopicSummary: "Smith PIP provider bill ledger",
    requestedAt: "2026-05-04T10:10:00.000Z",
    maxMemoryTokens: 6
  });

  expect(packet?.selectedMemory).not.toContain("[Parent Box: Smith Case]");
  expect(packet?.boxIds).toEqual(["box_smith_pip"]);
});
```

- [ ] **Step 3: Run failing parent tests**

Run:

```bash
npm test -- tests/retrieval/memory-retriever.test.ts -t "parent"
```

Expected: FAIL because parent context is not built or appended.

- [ ] **Step 4: Build parent context helper**

In `src/retrieval/memory-retriever.ts`, add:

```ts
function addParentBoxContext(
  selected: RankedMemory[],
  boxes: Box[],
  maxMemoryTokens?: number
): RankedMemory[] {
  const boxesById = new Map(boxes.map((box) => [box.id, box]));
  const selectedBoxIds = new Set(selected.flatMap((memory) => memory.boxIds));
  const usedTokens = selected.reduce((sum, memory) => sum + memory.tokenCount, 0);

  for (const boxId of selectedBoxIds) {
    const child = boxesById.get(boxId);
    if (!child?.parentBoxId) {
      continue;
    }

    const parent = boxesById.get(child.parentBoxId);
    if (!parent || !["active", "approved", "revived"].includes(parent.state)) {
      continue;
    }

    const text = `[Parent Box: ${parent.title}]\n${parent.summary}`;
    const candidate: RankedMemory = {
      kind: "box_context",
      id: parent.id,
      text,
      score: 0.01,
      tokenCount: estimateTokenCount(text),
      canUseStub: false,
      scoringMethod: "keyword overlap",
      summaryId: null,
      summaryIds: [],
      traceId: null,
      sourceTurnRanges: parent.turnRanges,
      boxIds: [parent.id]
    };

    if (maxMemoryTokens !== undefined && usedTokens + candidate.tokenCount > maxMemoryTokens) {
      return selected;
    }

    return selected.some((memory) => memory.boxIds.includes(parent.id)) ? selected : [...selected, candidate];
  }

  return selected;
}
```

- [ ] **Step 5: Call parent context after primary selection**

In `prepareInjection`, replace:

```ts
const selected = selectMemories(ranked, request.maxMemoryTokens);
```

with:

```ts
const primarySelected = selectMemories(ranked, request.maxMemoryTokens);
const selected = addParentBoxContext(primarySelected, boxes, request.maxMemoryTokens);
```

Keep the existing empty-selection null check after this block.

- [ ] **Step 6: Update disclosure text**

Change `buildDisclosureText` signature to accept selected memory items:

```ts
function buildDisclosureText(
  selected: RankedMemory[],
  currentTopicSummary: string,
  selectedTokenCount: number,
  maxMemoryTokens?: number
): string
```

Build the base text with:

```ts
const parentContextCount = selected.filter((memory) => memory.kind === "box_context").length;
const primaryCount = selected.length - parentContextCount;
const parentText = parentContextCount > 0 ? ` Included ${parentContextCount} parent box context item${parentContextCount === 1 ? "" : "s"}.` : "";
const base = `Retrieved ${primaryCount} memory item${primaryCount === 1 ? "" : "s"} for ${currentTopicSummary}.${parentText}`;
```

Update the call site:

```ts
disclosureText: buildDisclosureText(selected, request.currentTopicSummary, selectedTokenCount, request.maxMemoryTokens),
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
npm test -- tests/retrieval/memory-retriever.test.ts -t "parent"
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/retrieval/memory-retriever.ts tests/retrieval/memory-retriever.test.ts
git commit -m "Add parent box context to retrieval"
```

## Task 4: Prevent Broad Trace Over-Injection

**Files:**
- Modify: `src/retrieval/memory-retriever.ts`
- Modify: `tests/retrieval/memory-retriever.test.ts`

- [ ] **Step 1: Write failing specificity test**

Add this test:

```ts
it("does not retrieve a child trace for a broad parent-only query", async () => {
  const store = new InMemoryStore();
  await store.saveSummary(makeSummary({
    id: "summary_case_smith",
    summaryText: "Smith car accident case overview and general planning.",
    boxIds: ["box_case_smith"],
    tokenCount: 8
  }));
  await store.saveSummary(makeSummary({
    id: "summary_provider_bill",
    summaryText: "Smith PIP provider bill ledger dispute.",
    boxIds: ["box_smith_pip"],
    tokenCount: 8
  }));
  await store.saveTrace(makeTrace());

  const retriever = new MemoryRetriever(store);
  const packet = await retriever.prepareInjection({
    host: "roscoe-hermes",
    profileId: "default",
    hostSessionId: "session_1",
    currentTopicSummary: "Smith case overview",
    requestedAt: "2026-05-04T10:10:00.000Z",
    maxMemoryTokens: 80
  });

  expect(packet?.sourceTraceIds).toEqual([]);
  expect(packet?.sourceSummaryIds[0]).toBe("summary_case_smith");
});
```

- [ ] **Step 2: Run specificity test**

Run:

```bash
npm test -- tests/retrieval/memory-retriever.test.ts -t "broad parent-only"
```

Expected: FAIL if the trace is selected on broad overlap.

- [ ] **Step 3: Add broad-word filtering for trace overlap**

In `src/retrieval/memory-retriever.ts`, add:

```ts
const TRACE_BROAD_WORDS = new Set(["case", "matter", "client", "claim", "overview", "general"]);
```

Update `rankTrace` overlap logic:

```ts
const specificOverlap = overlap.filter((word) => !TRACE_BROAD_WORDS.has(word));

if (specificOverlap.length < 2) {
  return null;
}
```

Keep `scoreText` unchanged for summaries and anchors.

- [ ] **Step 4: Run retrieval suite**

Run:

```bash
npm test -- tests/retrieval/memory-retriever.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/retrieval/memory-retriever.ts tests/retrieval/memory-retriever.test.ts
git commit -m "Constrain broad trace retrieval"
```

## Task 5: Hermes Inject Integration and ADR

**Files:**
- Modify: `tests/integrations/hermes-inject-command.test.ts`
- Create: `docs/adr/0036-trace-aware-retrieval.md`

- [ ] **Step 1: Update Hermes inject integration test**

In `tests/integrations/hermes-inject-command.test.ts`, add a trace fixture to the test database setup:

```ts
await store.saveTrace({
  id: "trace_smith_pip_provider_bills",
  title: "Smith PIP Provider Bills",
  description: "Recurring Smith PIP provider bill dispute and no-fault payment timing.",
  traceType: "case_issue",
  state: "approved",
  summaryIds: ["summary_smith_pip", "summary_smith_provider_bill"],
  boxIds: ["box_smith_pip"],
  turnRanges: [
    { threadId: "session_1", startSequence: 1, endSequence: 2 },
    { threadId: "session_1", startSequence: 10, endSequence: 12 }
  ],
  createdAt: "2026-05-04T10:05:00.000Z",
  updatedAt: "2026-05-04T10:05:00.000Z",
  lastActivityAt: "2026-05-04T10:05:00.000Z",
  confidence: 0.9,
  rationale: "The provider bill issue recurred across separated turns."
});
```

Ensure the command input asks for:

```json
{
  "current_topic_summary": "Smith PIP provider bill ledger"
}
```

Assert:

```ts
expect(stdout).toContain("trace_smith_pip_provider_bills");
expect(stdout).toContain("Top trace match trace_smith_pip_provider_bills");
```

- [ ] **Step 2: Run integration test**

Run:

```bash
npm test -- tests/integrations/hermes-inject-command.test.ts
```

Expected: PASS.

- [ ] **Step 3: Write ADR**

Create `docs/adr/0036-trace-aware-retrieval.md`:

```markdown
# ADR 0036: Trace-Aware Retrieval

## Status

Accepted

## Context

Proposal approval can create approved traces and box hierarchies, but retrieval previously ranked only summaries and anchors. Approved memory structure therefore existed without affecting foreground agent context.

## Decision

Memory retrieval will rank approved traces as primary candidates and append bounded parent box context after a selected child memory. Injection packets will include `sourceTraceIds` so trace provenance is auditable.

Trace ranking remains deterministic keyword overlap in this phase. Traces require specific overlap and ignore proposed, rejected, and superseded records.

## Consequences

- Agents can resume recurring issue threads without loading entire cases.
- Parent case context can appear when a child issue is selected.
- Broad parent queries are less likely to over-inject child traces.
- Future trace embedding or LLM reranking can be added behind the same candidate shape.
```

- [ ] **Step 4: Run full verification**

Run:

```bash
npm test -- --run
npm run typecheck
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/retrieval/memory-retriever.ts tests docs/adr/0036-trace-aware-retrieval.md
git commit -m "Document trace-aware retrieval"
```

## Task 6: Ship the Phase

**Files:**
- No source edits unless verification exposes a defect.

- [ ] **Step 1: Inspect branch state**

Run:

```bash
git status --short --branch
git log --oneline -5
```

Expected: working tree contains only `?? example/` and committed phase work.

- [ ] **Step 2: Push branch**

If implementing directly on `main` as previously agreed for planning docs, run:

```bash
git push forgejo main
```

If implementation is done on a feature branch, run:

```bash
git push forgejo HEAD
```

Expected: push succeeds.

- [ ] **Step 3: Create PR when using a feature branch**

If implementation is on a branch, create a Forgejo PR into `main` with the title:

```text
Add trace-aware retrieval
```

Body:

```markdown
## Summary

- retrieves approved traces during memory injection
- records source trace ids on injection packets
- adds bounded parent box context for selected child memories
- documents the deterministic trace-aware retrieval decision

## Verification

- npm test -- --run
- npm run typecheck
- git diff --check
```

If implementation is on `main`, no PR is needed.

## Self-Review

- Spec coverage: every design requirement maps to a task above.
- Placeholder scan: no deferred implementation language remains.
- Type consistency: `sourceTraceIds`, `summaryIds`, and `traceId` are introduced before later tasks use them.
- Test coverage: trace retrieval, non-approved traces, specificity, parent context, budget limits, Hermes integration, typecheck, and full suite are included.
