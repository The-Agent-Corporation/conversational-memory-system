# Phase 5: Generic MCP Interface - Pattern Map

**Mapped:** 2026-07-18
**Files analyzed:** 35 new/modified files
**Analogs found:** 30 / 35

## Scope Notes

- This map treats `src/` and `tests/` as authoritative production/test code. `example/` was excluded.
- The worktree was already substantially dirty before mapping; this file is the only change made by the mapper.
- ADR 0046 requires person plus complete allowed-scope authorization at the query boundary. ADR 0044 requires revocation before deletion, attributable invalidation, audit retention, and no native-source mutation.
- Exact files under `src/mcp/tools/` remain planner discretion. Keep task-specific tools; do not collapse them into an action/CRUD dispatcher.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `package.json` | config | request-response | existing command scripts in `package.json` | exact |
| `package-lock.json` | config | batch | existing lockfile dependency entries | exact |
| `src/mcp/server-command.ts` | controller | streaming | `src/integrations/hermes/ingest-command.ts` | role-match |
| `src/mcp/server.ts` | provider | streaming | `src/integrations/hermes/ingest-command.ts` | data-flow match |
| `src/mcp/profile-loader.ts` | config | file-I/O | no close production analog | none |
| `src/mcp/authority.ts` | provider | request-response | strict boundary in `src/retrieval/memory-retriever.ts` | partial |
| `src/mcp/response-envelope.ts` | utility | transform | result DTOs in `src/proposals/proposal-reviewer.ts` | partial |
| `src/mcp/tool-catalog.ts` | route | request-response | explicit command surface in `src/integrations/hermes/` | role-match |
| `src/mcp/confirmation-service.ts` | service | event-driven | exact-confirmation checks in `src/service/source-lifecycle-service.ts` | partial |
| `src/mcp/continuation-cursor.ts` | utility | transform | deterministic hashing in `src/retrieval/memory-retriever.ts` | partial |
| `src/mcp/disclosure-labels.ts` | utility | transform | disclosure builder in `src/retrieval/memory-retriever.ts` | partial |
| `src/mcp/tools/memory-search.ts` | controller | request-response | `src/retrieval/memory-retriever.ts` | role-match |
| `src/mcp/tools/memory-recall.ts` | controller | request-response | `src/retrieval/memory-retriever.ts` | role-match |
| `src/mcp/tools/memory-review.ts` | controller | request-response | `src/proposals/proposal-reviewer.ts` list DTO pattern | partial |
| `src/mcp/tools/memory-expand-subject.ts` | controller | streaming | budget packing in `src/retrieval/memory-retriever.ts` | data-flow match |
| `src/mcp/tools/source-status.ts` | controller | request-response | person-scoped store queries in `src/service/source-lifecycle-service.ts` | partial |
| `src/mcp/tools/proposal-list.ts` | controller | request-response | `src/proposals/proposal-reviewer.ts` | exact role, unsafe scope |
| `src/mcp/tools/history-ingest.ts` | controller | batch | `src/integrations/hermes/ingest-command.ts` | role-match |
| `src/mcp/tools/proposal-decision.ts` | controller | event-driven | `src/proposals/proposal-reviewer.ts` | exact role, non-atomic |
| `src/mcp/tools/source-revocation.ts` | controller | event-driven | `src/service/source-lifecycle-service.ts` | exact role |
| `src/mcp/tools/source-deletion.ts` | controller | event-driven | `src/service/source-lifecycle-service.ts` | exact role, non-atomic |
| `src/retrieval/memory-query-service.ts` | service | transform | `src/retrieval/memory-retriever.ts` | exact algorithm, unsafe side effects |
| `src/retrieval/subject-expansion-service.ts` | service | streaming | retrieval boundary/packing plus `SqliteStore.listCanonicalEvents()` | composite |
| `src/proposals/scoped-proposal-reviewer.ts` | service | CRUD | `src/proposals/proposal-reviewer.ts` | exact role, unsafe scope |
| `src/storage/memory-store.ts` | provider | CRUD | existing atomic daemon commit contracts in same file | exact |
| `src/storage/sqlite-store.ts` | provider | CRUD | existing `BEGIN IMMEDIATE` commit methods in same file | exact |
| `src/storage/in-memory-store.ts` | provider | CRUD | existing interface parity with `MemoryStore` | exact |
| `src/service/source-lifecycle-service.ts` | service | CRUD | existing lifecycle methods in same file | exact, requires atomic refactor |
| `tests/mcp/profile-loader.test.ts` | test | file-I/O | `tests/integrations/hermes-ingest-command.test.ts` temp-path pattern | role-match |
| `tests/mcp/read-tools.test.ts` | test | request-response | `tests/retrieval/memory-retriever.test.ts` | exact behavior family |
| `tests/mcp/subject-expansion.test.ts` | test | streaming | retrieval boundary tests plus SQLite ordering tests | composite |
| `tests/mcp/confirmation-service.test.ts` | test | event-driven | `tests/service/source-lifecycle-service.test.ts` | role-match |
| `tests/mcp/mutation-tools.test.ts` | test | CRUD | lifecycle and proposal reviewer tests | role-match |
| `tests/mcp/tool-catalog.test.ts` | test | request-response | explicit Hermes command tests | partial |
| `tests/mcp/stdio-server.test.ts` | test | streaming | `tests/integrations/hermes-ingest-command.test.ts` | data-flow match |

