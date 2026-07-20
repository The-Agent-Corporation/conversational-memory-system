---
phase: 06
slug: zero-knowledge-multi-device-sync
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-19
updated: 2026-07-20
---

# Phase 06 — Validation Strategy

> Execution contract for the original eight Zero-Knowledge Multi-Device Sync plans PLUS five gap-closure plans (06-09..06-13) that close the CR-01/CR-02 blockers and the WR-01..WR-08 hardening warnings from 06-VERIFICATION.md / 06-REVIEW.md. The eight-plan rows below are complete and green; the five gap-closure rows are `pending` until executed. `nyquist_compliant` stays as recorded for the original phase and is NOT re-flipped by this gap-closure planning pass — the gap work is not yet executed.

## Test Infrastructure

| Property | Value |
|----------|-------|
| Framework | Vitest 2.1.9, TypeScript, temporary SQLite, deterministic fake clocks/crypto/network/account adapters, and actual loopback Node HTTP for the production transport path |
| Config | `vitest.config.ts` |
| Quick command | `npx vitest run tests/sync tests/relay tests/integration/multi-device-sync.test.ts` |
| Full command | `npm test && npm run typecheck` |
| Privacy boundary | Deterministic suites use synthetic histories/devices and no live Keychain, hosted relay/IdP, external model, credentials, or personal history; the final blocking UAT uses only a synthetic non-production item in the real macOS Keychain. |

## Execution Waves and Dependencies

| Wave | Plans | Dependency gate |
|------|-------|-----------------|
| 1 | 06-01 | None; blocks protocol implementation on digest-bound owner risk acceptance (independent review waived for personal single-user deployment per ADR 0047 Security Review Record) |
| 2 | 06-02, 06-03 | Both depend on 06-01; files do not overlap |
| 3 | 06-04, 06-05 | Both depend on 06-02; files do not overlap |
| 4 | 06-06, 06-07 | 06-06 depends on 06-03/04/05; 06-07 depends on 06-04; files do not overlap |
| 5 | 06-08 | Depends on 06-06 and 06-07 |

### Gap-closure waves (plans 06-09..06-13)

