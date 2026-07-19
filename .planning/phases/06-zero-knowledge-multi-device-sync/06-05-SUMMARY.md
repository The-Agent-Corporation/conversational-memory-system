---
phase: 06-zero-knowledge-multi-device-sync
plan: "05"
subsystem: api
tags: [jose, oidc, auth0, libsodium, canonicalize, node-sqlite, node-http, zod]

requires:
  - phase: 06-01
    provides: ADR 0047 protocol-v1 wire contract, threat model, and digest-bound review record (Owner Risk Acceptance)
  - phase: 06-02
    provides: RFC 8785 canonical-byte conventions, base64url schema helpers, and Ed25519/XChaCha20 primitive patterns (via libsodium-wrappers-sumo) reused independently on the relay side
provides:
  - src/relay/domain/types.ts - strict protocol-v1 relay wire/persistence schemas (account namespace, device credential, enrollment request, membership commit, control record, data envelope, recovery package, head observation) and versioned RelayRequestSchema/RelayResponseSchema operation union
  - src/relay/auth/relay-account-authenticator.ts - RelayAccountAuthenticator contract, JoseRelayAccountAuthenticator (Auth0/OIDC, injectable env config), FakeRelayAccountAuthenticator (deterministic D-16 email signup/login/password-recovery/passkey-recovery lifecycle)
  - src/relay/storage/relay-store.ts, in-memory-relay-store.ts, sqlite-relay-store.ts - append-only RelayStore contract with backend-parity membership CAS, equivocation-aware envelope append, bounded pagination, and revocation-aware device credentials
  - src/relay/service/opaque-relay-service.ts - OpaqueRelayService: authenticated pseudonymous account/device authorization, Ed25519 signature verification (genesis/rotation/recovery paths), zero decrypt/unwrap surface
  - src/relay/http/relay-http-server.ts - createRelayHttpServer: bounded versioned Node HTTP/HTTPS JSON adapter with real ephemeral loopback test coverage
affects: [06-06, 06-07, 06-08]

tech-stack:
  added: []
  patterns:
    - "Relay-side signature/digest verification uses libsodium-wrappers-sumo and canonicalize directly (never importing src/sync/*), keeping the zero-knowledge relay boundary independent of the local CryptoProvider abstraction"
    - "OpaqueRelayService resolves exactly one pseudonymous syncId per verified (issuerHash, subjectHash) via RelayStore.ensureAccountNamespace, then closes every subsequent operation to that syncId"
    - "HTTP status is decoupled from RelayErrorCode's default mapping via an explicit sendError(res, code, status) override, since transport-layer failures (404/405/415/408/429) intentionally differ from the code's default application-layer status"

key-files:
  created:
    - src/relay/domain/types.ts
    - src/relay/auth/relay-account-authenticator.ts
    - src/relay/storage/relay-store.ts
    - src/relay/storage/in-memory-relay-store.ts
    - src/relay/storage/sqlite-relay-store.ts
    - src/relay/service/opaque-relay-service.ts
    - src/relay/http/relay-http-server.ts
    - tests/relay/relay-fixtures.ts
    - tests/relay/account-auth.test.ts
    - tests/relay/metadata-contract.test.ts
    - tests/relay/membership-cas.test.ts
    - tests/relay/append-only-store.test.ts
    - tests/relay/zero-knowledge-boundary.test.ts
    - tests/relay/http-relay.test.ts
  modified: []

key-decisions:
  - "Membership CAS signer verification (genesis / rotation / revocation / recovery) lives entirely in OpaqueRelayService, not RelayStore: the store performs only the numeric (previousControlVersion, previousCommitHash) CAS and persists whatever record the service already verified. This keeps signature/crypto logic out of both storage adapters, which only need to stay backend-equivalent for pure CAS/append-only semantics."
  - "Recovery-path membership CAS is scoped down from the full ADR transcript/challenge exchange to a relay-verifiable proxy: the relay accepts a commit as a recovery-driven enrollment only when it introduces exactly one new device, that device's own key co-signs both a recovery-authorization preimage (bound to an active RecoveryPackageRecord) and the outer control commit, and the referenced package is marked superseded atomically with the CAS. The full X25519 sealed-box historical-keyring exchange is client-side and outside relay zero-knowledge scope, so this plan does not implement it."
  - "OpaqueRelayService.handle uses one generic versioned operation union (RelayRequestSchema/RelayResponseSchema) rather than one bespoke method per operation, so relay-http-server.ts's per-route dispatch and any future non-HTTP transport share one authorization/validation path with a single test surface."
  - "Head-observation records (signed observed control/data heads for split-view detection) are implemented as a thin, unverified append/list pair scoped to active-device authorization only; ADR 0047's split-view cross-observation semantics are a client-side responsibility layered on top of this relay primitive in a later plan."