## Pattern Assignments

### MCP command, server, catalog, and task handlers

**Applies to:** `src/mcp/server-command.ts`, `src/mcp/server.ts`, `src/mcp/tool-catalog.ts`, and `src/mcp/tools/*.ts`

**Analog:** `src/integrations/hermes/ingest-command.ts`

**Imports and schema-at-boundary pattern** (lines 1-18):

```typescript
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SqliteStore } from "../../storage/sqlite-store.js";

const IngestOptionsSchema = z.object({
  databasePath: z.string().min(1),
  input: z.string().min(1)
});
```

Copy the ESM `.js` import convention and parse inputs before opening services. For MCP, startup args resolve the authority once; database/person/scopes must not appear in tool schemas.

**Resource lifecycle pattern** (lines 27-59):

```typescript
const parsedOptions = IngestOptionsSchema.parse(options);
const store = new SqliteStore(parsedOptions.databasePath);

try {
  // application operation
  return result;
} finally {
  store.close();
}
```

The STDIO server is longer-lived, but must preserve the same explicit ownership of the store and guaranteed close on EOF/signals.

**Entrypoint/error-channel pattern** (lines 216-258):

```typescript
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
```

For MCP, reserve stdout entirely for `StdioServerTransport`; sanitize stderr rather than forwarding raw path/content-bearing exception messages.

**Package script pattern:** `package.json` lines 6-34 use `tsx src/...-command.ts`. Add `memory:mcp` in that style and add the pinned SDK dependency while upgrading Zod within v3.

**Testing analog:** `tests/integrations/hermes-ingest-command.test.ts` lines 1-20 creates a unique temp directory and removes it in `afterEach`; lines 23-77 invokes the public command function, reopens the SQLite file, and verifies persisted effects. Reuse that isolation pattern for profile/config tests. STDIO tests should additionally spawn the real child and assert transport stdout contains protocol frames only.

---

### Immutable profile authority and strict read services

**Applies to:** `src/mcp/authority.ts`, `src/retrieval/memory-query-service.ts`, read handlers, and `src/proposals/scoped-proposal-reviewer.ts`

**Analog:** `src/retrieval/memory-retriever.ts`

**Fail-closed authority pattern** (lines 127-166):

```typescript
const hasPerson = request.personId !== undefined;
const hasScopes = request.allowedScopeIds !== undefined;
if (hasPerson !== hasScopes) {
  throw new Error("Scoped retrieval requires both personId and allowedScopeIds");
}
if (!hasPerson || !hasScopes) {
  if (!allowLegacyUnscoped) {
    throw new Error("Unscoped retrieval is disabled; provide personId and allowedScopeIds");
  }
}

const personId = request.personId!;
const allowedScopeIds = [...new Set(request.allowedScopeIds!)].sort();
const allowed = new Set(allowedScopeIds);
const scopedSummaries = summaries.filter((summary) =>
  summary.personId === personId &&
  (summary.scopeIds ?? ["personal"]).every((scopeId) => allowed.has(scopeId))
);
```

Continue the dependency rule from lines 146-159: a trace or box is eligible only when every referenced summary survived authorization. In MCP, remove the legacy-unscoped option entirely and capture the normalized authority at startup.

**Deterministic ranking pattern** (lines 325-355):

```typescript
const ranked: RankedMemory[] = [
  ...summaries.map((summary) => rankSummary(topicWords, summary, options)),
  ...traceCandidates,
  ...anchors.map((anchor) => rankAnchor(topicWords, anchor, options))
].filter((memory) => memory.score > 0);

return ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
```

Extract/reuse this pure ranking rather than creating an MCP-specific ranker.

**Critical unsafe section — do not copy:** `MemoryRetriever.prepareInjection()` lines 82-108 saves an injection, updates access timestamps/counts, strengthens summaries, and revives stale summaries. MCP reads must stop before all of those writes and should be testable through a read-only store connection.

**Testing analog:** `tests/retrieval/memory-retriever.test.ts` lines 89-161 constructs allowed, denied, mixed-scope, and other-person objects, then asserts denied content and mixed dependencies do not surface. Lines 163-185 prove missing/partial authority fails closed. Copy this adversarial fixture shape and add durable-table snapshots before/after each MCP read.