| Wave | Plans | Dependency gate |
|------|-------|-----------------|
| 1 | 06-09, 06-10, 06-11, 06-12 | All `depends_on: []`; source and declared test files are disjoint across the four plans (06-09 recovery.test.ts; 06-10 replay-equivocation.test.ts + multi-device-sync.test.ts; 06-11 gap-allocation.test.ts + http-sync-relay.test.ts; 06-12 sync-producers.test.ts + mutation-tools.test.ts + device-secret-store.test.ts) |
| 2 | 06-13 | Depends on 06-09 (shares recovery.test.ts + relay service/store/control-service source; serialized after 06-09) |

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirements | Threat refs | Literal automated command | Status |
|---------|------|------|--------------|-------------|---------------------------|--------|
| 06-01-00 | 06-01 | 1 | REQ-031–REQ-036 | T-06-01, T-06-02, T-06-03 | `git status --short && git branch --show-current && git diff --check` | complete |
| 06-01-01 | 06-01 | 1 | REQ-031–REQ-036 | T-06-01, T-06-02, T-06-03, T-06-SC | `node scripts/benchmark-sync-padding.mjs && node -e "const fs=require('fs'); const p='docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md'; const s=fs.readFileSync(p,'utf8'); for (let i=1;i<=16;i++){const d='D-'+String(i).padStart(2,'0'); if(!s.includes(d)) throw new Error('missing '+d)} for (let i=31;i<=36;i++){const q='REQ-'+String(i).padStart(3,'0'); if(!s.includes(q)) throw new Error('missing '+q)} for (const x of ['Threat Model','Protocol Version','Wire','Recovery','Revocation','Tombstone','Conflict','Padding Policy','split-view','Merkle','Residual Risk','Security Review']) if(!s.includes(x)) throw new Error('missing '+x);" && node -e "const s=require('fs').readFileSync('.planning/phases/06-zero-knowledge-multi-device-sync/06-VALIDATION.md','utf8'); if(!/wave_0_complete: false/.test(s)||!/nyquist_compliant: false/.test(s)||/TBD-03[1-6]/.test(s)) process.exit(1)"` | complete |
| 06-01-02 | 06-01 | 1 | REQ-031–REQ-036 | T-06-01, T-06-02, T-06-03 | `node -e "const s=require('fs').readFileSync('docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md','utf8'); for (const x of ['Reviewer','Review Date','Protocol Digest','Account Provider Boundary','Email Signup','Email Login','Password Recovery','Passkey Recovery','Account Recovery Cannot Enroll or Decrypt','Owner Risk Acceptance','| Disposition | Approved for personal single-user deployment','| Blocking Findings | None']) if(!s.includes(x)) throw new Error('missing approval evidence: '+x)"` | complete |
| 06-02-01 | 06-02 | 2 | REQ-031, REQ-034, REQ-036 | T-06-07, T-06-SC | `npx vitest run tests/sync/protocol-contracts.test.ts && npm run typecheck` | complete |
| 06-02-02 | 06-02 | 2 | REQ-031, REQ-034, REQ-036 | T-06-04–T-06-07 | `npx vitest run tests/sync/crypto-envelope.test.ts && npm run typecheck` | complete |
| 06-03-01 | 06-03 | 2 | REQ-031, REQ-032, REQ-033 | T-06-09, T-06-10 | `npx vitest run tests/sync/device-secret-store.test.ts && npm run typecheck` | complete |
| 06-03-02 | 06-03 | 2 | REQ-031, REQ-032, REQ-033 | T-06-08–T-06-10 | `npx vitest run tests/sync/device-secret-store.test.ts -t "macOS|leak|helper" && swiftc -typecheck src/sync/secrets/macos-keychain-helper.swift && npm run typecheck` | complete |
| 06-04-01 | 06-04 | 3 | REQ-031, REQ-033, REQ-034, REQ-035 | T-06-11, T-06-12, T-06-14 | `npx vitest run tests/storage/sync-store.test.ts -t "contract|schema|binding" && npm run typecheck` | complete |
| 06-04-02 | 06-04 | 3 | REQ-031, REQ-033, REQ-034, REQ-035 | T-06-11–T-06-14 | `npx vitest run tests/storage/sync-store.test.ts tests/storage/sqlite-store.test.ts && npm run typecheck` | complete |
| 06-05-01 | 06-05 | 3 | REQ-031, REQ-033, REQ-036 | T-06-15, T-06-17, T-06-18 | `npx vitest run tests/relay/account-auth.test.ts tests/relay/metadata-contract.test.ts && npm run typecheck` | complete |
| 06-05-02 | 06-05 | 3 | REQ-031, REQ-033, REQ-036 | T-06-16, T-06-19 | `npx vitest run tests/relay/membership-cas.test.ts tests/relay/append-only-store.test.ts tests/relay/zero-knowledge-boundary.test.ts && npm run typecheck` | complete |
| 06-05-03 | 06-05 | 3 | REQ-031, REQ-033, REQ-036 | T-06-15, T-06-17–T-06-19 | `npx vitest run tests/relay/http-relay.test.ts tests/relay/metadata-contract.test.ts tests/relay/zero-knowledge-boundary.test.ts && npm run typecheck` | complete |
| 06-06-01 | 06-06 | 4 | REQ-032, REQ-033 | T-06-20, T-06-21, T-06-23 | `npx vitest run tests/sync/enrollment.test.ts tests/sync/recovery.test.ts && npm run typecheck` | complete |
| 06-06-02 | 06-06 | 4 | REQ-032, REQ-033 | T-06-22, T-06-23 | `npx vitest run tests/sync/revocation.test.ts tests/sync/recovery.test.ts tests/relay/membership-cas.test.ts && npm run typecheck` | complete |
| 06-06-03 | 06-06 | 4 | REQ-032, REQ-033, REQ-036 | T-06-34 | `npx vitest run tests/sync/http-sync-relay.test.ts tests/relay/http-relay.test.ts tests/sync/enrollment.test.ts && npm run typecheck` | complete |
| 06-07-01 | 06-07 | 4 | REQ-034, REQ-035 | T-06-24, T-06-26 | `npx vitest run tests/sync/convergence.test.ts tests/sync/conflicts.test.ts && npm run typecheck` | complete |
| 06-07-02 | 06-07 | 4 | REQ-034, REQ-035 | T-06-25–T-06-27 | `npx vitest run tests/sync/deletion-tombstones.test.ts tests/service/source-lifecycle-service.test.ts tests/retrieval/memory-retriever.test.ts -t "revocation|delete|quarantine|keep deletion|restoration|remote origin|backend parity" && npm run typecheck` | complete |
| 06-07-03 | 06-07 | 4 | REQ-034, REQ-035 | T-06-24–T-06-27, T-06-35 | `npx vitest run tests/integration/sync-producers.test.ts tests/service/memory-service.test.ts tests/service/source-lifecycle-service.test.ts tests/proposals/proposal-reviewer.test.ts tests/boxes/box-reviewer.test.ts tests/mcp/mutation-tools.test.ts && npm run typecheck` | complete |
| 06-08-01 | 06-08 | 5 | REQ-031, REQ-033–REQ-036 | T-06-28–T-06-31 | `npx vitest run tests/sync/replay-equivocation.test.ts tests/sync/convergence.test.ts tests/sync/deletion-tombstones.test.ts tests/integration/multi-device-sync.test.ts && npm run typecheck` | complete |
| 06-08-02 | 06-08 | 5 | REQ-031–REQ-036 | T-06-29–T-06-32, T-06-36 | `node scripts/benchmark-sync-padding.mjs && npx vitest run tests/sync tests/relay tests/integration/multi-device-sync.test.ts tests/storage/sync-store.test.ts tests/daemon/contraction-runner.test.ts tests/daemon/daemon-loop.test.ts tests/daemon/daemon-commands.test.ts tests/mcp && npm test && npm run typecheck && node scripts/verify-phase06-evidence.mjs --automated` | complete |
| 06-08-03 | 06-08 | 5 | REQ-031, REQ-032, REQ-033 | T-06-33 | `node scripts/verify-phase06-evidence.mjs --keychain-evidence /private/tmp/phase06-keychain-uat-evidence.json` | complete |
| 06-09-01 | 06-09 | 1 (gap) | REQ-032 | T-06-02 | `npx vitest run tests/sync/recovery.test.ts -t "account-only" 2>&1 \| tail -20` | pending |
| 06-09-02 | 06-09 | 1 (gap) | REQ-032 | T-06-02 | `npx tsc --noEmit && npx vitest run tests/sync/recovery.test.ts -t "recovery rotation" 2>&1 \| tail -20` | pending |
| 06-09-03 | 06-09 | 1 (gap) | REQ-032 | T-06-02, T-06-09 | `npx vitest run tests/sync/recovery.test.ts 2>&1 \| tail -25` | pending |
| 06-10-01 | 06-10 | 1 (gap) | REQ-031, REQ-034, REQ-035 | T-06-05 | `npx vitest run tests/sync/replay-equivocation.test.ts -t "sequence-2" 2>&1 \| tail -20` | pending |
| 06-10-02 | 06-10 | 1 (gap) | REQ-031, REQ-034, REQ-035 | T-06-05, T-06-05b | `npx vitest run tests/sync/replay-equivocation.test.ts 2>&1 \| tail -25` | pending |
| 06-10-03 | 06-10 | 1 (gap) | REQ-034, REQ-035 | T-06-05 | `npx vitest run tests/integration/multi-device-sync.test.ts 2>&1 \| tail -25` | pending |
| 06-11-01 | 06-11 | 1 (gap) | REQ-034, REQ-036 | T-06-07 | `npx vitest run tests/sync/gap-allocation.test.ts 2>&1 \| tail -20` | pending |
| 06-11-02 | 06-11 | 1 (gap) | REQ-034, REQ-036 | T-06-07b | `npx vitest run tests/sync/http-sync-relay.test.ts 2>&1 \| tail -20` | pending |
| 06-12-01 | 06-12 | 1 (gap) | REQ-033, REQ-035 | T-06-08, T-06-03 | `npx vitest run tests/integration/sync-producers.test.ts 2>&1 \| tail -20` | pending |
| 06-12-02 | 06-12 | 1 (gap) | REQ-031 | T-06-07 | `npx vitest run tests/mcp 2>&1 \| tail -20` | pending |
| 06-12-03 | 06-12 | 1 (gap) | REQ-031 | T-06-07 | `npx vitest run tests/sync/device-secret-store.test.ts 2>&1 \| tail -20` | pending |
| 06-13-01 | 06-13 | 2 (gap) | REQ-032, REQ-036 | T-06-02 | `npx vitest run tests/sync/recovery.test.ts 2>&1 \| tail -25` | pending |
| 06-13-02 | 06-13 | 2 (gap) | REQ-032 | T-06-06 | `npx vitest run tests/sync/recovery.test.ts tests/sync/crypto-envelope.test.ts 2>&1 \| tail -20` | pending |
| 06-13-03 | 06-13 | 2 (gap) | REQ-033, REQ-036 | T-06-09 | `npx vitest run tests/sync/revocation.test.ts 2>&1 \| tail -20` | pending |

