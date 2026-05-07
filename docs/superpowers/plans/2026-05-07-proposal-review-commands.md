# Proposal Review Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add command-based review for sleep-review proposals so agents can list, approve, and reject proposed boxes, parent/child relationships, and traces.

**Architecture:** Add explicit lookup methods and decision metadata to proposal storage, implement a `ProposalReviewer` service for deterministic review semantics, then expose three Hermes command scripts that read JSON from stdin and write compact JSON results.

**Tech Stack:** TypeScript, Node.js, Zod, Vitest, SQLite via `node:sqlite`, existing `MemoryStore`, existing Hermes command conventions.

---

## Scope

This plan implements:

- proposal decision metadata
- proposal/box/trace lookup helpers
- proposal list service
- proposal approve service
- proposal reject service
- Hermes list/approve/reject commands
- package scripts and smoke harness env additions
- ADR documentation

This plan does not implement:

- dashboard UI
- automatic approval
- bulk approval
- retrieval ranking over approved traces
- OpenRouter review decisions
- merge/split/supersession proposals

## File Structure

- Modify `src/domain/types.ts`: add nullable proposal decision fields.
- Modify `src/storage/memory-store.ts`: add `getProposal`, `getBox`, and `getTrace`.
- Modify `src/storage/in-memory-store.ts`: implement lookup helpers.
- Modify `src/storage/sqlite-store.ts`: implement lookup helpers.
- Create `src/proposals/proposal-reviewer.ts`: list, approve, and reject proposal logic.
- Create `src/integrations/hermes/proposals-list-command.ts`: list command bridge.
- Create `src/integrations/hermes/proposals-approve-command.ts`: approve command bridge.
- Create `src/integrations/hermes/proposals-reject-command.ts`: reject command bridge.
- Modify `src/integrations/hermes/smoke-harness.ts`: expose command env vars.
- Modify `package.json`: add command scripts.
- Modify `tests/proposals/memory-proposal.test.ts`: schema decision fields.
- Modify `tests/storage/sqlite-store.test.ts`: lookup helpers.
- Create `tests/proposals/proposal-reviewer.test.ts`: core review behavior.
- Create `tests/integrations/hermes-proposals-commands.test.ts`: command contracts.
- Modify `tests/integrations/hermes-smoke-harness.test.ts`: env var expectations.
- Create `docs/adr/0035-proposal-review-commands.md`: decision record.