---

### Subject expansion, token packing, continuation, and disclosure

**Applies to:** `src/retrieval/subject-expansion-service.ts`, `src/mcp/continuation-cursor.ts`, `src/mcp/disclosure-labels.ts`, `src/mcp/response-envelope.ts`, and `src/mcp/tools/memory-expand-subject.ts`

**Composite analogs:** `src/retrieval/memory-retriever.ts` and `src/storage/sqlite-store.ts`

**Budget packing pattern** (`memory-retriever.ts` lines 169-205):

```typescript
const selected: RankedMemory[] = [];
let usedTokens = 0;
for (const memory of deduped) {
  if (usedTokens + memory.tokenCount > maxMemoryTokens) continue;
  selected.push(memory);
  usedTokens += memory.tokenCount;
}
```

Expansion should use one shared estimator (`memory-retriever.ts` lines 598-600), report requested/used/unit/version, and issue a continuation rather than silently dropping the remainder.

**Canonical event ordering pattern** (`sqlite-store.ts` lines 652-661):

```typescript
select payload from canonical_events
where person_id = ?
order by occurred_at asc, native_sequence asc, id asc
```

Bind continuation to this tuple, the authority/profile fingerprint, normalized subject, estimator version, and expiry. Never embed memory text in the cursor.

**Disclosure pattern** (`memory-retriever.ts` lines 578-595): build disclosure from the exact selected count and budget use. MCP must extend it with assistive/non-authoritative language, timestamps, confidence, provenance, scopes, and continuation state, and keep rendered text semantically equal to `structuredContent`.

**No direct analog:** authenticated stateless cursors and SDK `structuredContent`/`outputSchema` parity are new to production. Follow the pinned official SDK pattern in RESEARCH.md, not a hand-written JSON-RPC envelope.

---

### Scoped proposal review and proposal decision mutations

**Applies to:** `src/proposals/scoped-proposal-reviewer.ts`, `src/mcp/tools/proposal-list.ts`, and `src/mcp/tools/proposal-decision.ts`

**Analog:** `src/proposals/proposal-reviewer.ts`

**Stable list DTO pattern** (lines 28-47, 71-82):

```typescript
return {
  ok: true,
  proposals: limited.map((proposal) => formatProposal(proposal, request.includePayload ?? false)),
  count: limited.length
};
```

Keep stable explicit DTOs, but authorize proposal ownership and every referenced summary scope before formatting. Do not expose payload by default.

**Decision/state-transition pattern** (lines 85-108, 262-273): load only a proposed item, dispatch by explicit proposal type, then set `state`, `decidedAt`, `decidedBy`, and `decisionNote` explicitly.

**Critical unsafe sections — do not wrap directly:**

- Lines 71-76 list globally before any person/scope filtering.
- Lines 233-241 load a globally addressable proposal and include its raw ID/state in errors.
- Lines 137-139, 169-181, and 218-219 perform multiple writes without one transaction.

Add scoped query methods and one atomic store operation per approval/rejection effect set. Externally collapse not-found/unauthorized into one sanitized result.

**Testing analog:** `tests/proposals/proposal-reviewer.test.ts` provides fixtures for each proposal type and decision state. Extend that shape with two people, mixed-scope summary dependencies, cross-profile confirmation attempts, and fault injection between every write boundary.

---

### Preview/confirmation tickets, revocation, deletion, and atomic storage

**Applies to:** `src/mcp/confirmation-service.ts`, mutation handlers, `src/service/source-lifecycle-service.ts`, and all three storage adapters/contracts

**Analogs:** `src/service/source-lifecycle-service.ts`, `src/storage/memory-store.ts`, and `src/storage/sqlite-store.ts`

**Existing exact-target prerequisite pattern** (`source-lifecycle-service.ts` lines 120-133):

```typescript
if (input.confirmedCandidateId !== input.candidateId) {
  throw new Error("Source deletion confirmation does not match the candidate ID");
}
const grant = await this.store.getSourceGrant(this.grantId(input.personId, input.candidateId));
if (!grant || grant.personId !== input.personId) throw new Error("Source grant not found");
if (grant.state !== "revoked") throw new Error("Source must be revoked before deletion");
```

Preserve these domain revalidations, but a candidate-ID echo is not sufficient for MCP. The new ticket must bind profile fingerprint, tool, normalized targets/parameters, exact preview effects, expiry, and one-time use.

**Person-isolated lifecycle pattern** (`source-lifecycle-service.ts` lines 69-89): grant lookup derives from person plus candidate, revocation is explicit, and `assertApproved` fails closed. Keep revocation and deletion separate tools.

**Atomic store contract pattern** (`memory-store.ts` lines 64-70): existing multi-write operations are named `commit*` methods on the store contract. Add task-specific atomic proposal/lifecycle commit methods here and implement parity in SQLite and in-memory adapters; do not expose a generic transaction callback.

