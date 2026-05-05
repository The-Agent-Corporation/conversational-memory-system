# Standalone Memory Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first testable foundation for the standalone accordion memory service, with a storage decision, stable core contracts, and a Roscoe-Hermes adapter contract.

**Architecture:** Start with a storage-neutral TypeScript core package. The core defines memory events, turns, summaries, boxes, anchors, injection packets, and adapter interfaces. Storage is selected through an ADR before implementing persistence; Roscoe-Hermes is treated as the first host adapter, not as the owner of the memory system.

**Tech Stack:** TypeScript, Node.js, Vitest, Zod, tsx, markdown ADRs. Storage backend to be selected by ADR before Phase 2.

---

## Scope

This plan intentionally does not implement the full memory intelligence system. It creates the foundation needed for later plans:

- standalone project scaffold
- storage backend decision
- core domain contracts
- host adapter contract
- Roscoe-Hermes integration notes
- in-memory reference implementation for tests

Follow-on plans should cover:

- persistent storage implementation
- topic monitor and pre-compaction
- summarizer and anchor detection
- retrieval and injection ranking
- sleep review
- Roscoe-Hermes production adapter

## File Structure

- Create `package.json`: Node/TypeScript project scripts and dependencies.
- Create `tsconfig.json`: strict TypeScript settings.
- Create `vitest.config.ts`: test runner config.
- Create `src/domain/types.ts`: core memory object schemas and TypeScript types.
- Create `src/domain/events.ts`: host-to-memory event schemas.
- Create `src/adapters/host.ts`: generic host adapter contract.
- Create `src/service/memory-service.ts`: storage-neutral memory service facade.
- Create `src/storage/memory-store.ts`: persistence interface.
- Create `src/storage/in-memory-store.ts`: reference in-memory store for tests.
- Create `src/integrations/hermes/contract.ts`: Roscoe-Hermes adapter contract and event mapping.
- Create `docs/adr/0001-storage-backend.md`: storage backend decision record.
- Create `tests/domain/types.test.ts`: schema tests.
- Create `tests/service/memory-service.test.ts`: event ingestion and injection tests.
- Create `tests/integrations/hermes-contract.test.ts`: Hermes contract tests.

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "conversational-memory-system",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.10",
    "tsx": "^4.16.2",
    "typescript": "^5.5.3",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`

Expected: `package-lock.json` is created and install exits with code 0.

- [ ] **Step 5: Verify empty scaffold**

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts
git commit -m "chore: scaffold standalone memory service"
```

If this folder is still not a git repository, skip the commit and note it in the task result.

## Task 2: Storage Backend ADR

**Files:**
- Create: `docs/adr/0001-storage-backend.md`

- [ ] **Step 1: Create ADR directory**

Run: `mkdir -p docs/adr`

Expected: `docs/adr` exists.

- [ ] **Step 2: Create `docs/adr/0001-storage-backend.md`**

```md
# ADR 0001: Initial Storage Backend

## Status

Proposed

## Context

The memory system must be standalone and adapter-driven. Roscoe-Hermes is the first integration target, but later adapters may include Pi, OpenClaw, Codex, Cursor, and other agents.

The system needs:

- append-only transcript storage
- source-linked summaries
- nested boxes
- anchors
- injection audit trail
- vector search over summaries, boxes, and anchors
- re-embedding support
- local development simplicity
- eventual cross-agent portability

## Options

### Option A: Postgres + pgvector

Pros:

- strong relational model
- good auditability
- mature vector indexing
- better for server deployment and future multi-user use
- easier concurrent access across adapters

Cons:

- requires database setup
- less local-first
- Supabase/PostgREST vector queries need RPC or direct SQL

### Option B: SQLite + sqlite-vec or external vector index

Pros:

- local-first
- matches Roscoe-Hermes per-profile SQLite state
- easy backup and inspection
- low infrastructure burden

Cons:

- vector search ecosystem is less mature
- concurrent multi-process writes need care
- server sync would be later work

### Option C: Hybrid SQLite Capture + Postgres Consolidation

Pros:

- fast local capture
- durable server-side consolidation
- good long-term path for cross-agent memory

Cons:

- sync complexity
- two storage layers from day one
- harder to debug initial implementation

## Decision

Start with Option B only if the first implementation is strictly local to Roscoe-Hermes. Start with Option A if the first implementation must support multiple hosts or remote access from the beginning.

For the first implementation plan, defer persistence behind `MemoryStore` and use `InMemoryStore` for tests. Choose A or B before implementing persistent storage.

## Consequences

- Core domain code must not import database-specific libraries.
- All persistence operations go through `MemoryStore`.
- Embedding metadata must include provider, model, dimension, and created time.
- Raw turns remain immutable regardless of backend.
```