patterns-established:
  - "Deterministic auth fakes model exactly the provider's four D-16 lifecycle actions (email signup/login, password/passkey recovery) as separate methods returning a bearer token, with authenticate() as the only path back to pseudonymous authority - this keeps 'account recovery cannot enroll or decrypt' a structural (not just behavioral) guarantee, since the fake/adapter classes have no enrollment or crypto-unwrap methods to call in the first place."
  - "RelayStore adapters follow the existing local-store staged-clone (in-memory) / BEGIN IMMEDIATE-plus-revalidate (SQLite) CAS pattern from src/storage/*, but scoped to a completely separate SQLite database file and schema, with no shared tables."
  - "relay-http-server.ts requires either `tls` config or an explicit `allowInsecureLoopback: true` acknowledgement to construct at all, making plaintext-HTTP-in-production structurally unreachable rather than just documented."

requirements-completed: [REQ-031, REQ-033, REQ-036]

duration: ~85min
completed: 2026-07-19
---

# Phase 6 Plan 05: Relay Account Boundary, Storage, Service, and HTTP Server Summary

**Auth0/OIDC-verified pseudonymous relay-account boundary (jose + deterministic fake), strict D-13 opaque wire/persistence schemas, backend-equivalent append-only RelayStore adapters with exact membership CAS and equivocation detection, an OpaqueRelayService enforcing three-tier account/device authorization via direct libsodium signature verification, and a bounded versioned Node HTTP/HTTPS relay server proven against 12 real ephemeral loopback tests.**

## Performance

