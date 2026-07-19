# Phase 6: Zero-Knowledge Multi-Device Sync - Context

**Gathered:** 2026-07-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver encrypted, offline-capable synchronization of the person-owned canonical memory archive across trusted devices without giving the relay decryption capability. This phase includes device enrollment, recovery, revocation, convergent replication, deletion propagation, encrypted relay retention, and the server-metadata boundary. It does not weaken the existing person, source, workspace, or retrieval-scope rules, and it does not make relay account access sufficient to decrypt memory.

</domain>

<decisions>
## Implementation Decisions

### Device enrollment
- **D-01:** A new device normally enrolls by sending a remote approval request through the relay. Direct QR pairing is not required as the primary enrollment path.
- **D-02:** Any one currently trusted device may approve enrollment after showing the proposed device name and a matching verification code.
- **D-03:** Enrollment grants the new trusted device the person's complete synchronized memory archive rather than a selected subset or future-only stream. MCP profiles and allowed scopes continue to restrict agent retrieval locally; they are not selective device-sync boundaries.
- **D-04:** When no trusted device is available, the recovery key plus access to the user's relay sync account is sufficient to enroll a replacement device.

### Recovery and device revocation
- **D-05:** Revocation blocks the device from future synchronization and triggers rotation of future synchronization keys. The product does not attempt or claim a remote erasure of memory already retained by an offline device.
- **D-06:** Revocation does not rewrite historical ciphertext. Existing history retains its prior encryption keys, while new synchronized changes use rotated keys.
- **D-07:** The user may opt into a relay-stored recovery package encrypted locally under a user-only passphrase. The relay never receives the passphrase and cannot perform support-assisted decryption.
- **D-08:** Any trusted device may explicitly rotate a compromised recovery key, invalidate the old recovery path, and replace the optional encrypted recovery package.

### Offline convergence and deletion
- **D-09:** Concurrent additive event streams are both preserved and merged deterministically using canonical time and provenance. Devices recompute only affected summaries, topics, and other derived memory after convergence.
- **D-10:** Incompatible mutations to the same reviewable object, such as concurrent approval and rejection, preserve both decisions and enter an explicit conflict state for user resolution. The system does not silently choose by timestamp or precedence.
- **D-11:** When a stale peer offers content covered by an approved deletion, that content is quarantined and cannot become active or retrievable memory. The user must explicitly decide whether to keep the deletion or create a reviewed restoration path.
- **D-12:** Deletion tombstones are retained indefinitely as compact encrypted audit records containing identifiers and timestamps but no deleted conversation content.

### Relay privacy and synchronization scope
- **D-13:** The relay may retain a pseudonymous sync identity, authorized device identifiers, encrypted-object identifiers, sequence and replay-protection data, timestamps, and ciphertext sizes. It must not receive memory content, decryption keys, person names, source labels, profile names, workspace labels, or other semantic memory metadata.
- **D-14:** The relay retains every encrypted object version indefinitely as an append-only synchronization archive rather than garbage-collecting superseded ciphertext after acknowledgement.
- **D-15:** All approved memory profiles and scopes are included in the person's encrypted synchronized archive. Scope authorization remains enforced by local retrieval and MCP profile boundaries on each trusted device.
- **D-16:** Relay authentication uses a conventional email-based account with password or passkey recovery. Relay account recovery restores service access only; it cannot decrypt memory without a trusted device, recovery key, or user-passphrase-protected recovery package.

### the agent's Discretion
- Exact transport, cryptographic protocol, key hierarchy, authenticated-encryption suite, password-based key derivation, device credential format, conflict-free data structure, clock representation, envelope format, and relay implementation are left to research and planning.
- Protocol selection must use established, reviewed cryptographic primitives and include an explicit threat model and protocol-approval gate; bespoke cryptography is not acceptable.
- Exact conflict UI, quarantine record schema, encrypted version addressing, replay window, verification-code format and expiry, passkey provider, and email-account implementation are flexible provided the decisions and requirements above remain testable.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and phase scope
- `.planning/PROJECT.md` — Current zero-knowledge synchronization milestone and local-first product boundaries.
- `.planning/REQUIREMENTS.md` — REQ-031 through REQ-036 define end-to-end encryption, enrollment, revocation, convergence, deletion propagation, and minimal relay metadata.
- `.planning/ROADMAP.md` — Phase 6 goal, research gate, ordering, and boundary before onboarding and operational readiness.