- [ ] **Step 3: Review ADR against approved spec**

Run: `rg -n "Supabase mandatory|Pi extension|primary v1 store" docs/adr/0001-storage-backend.md docs/superpowers/specs/2026-05-04-accordion-memory-design.md`

Expected: No lines implying Supabase is mandatory or Pi is the owning runtime.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0001-storage-backend.md
git commit -m "docs: record initial storage backend options"
```

If this folder is still not a git repository, skip the commit and note it in the task result.

## Task 3: Core Domain Types

**Files:**
- Create: `src/domain/types.ts`
- Test: `tests/domain/types.test.ts`

- [ ] **Step 1: Write failing tests in `tests/domain/types.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  AnchorSchema,
  BoxSchema,
  InjectionPacketSchema,
  SummarySchema,
  TurnSchema
} from "../../src/domain/types.js";

describe("domain schemas", () => {
  it("parses a durable turn", () => {
    const parsed = TurnSchema.parse({
      id: "turn_1",
      threadId: "thread_1",
      sequence: 1,
      role: "user",
      content: "Let's discuss the Smith PIP claim.",
      createdAt: "2026-05-04T10:00:00.000Z",
      provenance: "direct_user_input",
      trustLevel: "high",
      metadata: {},
      contentHash: "hash_1"
    });

    expect(parsed.role).toBe("user");
    expect(parsed.provenance).toBe("direct_user_input");
  });

  it("parses a source-linked summary", () => {
    const parsed = SummarySchema.parse({
      id: "summary_1",
      summaryText: "Discussed Smith PIP coverage strategy.",
      sourceTurnRanges: [{ threadId: "thread_1", startSequence: 1, endSequence: 30 }],
      sourceSummaryIds: [],
      boxIds: ["box_1"],
      embedding: {
        provider: "test",
        model: "test-embedding",
        dimensions: 3,
        vector: [0.1, 0.2, 0.3],
        createdAt: "2026-05-04T10:05:00.000Z"
      },
      createdAt: "2026-05-04T10:05:00.000Z",
      model: "test-summarizer",
      promptVersion: "v1",
      confidence: 0.9,
      state: "active",
      detailLevel: "brief",
      tokenCount: 72,
      lastAccessedAt: null,
      version: 1,
      strength: 0.8,
      retrievalCount: 0,
      retrievedAt: null,
      halfLifeHours: 168,
      outcomeScore: null
    });

    expect(parsed.sourceTurnRanges[0].endSequence).toBe(30);
  });

  it("parses nested boxes, anchors, and injection packets", () => {
    expect(BoxSchema.parse({
      id: "box_1",
      title: "Smith case",
      description: "Case-level memory box",
      parentBoxId: null,
      childBoxIds: ["box_2"],
      summaryIds: ["summary_1"],
      turnRanges: [{ threadId: "thread_1", startSequence: 1, endSequence: 30 }],
      state: "active",
      createdAt: "2026-05-04T10:00:00.000Z",
      updatedAt: "2026-05-04T10:00:00.000Z",
      caseId: "smith",
      boxType: "case",
      summary: "Smith case discussion",
      lastActivityAt: "2026-05-04T10:00:00.000Z"
    }).boxType).toBe("case");

    expect(AnchorSchema.parse({
      id: "anchor_1",
      turnId: "turn_4",
      threadId: "thread_1",
      boxId: "box_1",
      anchorType: "deadline",
      content: "PIP demand deadline is June 1.",
      embedding: null,
      createdAt: "2026-05-04T10:02:00.000Z",
      trustLevel: "high",
      source: "direct_user_input"
    }).anchorType).toBe("deadline");

    expect(InjectionPacketSchema.parse({
      id: "inject_1",
      hostSessionId: "hermes_session_1",
      currentTopicSummary: "User is discussing Smith PIP coverage.",
      selectedMemory: "Prior Smith PIP demand strategy exists.",
      sourceSummaryIds: ["summary_1"],
      sourceTurnRanges: [{ threadId: "thread_1", startSequence: 1, endSequence: 30 }],
      boxIds: ["box_1"],
      relevanceReason: "Current topic matches Smith PIP summary.",
      confidence: 0.86,
      disclosureText: "This came from the Smith PIP discussion on May 4.",
      createdAt: "2026-05-04T10:06:00.000Z"
    }).confidence).toBe(0.86);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/domain/types.test.ts`

Expected: FAIL because `src/domain/types.ts` does not exist.

- [ ] **Step 3: Create `src/domain/types.ts`**

```ts
import { z } from "zod";

export const IsoDateTimeSchema = z.string().datetime();

export const RoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export const ProvenanceSchema = z.enum([
  "direct_user_input",
  "assistant_output",
  "tool_output",
  "external_content",
  "system_event"
]);
export const TrustLevelSchema = z.enum(["low", "medium", "high"]);
export const MemoryStateSchema = z.enum([
  "active",
  "compacted",
  "stale",
  "revived",
  "proposed",
  "approved",
  "rejected",
  "superseded",
  "disputed"
]);

export const TurnRangeSchema = z.object({
  threadId: z.string().min(1),
  startSequence: z.number().int().nonnegative(),
  endSequence: z.number().int().nonnegative()
}).refine((range) => range.endSequence >= range.startSequence, {
  message: "endSequence must be greater than or equal to startSequence"
});

export const EmbeddingSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  vector: z.array(z.number()),
  createdAt: IsoDateTimeSchema
}).refine((embedding) => embedding.vector.length === embedding.dimensions, {
  message: "vector length must match dimensions"
});

export const TurnSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  role: RoleSchema,
  content: z.string(),
  createdAt: IsoDateTimeSchema,
  provenance: ProvenanceSchema,
  trustLevel: TrustLevelSchema,
  metadata: z.record(z.unknown()),
  contentHash: z.string().min(1)
});