## Requirement Proof Map

| Requirement | Primary task evidence | Required observable proof |
|-------------|-----------------------|---------------------------|
| REQ-031 | 06-02-02, 06-03-02, 06-05-02/03, 06-08-01/02/03 | Device-side encryption, OS secret boundary, relay negative knowledge, production network transport, authenticated fail-closed envelopes |
| REQ-032 | 06-06-01/03, 06-08-02 | Active-device or current-recovery enrollment, matching transcript, complete history, account-only denial over production transport |
| REQ-033 | 06-05-02, 06-06-02/03, 06-08-01/02 | Future denial, fresh epoch, unchanged history, relay/client enforcement, honest status |
| REQ-034 | 06-04-02, 06-07-01/03, 06-08-01/02 | Offline convergence, complete producer-to-sealed-outbox-to-HTTP-relay-to-materializer proof, restart equivalence, explicit conflicts |
| REQ-035 | 06-04-02, 06-07-02/03, 06-08-01/02 | Atomic lifecycle propagation, permanent tombstone/audit, quarantine, both reviewed resolutions, remote suppression |
| REQ-036 | 06-05-01/02/03, 06-06-03, 06-08-01/02 | Exact outer allowlist, bounded HTTP server/client, append-only ciphertext retention, no semantic metadata/decryption capability |

