# Phase 6: Zero-Knowledge Multi-Device Sync - Pattern Map

**Mapped:** 2026-07-19
**Files analyzed:** 42 planned new/modified paths
**Analogs found:** 34 / 42 (including partial role/data-flow matches)

This map derives exact candidate files from the structure and Wave 0 gaps in `06-RESEARCH.md`. The research names several directories rather than final filenames; the planner may consolidate files, but should retain the pattern assignment for each responsibility. Every analog below is a live `src/` or `tests/` path. `example/` was excluded.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md` | config / ADR | request-response protocol specification | `docs/adr/0044-source-revocation-and-attributable-deletion.md` | role-match |
| `package.json` | config | dependency/runtime configuration | `package.json` | exact modification |
| `package-lock.json` | config | dependency lock | `package-lock.json` | exact modification |
| `src/types/node-sqlite.d.ts` | config / types | request-response | `src/types/node-sqlite.d.ts` | exact modification |
| `src/sync/domain/types.ts` | model | event-driven + pub-sub | `src/storage/mcp-mutation-contracts.ts` | role-match |
| `src/sync/crypto/crypto-provider.ts` | provider | transform | none | no analog |
| `src/sync/crypto/libsodium-crypto-provider.ts` | provider | transform | none | no analog |
| `src/sync/secrets/device-secret-store.ts` | provider | CRUD | `src/storage/memory-store.ts` | partial interface match |
| `src/sync/secrets/macos-keychain-secret-store.ts` | provider | request-response | none | no analog |
| `src/sync/transport/sync-relay.ts` | provider | request-response | `src/storage/memory-store.ts` | partial interface match |
| `src/sync/transport/http-sync-relay.ts` | provider | HTTP request-response | `src/integrations/hermes/adapter.ts` | partial adapter match |
| `src/sync/control/sync-control-service.ts` | service | request-response + CRUD | `src/service/source-lifecycle-service.ts` | role-match |
| `src/sync/replication/sync-replication-service.ts` | service | pub-sub + batch | `src/daemon/contraction-runner.ts` | data-flow match |
| `src/sync/materialization/sync-materializer.ts` | service | event-driven + transform | `src/service/source-lifecycle-service.ts` | role-match |
| `src/relay/domain/types.ts` | model | request-response | `src/storage/mcp-mutation-contracts.ts` | role-match |
| `src/relay/auth/relay-account-authenticator.ts` | provider | request-response | `src/mcp/authority.ts` | partial authority match |
| `src/relay/service/opaque-relay-service.ts` | service | request-response + append-only CRUD | `src/service/source-lifecycle-service.ts` | role-match |
| `src/relay/http/relay-http-server.ts` | provider / server | bounded HTTP request-response | `src/mcp/server.ts` | transport/runtime match |
| `src/relay/storage/relay-store.ts` | model / store | append-only CRUD | `src/storage/memory-store.ts` | exact role, different domain |
| `src/relay/storage/in-memory-relay-store.ts` | store | append-only CRUD | `src/storage/in-memory-store.ts` | role-match |
| `src/relay/storage/sqlite-relay-store.ts` | store | append-only CRUD | `src/storage/sqlite-store.ts` | role-match |
| `src/storage/memory-store.ts` | store contract | CRUD + event-driven | existing file | exact modification |
| `src/storage/in-memory-store.ts` | store | CRUD + event-driven | existing file, lines 332-442 | exact modification |
| `src/storage/sqlite-store.ts` | store | CRUD + event-driven | existing file, lines 430-540 | exact modification |
| `src/storage/mcp-mutation-contracts.ts` | model / transaction contract | event-driven | existing file, lines 291-438 | exact modification |
| `src/service/source-lifecycle-service.ts` | service | CRUD + event-driven | existing file, lines 145-200 | exact modification |
| `src/daemon/contraction-runner.ts` | service | batch + transform | existing file, lines 55-180, 225-252 | exact modification |
| `tests/sync/fixtures.ts` | test utility | event-driven + batch | `tests/daemon/fixtures.ts` | role-match |
| `tests/sync/crypto-envelope.test.ts` | test | transform | `tests/domain/canonical.test.ts` | partial schema-test match |
| `tests/sync/convergence.test.ts` | test | pub-sub + batch | `tests/daemon/contraction-runner.test.ts` | data-flow match |
| `tests/sync/enrollment.test.ts` | test | request-response | `tests/mcp/confirmation-service.test.ts` | state-machine match |
| `tests/sync/recovery.test.ts` | test | request-response | `tests/mcp/confirmation-service.test.ts` | state-machine match |
| `tests/sync/revocation.test.ts` | test | CRUD + event-driven | `tests/service/source-lifecycle-service.test.ts` | exact behavior match |
| `tests/sync/conflicts.test.ts` | test | event-driven | `tests/service/source-lifecycle-service.test.ts` | partial reviewed-state match |
| `tests/sync/deletion-tombstones.test.ts` | test | event-driven + CRUD | `tests/service/source-lifecycle-service.test.ts` | exact domain match |
| `tests/sync/device-secret-store.test.ts` | test | CRUD | `tests/mcp/confirmation-service.test.ts` | partial non-persistence match |
| `tests/relay/metadata-contract.test.ts` | test | request-response | `tests/domain/canonical.test.ts` | schema-test match |
| `tests/relay/zero-knowledge-boundary.test.ts` | test | request-response | `tests/mcp/confirmation-service.test.ts` | negative-persistence match |
| `tests/relay/membership-cas.test.ts` | test | request-response + CRUD | `tests/storage/sqlite-store.test.ts` | transaction match |
| `tests/relay/append-only-store.test.ts` | test | append-only CRUD | `tests/storage/sqlite-store.test.ts` | store-test match |
| `tests/relay/http-relay.test.ts` | test | loopback HTTP request-response | `tests/mcp/stdio-server.test.ts` | transport-boundary match |
| `tests/sync/http-sync-relay.test.ts` | test | loopback HTTP request-response | `tests/integrations/hermes-adapter.test.ts` | client-adapter match |
| `tests/integration/multi-device-sync.test.ts` | test | pub-sub + batch | `tests/daemon/contraction-runner.test.ts` | data-flow match |

## Pattern Assignments

### Domain and wire models

**Apply to:** `src/sync/domain/types.ts`, `src/relay/domain/types.ts`, and the sync extensions in `src/storage/mcp-mutation-contracts.ts`.

**Primary analog:** `src/storage/mcp-mutation-contracts.ts`

**Imports and strict schema pattern** (lines 1-35):

```typescript
import { createHash } from "node:crypto";
import { z } from "zod";
import { HistoricalBootstrapCheckpointSchema } from "../bootstrap/types.js";
import { CanonicalEventSchema, MemorySourceSchema } from "../domain/canonical.js";