## Task 1: Proposal Decision Metadata and Lookup Methods

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/storage/memory-store.ts`
- Modify: `src/storage/in-memory-store.ts`
- Modify: `src/storage/sqlite-store.ts`
- Modify: `tests/proposals/memory-proposal.test.ts`
- Modify: `tests/storage/sqlite-store.test.ts`

- [ ] **Step 1: Write failing schema and storage tests**

In `tests/proposals/memory-proposal.test.ts`, update valid proposal fixtures to include:

```ts
decidedAt: null,
decidedBy: null,
decisionNote: null,
```

Add a test:

```ts
it("parses proposal decision metadata", () => {
  const parsed = MemoryProposalSchema.parse({
    id: "proposal_box_smith_pip",
    proposalType: "box",
    state: "approved",
    title: "Smith PIP Coverage",
    rationale: "Approved box proposal.",
    confidence: 0.82,
    createdAt: "2026-05-07T12:00:00.000Z",
    reviewedAt: "2026-05-07T12:00:00.000Z",
    decidedAt: "2026-05-07T13:00:00.000Z",
    decidedBy: "aaron",
    decisionNote: "Looks right.",
    sourceSummaryIds: ["summary_1"],
    sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }],
    targetBoxIds: ["box_topic_smith_pip"],
    targetTraceIds: [],
    payload: {
      boxId: "box_topic_smith_pip",
      title: "Smith PIP Coverage",
      description: "Proposed topic box for Smith PIP coverage.",
      summary: "Smith PIP coverage and provider bill review.",
      boxType: "topic",
      candidateParentBoxId: null,
      keywords: ["smith", "pip"],
      evidence: ["Shared keywords: smith, pip"],
      sourceSummaryIds: ["summary_1"],
      sourceTurnRanges: [{ threadId: "profile:default", startSequence: 1, endSequence: 3 }]
    }
  });

  expect(parsed.decidedBy).toBe("aaron");
});
```

In `tests/storage/sqlite-store.test.ts`, extend proposal/trace persistence coverage:

```ts
await expect(store.getProposal("proposal_trace_smith_pip_bills")).resolves.toEqual(proposal);
await expect(store.getProposal("missing")).resolves.toBeNull();
await expect(store.getBox("box_1")).resolves.toEqual(makeBox());
await expect(store.getBox("missing")).resolves.toBeNull();
await expect(store.getTrace("trace_smith_pip_bills")).resolves.toEqual(trace);
await expect(store.getTrace("missing")).resolves.toBeNull();
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- tests/proposals/memory-proposal.test.ts tests/storage/sqlite-store.test.ts
```

Expected: FAIL because decision fields and lookup methods do not exist.

- [ ] **Step 3: Update `MemoryProposalSchema`**

In `src/domain/types.ts`, add these fields to `MemoryProposalSchema` after `reviewedAt`:

```ts
decidedAt: IsoDateTimeSchema.nullable().optional().default(null),
decidedBy: z.string().min(1).nullable().optional().default(null),
decisionNote: z.string().nullable().optional().default(null),
```

Using optional defaults preserves compatibility with proposal records created before this phase.

- [ ] **Step 4: Extend `MemoryStore`**

In `src/storage/memory-store.ts`, add:

```ts
getBox(id: string): Promise<Box | null>;
getProposal(id: string): Promise<MemoryProposal | null>;
getTrace(id: string): Promise<MemoryTrace | null>;
```

- [ ] **Step 5: Implement lookup helpers**

In `src/storage/in-memory-store.ts`, implement:

```ts
async getBox(id: string): Promise<Box | null> {
  return structuredClone(this.boxes.find((box) => box.id === id) ?? null);
}

async getProposal(id: string): Promise<MemoryProposal | null> {
  return structuredClone(this.proposals.find((proposal) => proposal.id === id) ?? null);
}

async getTrace(id: string): Promise<MemoryTrace | null> {
  return structuredClone(this.traces.find((trace) => trace.id === id) ?? null);
}
```

In `src/storage/sqlite-store.ts`, implement a private `getPayload` helper and public methods:

```ts
async getBox(id: string): Promise<Box | null> {
  return this.getPayload("boxes", id, BoxSchema);
}

async getProposal(id: string): Promise<MemoryProposal | null> {
  const row = this.database.prepare("select payload from proposals where id = ?").get(id) as PayloadRow | undefined;
  return row ? MemoryProposalSchema.parse(JSON.parse(row.payload)) : null;
}

async getTrace(id: string): Promise<MemoryTrace | null> {
  const row = this.database.prepare("select payload from traces where id = ?").get(id) as PayloadRow | undefined;
  return row ? MemoryTraceSchema.parse(JSON.parse(row.payload)) : null;
}
```

Add `get` to the local `StatementSync` interface:

```ts
get(...anonymousParameters: unknown[]): unknown;
```

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
npm test -- tests/proposals/memory-proposal.test.ts tests/storage/sqlite-store.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/storage/memory-store.ts src/storage/in-memory-store.ts src/storage/sqlite-store.ts tests/proposals/memory-proposal.test.ts tests/storage/sqlite-store.test.ts
git commit -m "Add proposal decision metadata and lookups"
```

## Task 2: ProposalReviewer Service