export const SummarySchema = z.object({
  id: z.string().min(1),
  summaryText: z.string().min(1),
  sourceTurnRanges: z.array(TurnRangeSchema),
  sourceSummaryIds: z.array(z.string().min(1)),
  boxIds: z.array(z.string().min(1)),
  embedding: EmbeddingSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  confidence: z.number().min(0).max(1),
  state: MemoryStateSchema,
  detailLevel: z.enum(["full", "medium", "brief", "stub"]),
  tokenCount: z.number().int().nonnegative(),
  lastAccessedAt: IsoDateTimeSchema.nullable(),
  version: z.number().int().positive(),
  strength: z.number().min(0).max(1),
  retrievalCount: z.number().int().nonnegative(),
  retrievedAt: IsoDateTimeSchema.nullable(),
  halfLifeHours: z.number().positive(),
  outcomeScore: z.number().min(-1).max(1).nullable()
});

export const BoxSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  parentBoxId: z.string().min(1).nullable(),
  childBoxIds: z.array(z.string().min(1)),
  summaryIds: z.array(z.string().min(1)),
  turnRanges: z.array(TurnRangeSchema),
  state: MemoryStateSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  caseId: z.string().min(1).nullable(),
  boxType: z.enum(["case", "topic", "general", "project", "person"]),
  summary: z.string(),
  lastActivityAt: IsoDateTimeSchema
});