const IdSchema = z.string().min(1);
const IdListSchema = z.array(IdSchema);
const EffectCountsSchema = z.record(z.number().int().nonnegative());

export const MutationCommitReceiptSchema = z.object({
  operation: z.enum(["history_import", "proposal_decision", "source_revocation", "source_deletion"]),
  status: z.enum(["COMMITTED", "STATE_CHANGED"]),
  personId: IdSchema,
  targetId: IdSchema,
  effectCounts: EffectCountsSchema,
  committedAt: IsoDateTimeSchema
}).strict();
```

Copy the `.js` ESM import convention, exported Zod schema plus inferred type, `.strict()` wire boundaries, bounded primitives, and explicit receipt/status enums. Unlike the existing canonical schemas in `src/domain/canonical.ts:10-48`, all relay-facing and cryptographic protocol schemas must be strict and reject unknown fields.

**Cross-person and exact-binding validation** (lines 291-331):

```typescript
export const CommitHistoryImportInputSchema = z.object({
  operation: z.literal("history_import"),
  personId: IdSchema,
  candidateId: IdSchema,
  // expected state, next state, effects and receipt omitted
}).strict().superRefine((input, context) => {
  const owned = [input.expectedSource, input.expectedCheckpoint, input.expectedGrant,
    ...input.nextSources, ...input.nextCanonicalEvents, ...input.auditEvents]
    .filter(Boolean) as Array<{ personId: string }>;
  if (owned.some((item) => item.personId !== input.personId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "History import crosses a person boundary" });
  }
  if (input.expectedSourceStateFingerprint !== mutationEffectsFingerprint(input.expectedSource) ||
      input.effectsFingerprint !== mutationEffectsFingerprint(input.effects)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "History import fingerprint mismatch" });
  }
});
```

For decrypted operations, perform person, source, scope, author-device, epoch, sequence, predecessor, operation ID, expected-base, and receipt bindings in the schema/contract before materialization. Do not copy `mutationEffectsFingerprint` as the wire canonicalizer: research explicitly requires RFC 8785 `canonicalize` for protocol bytes.

**Canonical identity/provenance fields** (source `src/domain/canonical.ts`, lines 27-47):

```typescript
export const CanonicalEventSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceApplication: z.string().min(1),
  sourceProfileId: z.string().min(1),
  scopeId: z.string().min(1).optional(),
  nativeSessionId: z.string().min(1),
  nativeEventId: z.string().min(1),
  nativeSequence: z.number().int().nonnegative(),
  causalParentId: z.string().min(1).nullable(),
  // content, timestamps, provenance, trust and hashes follow
});
```

Plain operations retain these fields inside ciphertext. Relay domain types must not import `CanonicalEventSchema`, source lifecycle types, summaries, profiles, or any plaintext operation schema.

### Store contracts and adapter parity

**Apply to:** `src/storage/memory-store.ts`, both local adapters, `src/relay/storage/relay-store.ts`, and both relay adapters.

**Primary analog:** `src/storage/memory-store.ts`, lines 48-83.

```typescript
export interface MemoryStore {
  commitHistoryImport(input: CommitHistoryImportInput): Promise<MutationCommitReceipt>;
  commitProposalDecision(input: CommitProposalDecisionInput): Promise<MutationCommitReceipt>;
  commitSourceRevocation(input: CommitSourceRevocationInput): Promise<MutationCommitReceipt>;
  commitSourceDeletion(input: CommitSourceDeletionInput): Promise<MutationCommitReceipt>;
  inspectSourceDeletionEffects(
    personId: string,
    candidateId: string,
    auditEventIds: string[]
  ): Promise<SourceDeletionEffects>;
  // task-specific daemon and domain methods continue
}
```

Add task-specific atomic methods, not a generic transaction callback. Local sync additions should cover device registry, epochs, accepted operations, outbox, replay frontier, tombstones, quarantine, conflicts, acknowledgements, and atomic remote apply. Relay store methods should cover exact membership CAS and immutable append/list/head/recovery-package operations only.

**In-memory atomic staging pattern** (source `src/storage/in-memory-store.ts`, lines 348-389):

```typescript
const parsed = CommitSourceDeletionInputSchema.parse(input);
const grant = this.sourceGrants.find((item) => item.id === parsed.expectedGrant.id) ?? null;
if (!this.sameRecord(grant, parsed.expectedGrant) || !this.sourceDeletionEffectsMatch(parsed)) {
  return this.stateChanged(parsed.receipt);
}
const staged = {
  sources: structuredClone(this.sources),
  canonicalEvents: structuredClone(this.canonicalEvents),
  quarantine: structuredClone(this.quarantineRecords),
  audits: structuredClone(this.sourceLifecycleAuditEvents)
};
this.faultInjector?.reach("source_deletion_before_write");
// mutate only staged collections
this.replace(this.sources, staged.sources);
this.replace(this.canonicalEvents, staged.canonicalEvents);
this.replace(this.quarantineRecords, staged.quarantine);
this.replace(this.sourceLifecycleAuditEvents, staged.audits);
return structuredClone(parsed.receipt);
```

Clone every collection participating in a sync commit, inject faults between semantic boundaries, and publish staged state only after all checks succeed. Maintain SQLite/in-memory semantic equivalence.

**SQLite transaction and CAS pattern** (source `src/storage/sqlite-store.ts`, lines 430-489):

```typescript
const parsed = CommitSourceRevocationInputSchema.parse(input);
this.database.exec("begin immediate");
try {
  const current = await this.getSourceGrant(parsed.expectedGrant.id);
  if (!this.sameRecord(current, parsed.expectedGrant)) {
    this.database.exec("rollback");
    return this.stateChanged(parsed.receipt);
  }
  this.faultInjector?.reach("source_revocation_before_write");
  await this.saveSourceGrant(parsed.nextGrant);
  await this.saveSourceLifecycleAuditEvent(parsed.auditEvent);
  this.database.exec("commit");
  return parsed.receipt;
} catch (error) {
  this.database.exec("rollback");
  throw error;
}
```

Use `begin immediate`, compare the full expected state inside the transaction, return a typed stale-state receipt after rollback, commit effects plus outbox/frontier/checkpoint atomically, and rollback/rethrow every error. Exact membership CAS should use the same pattern with `previousControlVersion`.

**Ownership checks before writes** (source `src/storage/in-memory-store.ts`, lines 950-977):

```typescript
for (const source of input.sources) {
  if (source.personId !== personId ||
      source.instanceId !== expectedGrant.candidateId ||
      source.scopeId !== receipt.scopeId) {
    throw new Error("Import source ownership mismatch");
  }
}
for (const event of input.canonicalEvents) {
  if (event.personId !== personId || event.scopeId !== receipt.scopeId) {
    throw new Error("Canonical event ownership mismatch");
  }
}
```

Remote origin is not authority. After decrypting, revalidate every person/source/scope dependency before any canonical or retrievable write. A remote apply must be marked as remote origin so it cannot generate a duplicate local outbox operation.

### Enrollment, recovery, revocation, and materialization services

**Apply to:** `src/sync/control/sync-control-service.ts`, `src/sync/materialization/sync-materializer.ts`, `src/relay/service/opaque-relay-service.ts`, and source lifecycle integration.

**Primary analog:** `src/service/source-lifecycle-service.ts`.

**Dependency injection and person isolation** (lines 41-67):

```typescript
export class SourceLifecycleService {
  constructor(private readonly store: MemoryStore) {}