**Files:**
- Create: `src/proposals/proposal-reviewer.ts`
- Test: `tests/proposals/proposal-reviewer.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `tests/proposals/proposal-reviewer.test.ts` with helper builders for summaries, boxes, proposals, and traces.

Required tests:

```ts
it("lists proposed proposals by default");
it("lists payloads only when requested");
it("approves a box proposal and creates an approved box");
it("approves a parent-child proposal and updates both boxes");
it("fails parent-child approval when either box is missing");
it("approves a trace proposal and creates an approved trace");
it("rejects a proposal without mutating boxes or traces");
it("throws a clear error for missing proposals");
it("throws a clear error for already decided proposals");
```

Use these expected snippets:

```ts
expect(result.createdBoxIds).toEqual(["box_topic_smith_pip"]);
expect(await store.getBox("box_topic_smith_pip")).toEqual(expect.objectContaining({
  state: "approved",
  summaryIds: ["summary_1", "summary_2"]
}));
expect(await store.getProposal("proposal_box_box_topic_smith_pip")).toEqual(expect.objectContaining({
  state: "approved",
  decidedAt: "2026-05-07T14:00:00.000Z",
  decidedBy: "aaron"
}));
```

For parent/child:

```ts
expect(parent?.childBoxIds).toEqual(["box_topic_smith_pip"]);
expect(child?.parentBoxId).toBe("box_case_smith");
```

For trace:

```ts
expect(result.createdTraceIds).toEqual(["trace_smith_pip_provider_bill"]);
expect(await store.getTrace("trace_smith_pip_provider_bill")).toEqual(expect.objectContaining({
  state: "approved",
  summaryIds: ["summary_1", "summary_3"]
}));
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- tests/proposals/proposal-reviewer.test.ts
```

Expected: FAIL because `ProposalReviewer` does not exist.

- [ ] **Step 3: Implement `ProposalReviewer`**

Create `src/proposals/proposal-reviewer.ts`.

Export:

```ts
export interface ProposalListRequest {
  state?: ProposalState;
  proposalType?: ProposalType;
  limit?: number;
  includePayload?: boolean;
}

export interface ProposalDecisionRequest {
  proposalId: string;
  decidedAt: string;
  reviewer?: string;
  note?: string;
}
```

Implement:

- `listProposals`
- `approveProposal`
- `rejectProposal`

Approval behavior:

- load proposal by id
- throw `Proposal ${id} was not found` if missing
- throw `Proposal ${id} is already ${state}` unless state is `proposed`
- dispatch by `proposal.proposalType`
- save updated durable records
- save proposal with `state: approved`, decision metadata

Rejection behavior:

- load proposal by id
- require `proposed`
- save proposal with `state: rejected`, decision metadata
- do not mutate boxes or traces

Use Zod payload schemas:

- `BoxProposalPayloadSchema`
- `ParentChildProposalPayloadSchema`
- `TraceProposalPayloadSchema`

- [ ] **Step 4: Run service tests and typecheck**

Run:

```bash
npm test -- tests/proposals/proposal-reviewer.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proposals/proposal-reviewer.ts tests/proposals/proposal-reviewer.test.ts
git commit -m "Add proposal review service"
```

## Task 3: Hermes Proposal List Command

**Files:**
- Create: `src/integrations/hermes/proposals-list-command.ts`
- Modify: `package.json`
- Test: `tests/integrations/hermes-proposals-commands.test.ts`

- [ ] **Step 1: Write failing list command test**

Create `tests/integrations/hermes-proposals-commands.test.ts`.

Seed a SQLite store with two proposals, one proposed and one rejected.

Test:

```ts
const result = await listHermesProposals({
  databasePath,
  input: JSON.stringify({ state: "proposed", limit: 10 })
});

expect(result).toEqual({
  ok: true,
  count: 1,
  proposals: [
    expect.objectContaining({
      id: "proposal_box_box_topic_smith_pip",
      proposalType: "box",
      state: "proposed",
      payload: undefined
    })
  ]
});
```

Add a second assertion with `include_payload: true` and expect `payload` to be present.

- [ ] **Step 2: Run failing command test**

Run:

```bash
npm test -- tests/integrations/hermes-proposals-commands.test.ts
```

Expected: FAIL because `proposals-list-command.ts` does not exist.

- [ ] **Step 3: Implement list command**

Create `src/integrations/hermes/proposals-list-command.ts` using the same style as `sleep-command.ts`.

Input schema:

```ts
const HermesProposalListRequestSchema = z.object({
  state: ProposalStateSchema.optional(),
  proposal_type: ProposalTypeSchema.optional(),
  limit: z.number().int().positive().optional(),
  include_payload: z.boolean().optional()
});
```

Export:

```ts
export async function listHermesProposals(options: {
  databasePath: string;
  input: string;
}): Promise<HermesProposalListResult>
```

Add script:

```json
"hermes:proposals:list": "tsx src/integrations/hermes/proposals-list-command.ts"
```

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npm test -- tests/integrations/hermes-proposals-commands.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json src/integrations/hermes/proposals-list-command.ts tests/integrations/hermes-proposals-commands.test.ts
git commit -m "Add Hermes proposal list command"
```