export const AnchorSchema = z.object({
  id: z.string().min(1),
  turnId: z.string().min(1),
  threadId: z.string().min(1),
  boxId: z.string().min(1).nullable(),
  anchorType: z.enum(["decision", "deadline", "key_fact", "strategic_insight", "bookmark"]),
  content: z.string().min(1),
  embedding: EmbeddingSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  trustLevel: TrustLevelSchema,
  source: ProvenanceSchema
});

export const InjectionPacketSchema = z.object({
  id: z.string().min(1),
  hostSessionId: z.string().min(1),
  currentTopicSummary: z.string().min(1),
  selectedMemory: z.string().min(1),
  sourceSummaryIds: z.array(z.string().min(1)),
  sourceTurnRanges: z.array(TurnRangeSchema),
  boxIds: z.array(z.string().min(1)),
  relevanceReason: z.string().min(1),
  confidence: z.number().min(0).max(1),
  disclosureText: z.string().min(1),
  createdAt: IsoDateTimeSchema
});

export type Turn = z.infer<typeof TurnSchema>;
export type Summary = z.infer<typeof SummarySchema>;
export type Box = z.infer<typeof BoxSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type InjectionPacket = z.infer<typeof InjectionPacketSchema>;
export type TurnRange = z.infer<typeof TurnRangeSchema>;
export type Embedding = z.infer<typeof EmbeddingSchema>;
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/domain/types.test.ts`

Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts tests/domain/types.test.ts
git commit -m "feat: define core memory domain types"
```

If this folder is still not a git repository, skip the commit and note it in the task result.

## Task 4: Host Event And Adapter Contracts

**Files:**
- Create: `src/domain/events.ts`
- Create: `src/adapters/host.ts`
- Test: `tests/domain/events.test.ts`

- [ ] **Step 1: Write failing tests in `tests/domain/events.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { HostEventSchema } from "../../src/domain/events.js";

describe("host events", () => {
  it("parses inbound and outbound conversation events", () => {
    const inbound = HostEventSchema.parse({
      id: "event_1",
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      sequence: 1,
      type: "conversation_turn",
      role: "user",
      content: "Let's talk about Smith PIP.",
      createdAt: "2026-05-04T10:00:00.000Z",
      metadata: { channel: "telegram" }
    });

    const outbound = HostEventSchema.parse({
      id: "event_2",
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      sequence: 2,
      type: "conversation_turn",
      role: "assistant",
      content: "We can pick up the Smith PIP analysis.",
      createdAt: "2026-05-04T10:00:03.000Z",
      metadata: { channel: "telegram" }
    });

    expect(inbound.role).toBe("user");
    expect(outbound.role).toBe("assistant");
  });

  it("parses host control signals", () => {
    const parsed = HostEventSchema.parse({
      id: "event_3",
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      sequence: 3,
      type: "control_signal",
      signal: "new_conversation",
      createdAt: "2026-05-04T10:05:00.000Z",
      metadata: { command: "/new" }
    });

    expect(parsed.signal).toBe("new_conversation");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/domain/events.test.ts`

Expected: FAIL because `src/domain/events.ts` does not exist.

- [ ] **Step 3: Create `src/domain/events.ts`**

```ts
import { z } from "zod";
import { IsoDateTimeSchema, RoleSchema } from "./types.js";

export const HostNameSchema = z.enum([
  "roscoe-hermes",
  "pi",
  "openclaw",
  "codex",
  "cursor",
  "unknown"
]);

export const ConversationTurnEventSchema = z.object({
  id: z.string().min(1),
  host: HostNameSchema,
  profileId: z.string().min(1),
  hostSessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  type: z.literal("conversation_turn"),
  role: RoleSchema,
  content: z.string(),
  createdAt: IsoDateTimeSchema,
  metadata: z.record(z.unknown())
});

export const ControlSignalEventSchema = z.object({
  id: z.string().min(1),
  host: HostNameSchema,
  profileId: z.string().min(1),
  hostSessionId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  type: z.literal("control_signal"),
  signal: z.enum(["new_conversation", "reset", "compress", "resume_requested", "sleep_review_requested"]),
  createdAt: IsoDateTimeSchema,
  metadata: z.record(z.unknown())
});

export const HostEventSchema = z.discriminatedUnion("type", [
  ConversationTurnEventSchema,
  ControlSignalEventSchema
]);

export type HostEvent = z.infer<typeof HostEventSchema>;
export type ConversationTurnEvent = z.infer<typeof ConversationTurnEventSchema>;
export type ControlSignalEvent = z.infer<typeof ControlSignalEventSchema>;
```