  async approve(input: ApproveSourceInput): Promise<SourceGrant> {
    const id = this.grantId(input.personId, input.candidateId);
    const existing = await this.store.getSourceGrant(id);
    if (existing && existing.personId !== input.personId) {
      throw new Error("Cannot reassign a source grant to another person");
    }
    const grant = SourceGrantSchema.parse({ /* explicit next state */ });
    await this.store.saveSourceGrant(grant);
    return grant;
  }
}
```

Inject interfaces (`MemoryStore`, `CryptoProvider`, `DeviceSecretStore`, `OpaqueSyncRelay`, clock) through constructors. Resolve and schema-parse explicit next state; do not allow an existing device/sync object to be rebound to another person or account.

**Plan/confirm/commit and drift handling** (lines 145-200):

```typescript
if (input.confirmedCandidateId !== input.candidateId) {
  throw new Error("Source deletion confirmation does not match the candidate ID");
}
const plan = await this.planDeletion(input);
const receipt = await this.commitDeletion(plan);
if (receipt.status !== "COMMITTED") throw new Error("Source state changed before deletion");
return this.deletionResult(plan);
```

Use the same split for enrollment approval, revocation, recovery rotation, conflict resolution, and restoration: preview an exact target/effect set, bind confirmation to it, then atomically revalidate at commit. Enrollment verification code comparison and protocol approval are human gates, not automatic reducer decisions.

**Deletion/tombstone semantics:** ADR 0044 lines 13-22 requires separate revocation/deletion, physical removal of attributable active memory, fail-closed derived invalidation, retained anti-reimport/audit state, content-free audit records, and no source-file mutation. Phase 6 adds an encrypted permanent tombstone and non-retrievable quarantine without weakening that local contract.

### Exact confirmation, replay, and expiry

**Apply to:** enrollment request/code state, recovery authorization, conflict/restoration confirmation, and relay one-time request consumption.

**Analog:** `src/mcp/confirmation-service.ts`, lines 59-110.

```typescript
export class ConfirmationService {
  private readonly tickets = new Map<string, ConfirmationTicket>();
  private readonly consumed = new Set<string>();