## Task 4: Hermes Proposal Approve Command

**Files:**
- Create: `src/integrations/hermes/proposals-approve-command.ts`
- Modify: `package.json`
- Modify: `tests/integrations/hermes-proposals-commands.test.ts`

- [ ] **Step 1: Add failing approve command tests**

In `tests/integrations/hermes-proposals-commands.test.ts`, add tests:

- approves a box proposal and returns created box ids
- approves a parent/child proposal and returns updated box ids
- approves a trace proposal and returns created trace ids
- fails missing proposal with a clear thrown error

Expected box approval:

```ts
expect(result).toMatchObject({
  ok: true,
  proposalId: "proposal_box_box_topic_smith_pip",
  proposalType: "box",
  approvedAt: "2026-05-07T14:00:00.000Z",
  createdBoxIds: ["box_topic_smith_pip"],
  updatedProposalIds: ["proposal_box_box_topic_smith_pip"]
});
```

- [ ] **Step 2: Run failing approve tests**

Run:

```bash
npm test -- tests/integrations/hermes-proposals-commands.test.ts
```

Expected: FAIL because `proposals-approve-command.ts` does not exist.

- [ ] **Step 3: Implement approve command**

Create `src/integrations/hermes/proposals-approve-command.ts`.

Input schema:

```ts
const HermesProposalDecisionRequestSchema = z.object({
  proposal_id: z.string().min(1),
  decided_at: z.string().datetime().optional(),
  reviewer: z.string().min(1).optional(),
  note: z.string().optional()
});
```

Default `decided_at` to `new Date().toISOString()` when omitted.

Add package script:

```json
"hermes:proposals:approve": "tsx src/integrations/hermes/proposals-approve-command.ts"
```

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npm test -- tests/integrations/hermes-proposals-commands.test.ts tests/proposals/proposal-reviewer.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json src/integrations/hermes/proposals-approve-command.ts tests/integrations/hermes-proposals-commands.test.ts
git commit -m "Add Hermes proposal approve command"
```

## Task 5: Hermes Proposal Reject Command

**Files:**
- Create: `src/integrations/hermes/proposals-reject-command.ts`
- Modify: `package.json`
- Modify: `tests/integrations/hermes-proposals-commands.test.ts`

- [ ] **Step 1: Add failing reject command tests**

Add tests:

- rejects a proposed proposal
- does not mutate boxes or traces
- fails for already approved proposals

Expected rejection:

```ts
expect(result).toEqual({
  ok: true,
  proposalId: "proposal_trace_trace_smith_pip_provider_bill",
  proposalType: "trace",
  rejectedAt: "2026-05-07T14:00:00.000Z",
  updatedProposalIds: ["proposal_trace_trace_smith_pip_provider_bill"]
});
```

- [ ] **Step 2: Run failing reject tests**

Run:

```bash
npm test -- tests/integrations/hermes-proposals-commands.test.ts
```

Expected: FAIL because `proposals-reject-command.ts` does not exist.

- [ ] **Step 3: Implement reject command**

Create `src/integrations/hermes/proposals-reject-command.ts` with the same decision input schema as approve.

Add package script:

```json
"hermes:proposals:reject": "tsx src/integrations/hermes/proposals-reject-command.ts"
```

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
npm test -- tests/integrations/hermes-proposals-commands.test.ts tests/proposals/proposal-reviewer.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json src/integrations/hermes/proposals-reject-command.ts tests/integrations/hermes-proposals-commands.test.ts
git commit -m "Add Hermes proposal reject command"
```