- [ ] **Step 4: Create `src/adapters/host.ts`**

```ts
import type { HostEvent } from "../domain/events.js";
import type { InjectionPacket } from "../domain/types.js";

export interface HostAdapter {
  readonly host: string;
  readEvents(sinceSequence: number): Promise<HostEvent[]>;
  writeInjection(packet: InjectionPacket): Promise<void>;
  acknowledgeInjection(packetId: string): Promise<void>;
  reportApproval(decision: HostApprovalDecision): Promise<void>;
}

export interface HostApprovalDecision {
  id: string;
  host: string;
  profileId: string;
  hostSessionId: string;
  proposalId: string;
  decision: "approved" | "rejected";
  reason: string | null;
  decidedAt: string;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test -- tests/domain/events.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/events.ts src/adapters/host.ts tests/domain/events.test.ts
git commit -m "feat: define host event and adapter contracts"
```

If this folder is still not a git repository, skip the commit and note it in the task result.

## Task 5: Memory Store And Service Facade

**Files:**
- Create: `src/storage/memory-store.ts`
- Create: `src/storage/in-memory-store.ts`
- Create: `src/service/memory-service.ts`
- Test: `tests/service/memory-service.test.ts`

- [ ] **Step 1: Write failing test in `tests/service/memory-service.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { MemoryService } from "../../src/service/memory-service.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";

describe("MemoryService", () => {
  it("ingests host conversation events as durable turns", async () => {
    const store = new InMemoryStore();
    const service = new MemoryService(store);

    await service.ingestEvent({
      id: "event_1",
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      sequence: 1,
      type: "conversation_turn",
      role: "user",
      content: "Let's talk about Smith PIP.",
      createdAt: "2026-05-04T10:00:00.000Z",
      metadata: {}
    });

    const turns = await store.listTurns("session_1");
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe("Let's talk about Smith PIP.");
    expect(turns[0].provenance).toBe("direct_user_input");
  });

  it("returns no injection packet before retrieval exists", async () => {
    const store = new InMemoryStore();
    const service = new MemoryService(store);

    const packet = await service.prepareInjection({
      host: "roscoe-hermes",
      profileId: "default",
      hostSessionId: "session_1",
      currentTopicSummary: "Smith PIP coverage"
    });

    expect(packet).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/service/memory-service.test.ts`

Expected: FAIL because service and store files do not exist.

- [ ] **Step 3: Create `src/storage/memory-store.ts`**

```ts
import type { Anchor, Box, InjectionPacket, Summary, Turn } from "../domain/types.js";

export interface MemoryStore {
  saveTurn(turn: Turn): Promise<void>;
  listTurns(threadId: string): Promise<Turn[]>;
  saveSummary(summary: Summary): Promise<void>;
  listSummaries(): Promise<Summary[]>;
  saveBox(box: Box): Promise<void>;
  listBoxes(): Promise<Box[]>;
  saveAnchor(anchor: Anchor): Promise<void>;
  listAnchors(): Promise<Anchor[]>;
  saveInjection(packet: InjectionPacket): Promise<void>;
  listInjections(hostSessionId: string): Promise<InjectionPacket[]>;
}
```

- [ ] **Step 4: Create `src/storage/in-memory-store.ts`**

