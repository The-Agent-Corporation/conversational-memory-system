# Requirements: Universal Personal Memory

**Created:** 2026-07-16
**Status:** Draft from approved product exploration

## Product Model

- **REQ-001 — Lifelong timeline:** The system shall maintain one canonical continuous conversation timeline per person across all approved agent sources.
- **REQ-002 — Source provenance:** Every canonical event shall retain its source application, source profile, native session ID, native event ID when available, source location reference, native timestamp, import timestamp, causal linkage, and parser version.
- **REQ-003 — Non-destructive import:** The system shall treat native history stores as read-only and shall not modify, move, or delete source histories.
- **REQ-004 — Session semantics:** Native session boundaries shall remain available as provenance but shall not partition compaction, retrieval, or the person's canonical conversation.

## Consent and Discovery

- **REQ-005 — Metadata-only discovery:** Before content import, discovery shall report candidate applications, roots, formats, session counts, date ranges, and estimated size without reading conversation bodies beyond what is required to identify the format.
- **REQ-006 — Explicit approval:** The system shall require explicit user approval per source or root before reading and importing message content.
- **REQ-007 — Revocation:** A user shall be able to revoke a source and stop future ingestion without affecting unrelated sources.
- **REQ-008 — Source deletion:** A user shall be able to remove imported events and derived memory attributable exclusively to a selected source, profile, session, device, or time range.

## Canonical Import

- **REQ-009 — Supported bootstrap sources:** The initial importer set shall support Codex, Claude Code, OpenClaw, and Hermes histories.
- **REQ-010 — Incremental JSONL ingestion:** JSONL importers shall checkpoint using stable file identity and byte offset, recover safely after partial writes, and tolerate rotation or archival.
- **REQ-011 — Incremental database ingestion:** SQLite importers shall checkpoint using stable row identity or a deterministic high-water mark and shall never mutate a source database.
- **REQ-012 — Format detection:** Importers shall capability-detect canonical source formats and avoid double-importing prompt indexes, routing metadata, sidecars, legacy exports, or migrated copies.
- **REQ-013 — Deterministic identity:** Canonical event IDs shall be derived deterministically from source identity and native event identity, with a content-based fallback only when native identity is unavailable.
- **REQ-014 — Deduplication:** Native IDs and explicit migration aliases shall take precedence in deduplication. Text similarity shall not be sufficient to discard an event.
- **REQ-015 — Ordering:** Events shall be ordered using normalized UTC timestamps plus deterministic source sequence and causal linkage tie-breakers. Clock ambiguity shall be retained as metadata rather than silently rewritten.
- **REQ-016 — Parser evolution:** Importers shall version-sniff supported schemas, preserve unknown records for later reprocessing, and fail one source without corrupting the canonical timeline.

## Continuous Local Operation

- **REQ-017 — Local daemon:** A background daemon shall continuously synchronize approved local sources into the canonical timeline.
- **REQ-018 — Correctness by rescan:** Periodic incremental rescans shall be the correctness mechanism; filesystem watchers may reduce latency but shall not be the sole synchronization mechanism.
- **REQ-019 — Idempotent restart:** Daemon restarts and repeated scans shall not duplicate canonical events or derived memory.
- **REQ-020 — Offline operation:** Local ingestion, retrieval, compaction, expansion, proposal review, and MCP access shall remain available without network connectivity.
- **REQ-021 — Local authority:** The local event log and memory database shall be authoritative for local operation, even when encrypted synchronization is configured.

## Accordion Memory

- **REQ-022 — Incremental contraction:** Newly ingested passages shall be processed incrementally into topic spans, summaries, anchors, boxes, traces, and other derived memory without reprocessing the full historical corpus.
- **REQ-023 — Layered expansion:** Retrieval shall be able to expand from compact subjects and summaries to source-linked verbatim events under an explicit token budget.
- **REQ-024 — Provenance-preserving derivation:** Every derived memory object shall retain the source event, range, summary, trace, parser, and processing provenance needed for audit and deletion propagation.
- **REQ-025 — Assistive memory:** Recalled memory shall be labeled as non-authoritative context with confidence, timestamps, sources, and disclosure text.
- **REQ-026 — Human review:** Proposed boxes, cross-session traces, durable conclusions, and destructive memory mutations shall retain explicit review and reversible state transitions.

## Agent Access

- **REQ-027 — MCP server:** The system shall expose a host-neutral MCP server over local STDIO and/or localhost Streamable HTTP.
- **REQ-028 — MCP capabilities:** The initial MCP surface shall support ingest, search, contextual recall, verbatim expansion, memory review, proposal listing, proposal approval/rejection, source status, and deletion requests.
- **REQ-029 — Tool safety metadata:** MCP tools shall accurately declare read-only versus mutating behavior and shall require approval for imports, durable writes, proposal decisions, and deletion.
- **REQ-030 — Adapter boundary:** Host-specific parsing and transport behavior shall live outside the host-neutral domain, storage, retrieval, compaction, and review services.

## Zero-Knowledge Synchronization

- **REQ-031 — End-to-end encryption:** Synchronized content and derived memory shall be encrypted on user devices before transmission. The synchronization service shall not possess decryption keys.
- **REQ-032 — Device enrollment:** New devices shall join through approval by an authorized device or a user-held recovery key.
- **REQ-033 — Device revocation:** A user shall be able to revoke a device and rotate future synchronization keys without losing locally retained memory.
- **REQ-034 — Offline convergence:** Concurrent device changes shall converge after reconnection without relying on a single online writer.
- **REQ-035 — Deletion propagation:** Approved deletions and source revocations shall propagate across devices with auditable tombstones while preventing deleted content from being reintroduced by stale peers.
- **REQ-036 — Minimal server metadata:** The synchronization service shall store only the metadata required for routing, authorization, replay protection, and encrypted convergence.

## Privacy and Isolation

- **REQ-037 — Secret handling:** The system shall detect and redact raw API keys, tokens, passwords, private keys, and equivalent secrets before durable memory derivation or synchronization.
- **REQ-038 — Sensitive-context policy:** Universal storage shall not imply unrestricted retrieval. The system shall support policies preventing sensitive workspace, client, case, or legal context from surfacing into unrelated agent work.
- **REQ-039 — Auditability:** The user shall be able to inspect why an item was imported, summarized, synchronized, retrieved, expanded, approved, rejected, or deleted.
- **REQ-040 — No mandatory external model:** Deterministic/local operation and tests shall not require an external LLM. Model-backed summarization or planning shall remain optional and adapter-gated.

## Initial Acceptance Outcome

A fresh installation is immediately useful when it can discover approved histories, import them idempotently into one personal timeline, produce layered memory, answer an MCP search from a different agent with provenance, expand the answer to source-linked events, and continue ingesting new history in the background while offline.