  issue(intent: ConfirmationIntent): ConfirmationPreview {
    const now = this.nowMs();
    // generate unique random token and bind digest to exact intent
    this.tickets.set(tokenKey, { intentDigest: digest(normalizeIntent(intent)), expiresAtMs });
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consumeExact(token: string, intent: ConfirmationIntent): void {
    if (this.consumed.has(tokenKey)) throw new ConfirmationError("CONFIRMATION_REPLAYED");
    const ticket = this.tickets.get(tokenKey);
    if (!ticket) throw new ConfirmationError("CONFIRMATION_MISMATCH");
    this.tickets.delete(tokenKey);
    this.consumed.add(tokenKey); // consume before returning any result
    if (this.nowMs() >= ticket.expiresAtMs) throw new ConfirmationError("CONFIRMATION_EXPIRED");
    if (!timingSafeEqual(ticket.intentDigest, digest(normalizeIntent(intent)))) {
      throw new ConfirmationError("CONFIRMATION_MISMATCH");
    }
  }
}
```

Enrollment differs cryptographically: both devices derive the displayed code from the approved full transcript; the relay must not generate it. Reuse the expiry, exact-binding, consume-before-result, replay, injectable clock/randomness, and content-free error-code patterns.

### Replication and affected-range recomputation

**Apply to:** `src/sync/replication/sync-replication-service.ts`, remote materialization, and `src/daemon/contraction-runner.ts` integration.

**Analog:** `src/daemon/contraction-runner.ts`.

**Bounded resumable work and authority checks** (lines 55-107):

```typescript
const parsedAuthority = WriteAuthoritySchema.safeParse(this.options.authority);
if (!parsedAuthority.success) throw new Error("Contraction write authority is required");
if (!(await this.store.getPerson(personId))) throw new Error(`Unknown contraction person ${personId}`);
const job = await this.store.getContractionJob(jobId);
if (!job || job.personId !== personId) throw new Error("Contraction job person ownership mismatch");

const checkpointCanResume = previous !== null &&
  previous.generation === job.generation &&
  (previous.processedThroughOrderKey === null ||
    compareKeys(job.earliestAffected, previous.processedThroughOrderKey) >= 0);

const maxEvents = limits.maxEvents ?? DEFAULT_CONTRACTION_LIMITS.maxEvents;
const maxMonotonicMs = limits.maxMonotonicMs ?? DEFAULT_CONTRACTION_LIMITS.maxMonotonicMs;
```

Pull/apply in bounded pages, persist a contiguous per-device replay frontier and predecessor hash, never advance across a gap, and resume after restart. Apply membership/control and tombstones to a stable frontier before ordinary data. Enqueue the merged earliest affected canonical range into the existing contraction job path.

**Preserve unaffected prefix** (lines 225-252):

```typescript
const earliestIndex = Math.max(0,
  events.findIndex((event) => compareKeys(orderKey(event)!, affected) >= 0));
let boundary = earliestIndex;
for (const summary of summaries) {
  // rewind only when the affected event intersects an existing summary
  if (first <= earliestIndex && last >= earliestIndex) boundary = Math.min(boundary, first);
}
return boundary;
```

Sync delivery order and device sequence are never canonical conversation order. Preserve the existing canonical order/provenance and recompute only the affected suffix/topic boundary.

### Relay account authority

**Apply to:** `src/relay/auth/relay-account-authenticator.ts` and request authorization in `src/relay/service/opaque-relay-service.ts`.

**Partial analog:** `src/mcp/authority.ts`, lines 19-43.

```typescript
export const createProfileAuthority = (input: ProfileAuthorityInput): ProfileAuthority => {
  const allowedScopeIds = Object.freeze([...new Set(input.allowedScopeIds)].sort());
  const fingerprintPayload = JSON.stringify({
    version: 1,
    profileName: input.profileName,
    databasePath: input.databasePath,
    personId: input.personId,
    allowedScopeIds
  });
  return Object.freeze({
    ...input,
    allowedScopeIds,
    fingerprint: createHash("sha256").update(fingerprintPayload).digest("hex")
  });
};
```

Normalize and freeze verified authority. For relay auth, verify JWT issuer, audience, signature, expiry and not-before through `jose`, then derive/persist only a pseudonymous identity from verified `iss` and `sub`. Never persist email/name claims. Relay-account authority permits ciphertext service access only; device/recovery signatures and local key possession remain separate gates.

### Production HTTP relay boundary

**Apply to:** Plan 06-05 `src/relay/http/relay-http-server.ts`, Plan 06-06 `src/sync/transport/http-sync-relay.ts`, and Plan 06-08 daemon composition/integration tests.

Use Node's injected HTTP/fetch primitives behind strict versioned request/response schemas. The server authenticates one bearer header, bounds headers/body/page/fanout/time/rate/concurrency before dispatch, calls only `OpaqueRelayService`, and maps failures to stable content-free statuses. The client implements the complete `SyncRelay` interface, requires HTTPS outside explicit loopback tests, bounds response bytes and deadlines, never persists/logs tokens, and reconciles ambiguous append/CAS outcomes through exact receipts/heads before resubmission. A real ephemeral loopback server/client test is required; an in-process service call or fake relay does not prove the production transport.

### Test fixtures and adversarial tests

**Apply to:** all `tests/sync/*`, `tests/relay/*`, and `tests/integration/multi-device-sync.test.ts`.

**State-machine fixture/test pattern** (source `tests/mcp/confirmation-service.test.ts`, lines 10-27 and 79-113):

```typescript
const intent = (overrides: Partial<ConfirmationIntent> = {}): ConfirmationIntent => ({
  profileFingerprint: "profile-alpha",
  tool: "proposal_approve_execute",
  targetIds: ["proposal-2", "proposal-1"],
  normalizedParameters: { note: "synthetic", reviewer: "fixture" },
  effectsFingerprint: "effects-alpha",
  ...overrides
});

it("rejects a token at or after its exact expiry instant", () => {
  const clock = createFakeClock();
  const service = new ConfirmationService({ clock: () => clock.now(), ttlMs: 1_000 });
  const preview = service.issue(intent());
  clock.advance(1_000);
  expectCode(() => service.consumeExact(preview.token, intent()), "CONFIRMATION_EXPIRED");
});
```

Build fixture factories with overrides, fake wall and monotonic clocks, injected deterministic test crypto, synthetic IDs/keys/content, named fault boundaries, and explicit error-code assertions. Do not place production secrets or personal-history values in fixtures.

**Isolation/deletion integration pattern** (source `tests/service/source-lifecycle-service.test.ts`, lines 49-72 and 164-213): test two people with the same candidate/device-like identifier; mutate one and assert the other is unchanged. Require exact confirmation, prerequisites, content-free audit/tombstone state, removal from active/retrievable tables, and preservation of unrelated memory.

**Convergence/restart pattern** (source `tests/daemon/contraction-runner.test.ts`, lines 86-129, 132-179, and 181-218): snapshot the unaffected prefix; append or late-insert synthetic events; restart with only durable state; assert deterministic replay, unique outputs, bounded slices, and stable-key resume rather than array offsets.

**Schema-negative pattern** (source `tests/domain/canonical.test.ts`, lines 49-72): use `safeParse`, inject an invalid/unknown/non-JSON field, and assert failure. Relay metadata tests should enumerate the exact allowed persistent keys and scan serialized relay state/logs for all synthetic plaintext, person/source/scope/profile/workspace labels, device names, passphrases, recovery seeds, and epoch keys.

## Shared Patterns

### Authentication and authorization

**Sources:** `src/mcp/authority.ts:19-43`, `src/daemon/contraction-runner.ts:55-76`, ADR 0046 lines 13-24.

Apply three independent gates: verified relay account, current active device/recovery authorization, and local content-key possession. After decrypt, require exact person plus complete allowed-scope dependency closure. Full device archive sync never widens MCP profile authority.

### Error handling

**Sources:** `src/mcp/confirmation-service.ts:3-13,92-110`, `src/storage/sqlite-store.ts:430-489`.

Use stable content-free error codes for protocol failures. Consume one-time authority before revealing results. Roll back and rethrow transactional errors; represent expected CAS drift with a typed stale-state receipt. Never include plaintext, keys, passphrases, request bodies, device names, or decrypted diagnostics in relay errors/logs.

### Validation

**Sources:** `src/storage/mcp-mutation-contracts.ts:28-35,291-331,388-426`.

Parse at every boundary using strict Zod schemas; use `superRefine` for cross-record ownership, exact state transition, ID/effect, receipt, and fingerprint bindings. Enforce size/count/sequence-gap limits before expensive signature/decryption work. Authenticate the envelope before parsing plaintext.

### Transactions, replay, and origin

**Sources:** `src/storage/in-memory-store.ts:348-389`, `src/storage/sqlite-store.ts:430-540`.

Every authoritative local mutation records its domain effects and sync outbox atomically. Every remote apply records the accepted operation, replay frontier, materialized effects or conflict/quarantine, and contraction range atomically. Identical replay is idempotent; different bytes at one `(syncId, deviceId, sequence)` are equivocation; missing predecessors remain pending. Remote-origin apply must not emit a duplicate local operation.

### Deletion and quarantine

**Sources:** ADR 0044 lines 13-28; `src/service/source-lifecycle-service.ts:145-200`; `src/storage/sqlite-store.ts:452-488`.

Revocation and deletion remain separate. Tombstones are permanent encrypted content-free audit facts and apply before additions. Covered stale content enters a separate non-retrievable quarantine. Reconnection never restores it; restoration is a new explicitly reviewed operation referencing the tombstone.

### Adapter parity and deterministic tests

**Sources:** `src/storage/memory-store.ts:48-130`, `src/storage/in-memory-store.ts:332-442`, `src/storage/sqlite-store.ts:430-540`.

Every store contract addition lands in both in-memory and SQLite adapters with the same validation, ordering, stale-state behavior, fault boundaries, and receipts. Hosted relay, live IdP, personal history, and external models are never required for automated tests.

## No Analog Found

| File | Role | Data Flow | Reason / Planner Direction |
|---|---|---|---|
| `src/sync/crypto/crypto-provider.ts` | provider | transform | No production cryptographic provider exists. Define a narrow byte-oriented injectable interface from the approved ADR; production randomness cannot be deterministic. |
| `src/sync/crypto/libsodium-crypto-provider.ts` | provider | transform | No production AEAD/signature/key-exchange implementation exists. Follow `06-RESEARCH.md` and fixed vectors only after independent protocol approval. |
| `src/sync/secrets/macos-keychain-secret-store.ts` | provider | request-response | No OS secret-store adapter exists. Use Keychain Services behind `DeviceSecretStore`; never pass secrets through argv/stdout or fall back to plaintext files/SQLite. |
| `src/relay/auth/relay-account-authenticator.ts` | provider | request-response | `src/mcp/authority.ts` supplies only normalization/fingerprinting, not JWT verification. Use `jose` behind an adapter and deterministic fake. |
| `src/relay/domain/types.ts` | model | request-response | Strict schema conventions exist, but no opaque zero-knowledge relay domain exists. Enforce an import-boundary test preventing semantic-domain imports. |
| `src/relay/service/opaque-relay-service.ts` | service | request-response | Service orchestration patterns exist, but no append-only ciphertext relay exists. Implement only allowed metadata, membership CAS, append/list/head and opaque recovery packages; no decrypt method. |
| `src/relay/storage/sqlite-relay-store.ts` | store | append-only CRUD | SQLite mechanics have an analog, but the separate relay database and exact metadata allowlist are new. Do not reuse local memory tables or schemas. |
| `src/sync/transport/http-sync-relay.ts` | provider | HTTP request-response | No production SyncRelay transport exists. Implement the exact Plan 05 versioned contract with HTTPS, deadlines, bounded responses, token redaction, and lost-response reconciliation in Plan 06-06. |

## Planner Guardrails

1. Plan and obtain independent approval for `docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md` before enabling production cryptography. Assumptions A1-A7 in research are not settled implementation choices.
2. Keep relay modules unable to import local semantic memory schemas. Relay-visible state is pseudonymous authorization/routing/replay data plus opaque ciphertext only.
3. Extend local authoritative transactions with an outbox rather than emitting before commit or with a best-effort after-commit callback.
4. Apply control and tombstones before data; check tombstones in the same transaction that would activate incoming content.
5. Preserve incompatible concurrent reviewed decisions as explicit unresolved multi-value conflicts; never choose by timestamp or delivery order.
6. Feed affected canonical ranges to the existing contraction queue; do not introduce a second derived-memory writer.
7. Require in-memory/SQLite parity and synthetic deterministic fault/convergence tests for every new state transition.
8. Plan 06-05 owns the versioned HTTP/HTTPS relay server, Plan 06-06 owns HttpSyncRelay, and Plan 06-08 owns production daemon selection plus the real loopback end-to-end scenario; do not assign transport work to another plan.

## Metadata

**Analog search scope:** `src/domain`, `src/storage`, `src/service`, `src/daemon`, `src/mcp`, `tests/domain`, `tests/storage`, `tests/service`, `tests/daemon`, `tests/mcp`, and relevant ADRs. `example/` excluded.

**Production/test files scanned:** 139 live paths inventoried; 14 analog/source files read for concrete patterns and tests.

**Primary analog set (5 pattern families):** strict domain/transaction contracts; store interface plus adapter parity; reviewed source lifecycle service; exact confirmation/authority; bounded contraction and restart tests.

**Pattern extraction date:** 2026-07-19

**Dirty-worktree note:** the worktree was materially dirty before mapping. No source or test file was modified; only this pattern map was created.
