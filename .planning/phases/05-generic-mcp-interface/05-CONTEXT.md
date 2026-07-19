# Phase 5: Generic MCP Interface - Context

**Gathered:** 2026-07-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver a local, host-neutral MCP interface that lets Codex, OpenClaw, Claude-compatible clients, Hermes, and future agents use one person-scoped memory database. Phase 5 includes the required ingest, search, contextual recall, subject-level verbatim expansion, memory review, proposal review and decisions, source status, revocation, and deletion-request capabilities. It also includes local profile configuration, strict authorization binding, accurate MCP safety metadata, and confirmed mutation flows. It does not add remote network access, multi-device synchronization, onboarding UI, or new native-history parsers.

</domain>

<decisions>
## Implementation Decisions

### Connection model
- **D-01:** Ship local STDIO as the initial MCP transport. Localhost Streamable HTTP is not required in Phase 5.
- **D-02:** Each MCP client launches a separate interactive facade that opens the configured SQLite memory database and calls the existing host-neutral services. The Phase 4 daemon remains a separate process and the only background synchronizer.
- **D-03:** MCP remains usable for interactive search, recall, review, and explicitly approved mutations while the daemon is stopped. Status must clearly report synchronization as offline.
- **D-04:** A product configuration file contains named connection profiles and resolves each profile to a memory database. Do not discover or select a database automatically.

### Identity and retrieval scope
- **D-05:** Each named profile fixes exactly one `personId` and its complete allowed-scope list. Individual tool calls do not widen or narrow that list.
- **D-06:** A profile represents a workspace or sensitivity context, not an agent application. Codex, OpenClaw, Claude-compatible clients, and Hermes may share a profile only when they should have identical memory access.
- **D-07:** MCP registrations select a profile explicitly. A missing or unknown profile fails closed; there is no implicit default profile.
- **D-08:** When relevant matches exist outside the profile's scopes, read tools may return redacted match labels without memory content. Labels must come from a disclosure-safe alias vocabulary rather than raw case, client, source, thread, title, or content values.

### Tool and response design
- **D-09:** Use explicit task-specific tools rather than umbrella action parameters or generic CRUD. The initial surface must cover memory search, contextual recall, memory review, subject expansion, source status, history ingestion, proposal listing, proposal approval/rejection, source revocation, and source deletion requests.
- **D-10:** `memory_search` returns ranked, inspectable candidates with identifiers and provenance. `memory_recall` accepts the current task and an explicit token budget and returns a compact disclosure-labeled context packet.
- **D-11:** Read tools return both stable structured data and compact rendered text. Structured results include applicable identifiers, timestamps, confidence, provenance, scopes, budget use, continuation state, and assistive-memory disclosure.
- **D-12:** Verbatim expansion operates on an entire remembered subject rather than requiring callers to select individual result IDs. Expansion still enforces the explicit token budget and uses bounded continuation when the subject is larger than one response.

### Mutation approvals
- **D-13:** Every import, durable memory write, proposal decision, revocation, and deletion operation uses a two-step preview and confirmation flow. Preview returns exact effects plus a short-lived, single-use confirmation token; execution requires the exact target and token.
- **D-14:** Confirmation tokens bind the selected profile, tool, exact target IDs, normalized parameters, expiry, and one-time use. Any changed input requires a new preview.
- **D-15:** Search, recall, expansion, review, and status are semantically read-only and must not strengthen, revive, supersede, or otherwise modify durable memory objects. Content-free operational telemetry may be recorded separately from memory state.
- **D-16:** Source revocation and deletion are separate confirmed operations. Deletion remains unavailable until the exact source has already been revoked, and both transitions retain their existing audit behavior.
- **D-17:** Tool annotations must accurately distinguish read-only and mutating behavior. Host approval prompts supplement the server-enforced confirmation protocol; they are not the sole authorization control.

### the agent's Discretion
- Exact package and module names, MCP SDK wiring, Zod schema decomposition, configuration file location and syntax, confirmation-token cryptographic representation, expiry duration, telemetry representation, pagination cursor encoding, and exact disclosure-safe label vocabulary.
- Exact task-tool names may vary from the examples in D-09 if schemas and safety boundaries stay explicit and one operation cannot smuggle a materially different mutation through an action parameter.
- Exact structured-response field names and rendered-text formatting, provided both representations carry the same authorization boundary, provenance, disclosure, and budget facts.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product and phase scope
- `.planning/PROJECT.md` — Product vision, current milestone, privacy rules, and host-neutral direction.
- `.planning/REQUIREMENTS.md` — REQ-023, REQ-025, and REQ-027 through REQ-029 define layered expansion, assistive disclosure, MCP transport, capabilities, and safety metadata.
- `.planning/ROADMAP.md` — Phase 5 goal, requirements mapping, and boundary before synchronization and onboarding.