## Task 6: Smoke Harness Env and Documentation

**Files:**
- Modify: `src/integrations/hermes/smoke-harness.ts`
- Modify: `tests/integrations/hermes-smoke-harness.test.ts`
- Create: `docs/adr/0035-proposal-review-commands.md`
- Modify: `docs/adr/0034-sleep-review-proposal-layer.md`
- Modify: `docs/adr/0031-hermes-e2e-smoke-harness.md`

- [ ] **Step 1: Add failing smoke harness expectations**

In `tests/integrations/hermes-smoke-harness.test.ts`, expect:

```ts
expect(env.HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_LIST_COMMAND).toBe(
  "npm --silent --prefix /repo/conversational-memory-system run hermes:proposals:list -- --db /tmp/memory.sqlite"
);
expect(env.HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_APPROVE_COMMAND).toBe(
  "npm --silent --prefix /repo/conversational-memory-system run hermes:proposals:approve -- --db /tmp/memory.sqlite"
);
expect(env.HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_REJECT_COMMAND).toBe(
  "npm --silent --prefix /repo/conversational-memory-system run hermes:proposals:reject -- --db /tmp/memory.sqlite"
);
```

- [ ] **Step 2: Run failing smoke test**

Run:

```bash
npm test -- tests/integrations/hermes-smoke-harness.test.ts
```

Expected: FAIL because env vars do not exist.

- [ ] **Step 3: Update smoke harness**

Add env fields:

- `HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_LIST_COMMAND`
- `HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_APPROVE_COMMAND`
- `HERMES_CONVERSATIONAL_MEMORY_PROPOSALS_REJECT_COMMAND`

Build them with existing `npmCommand`.

- [ ] **Step 4: Add ADR 0035**

Create `docs/adr/0035-proposal-review-commands.md`:

```md
# ADR 0035: Proposal Review Commands

## Status

Accepted.

## Context

Sleep review now stores proposed boxes, parent/child relationships, and traces. Hosts need a command-based way to inspect, approve, and reject those proposals without a dashboard.

## Decision

Add `hermes:proposals:list`, `hermes:proposals:approve`, and `hermes:proposals:reject`.

Approval is explicit and proposal-type specific. Box approval creates or updates the target approved box. Parent/child approval wires existing boxes. Trace approval creates an approved `MemoryTrace`. Rejection marks a proposal rejected without deleting it or mutating durable memory.

## Consequences

- Agents can mature memory organization safely.
- Approved structure remains auditable through proposal decision metadata.
- The system stays command-based and host-agnostic.
```

Update ADR 0034 with one consequence:

```md
- Proposal review commands provide the approval path for proposed boxes, parent/child relationships, and traces.
```

Update ADR 0031 env snippet with the three new env vars.

- [ ] **Step 5: Full verification**

Run:

```bash
npm test -- --run
npm run typecheck
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/integrations/hermes/smoke-harness.ts tests/integrations/hermes-smoke-harness.test.ts docs/adr/0035-proposal-review-commands.md docs/adr/0034-sleep-review-proposal-layer.md docs/adr/0031-hermes-e2e-smoke-harness.md
git commit -m "Document proposal review commands"
```

## Final Integration Checklist

- [ ] `npm test -- --run` passes.
- [ ] `npm run typecheck` passes.
- [ ] `hermes:proposals:list` returns proposed proposals by default.
- [ ] `hermes:proposals:approve` approves box, parent/child, and trace proposals.
- [ ] `hermes:proposals:reject` marks proposals rejected without deleting them.
- [ ] Approval fails clearly for missing or already-decided proposals.
- [ ] `example/` remains untracked and unstaged.

## Execution Notes

Run implementation on a feature branch:

```bash
git switch main
git pull --ff-only forgejo main
git switch -c codex/proposal-review-commands
```

Do not stage `example/`.

After implementation, push the feature branch, create a Forgejo PR, merge it, and fast-forward local `main`.
