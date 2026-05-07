# Sleep Review and Trace Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `hermes:sleep` into a deterministic background organization pipeline that stores auditable box, parent/child, and trace proposals without automatically rewriting approved memory.

**Architecture:** Add first-class proposal and trace domain records, persist them through `MemoryStore`, then move planning logic out of `SleepReviewer` into focused deterministic planners. `SleepReviewer` remains the orchestrator for decay, box refresh, proposal planning, proposal persistence, and compact command output.

**Tech Stack:** TypeScript, Node.js, Zod, Vitest, SQLite via `node:sqlite`, existing `MemoryStore`, existing Hermes command scripts.

---

## Scope

This plan implements the deterministic core from the design spec:

- `MemoryProposal` and `MemoryTrace` schemas
- proposal and trace storage
- deterministic box proposals
- deterministic parent/child proposals
- deterministic trace proposals
- `SleepReviewer` integration
- `hermes:sleep` output updates
- ADR documentation

This plan does not implement:

- OpenRouter proposal planning
- proposal approval/rejection commands
- graph database integration
- dashboard UI
- automatic mutation of approved boxes

## File Structure

- Modify `src/domain/types.ts`: add `MemoryProposal`, typed proposal payloads, `MemoryTrace`, schemas, and exported types.
- Modify `src/storage/memory-store.ts`: add proposal and trace persistence methods.
- Modify `src/storage/in-memory-store.ts`: store proposals and traces for tests.
- Modify `src/storage/sqlite-store.ts`: add `proposals` and `traces` tables, indexes, save/list methods.
- Create `src/proposals/proposal-utils.ts`: shared id, text normalization, turn-range dedupe, and duplicate helpers.
- Create `src/boxes/box-proposal-planner.ts`: deterministic box and parent/child proposal planner.
- Create `src/traces/trace-proposal-planner.ts`: deterministic non-contiguous trace proposal planner.
- Modify `src/sleep/sleep-reviewer.ts`: delegate planning and persist proposals.
- Modify `src/integrations/hermes/sleep-command.ts`: parse proposal controls and return proposal ids.
- Create `tests/proposals/memory-proposal.test.ts`: schema and payload validation.
- Modify `tests/storage/sqlite-store.test.ts`: persistence coverage for proposals and traces.
- Create `tests/boxes/box-proposal-planner.test.ts`: richer box and parent/child planning.
- Create `tests/traces/trace-proposal-planner.test.ts`: trace planning and overbroad rejection.
- Modify `tests/sleep/sleep-reviewer.test.ts`: orchestration coverage.
- Modify `tests/integrations/hermes-sleep-command.test.ts`: command output coverage.
- Create `docs/adr/0034-sleep-review-proposal-layer.md`: decision record for proposal and trace layer.

## Task 1: Proposal and Trace Domain Schemas

**Files:**
- Modify: `src/domain/types.ts`
- Test: `tests/proposals/memory-proposal.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `tests/proposals/memory-proposal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BoxProposalPayloadSchema,
  MemoryProposalSchema,
  MemoryTraceSchema,
  ParentChildProposalPayloadSchema,
  TraceProposalPayloadSchema
} from "../../src/domain/types.js";

const turnRange = { threadId: "profile:default", startSequence: 1, endSequence: 3 };