### Identity, provenance, and retrieval isolation
- `docs/adr/0040-personal-canonical-timeline.md` — Person-owned canonical events, native provenance, and compatibility boundaries.
- `docs/adr/0046-person-and-retrieval-scope-boundaries.md` — Mandatory person and allowed-scope authorization, fail-closed derived-memory filtering, and the prohibition on legacy-unscoped MCP retrieval.
- `.planning/phases/03-source-lifecycle-control-plane/03-CONTEXT.md` — Locked approval, revocation, deletion, quarantine, tool-call, and cross-workspace isolation decisions.

### Source lifecycle and daemon integration
- `docs/adr/0044-source-revocation-and-attributable-deletion.md` — Separate revocation and exact-confirmation deletion, native-source preservation, audit events, and derived-memory invalidation.
- `.planning/phases/04-continuous-local-daemon/04-CONTEXT.md` — Daemon ownership, offline behavior, lifecycle controls, status, and background synchronization boundary inherited by MCP.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/retrieval/memory-retriever.ts` and `src/service/memory-service.ts`: Existing strict person-and-scope recall, deterministic ranking, budget packing, disclosure, and injection-packet construction. MCP needs a semantically read-only path because the current retriever records access and revival mutations.
- `src/resume/conversation-resumer.ts`: Existing summary, trace, box, and injection expansion. Subject-level MCP expansion must add strict person/scope checks and budgeted continuation before exposing this functionality.
- `src/proposals/proposal-reviewer.ts`: Existing proposal listing and approval/rejection state transitions. MCP wrappers must add profile-bound person/scope filtering and the two-step confirmation protocol.
- `src/service/source-lifecycle-service.ts`: Existing durable source approval, revocation, exact-confirmation deletion, quarantine replay, and audit behavior.
- `src/bootstrap/status-command.ts`: Existing content-free database, person, source, bootstrap, and daemon-status snapshot that can back `source_status`.
- `src/imports/history-import-command.ts` and `src/imports/codex-import-command.ts`: Existing explicitly approved importer orchestration for the supported history formats.
- `src/storage/memory-store.ts` and `src/storage/sqlite-store.ts`: Existing storage contracts and SQLite authority shared by the daemon and interactive MCP facade.

### Established Patterns
- Strict retrieval requires both person and scope authorization and excludes any derived object with a disallowed dependency.
- Source discovery and import are explicit, exact-source, checkpointed, and idempotent; MCP must not bypass those services with generic writes.
- Native histories remain read-only. Deletion removes attributable canonical and derived memory but never edits the native source.
- External models are optional adapters and cannot be required for MCP correctness or deterministic tests.
- Existing host-specific behavior lives at adapter and command boundaries; MCP belongs outside domain, storage, retrieval, and review internals.

### Integration Points
- Add a transport-neutral MCP application layer over existing services, with a STDIO entry point and named local-profile loader.
- Add strict scoped query/expansion/review service methods where current classes expose unscoped IDs or global lists.
- Separate retrieval telemetry from semantic memory mutation so MCP read tools can truthfully advertise read-only behavior.
- Add a durable or transaction-safe confirmation-ticket service for preview/execute mutation pairs.
- Add package scripts and synthetic integration tests that exercise real JSON-RPC/MCP STDIO sessions without reading personal history.

</code_context>

<specifics>
## Specific Ideas

- Expected profile examples include `personal`, a project workspace such as `projectrunner`, or a disclosure-safe alias for a separately authorized sensitive context.
- MCP client configuration names the profile; the profile, not the agent's tool arguments, selects the database, person, and complete scope list.
- Subject expansion should feel like opening the next accordion layer: the server identifies the subject's related source ranges, returns the budgeted portion, and exposes continuation for the rest.
- Unauthorized match labels are intentionally visible, but only through configured non-sensitive aliases; no blocked snippets, raw titles, source paths, session IDs, or client/case names are disclosed.

</specifics>

<deferred>
## Deferred Ideas

- Localhost Streamable HTTP transport is deferred beyond the initial STDIO interface.
- Remote access, cross-device authentication, and zero-knowledge synchronization remain Phase 6.
- First-run profile creation UI, broad packaging, and onboarding remain Phase 7.

</deferred>

---

*Phase: 05-generic-mcp-interface*
*Context gathered: 2026-07-18*