```ts
import type { Anchor, Box, InjectionPacket, Summary, Turn } from "../domain/types.js";
import type { MemoryStore } from "./memory-store.js";

export class InMemoryStore implements MemoryStore {
  private readonly turns: Turn[] = [];
  private readonly summaries: Summary[] = [];
  private readonly boxes: Box[] = [];
  private readonly anchors: Anchor[] = [];
  private readonly injections: InjectionPacket[] = [];

  async saveTurn(turn: Turn): Promise<void> {
    this.turns.push(turn);
  }

  async listTurns(threadId: string): Promise<Turn[]> {
    return this.turns.filter((turn) => turn.threadId === threadId);
  }

  async saveSummary(summary: Summary): Promise<void> {
    this.summaries.push(summary);
  }

  async listSummaries(): Promise<Summary[]> {
    return [...this.summaries];
  }

  async saveBox(box: Box): Promise<void> {
    this.boxes.push(box);
  }

  async listBoxes(): Promise<Box[]> {
    return [...this.boxes];
  }

  async saveAnchor(anchor: Anchor): Promise<void> {
    this.anchors.push(anchor);
  }

  async listAnchors(): Promise<Anchor[]> {
    return [...this.anchors];
  }

  async saveInjection(packet: InjectionPacket): Promise<void> {
    this.injections.push(packet);
  }

  async listInjections(hostSessionId: string): Promise<InjectionPacket[]> {
    return this.injections.filter((packet) => packet.hostSessionId === hostSessionId);
  }
}
```

- [ ] **Step 5: Create `src/service/memory-service.ts`**

```ts
import { createHash } from "node:crypto";
import type { HostEvent } from "../domain/events.js";
import type { InjectionPacket, Turn } from "../domain/types.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface InjectionRequest {
  host: string;
  profileId: string;
  hostSessionId: string;
  currentTopicSummary: string;
}

export class MemoryService {
  constructor(private readonly store: MemoryStore) {}

  async ingestEvent(event: HostEvent): Promise<void> {
    if (event.type === "control_signal") {
      return;
    }

    const turn: Turn = {
      id: `turn_${event.id}`,
      threadId: event.hostSessionId,
      sequence: event.sequence,
      role: event.role,
      content: event.content,
      createdAt: event.createdAt,
      provenance: this.provenanceForRole(event.role),
      trustLevel: event.role === "user" ? "high" : "medium",
      metadata: {
        host: event.host,
        profileId: event.profileId,
        hostSessionId: event.hostSessionId,
        ...event.metadata
      },
      contentHash: createHash("sha256").update(event.content).digest("hex")
    };

    await this.store.saveTurn(turn);
  }

  async prepareInjection(_request: InjectionRequest): Promise<InjectionPacket | null> {
    return null;
  }

  private provenanceForRole(role: Turn["role"]): Turn["provenance"] {
    if (role === "user") return "direct_user_input";
    if (role === "assistant") return "assistant_output";
    if (role === "tool") return "tool_output";
    return "system_event";
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -- tests/service/memory-service.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/storage/memory-store.ts src/storage/in-memory-store.ts src/service/memory-service.ts tests/service/memory-service.test.ts
git commit -m "feat: add storage-neutral memory service facade"
```

If this folder is still not a git repository, skip the commit and note it in the task result.

## Task 6: Roscoe-Hermes Adapter Contract

**Files:**
- Create: `src/integrations/hermes/contract.ts`
- Test: `tests/integrations/hermes-contract.test.ts`

- [ ] **Step 1: Write failing test in `tests/integrations/hermes-contract.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { mapHermesTimelineRowToHostEvent } from "../../src/integrations/hermes/contract.js";

describe("Roscoe-Hermes contract", () => {
  it("maps a Hermes unified timeline row to a host event", () => {
    const event = mapHermesTimelineRowToHostEvent({
      id: "42",
      profile_id: "default",
      session_id: "hermes-session",
      sequence: 7,
      role: "user",
      content: "Can we resume the Smith PIP discussion?",
      created_at: "2026-05-04T10:00:00.000Z",
      channel: "telegram",
      metadata_json: "{\"platform\":\"telegram\"}"
    });

    expect(event.host).toBe("roscoe-hermes");
    expect(event.hostSessionId).toBe("hermes-session");
    expect(event.role).toBe("user");
    expect(event.metadata.channel).toBe("telegram");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integrations/hermes-contract.test.ts`