describe("memory proposal schemas", () => {
  it("parses a box proposal with evidence and provenance", () => {
    const parsed = MemoryProposalSchema.parse({
      id: "proposal_box_smith_pip",
      proposalType: "box",
      state: "proposed",
      title: "Smith PIP Coverage",
      rationale: "Two compacted summaries discuss Smith PIP coverage and provider bills.",
      confidence: 0.82,
      createdAt: "2026-05-07T12:00:00.000Z",
      reviewedAt: "2026-05-07T12:00:00.000Z",
      sourceSummaryIds: ["summary_1", "summary_2"],
      sourceTurnRanges: [turnRange],
      targetBoxIds: ["box_topic_smith_pip"],
      targetTraceIds: [],
      payload: {
        boxId: "box_topic_smith_pip",
        title: "Smith PIP Coverage",
        description: "Proposed topic box for Smith PIP coverage.",
        summary: "Smith PIP coverage and provider bill review.",
        boxType: "topic",
        candidateParentBoxId: "box_case_smith",
        keywords: ["smith", "pip", "coverage", "provider", "bill"],
        evidence: ["Shared keywords: smith, pip, coverage", "2 source summaries"],
        sourceSummaryIds: ["summary_1", "summary_2"],
        sourceTurnRanges: [turnRange]
      }
    });

    expect(BoxProposalPayloadSchema.parse(parsed.payload).candidateParentBoxId).toBe("box_case_smith");
  });

  it("parses parent-child and trace payloads", () => {
    expect(ParentChildProposalPayloadSchema.parse({
      parentBoxId: "box_case_smith",
      childBoxId: "box_topic_smith_pip",
      relationshipLabel: "case subtopic",
      rationale: "Smith PIP is narrower than the Smith case box.",
      sourceSummaryIds: ["summary_1"]
    }).relationshipLabel).toBe("case subtopic");

    expect(TraceProposalPayloadSchema.parse({
      traceId: "trace_smith_pip_bills",
      title: "Smith PIP Provider Bill Review",
      description: "Non-contiguous summaries continue the Smith PIP provider bill review issue.",
      traceType: "case_issue",
      summaryIds: ["summary_1", "summary_3"],
      boxIds: ["box_topic_smith_pip"],
      turnRanges: [turnRange],
      continuityReason: "Both summaries discuss Smith PIP provider bill review.",
      boundaryReason: "Smith BI summaries were excluded because they concern bodily injury coverage.",
      keywords: ["smith", "pip", "provider", "bill"]
    }).traceType).toBe("case_issue");
  });

  it("parses a memory trace record", () => {
    const trace = MemoryTraceSchema.parse({
      id: "trace_smith_pip_bills",
      title: "Smith PIP Provider Bill Review",
      description: "Approved trace for Smith PIP bill review.",
      traceType: "case_issue",
      state: "proposed",
      summaryIds: ["summary_1", "summary_3"],
      boxIds: ["box_topic_smith_pip"],
      turnRanges: [turnRange],
      createdAt: "2026-05-07T12:00:00.000Z",
      updatedAt: "2026-05-07T12:00:00.000Z",
      lastActivityAt: "2026-05-07T12:00:00.000Z",
      confidence: 0.78,
      rationale: "The summaries continue the same provider bill review issue."
    });

    expect(trace.state).toBe("proposed");
  });

  it("rejects proposal payloads without source provenance", () => {
    expect(() => MemoryProposalSchema.parse({
      id: "proposal_bad",
      proposalType: "box",
      state: "proposed",
      title: "Bad",
      rationale: "Missing source summary ids.",
      confidence: 0.5,
      createdAt: "2026-05-07T12:00:00.000Z",
      reviewedAt: "2026-05-07T12:00:00.000Z",
      sourceSummaryIds: [],
      sourceTurnRanges: [],
      targetBoxIds: [],
      targetTraceIds: [],
      payload: {}
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- tests/proposals/memory-proposal.test.ts`

Expected: FAIL with missing exports such as `MemoryProposalSchema`.

- [ ] **Step 3: Add schemas and types to `src/domain/types.ts`**

Add these schemas after `InjectionPacketSchema`:

```ts
export const ProposalStateSchema = z.enum(["proposed", "approved", "rejected", "superseded"]);
export const ProposalTypeSchema = z.enum(["box", "box_parent_child", "trace"]);
export const TraceTypeSchema = z.enum(["case_issue", "task_thread", "strategy_thread", "fact_development", "follow_up"]);

export const BoxProposalPayloadSchema = z.object({
  boxId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  summary: z.string().min(1),
  boxType: z.enum(["case", "topic", "general", "project", "person"]),
  candidateParentBoxId: z.string().min(1).nullable(),
  keywords: z.array(z.string().min(1)),
  evidence: z.array(z.string().min(1)),
  sourceSummaryIds: z.array(z.string().min(1)).min(1),
  sourceTurnRanges: z.array(TurnRangeSchema).min(1)
});

export const ParentChildProposalPayloadSchema = z.object({
  parentBoxId: z.string().min(1),
  childBoxId: z.string().min(1),
  relationshipLabel: z.string().min(1),
  rationale: z.string().min(1),
  sourceSummaryIds: z.array(z.string().min(1)).min(1)
});

export const TraceProposalPayloadSchema = z.object({
  traceId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  traceType: TraceTypeSchema,
  summaryIds: z.array(z.string().min(1)).min(2),
  boxIds: z.array(z.string().min(1)),
  turnRanges: z.array(TurnRangeSchema).min(1),
  continuityReason: z.string().min(1),
  boundaryReason: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1)
});

export const MemoryProposalSchema = z.object({
  id: z.string().min(1),
  proposalType: ProposalTypeSchema,
  state: ProposalStateSchema,
  title: z.string().min(1),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
  createdAt: IsoDateTimeSchema,
  reviewedAt: IsoDateTimeSchema,
  sourceSummaryIds: z.array(z.string().min(1)).min(1),
  sourceTurnRanges: z.array(TurnRangeSchema).min(1),
  targetBoxIds: z.array(z.string().min(1)),
  targetTraceIds: z.array(z.string().min(1)),
  payload: JsonObjectSchema
}).superRefine((proposal, context) => {
  const result =
    proposal.proposalType === "box"
      ? BoxProposalPayloadSchema.safeParse(proposal.payload)
      : proposal.proposalType === "box_parent_child"
        ? ParentChildProposalPayloadSchema.safeParse(proposal.payload)
        : TraceProposalPayloadSchema.safeParse(proposal.payload);

  if (!result.success) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid ${proposal.proposalType} proposal payload`
    });
  }
});

export const MemoryTraceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  traceType: TraceTypeSchema,
  state: ProposalStateSchema,
  summaryIds: z.array(z.string().min(1)).min(2),
  boxIds: z.array(z.string().min(1)),
  turnRanges: z.array(TurnRangeSchema).min(1),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  lastActivityAt: IsoDateTimeSchema,
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1)
});
```

Add exported types:

```ts
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;
export type MemoryTrace = z.infer<typeof MemoryTraceSchema>;
export type BoxProposalPayload = z.infer<typeof BoxProposalPayloadSchema>;
export type ParentChildProposalPayload = z.infer<typeof ParentChildProposalPayloadSchema>;
export type TraceProposalPayload = z.infer<typeof TraceProposalPayloadSchema>;
export type ProposalType = z.infer<typeof ProposalTypeSchema>;
export type ProposalState = z.infer<typeof ProposalStateSchema>;
export type TraceType = z.infer<typeof TraceTypeSchema>;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- tests/proposals/memory-proposal.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts tests/proposals/memory-proposal.test.ts
git commit -m "Add memory proposal and trace schemas"
```

## Task 2: Store Proposal and Trace Records

**Files:**
- Modify: `src/storage/memory-store.ts`
- Modify: `src/storage/in-memory-store.ts`
- Modify: `src/storage/sqlite-store.ts`
- Modify: `tests/storage/sqlite-store.test.ts`

- [ ] **Step 1: Write failing SQLite persistence test**

In `tests/storage/sqlite-store.test.ts`, extend the existing persistence test or add a new test:

```ts
it("persists proposals and traces", async () => {
  const store = new SqliteStore(databasePath);
  const proposal = makeProposal();
  const trace = makeTrace();

  await store.saveProposal(proposal);
  await store.saveTrace(trace);

  await expect(store.listProposals()).resolves.toEqual([proposal]);
  await expect(store.listProposals({ state: "proposed", proposalType: "trace" })).resolves.toEqual([proposal]);
  await expect(store.listProposals({ state: "approved" })).resolves.toEqual([]);
  await expect(store.listTraces()).resolves.toEqual([trace]);
  await expect(store.listTraces({ state: "proposed" })).resolves.toEqual([trace]);
  store.close();
});
```

Add local helpers in the test file:

```ts
const makeProposal = (): MemoryProposal => ({
  id: "proposal_trace_smith_pip_bills",
  proposalType: "trace",
  state: "proposed",
  title: "Smith PIP Provider Bill Review",
  rationale: "Two summaries continue the same Smith PIP provider bill review issue.",
  confidence: 0.78,
  createdAt: "2026-05-07T12:00:00.000Z",
  reviewedAt: "2026-05-07T12:00:00.000Z",
  sourceSummaryIds: ["summary_1", "summary_3"],
  sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
  targetBoxIds: ["box_topic_smith_pip"],
  targetTraceIds: ["trace_smith_pip_bills"],
  payload: {
    traceId: "trace_smith_pip_bills",
    title: "Smith PIP Provider Bill Review",
    description: "Non-contiguous summaries continue the Smith PIP provider bill review issue.",
    traceType: "case_issue",
    summaryIds: ["summary_1", "summary_3"],
    boxIds: ["box_topic_smith_pip"],
    turnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
    continuityReason: "Both summaries discuss Smith PIP provider bill review.",
    boundaryReason: "Smith BI summaries were excluded.",
    keywords: ["smith", "pip", "provider", "bill"]
  }
});

const makeTrace = (): MemoryTrace => ({
  id: "trace_smith_pip_bills",
  title: "Smith PIP Provider Bill Review",
  description: "Approved trace for Smith PIP bill review.",
  traceType: "case_issue",
  state: "proposed",
  summaryIds: ["summary_1", "summary_3"],
  boxIds: ["box_topic_smith_pip"],
  turnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
  createdAt: "2026-05-07T12:00:00.000Z",
  updatedAt: "2026-05-07T12:00:00.000Z",
  lastActivityAt: "2026-05-07T12:00:00.000Z",
  confidence: 0.78,
  rationale: "The summaries continue the same provider bill review issue."
});
```

- [ ] **Step 2: Run the failing test**

Run: `npm test -- tests/storage/sqlite-store.test.ts`

Expected: FAIL because `saveProposal`, `listProposals`, `saveTrace`, and `listTraces` do not exist.

- [ ] **Step 3: Extend `MemoryStore`**

In `src/storage/memory-store.ts`, import `MemoryProposal`, `MemoryTrace`, `ProposalState`, and `ProposalType`, then add:

```ts
export interface ProposalFilter {
  state?: ProposalState;
  proposalType?: ProposalType;
}

export interface TraceFilter {
  state?: ProposalState;
}
```

Add methods to `MemoryStore`:

```ts
saveProposal(proposal: MemoryProposal): Promise<void>;
listProposals(filter?: ProposalFilter): Promise<MemoryProposal[]>;
saveTrace(trace: MemoryTrace): Promise<void>;
listTraces(filter?: TraceFilter): Promise<MemoryTrace[]>;
```

- [ ] **Step 4: Implement in-memory store support**

In `src/storage/in-memory-store.ts`, add arrays:

```ts
private readonly proposals: MemoryProposal[] = [];
private readonly traces: MemoryTrace[] = [];
```

Add methods:

```ts
async saveProposal(proposal: MemoryProposal): Promise<void> {
  this.upsertById(this.proposals, structuredClone(MemoryProposalSchema.parse(proposal)));
}

async listProposals(filter: ProposalFilter = {}): Promise<MemoryProposal[]> {
  return structuredClone(this.proposals.filter((proposal) =>
    (filter.state === undefined || proposal.state === filter.state) &&
    (filter.proposalType === undefined || proposal.proposalType === filter.proposalType)
  ));
}

async saveTrace(trace: MemoryTrace): Promise<void> {
  this.upsertById(this.traces, structuredClone(MemoryTraceSchema.parse(trace)));
}

async listTraces(filter: TraceFilter = {}): Promise<MemoryTrace[]> {
  return structuredClone(this.traces.filter((trace) =>
    filter.state === undefined || trace.state === filter.state
  ));
}
```

- [ ] **Step 5: Implement SQLite store support**

In `src/storage/sqlite-store.ts`, import `MemoryProposalSchema`, `MemoryTraceSchema`, and their types. Add methods:

```ts
async saveProposal(proposal: MemoryProposal): Promise<void> {
  const parsed = MemoryProposalSchema.parse(proposal);
  this.database
    .prepare(
      `insert into proposals (id, state, proposal_type, payload)
       values (?, ?, ?, ?)
       on conflict(id) do update set
         state = excluded.state,
         proposal_type = excluded.proposal_type,
         payload = excluded.payload`
    )
    .run(parsed.id, parsed.state, parsed.proposalType, JSON.stringify(parsed));
}

async listProposals(filter: ProposalFilter = {}): Promise<MemoryProposal[]> {
  const clauses: string[] = [];
  const values: string[] = [];
  if (filter.state) {
    clauses.push("state = ?");
    values.push(filter.state);
  }
  if (filter.proposalType) {
    clauses.push("proposal_type = ?");
    values.push(filter.proposalType);
  }
  const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";
  const rows = this.database
    .prepare(`select payload from proposals${where} order by id asc`)
    .all(...values) as PayloadRow[];
  return rows.map((row) => MemoryProposalSchema.parse(JSON.parse(row.payload)));
}

async saveTrace(trace: MemoryTrace): Promise<void> {
  const parsed = MemoryTraceSchema.parse(trace);
  this.database
    .prepare(
      `insert into traces (id, state, payload)
       values (?, ?, ?)
       on conflict(id) do update set
         state = excluded.state,
         payload = excluded.payload`
    )
    .run(parsed.id, parsed.state, JSON.stringify(parsed));
}

async listTraces(filter: TraceFilter = {}): Promise<MemoryTrace[]> {
  const rows = filter.state
    ? this.database.prepare("select payload from traces where state = ? order by id asc").all(filter.state) as PayloadRow[]
    : this.database.prepare("select payload from traces order by id asc").all() as PayloadRow[];
  return rows.map((row) => MemoryTraceSchema.parse(JSON.parse(row.payload)));
}
```

Add migration SQL:

```sql
create table if not exists proposals (
  id text primary key,
  state text not null,
  proposal_type text not null,
  payload text not null
);

create index if not exists idx_proposals_state_type
  on proposals (state, proposal_type);

create table if not exists traces (
  id text primary key,
  state text not null,
  payload text not null
);

create index if not exists idx_traces_state
  on traces (state);
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- tests/storage/sqlite-store.test.ts tests/proposals/memory-proposal.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage/memory-store.ts src/storage/in-memory-store.ts src/storage/sqlite-store.ts tests/storage/sqlite-store.test.ts
git commit -m "Persist memory proposals and traces"
```

## Task 3: Shared Proposal Utilities

**Files:**
- Create: `src/proposals/proposal-utils.ts`

- [ ] **Step 1: Create deterministic utility module**

Create `src/proposals/proposal-utils.ts`:

```ts
import type { MemoryProposal, Summary, TurnRange } from "../domain/types.js";

export const COMMON_TERMS = new Set([
  "about", "and", "are", "case", "coverage", "discussed", "for", "from",
  "issue", "legal", "matter", "review", "strategy", "the", "this", "that",
  "with"
]);

export function significantTerms(text: string): string[] {
  return [...new Set(text.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2 && !COMMON_TERMS.has(term)))];
}

export function sharedTerms(left: string[] | Set<string>, right: string[] | Set<string>): string[] {
  const leftSet = left instanceof Set ? left : new Set(left);
  const rightSet = right instanceof Set ? right : new Set(right);
  return [...leftSet].filter((term) => rightSet.has(term)).sort();
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function titleCase(value: string): string {
  return value.split(/\s+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function dedupeTurnRanges(ranges: TurnRange[]): TurnRange[] {
  const seen = new Set<string>();
  return ranges.filter((range) => {
    const key = `${range.threadId}:${range.startSequence}:${range.endSequence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function latestSummaryTimestamp(summaries: Summary[], fallback: string): string {
  return summaries.map((summary) => summary.createdAt).sort().at(-1) ?? fallback;
}

export function hasExistingProposal(proposals: MemoryProposal[], proposalId: string): boolean {
  return proposals.some((proposal) => proposal.id === proposalId && proposal.state === "proposed");
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/proposals/proposal-utils.ts
git commit -m "Add shared proposal planning utilities"
```

## Task 4: Deterministic Box Proposal Planner

**Files:**
- Create: `src/boxes/box-proposal-planner.ts`
- Test: `tests/boxes/box-proposal-planner.test.ts`

- [ ] **Step 1: Write failing planner tests**

Create `tests/boxes/box-proposal-planner.test.ts` with tests for:

```ts
it("proposes a Smith PIP box from repeated Smith PIP summaries", async () => {
  const planner = new DeterministicBoxProposalPlanner();
  const result = await planner.proposeBoxes({
    reviewedAt: "2026-05-07T12:00:00.000Z",
    summaries: [
      summary({ id: "summary_1", summaryText: "Smith PIP coverage provider bill review." }),
      summary({ id: "summary_2", summaryText: "Smith PIP provider bill deadline and coverage timing.", sourceTurnRanges: [{ threadId: "profile:default", startSequence: 20, endSequence: 22 }] })
    ],
    boxes: [],
    anchors: [],
    proposals: [],
    minimumSummariesPerBox: 2,
    minimumConfidence: 0.5
  });

  expect(result.proposals.map((proposal) => proposal.id)).toEqual(["proposal_box_box_topic_smith_pip"]);
  expect(result.proposals[0]).toMatchObject({
    proposalType: "box",
    title: "Smith PIP",
    confidence: expect.any(Number),
    targetBoxIds: ["box_topic_smith_pip"]
  });
});

it("does not merge Smith PIP and Smith BI into one child box", async () => {
  const planner = new DeterministicBoxProposalPlanner();
  const result = await planner.proposeBoxes({
    reviewedAt: "2026-05-07T12:00:00.000Z",
    summaries: [
      summary({ id: "summary_pip", summaryText: "Smith PIP coverage provider bill review." }),
      summary({ id: "summary_bi", summaryText: "Smith BI coverage bodily injury demand strategy.", sourceTurnRanges: [{ threadId: "profile:default", startSequence: 40, endSequence: 42 }] })
    ],
    boxes: [],
    anchors: [],
    proposals: [],
    minimumSummariesPerBox: 2,
    minimumConfidence: 0.5
  });

  expect(result.proposals).toEqual([]);
});

it("avoids duplicate proposed boxes", async () => {
  const planner = new DeterministicBoxProposalPlanner();
  const result = await planner.proposeBoxes({
    reviewedAt: "2026-05-07T12:00:00.000Z",
    summaries: [
      summary({ id: "summary_1", summaryText: "Smith PIP coverage provider bill review." }),
      summary({ id: "summary_2", summaryText: "Smith PIP provider bill deadline.", sourceTurnRanges: [{ threadId: "profile:default", startSequence: 20, endSequence: 22 }] })
    ],
    boxes: [box({ id: "box_topic_smith_pip", title: "Smith PIP", state: "approved" })],
    anchors: [],
    proposals: [],
    minimumSummariesPerBox: 2,
    minimumConfidence: 0.5
  });

  expect(result.proposals).toEqual([]);
});

it("proposes Smith PIP as a child of an existing Smith case box", async () => {
  const planner = new DeterministicBoxProposalPlanner();
  const result = await planner.proposeBoxes({
    reviewedAt: "2026-05-07T12:00:00.000Z",
    summaries: [
      summary({ id: "summary_1", summaryText: "Smith PIP coverage provider bill review." }),
      summary({ id: "summary_2", summaryText: "Smith PIP provider bill deadline.", sourceTurnRanges: [{ threadId: "profile:default", startSequence: 20, endSequence: 22 }] })
    ],
    boxes: [box({ id: "box_case_smith", title: "Smith", boxType: "case", summary: "Smith case overview." })],
    anchors: [],
    proposals: [],
    minimumSummariesPerBox: 2,
    minimumConfidence: 0.5
  });

  expect(result.proposals.map((proposal) => proposal.proposalType)).toEqual(["box", "box_parent_child"]);
  expect(result.proposals[1].payload).toMatchObject({
    parentBoxId: "box_case_smith",
    childBoxId: "box_topic_smith_pip"
  });
});
```

Add `summary` and `box` helper builders in the test file by copying the full object shapes from `tests/sleep/sleep-reviewer.test.ts` and overriding only the fields used by each test. Keep the default summary text, source turn range, timestamps, confidence, state, token count, strength, and half-life valid for `SummarySchema`; keep the default box state, type, summary ids, turn ranges, and timestamps valid for `BoxSchema`.

- [ ] **Step 2: Run the failing tests**

Run: `npm test -- tests/boxes/box-proposal-planner.test.ts`

Expected: FAIL because `DeterministicBoxProposalPlanner` does not exist.

- [ ] **Step 3: Implement planner interfaces and deterministic planner**

Create `src/boxes/box-proposal-planner.ts` with:

```ts
export interface BoxProposalPlanningRequest {
  reviewedAt: string;
  summaries: Summary[];
  boxes: Box[];
  anchors: Anchor[];
  proposals: MemoryProposal[];
  minimumSummariesPerBox?: number;
  minimumConfidence?: number;
}

export interface BoxProposalPlanningResult {
  proposals: MemoryProposal[];
  skippedCandidates: { title: string; summaryIds: string[]; reason: string }[];
}

export class DeterministicBoxProposalPlanner {
  async proposeBoxes(request: BoxProposalPlanningRequest): Promise<BoxProposalPlanningResult> {
    const minimumSummaries = request.minimumSummariesPerBox ?? 2;
    const minimumConfidence = request.minimumConfidence ?? 0.5;
    const skippedCandidates: BoxProposalPlanningResult["skippedCandidates"] = [];
    const groups = buildCandidateGroups(request.summaries);
    const proposals: MemoryProposal[] = [];

    for (const group of groups) {
      if (group.summaries.length < minimumSummaries) {
        skippedCandidates.push({ title: group.title, summaryIds: group.summaries.map((summary) => summary.id), reason: "Insufficient source summaries" });
        continue;
      }
      if (group.sharedSpecificTerms.length < 2) {
        skippedCandidates.push({ title: group.title, summaryIds: group.summaries.map((summary) => summary.id), reason: "Insufficient shared specific terms" });
        continue;
      }
      const confidence = Number(Math.min(0.9, 0.45 + group.sharedSpecificTerms.length * 0.1 + group.summaries.length * 0.05).toFixed(2));
      if (confidence < minimumConfidence) {
        skippedCandidates.push({ title: group.title, summaryIds: group.summaries.map((summary) => summary.id), reason: "Confidence below threshold" });
        continue;
      }
      const boxId = `box_topic_${slugify(group.title)}`;
      const proposalId = `proposal_box_${boxId}`;
      if (hasDuplicateBox(request.boxes, request.proposals, boxId, group.title, proposalId)) {
        skippedCandidates.push({ title: group.title, summaryIds: group.summaries.map((summary) => summary.id), reason: "Duplicate box or proposal already exists" });
        continue;
      }
      proposals.push(buildBoxProposal(group, request.reviewedAt, confidence, findCandidateParent(group, request.boxes)));
      const parent = findCandidateParent(group, request.boxes);
      if (parent) {
        proposals.push(buildParentChildProposal(parent.id, boxId, group, request.reviewedAt, confidence));
      }
    }

    return { proposals, skippedCandidates };
  }
}
```

Implement helpers in the same file:

- `buildCandidateGroups`
- `buildBoxProposal`
- `buildParentChildProposal`
- `findCandidateParent`
- `hasDuplicateBox`

For the first deterministic version, `buildCandidateGroups` should group by the first two significant terms only after verifying all summaries in the group share at least those terms. This preserves determinism while the tests prevent broad Smith-only merging.

- [ ] **Step 4: Run planner tests and typecheck**

Run: `npm test -- tests/boxes/box-proposal-planner.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/boxes/box-proposal-planner.ts tests/boxes/box-proposal-planner.test.ts
git commit -m "Add deterministic box proposal planner"
```

## Task 5: Wire Box Proposals into SleepReviewer

**Files:**
- Modify: `src/sleep/sleep-reviewer.ts`
- Modify: `tests/sleep/sleep-reviewer.test.ts`

- [ ] **Step 1: Update sleep reviewer tests**

Adjust the existing box proposal test to assert proposals are stored:

```ts
const result = await reviewer.proposeBoxes({
  reviewedAt: "2026-05-07T12:00:00.000Z",
  minimumSummariesPerBox: 2
});

expect(result.proposedBoxes.map((box) => box.id)).toEqual(["box_topic_smith_pip"]);
expect(result.proposals.map((proposal) => proposal.id)).toEqual(["proposal_box_box_topic_smith_pip"]);
await expect(store.listProposals({ proposalType: "box", state: "proposed" })).resolves.toHaveLength(1);
```

Keep existing assertions that a proposed `Box` exists for backward compatibility with `proposedBoxIds`.

- [ ] **Step 2: Run failing sleep tests**

Run: `npm test -- tests/sleep/sleep-reviewer.test.ts`

Expected: FAIL because `SleepReviewResult` does not expose `proposals` and does not persist proposal records.

- [ ] **Step 3: Update `SleepReviewer.proposeBoxes`**

In `src/sleep/sleep-reviewer.ts`:

- import `DeterministicBoxProposalPlanner`
- import `BoxProposalPayloadSchema`
- update `SleepReviewResult` to include `proposals: MemoryProposal[]`
- load `anchors` and existing proposed `proposals`
- call the planner
- save every returned proposal
- continue saving compatibility `Box` records for `proposalType === "box"`

The compatibility box creation should parse the payload:

```ts
const payload = BoxProposalPayloadSchema.parse(proposal.payload);
await this.store.saveBox({
  id: payload.boxId,
  title: payload.title,
  description: payload.description,
  parentBoxId: null,
  childBoxIds: [],
  summaryIds: payload.sourceSummaryIds,
  turnRanges: payload.sourceTurnRanges,
  state: "proposed",
  createdAt: request.reviewedAt,
  updatedAt: request.reviewedAt,
  caseId: null,
  boxType: payload.boxType,
  summary: payload.summary,
  lastActivityAt: request.reviewedAt
});
```

- [ ] **Step 4: Run sleep tests and focused planner tests**

Run: `npm test -- tests/sleep/sleep-reviewer.test.ts tests/boxes/box-proposal-planner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sleep/sleep-reviewer.ts tests/sleep/sleep-reviewer.test.ts
git commit -m "Store box proposals during sleep review"
```

## Task 6: Deterministic Trace Proposal Planner

**Files:**
- Create: `src/traces/trace-proposal-planner.ts`
- Test: `tests/traces/trace-proposal-planner.test.ts`

- [ ] **Step 1: Write failing trace planner tests**

Create `tests/traces/trace-proposal-planner.test.ts` with:

```ts
it("links non-contiguous Smith PIP bill review summaries", async () => {
  const planner = new DeterministicTraceProposalPlanner();
  const result = await planner.proposeTraces({
    reviewedAt: "2026-05-07T12:00:00.000Z",
    summaries: [
      summary({ id: "summary_1", summaryText: "Smith PIP provider bill review and coverage timing.", sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }] }),
      summary({ id: "summary_3", summaryText: "Smith PIP provider bill review follow-up after new records.", sourceTurnRanges: [{ threadId: "profile:default", startSequence: 4350, endSequence: 4380 }] })
    ],
    boxes: [box({ id: "box_topic_smith_pip", title: "Smith PIP", summaryIds: ["summary_1", "summary_3"] })],
    anchors: [],
    proposals: [],
    traces: [],
    minimumTraceSummaries: 2,
    minimumConfidence: 0.5
  });

  expect(result.proposals.map((proposal) => proposal.id)).toEqual(["proposal_trace_trace_smith_pip_provider_bill"]);
  expect(result.proposals[0].payload).toMatchObject({
    traceId: "trace_smith_pip_provider_bill",
    continuityReason: expect.stringContaining("provider")
  });
});

it("does not link summaries that only share the broad Smith case term", async () => {
  const planner = new DeterministicTraceProposalPlanner();
  const result = await planner.proposeTraces({
    reviewedAt: "2026-05-07T12:00:00.000Z",
    summaries: [
      summary({ id: "summary_pip", summaryText: "Smith PIP provider bill review.", sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }] }),
      summary({ id: "summary_bi", summaryText: "Smith BI bodily injury coverage demand.", sourceTurnRanges: [{ threadId: "profile:default", startSequence: 4350, endSequence: 4380 }] })
    ],
    boxes: [],
    anchors: [],
    proposals: [],
    traces: [],
    minimumTraceSummaries: 2,
    minimumConfidence: 0.5
  });

  expect(result.proposals).toEqual([]);
  expect(result.skippedCandidates.some((candidate) => candidate.reason.includes("Only broad shared terms"))).toBe(true);
});
```

- [ ] **Step 2: Run failing trace tests**

Run: `npm test -- tests/traces/trace-proposal-planner.test.ts`

Expected: FAIL because `DeterministicTraceProposalPlanner` does not exist.

- [ ] **Step 3: Implement trace planner**

Create `src/traces/trace-proposal-planner.ts`:

```ts
export interface TraceProposalPlanningRequest {
  reviewedAt: string;
  summaries: Summary[];
  boxes: Box[];
  anchors: Anchor[];
  proposals: MemoryProposal[];
  traces: MemoryTrace[];
  minimumTraceSummaries?: number;
  minimumConfidence?: number;
}

export interface TraceProposalPlanningResult {
  proposals: MemoryProposal[];
  skippedCandidates: { title: string; summaryIds: string[]; reason: string }[];
}
```

Implement `DeterministicTraceProposalPlanner.proposeTraces` so it:

- builds candidate groups from summaries sharing at least three significant terms
- removes broad case-only terms from the continuity check
- requires non-contiguous source ranges or separate creation timestamps
- avoids duplicate proposed or existing trace ids
- creates `trace` proposals with `TraceProposalPayloadSchema` compatible payloads

Use broad-term exclusion:

```ts
const BROAD_TRACE_TERMS = new Set(["smith", "jones", "case", "matter", "claim", "coverage"]);
```

The accepted Smith PIP bill group must include at least two non-broad shared terms such as `pip`, `provider`, and `bill`.

- [ ] **Step 4: Run trace tests and typecheck**

Run: `npm test -- tests/traces/trace-proposal-planner.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/traces/trace-proposal-planner.ts tests/traces/trace-proposal-planner.test.ts
git commit -m "Add deterministic trace proposal planner"
```

## Task 7: Wire Trace Proposals into SleepReviewer and Hermes Sleep

**Files:**
- Modify: `src/sleep/sleep-reviewer.ts`
- Modify: `src/integrations/hermes/sleep-command.ts`
- Modify: `tests/sleep/sleep-reviewer.test.ts`
- Modify: `tests/integrations/hermes-sleep-command.test.ts`

- [ ] **Step 1: Add failing orchestration assertions**

In `tests/sleep/sleep-reviewer.test.ts`, add a test that:

- seeds two non-contiguous Smith PIP provider bill summaries
- runs a new `reviewer.proposeTraces`
- expects one trace proposal id
- expects the proposal to be persisted

Expected assertion:

```ts
expect(result.proposals.map((proposal) => proposal.id)).toEqual(["proposal_trace_trace_smith_pip_provider_bill"]);
await expect(store.listProposals({ proposalType: "trace", state: "proposed" })).resolves.toHaveLength(1);
```

In `tests/integrations/hermes-sleep-command.test.ts`, update the existing populated-store test to expect:

```ts
expect(result.proposalIds).toEqual(expect.arrayContaining([
  "proposal_box_box_topic_smith_pip"
]));
expect(result.proposedTraceIds).toEqual(expect.arrayContaining([
  "trace_smith_pip_provider_bill"
]));
```

The no-op test should expect:

```ts
proposalIds: [],
proposedTraceIds: []
```

- [ ] **Step 2: Run failing tests**

Run: `npm test -- tests/sleep/sleep-reviewer.test.ts tests/integrations/hermes-sleep-command.test.ts`

Expected: FAIL because sleep review does not call trace planning and command output has no `proposalIds` or `proposedTraceIds`.

- [ ] **Step 3: Add trace review method to `SleepReviewer`**

In `src/sleep/sleep-reviewer.ts`, add:

```ts
export interface TraceProposalReviewResult {
  proposals: MemoryProposal[];
}
```

Add method:

```ts
async proposeTraces(request: SleepReviewRequest): Promise<TraceProposalReviewResult> {
  const [summaries, boxes, anchors, proposals, traces] = await Promise.all([
    this.store.listSummaries(),
    this.store.listBoxes(),
    this.store.listAnchors(),
    this.store.listProposals({ state: "proposed" }),
    this.store.listTraces()
  ]);
  const planner = new DeterministicTraceProposalPlanner();
  const result = await planner.proposeTraces({
    reviewedAt: request.reviewedAt,
    summaries,
    boxes,
    anchors,
    proposals,
    traces,
    minimumTraceSummaries: request.minimumTraceSummaries,
    minimumConfidence: request.minimumTraceConfidence
  });

  for (const proposal of result.proposals) {
    await this.store.saveProposal(proposal);
  }

  return { proposals: result.proposals };
}
```

Extend `SleepReviewRequest`:

```ts
minimumTraceSummaries?: number;
minimumBoxConfidence?: number;
minimumTraceConfidence?: number;
```

- [ ] **Step 4: Update `hermes:sleep` input and output**

In `src/integrations/hermes/sleep-command.ts`, extend request schema:

```ts
include_proposals: z.boolean().optional(),
proposal_mode: z.enum(["deterministic"]).optional(),
minimum_trace_summaries: z.number().int().positive().optional(),
minimum_box_confidence: z.number().min(0).max(1).optional(),
minimum_trace_confidence: z.number().min(0).max(1).optional()
```

Extend result:

```ts
proposalIds: string[];
proposedTraceIds: string[];
```

After `proposeBoxes`, call `proposeTraces` when `include_proposals !== false`.

Build ids:

```ts
const proposalIds = [...proposals.proposals, ...traceProposals.proposals].map((proposal) => proposal.id);
const proposedTraceIds = traceProposals.proposals
  .map((proposal) => TraceProposalPayloadSchema.parse(proposal.payload).traceId);
```

Update `noopReason` to consider `proposalIds`.

- [ ] **Step 5: Run focused tests**

Run: `npm test -- tests/sleep/sleep-reviewer.test.ts tests/integrations/hermes-sleep-command.test.ts tests/boxes/box-proposal-planner.test.ts tests/traces/trace-proposal-planner.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sleep/sleep-reviewer.ts src/integrations/hermes/sleep-command.ts tests/sleep/sleep-reviewer.test.ts tests/integrations/hermes-sleep-command.test.ts
git commit -m "Report proposal and trace ids from sleep review"
```

## Task 8: Documentation and Full Verification

**Files:**
- Create: `docs/adr/0034-sleep-review-proposal-layer.md`
- Modify: `docs/adr/0033-hermes-sleep-command.md`

- [ ] **Step 1: Add ADR 0034**

Create `docs/adr/0034-sleep-review-proposal-layer.md`:

```md
# ADR 0034: Sleep Review Proposal Layer

## Status

Accepted.

## Context

Sleep review can decay summaries, refresh boxes, and propose basic boxes. The accordion memory design needs a safer background organization layer for richer boxes, parent/child structure, and non-contiguous traces without automatically rewriting approved memory.

## Decision

Add `MemoryProposal` and `MemoryTrace` domain records.

Sleep review stores proposed boxes, parent/child relationships, and trace links as proposals. Approved boxes remain unchanged until a future explicit review command approves a proposal. Deterministic planners are the default and the test oracle. OpenRouter-backed planning can implement the same planner interfaces in a future phase.

## Consequences

- Sleep review can explain what it found without silently changing approved organization.
- Hermes receives compact proposal ids from `hermes:sleep`.
- Proposal review commands can be added without changing planner output.
- SQLite remains local-first with additive JSON payload tables.
```

- [ ] **Step 2: Update ADR 0033**

In `docs/adr/0033-hermes-sleep-command.md`, update the command output example to include:

```json
{
  "ok": true,
  "reviewedAt": "2026-05-03T00:00:00.000Z",
  "updatedSummaryIds": ["summary_1"],
  "updatedBoxIds": ["box_topic_smith_pip"],
  "proposedBoxIds": ["box_topic_new_case"],
  "proposalIds": ["proposal_box_box_topic_new_case"],
  "proposedTraceIds": ["trace_smith_pip_provider_bill"],
  "noopReason": null
}
```

Add one consequence:

```md
- Proposal ids provide a stable review handle without dumping large proposal payloads into foreground context.
```

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test -- --run
npm run typecheck
```

Expected: all tests pass and TypeScript exits with code 0.

- [ ] **Step 4: Review working tree**

Run: `git status --short`

Expected: only intended files are modified. `example/` may remain untracked and must not be staged.

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/storage/memory-store.ts src/storage/in-memory-store.ts src/storage/sqlite-store.ts src/proposals/proposal-utils.ts src/boxes/box-proposal-planner.ts src/traces/trace-proposal-planner.ts src/sleep/sleep-reviewer.ts src/integrations/hermes/sleep-command.ts tests/proposals/memory-proposal.test.ts tests/storage/sqlite-store.test.ts tests/boxes/box-proposal-planner.test.ts tests/traces/trace-proposal-planner.test.ts tests/sleep/sleep-reviewer.test.ts tests/integrations/hermes-sleep-command.test.ts docs/adr/0033-hermes-sleep-command.md docs/adr/0034-sleep-review-proposal-layer.md
git commit -m "Document sleep review proposal layer"
```

If all implementation commits have already captured the source/test changes, this final commit should include only documentation files.

## Final Integration Checklist

- [ ] `npm test -- --run` passes.
- [ ] `npm run typecheck` passes.
- [ ] `git status --short` shows no unstaged implementation files.
- [ ] `example/` remains untracked and unstaged.
- [ ] `hermes:sleep` no-op output includes empty `proposalIds` and `proposedTraceIds`.
- [ ] `hermes:sleep` populated output includes `proposalIds` and trace ids when deterministic trace candidates exist.
- [ ] No approved boxes are mutated to add parent/child relations.
- [ ] Proposal records always include source summary ids and source turn ranges.

## Execution Notes

Run this plan on a feature branch from `main`.

Recommended branch:

```bash
git switch main
git pull --ff-only forgejo main
git switch -c codex/sleep-review-trace-planning
```

Do not stage `example/`.

When the plan is complete, create a Forgejo PR against `main`, run full verification before merging, and fast-forward local `main` after merge.