**SQLite transaction pattern** (`sqlite-store.ts` lines 336-379):

```typescript
const parsed = CommitImportBatchInputSchema.parse(input);
this.validateImportOwnership(parsed);
this.database.exec("begin immediate");
try {
  await this.assertWriteAuthority(parsed.authority, parsed.personId, "approved-import");
  // revalidate expected state, apply all writes, reach fault-injection seams
  this.database.exec("commit");
  return parsed.receipt;
} catch (error) {
  this.database.exec("rollback");
  throw error;
}
```

Copy validation-before-write, revalidation inside `BEGIN IMMEDIATE`, explicit commit/rollback, and fault-injection seams. Extend the constructor (`sqlite-store.ts` lines 110-118) with read-only/no-migration and bounded-timeout modes instead of opening every connection identically.

**Critical unsafe section — refactor before exposure:** `SourceLifecycleService.deleteRevokedSource()` lines 134-203 computes the right attributable effect set but performs audit, supersessions, deletes, and completion audit as separate writes. Move the full effect set behind one atomic commit while preserving ADR 0044 behavior and aggregate content-free audit details.

**Testing analog:** `tests/service/source-lifecycle-service.test.ts` lines 11-79 verifies exact person-owned approval, immutable scope, isolated revocation, and audit. Lines 81 onward build two synthetic sources and prove only the revoked source's derived objects are invalidated. Add mismatch, expiry, replay, changed-parameter, changed-effects/state, cross-profile, and rollback cases; assert tickets are consumed after attempted execution.

## Shared Patterns

### Authorization

**Source:** `src/retrieval/memory-retriever.ts` lines 127-166 and ADR 0046.

Apply to every read, preview, and execute operation: immutable startup profile, exactly one person, normalized complete scope list, and fail-closed dependency authorization. Tool input must never carry authority-changing fields.

### Validation and imports

**Source:** `src/integrations/hermes/ingest-command.ts` lines 1-18 and `src/service/source-lifecycle-service.ts` lines 46-66.

Use ESM `.js` imports, `import type` for types, Zod parsing at boundaries, explicit result interfaces, and domain schemas before persistence. Keep external model adapters optional.

### Error handling and logging

**Source:** `src/integrations/hermes/ingest-command.ts` lines 252-257 and SQLite transaction catch blocks.

Use `try/finally` for owned resources and `try/catch` rollback for atomic writes. MCP-facing failures need stable sanitized codes; do not emit raw exception text, paths, IDs, titles, or memory content. stdout belongs exclusively to MCP framing, stderr diagnostics must be content-free.

### Determinism

**Source:** `src/retrieval/memory-retriever.ts` lines 325-355, 540-566 and `src/storage/sqlite-store.ts` lines 652-661.

Normalize arrays by dedupe plus sort, use deterministic tie-breakers, preserve `(occurredAt, nativeSequence, id)` ordering, and report budget estimator version. Confirmation intent hashing must use one canonical serialization.

### Testing

Use synthetic fixtures only. Mirror existing Vitest conventions: typed fixture builders, `InMemoryStore` for service behavior, temp SQLite files for persistence/transactions, and public-command invocation. Required adversarial matrix: two people; at least three scopes; mixed-scope summaries/traces/boxes/proposals; safe aliases distinct from raw metadata; database snapshots proving zero semantic read writes; fault injection; concurrent reader/writer exercise; clean real STDIO initialize/list/call/shutdown.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/mcp/profile-loader.ts` | config | file-I/O | No versioned named-profile loader exists; implement from RESEARCH.md and fail before transport connection. |
| `src/mcp/confirmation-service.ts` | service | event-driven | Existing exact-ID confirmation is not short-lived, single-use, profile/intent/effects-bound ticketing. |
| `src/mcp/continuation-cursor.ts` | utility | transform | No authenticated stateless continuation exists. |
| `src/mcp/response-envelope.ts` | utility | transform | No production MCP structured/text dual-output envelope exists. |
| `src/mcp/server.ts` | provider | streaming | No production MCP lifecycle/STDIO server exists; use official SDK v1.29.0 rather than copying a host command protocol. |

## Metadata

**Analog search scope:** `src/integrations/hermes/`, `src/retrieval/`, `src/proposals/`, `src/service/`, `src/storage/`, corresponding `tests/`; `example/` excluded

**Primary analog families:** 5 (Hermes command boundary, retrieval, proposal review, source lifecycle, SQLite storage)

**Files scanned:** 10 primary production/test analogs plus package/storage contracts and ADR 0044/0046

**Pattern extraction date:** 2026-07-18

**Privacy check:** no live personal history or native source content was opened; only source code, planning files, ADRs, and synthetic tests were inspected.