Expected: FAIL because `src/integrations/hermes/contract.ts` does not exist.

- [ ] **Step 3: Create `src/integrations/hermes/contract.ts`**

```ts
import type { ConversationTurnEvent } from "../../domain/events.js";

export interface HermesTimelineRow {
  id: string;
  profile_id: string;
  session_id: string;
  sequence: number;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  created_at: string;
  channel: string | null;
  metadata_json: string | null;
}

export function mapHermesTimelineRowToHostEvent(row: HermesTimelineRow): ConversationTurnEvent {
  return {
    id: `hermes_${row.id}`,
    host: "roscoe-hermes",
    profileId: row.profile_id,
    hostSessionId: row.session_id,
    sequence: row.sequence,
    type: "conversation_turn",
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    metadata: {
      channel: row.channel,
      ...parseMetadata(row.metadata_json)
    }
  };
}

function parseMetadata(metadataJson: string | null): Record<string, unknown> {
  if (!metadataJson) {
    return {};
  }

  const parsed = JSON.parse(metadataJson);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }

  return { rawMetadata: parsed };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- tests/integrations/hermes-contract.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Add integration notes to `docs/adr/0001-storage-backend.md`**

Append this section:

```md
## First Adapter Target: Roscoe-Hermes

Roscoe-Hermes already has a unified per-profile timeline with SQLite and FTS5. The first adapter should ingest from that timeline or from the same write path used by the gateway. The memory system should not replace Hermes memory on day one; it should run alongside it, producing injection packets and search/resume tools.

The first adapter must preserve:

- `profile_id`
- host session id
- monotonic sequence
- platform/channel metadata
- inbound and outbound role
- raw content
- created timestamp
```

- [ ] **Step 6: Commit**

```bash
git add src/integrations/hermes/contract.ts tests/integrations/hermes-contract.test.ts docs/adr/0001-storage-backend.md
git commit -m "feat: define roscoe hermes adapter contract"
```

If this folder is still not a git repository, skip the commit and note it in the task result.

## Task 7: Self-Review And Handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-05-04-standalone-memory-foundation.md`

- [ ] **Step 1: Run verification**

Run:

```bash
npm test
npm run typecheck
```

Expected: both commands PASS.

- [ ] **Step 2: Check for forbidden placeholders**

Run:

```bash
printf '%s\n' 'T''BD' 'TO''DO' 'FIX''ME' 'implement ''later' 'add ''appropriate' 'write tests ''for' 'similar ''to Task' > /tmp/memory-plan-red-flags.txt
rg -n -f /tmp/memory-plan-red-flags.txt docs/superpowers/plans/2026-05-04-standalone-memory-foundation.md src tests docs/adr
```

Expected: no matches in the plan or implementation files.

- [ ] **Step 3: Confirm spec coverage for this foundation slice**

Verify that the implementation now covers:

- standalone memory service boundary
- storage-neutral core
- Roscoe-Hermes as first adapter target
- append-only turn contract
- summary, box, anchor, and injection packet contracts
- provenance and trust fields
- storage backend decision not hardcoded

- [ ] **Step 4: Record gaps for next plan**

Append this section to the end of this plan if not already present:

```md
## Next Plan Gaps

- Persistent storage backend implementation
- Topic monitor and rolling topic summary
- Pre-compaction on topic change
- Summary generation and source range linking
- Anchor detection
- Retrieval and injection ranking
- Sleep review proposals
- Roscoe-Hermes production adapter wiring
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-05-04-standalone-memory-foundation.md
git commit -m "docs: finalize standalone memory foundation plan"
```

If this folder is still not a git repository, skip the commit and note it in the task result.

## Next Plan Gaps

- Persistent storage backend implementation
- Topic monitor and rolling topic summary
- Pre-compaction on topic change
- Summary generation and source range linking
- Anchor detection
- Retrieval and injection ranking
- Sleep review proposals
- Roscoe-Hermes production adapter wiring