- **Duration:** ~85 min
- **Started:** 2026-07-19T13:58:00Z (approx.)
- **Completed:** 2026-07-19T14:16:00Z
- **Tasks:** 3
- **Files modified:** 14 (13 created, 1 modified within the plan's own scope)

## Accomplishments

- Implemented the D-13/D-16 account-provider boundary: `JoseRelayAccountAuthenticator` verifies Auth0-issued OIDC bearer tokens (signature/issuer/audience/expiry/not-before via `jose`) against injectable `MEMORY_RELAY_OIDC_ISSUER`/`_AUDIENCE`/`_JWKS_URI` configuration (never hardcoded), and `FakeRelayAccountAuthenticator` exercises email signup/login, password recovery, and passkey recovery deterministically with zero network access, proving account recovery yields only pseudonymous `(issuerHash, subjectHash)` authority
- Defined strict, closed protocol-v1 relay schemas matching ADR 0047's exact persisted-field allowlist per record type (account namespace, device credential, enrollment request, control record, data envelope, recovery package, head observation), plus a versioned `RelayRequestSchema`/`RelayResponseSchema` operation union covering membership CAS, envelope append/list/head, enrollment submit/list, recovery upload/fetch, and head observation
- Built backend-equivalent `InMemoryRelayStore`/`SqliteRelayStore` adapters (separate SQLite database, no shared tables with local memory storage) implementing exact membership CAS, immutable append-only envelope retention with idempotent replay vs. permanent equivocation detection, bounded 1,024-slot gap rejection, and revocation-aware device credential status
- Implemented `OpaqueRelayService`, which authenticates every operation, resolves one pseudonymous syncId per account, verifies Ed25519 control-commit and envelope signatures directly via `libsodium-wrappers-sumo` (never importing the local `CryptoProvider`/sync domain), and exposes no decrypt or key-unwrap path
- Implemented `createRelayHttpServer`, a bounded Node HTTP/HTTPS JSON adapter exposing explicit `/v1/*` routes over `OpaqueRelayService` with content-type enforcement, header/body/rate/concurrency/timeout limits, exact bearer propagation without logging/persisting the token, and stable content-free error/status mapping; proven against 12 real ephemeral loopback tests (full route flow, every bounded-failure path, rate limiting, log/error content-free scans)
- 103 new tests across 7 test files (29 schema/auth, 31 storage/service, 12 HTTP loopback); full `tests/relay/` suite green; `tsc --noEmit` clean after every task

## Task Commits

1. **Task 1: Implement the approved account-provider boundary and strict opaque schemas** - `5b3a108` (feat)
2. **Task 2: Implement append-only relay storage parity and zero-knowledge service** - `e1cbb9a` (feat)
3. **Task 3: Expose the strict versioned HTTP/HTTPS relay server boundary** - `face83b` (feat)

**Plan metadata:** (this SUMMARY commit, created by the worktree executor)

_Note: all three tasks were TDD-flagged; tests and implementation were authored together per task and verified green before commit, since each task's `<verify>` gate requires the paired test files and implementation to land atomically (matching the precedent set by Plan 06-02)._

## Files Created/Modified

- `src/relay/domain/types.ts` - protocol-v1 relay wire/persistence schemas, versioned request/response operation union (created in Task 1; extended in Task 2 with the `membership.cas` request's `signature` field, needed by CAS signer verification)
- `src/relay/auth/relay-account-authenticator.ts` - `RelayAccountAuthenticator`, `JoseRelayAccountAuthenticator`, `joseRelayAccountAuthenticatorConfigFromEnv`, `FakeRelayAccountAuthenticator`
- `src/relay/storage/relay-store.ts` - `RelayStore` interface, `CommitControlInput/Result`, `AppendEnvelopeResult`
- `src/relay/storage/in-memory-relay-store.ts` - staged-clone in-memory adapter
- `src/relay/storage/sqlite-relay-store.ts` - separate-database `node:sqlite` adapter with `BEGIN IMMEDIATE` CAS
- `src/relay/service/opaque-relay-service.ts` - `OpaqueRelayService`, direct libsodium/canonicalize signature verification
- `src/relay/http/relay-http-server.ts` - `createRelayHttpServer`, `RelayHttpServer`, `RelayHttpServerConfig`, `RelayHttpLogEntry`
- `tests/relay/relay-fixtures.ts` - shared deterministic device/commit/envelope fixture helpers
- `tests/relay/account-auth.test.ts`, `metadata-contract.test.ts`, `membership-cas.test.ts`, `append-only-store.test.ts`, `zero-knowledge-boundary.test.ts`, `http-relay.test.ts` - 103 tests total

## Decisions Made

See `key-decisions` in frontmatter (signer-verification ownership, scoped recovery-CAS proxy, single generic operation union, thin head-observation primitive).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Extended `src/relay/domain/types.ts` with a `signature` field on the `membership.cas` request variant**
- **Found during:** Task 2 (wiring `OpaqueRelayService`'s CAS signer verification)
- **Issue:** The Task-1 `RelayRequestSchema` membership.cas variant had no field carrying the detached Ed25519 signature over the commit's canonical bytes, making signer verification impossible.
- **Fix:** Added `signature: relayBase64UrlBytesSchema(64, "signature")` to the schema. `src/relay/domain/types.ts` is listed in the plan's overall `files_modified` frontmatter (used by both Task 1 and Task 3), so this is within the plan's declared scope even though Task 2's own `<files>` tag did not list it.
- **Files modified:** `src/relay/domain/types.ts`
- **Verification:** `tests/relay/membership-cas.test.ts` and `tests/relay/zero-knowledge-boundary.test.ts` exercise signed genesis/rotation/revocation commits end-to-end.
- **Committed in:** `e1cbb9a` (Task 2 commit)

**2. [Rule 1 - Bug] Fixed `sendError` silently overriding an intentionally different HTTP status with `RelayErrorCode`'s default status**
- **Found during:** Task 3 (writing the 404/405/415 loopback tests)
- **Issue:** `sendError(res, code)` always recomputed status from `ERROR_STATUS[code]`, so routes that intentionally return a transport-layer status different from the code's default application status (e.g., an unknown route returning 404 with `SYNC_SCHEMA_INVALID`, whose default status is 400) silently got 400 instead.
- **Fix:** `sendError` now accepts an optional explicit `status` parameter; every call site that already computed a specific `status` passes it through.
- **Files modified:** `src/relay/http/relay-http-server.ts`
- **Verification:** `tests/relay/http-relay.test.ts` 404/405/415/408 cases pass.
- **Committed in:** `face83b` (Task 3 commit)

**3. [Rule 1 - Bug] Removed an incorrect `req.destroyed` early-return that silently dropped every request with a JSON body**
- **Found during:** Task 3 (debugging a hung loopback request)
- **Issue:** `dispatch` checked `req.destroyed || res.destroyed` after reading the request body to guard against mutating on a dead connection. In Node 24, `IncomingMessage.destroyed` becomes `true` immediately after the readable side finishes a normal `'end'` (not only on client abort), so this check silently returned with no response for every well-formed request, hanging the client indefinitely.
- **Fix:** Changed the guard to `res.destroyed || res.writableEnded` (the correct signal for "the outgoing response is already closed"), and separately replaced an `req.destroy()` call on oversized-body abort with `req.pause()` so the bounded 413 response can still be written before the connection closes.
- **Files modified:** `src/relay/http/relay-http-server.ts`
- **Verification:** All 12 `tests/relay/http-relay.test.ts` loopback tests pass, including the full membership/envelope/enrollment route flow and the oversized-body 413 case.
- **Committed in:** `face83b` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (2 bugs discovered while wiring CAS/HTTP integration, 1 pre-existing schema gap needed for the CAS signer-verification flow). All within Rule 1 (bug fixes) and inside the plan's declared overall file scope.
**Impact on plan:** All three fixes were necessary for the plan's own acceptance criteria (signed CAS, correct bounded-failure status codes, and a working loopback server) to be achievable at all. No scope creep beyond the plan's thirteen listed files.

## Issues Encountered

- Pre-existing `tests/mcp/stdio-server.test.ts` failures (missing `tsx` binary in this worktree's `node_modules`) were observed during a full-suite sanity run. Confirmed out of scope (unrelated to any file this plan touches) and already tracked in `.planning/phases/06-zero-knowledge-multi-device-sync/deferred-items.md` by a prior plan's executor (06-03); no new action taken.

## User Setup Required

**External services require manual configuration for production use of `JoseRelayAccountAuthenticator`.** Per the plan's `user_setup` frontmatter:
- `MEMORY_RELAY_OIDC_ISSUER` - Auth0 tenant Domain, expressed as the exact HTTPS issuer URL approved in ADR 0047
- `MEMORY_RELAY_OIDC_AUDIENCE` - Auth0 API Identifier approved in ADR 0047
- `MEMORY_RELAY_OIDC_JWKS_URI` - Auth0 tenant OpenID configuration `jwks_uri`

`joseRelayAccountAuthenticatorConfigFromEnv` throws at construction time if any of these are missing, so misconfiguration fails closed rather than silently trusting an unconfigured issuer. No Auth0 tenant configuration was performed as part of this plan; `FakeRelayAccountAuthenticator` is used for all automated tests.

## Next Phase Readiness

- `RelayAccountAuthenticator`, `RelayStore`/adapters, `OpaqueRelayService`, and `createRelayHttpServer` are ready for Plan 06-06 (`HttpSyncRelay` client transport) to consume as the server side of the loopback contract, and for Plan 06-08 (production daemon composition and end-to-end loopback scenario) to wire together with the local `SyncRelay` client implementation.
- Recovery-path CAS in `OpaqueRelayService` implements only the relay-verifiable proxy described in `key-decisions`; the full client-side X25519 sealed-box historical-keyring exchange and enrollment-transcript verification-code flow (ADR 0047 "Normal remote enrollment" / "Recovery-key enrollment" state machines) remain the responsibility of a client-side control/enrollment service in a later plan (per `06-PATTERNS.md`, likely `src/sync/control/sync-control-service.ts`).
- Head-observation records are a thin storage primitive only; split-view cross-observation detection logic is not implemented here and remains for a later plan per ADR 0047 "Split-View and Merkle Decision".
- No blockers identified for 06-06.

---
*Phase: 06-zero-knowledge-multi-device-sync*
*Completed: 2026-07-19*

## Self-Check: PASSED