### Personal timeline, deletion, and isolation
- `docs/adr/0040-personal-canonical-timeline.md` — Person-owned canonical events, deterministic native provenance, and cross-host timeline ordering.
- `docs/adr/0044-source-revocation-and-attributable-deletion.md` — Separate revocation and deletion, anti-reimport state, native-source preservation, and fail-closed derived-memory invalidation.
- `docs/adr/0046-person-and-retrieval-scope-boundaries.md` — Mandatory person and scope authorization and fail-closed filtering of mixed-scope derived memory.
- `.planning/phases/03-source-lifecycle-control-plane/03-CONTEXT.md` — Locked exact-source approval, revocation, deletion, quarantine, tool-call, and cross-workspace isolation decisions.

### Existing runtime and client boundaries
- `.planning/phases/04-continuous-local-daemon/04-CONTEXT.md` — Local single-writer daemon behavior, durable stage checkpoints, revocation revalidation, and bounded affected-range contraction.
- `.planning/phases/05-generic-mcp-interface/05-CONTEXT.md` — Named profile authority, read-only MCP semantics, explicit mutation confirmation, and local agent retrieval boundaries.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/domain/canonical.ts`: Person, source, and canonical-event schemas already carry deterministic identity, native ordering, timestamps, provenance, and scope inputs needed to define replicated objects.
- `src/storage/memory-store.ts`: The shared storage contract is the seam for adding device state, encrypted change envelopes, clocks, conflicts, tombstones, acknowledgements, and sync checkpoints without coupling the domain to a relay transport.
- `src/storage/sqlite-store.ts` and `src/storage/in-memory-store.ts`: Both adapters already enforce equivalent person ownership and transactional mutation contracts; Phase 6 must keep their behavior aligned.
- `src/service/source-lifecycle-service.ts`: Existing revocation and exact-confirmation deletion planning provides the local authoritative mutation whose encrypted tombstone must propagate.
- `src/daemon/contraction-runner.ts` and the durable daemon checkpoint types: Existing bounded affected-range rewinds and idempotent jobs can be triggered after newly converged canonical ranges arrive.
- `src/mcp/profile-loader.ts` and `src/mcp/authority.ts`: Existing profile-bound person and scope authorization remains the local retrieval boundary even though each enrolled device receives the full encrypted archive.

### Established Patterns
- Canonical event identity is deterministic and source/session namespaced, so additive events can deduplicate across peers without using last-writer-wins content replacement.
- Native histories remain read-only; synchronization replicates the memory database's canonical and derived state rather than modifying original Claude, Codex, OpenClaw, Hermes, or other source files.
- Source deletion physically removes attributable active memory while retaining content-free audit and anti-reimport state. Phase 6 adds encrypted cross-device tombstones without changing that local contract.
- Sensitive retrieval fails closed unless both person and complete allowed-scope authority are supplied. Synchronizing ciphertext to a trusted device must not widen any agent's MCP profile.
- External services and models are optional adapters. Deterministic local tests must use synthetic devices, histories, keys, clocks, relay fixtures, and fault injection rather than personal history or a live hosted relay.

### Integration Points
- Add host-neutral synchronization domain and service modules beside `src/domain/`, `src/service/`, and `src/storage/`; keep network relay transport and account-provider behavior behind adapters.
- Extend the memory-store contract and both storage adapters with atomic encrypted change-log, device registry, key-epoch, conflict, acknowledgement, quarantine, and tombstone operations.
- Feed converged canonical ranges into the existing daemon contraction queue instead of introducing a second derived-memory writer.
- Route confirmed local source revocation/deletion and MCP mutations into the synchronization change log only after their existing local transactions commit.
- Add a separate relay package or service that treats payloads as opaque ciphertext and is testable for metadata minimization and inability to decrypt.

</code_context>

<specifics>
## Specific Ideas

- Remote enrollment should feel like an account notification: the approving device shows the proposed device name and a short matching code before one-tap approval.
- A trusted device is trusted at the person's archive level. Agent applications on that device remain limited by named MCP profiles and their fixed allowed scopes.
- Revocation language must be honest: it stops future synchronization but cannot erase an offline copy or revoke historical keys already held by that device.
- A stale peer's deleted payload may be retained only in a non-retrievable quarantine pending an explicit user decision; reconnection alone never restores it.
- The append-only relay archive contains ciphertext versions indefinitely, but semantic names and content-bearing indexes stay encrypted on devices.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 6-zero-knowledge-multi-device-sync*
*Context gathered: 2026-07-19*