## Decision Traceability

| Decisions | Plan/task coverage |
|-----------|--------------------|
| D-01–D-04 | 06-01 protocol; 06-06 enrollment/recovery/HttpSyncRelay; 06-08 end-to-end account-only denial |
| D-05–D-08 | 06-06 future exclusion/recovery rotation; 06-05/06 HTTP relay enforcement; 06-08 end-to-end proof |
| D-09–D-10 | 06-07 deterministic reducers/conflicts and authoritative-vs-derived producer classification; 06-08 full convergence |
| D-11–D-12 | 06-07 permanent tombstone/quarantine/resolutions and lifecycle producers; 06-08 control-first replication |
| D-13–D-14 | 06-05 schemas/server/storage/service; 06-06 client; 06-08 privacy gate |
| D-15–D-16 | 06-05 account-only authority; 06-06 complete archive/production client; 06-08 unchanged MCP scope and daemon composition |

## Wave 0 Gaps

- [x] **06-01:** ADR 0047, benchmark, exact eight-plan validation mapping, and digest-bound owner risk acceptance (independent review waived for personal single-user deployment).
- [x] **06-02:** Audited dependencies, strict contracts, fixtures, crypto provider, and vectors.
- [x] **06-03:** DeviceSecretStore, deterministic fake, production macOS Keychain adapter/helper, and leakage/rotation tests.
- [x] **06-04:** Atomic local outbox/remote apply, immutable pre-upload envelope sealing, and both local adapter implementations.
- [x] **06-05:** Account provider, strict schemas, append-only relay adapters/service, bounded HTTP/HTTPS server, and loopback privacy tests.
- [x] **06-06:** SyncRelay/HttpSyncRelay and enrollment, recovery, revocation, recovery-rotation, and client/server control-flow tests.
- [x] **06-07:** Deterministic materialization, complete authoritative producer wiring including BoxReviewer, lifecycle controls, tombstones, quarantine, conflicts, and both resolutions.
- [x] **06-08:** Sealed-byte replication, production daemon transport selection, complete real-loopback multi-device proof, final validator (automated portion), and blocking external real-Keychain evidence (Task 06-08-03 complete -- Keychain UAT evidence verified and owner-approved 2026-07-19).

## Gap-Closure Plans (06-09..06-13)

- [ ] **06-09 (CR-01, BLOCKING):** Bind recovery-seed possession (CMSRSIG1) into recovery enrollment so account-only access cannot enroll an active device; adversarial account-only rejection test.
- [ ] **06-10 (CR-02, BLOCKING):** Chain `previousEnvelopeHash` on the predecessor's `ciphertextDigest` so device-sequence >= 2 envelopes verify and multi-operation histories converge.
- [ ] **06-11 (WR-02, WR-08):** Bound client remote-apply gap allocation at MAX_RETAINED_GAP_SLOTS (both adapters, new `tests/sync/gap-allocation.test.ts`) and evict stale relay HTTP rate-limit windows.
- [ ] **06-12 (WR-06, WR-01, WR-05):** Surface non-COMMITTED local outbox emissions, restore the takePlan kind guard, and remove the Keychain read pipe-deadlock.
- [ ] **06-13 (WR-03, WR-04, WR-07):** Relay-issued single-use recovery challenge, Argon2id reviewed-floor enforcement on unwrap, and revoked-device reactivation guard (both relay stores).

## Adversarial Matrix

| Scenario | Required assertion |
|----------|--------------------|
| Crash after outbox encryption/seal | Reopen returns exact stored bytes; retry does not re-encrypt or change nonce/padding/signature/digest. |
| Identical envelope replay / tuple equivocation | Exact replay is idempotent; different bytes become permanent equivocation and never overwrite. |
| Missing predecessor / excessive jump | Bounded pending gap; no frontier advance or unbounded work. |
| Relay reorders tombstone after content | Control-first apply quarantines covered content before retrieval-visible write. |
| Relay withholding / fork | Client reports incomplete; crossed signed heads may expose inconsistency without overclaiming permanent detection. |
| Revoked device upload/fetch | HTTP relay and local verifier reject future operations; historical local access remains possible. |
| Concurrent approve/reject | Every signed decision persists in explicit unresolved conflict with no timestamp winner. |
| BoxReviewer failure/drift | Box, exact summary attachments, audit, and outbox all remain unchanged; success commits all atomically. |
| Remote authoritative operation | Peer reaches equivalent domain/audit state and emits zero new outbox operations. |
| Derived cache recomputation | Automatic summaries/boxes/traces/topics/embeddings do not emit authority; explicit reviewed decisions do. |
| HTTP abuse/ambiguous outcome | Bad route/method/field/body/token/timeouts fail content-free; lost write response reconciles exact receipt/head before retry. |
| Account password/passkey recovery only | Service access may recover, but enrollment, key unwrap, and decryption remain denied. |

## Sampling and Sign-Off

- After each task, run its literal automated command above; TypeScript changes include `npm run typecheck`.
- After each wave, run `npx vitest run tests/sync tests/relay tests/storage/sync-store.test.ts tests/daemon tests/mcp && npm run typecheck`.
- Task 06-08-01's exact command includes `tests/integration/multi-device-sync.test.ts`; Task 06-08-02 is the complete automated phase gate.
- The production macOS Keychain gate is separate Task 06-08-03. Editing this file cannot create its external content-free evidence.
- No watch mode, live hosted provider, credential, external model, or personal history is permitted in deterministic validation.
- Set `wave_0_complete: true` only after every Wave 0 artifact exists and its owning task is green.
- Set `nyquist_compliant: true` only after every task row and requirement proof is green and the blocking Keychain human inspection is approved. The five gap-closure rows (06-09..06-13) are `pending`; re-flip only after they are executed and green.

**Keychain UAT:** complete (2026-07-19, macOS 26.4.1 real Keychain, production adapter + compiled helper, synthetic non-production item; exact sequence create→read→rotate_success→rotate_failed_preserves_old→delete→post_delete_absent; all leakageScanCounts zero; evidence digest `7ebe6a455f251b3ddb5ec0dcbbeeaedb6809ffe9b10af644c939af560237cbcc`; `verify-phase06-evidence.mjs --keychain-evidence` PASSED)
**Approval:** approved by Aaron Whaley (owner) 2026-07-19 after reviewing the UAT evidence summary; `nyquist_compliant: true`
</content>
</invoke>
