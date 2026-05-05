# Accordion Memory Design

## Purpose

Build an ambient personal memory system for AI conversations that can store complete verbatim history while keeping active model context small, relevant, and trustworthy.

This should be its own system, not a feature owned by one agent runtime. It should expose stable integration contracts so it can plug into Roscoe-Hermes first, and later into Pi, OpenClaw, Codex, Cursor, or other configured agents.

The system should feel like a person with excellent recall, but it must respect the practical limit that model context is scarce and performance degrades as context fills. The design therefore treats storage as effectively unbounded, while treating context injection as a governed, auditable decision.

The first product wedge is ambient personal memory. The second wedge is project continuity across long-running work. The system should start conservative and auditable, then graduate toward a more automatic topic graph as it proves reliable.

This design continues the earlier February 2026 planning work in `/Users/aaronwhaley/CoWork/workspace-brainstorm/memory-dump`. That prior work already established the major direction: conversation-as-memory, passive surfacing, progressive disclosure, anchors, boxes, decay, active search, and conversation resumption. This spec keeps those decisions, updates the surfacing model around a rolling topic monitor rather than noisy per-turn memory retrieval, and changes the system boundary from Pi-specific extension to standalone memory platform with adapters.

## Prior Work Incorporated

The earlier approved design is at `/Users/aaronwhaley/CoWork/workspace-brainstorm/memory-dump/docs/plans/2026-02-27-conversational-memory-design.md`.

The planning folder also contains:

- `/Users/aaronwhaley/CoWork/workspace-brainstorm/memory-dump/.planning/PROJECT.md`
- `/Users/aaronwhaley/CoWork/workspace-brainstorm/memory-dump/.planning/REQUIREMENTS.md`
- `/Users/aaronwhaley/CoWork/workspace-brainstorm/memory-dump/.planning/ROADMAP.md`
- `/Users/aaronwhaley/CoWork/workspace-brainstorm/memory-dump/.planning/STATE.md`
- `/Users/aaronwhaley/CoWork/workspace-brainstorm/memory-dump/.planning/research/ARCHITECTURE.md`
- `/Users/aaronwhaley/CoWork/workspace-brainstorm/memory-dump/.planning/research/FEATURES.md`
- `/Users/aaronwhaley/CoWork/workspace-brainstorm/memory-dump/.planning/research/PITFALLS.md`
- `/Users/aaronwhaley/CoWork/workspace-brainstorm/memory-dump/.planning/research/STACK.md`
- `/Users/aaronwhaley/CoWork/workspace-brainstorm/memory-dump/.planning/research/SUMMARY.md`

Important retained decisions:

- Use a hybrid architecture: lightweight host adapter plus background memory service.
- Treat conversations as the durable memory unit rather than extracted facts.
- Store raw turns immutably and allow summaries to change with version history.
- Support relational and vector storage, without making Supabase mandatory.
- Use a dedicated Surfacer/monitor instead of requiring the main agent to search its own memory.
- Use active search only as a safety valve.
- Use progressive disclosure: nothing, box summary, thread summary, resumption flag, full thread on explicit resume.
- Use anchors for decisions, deadlines, key facts, and strategic insights.
- Use boxes for case/topic grouping and nested legal case structure.
- Preserve provenance and confidence for every memory injection.

Additional Hippo Memory ideas to incorporate from `/Users/aaronwhaley/.hermes/agents/Brainstorm/brainstorm-docs/summaries/hippo-memory-master-summary.md`:

- Use working, episodic, and semantic layers as useful vocabulary for the memory lifecycle.
- Treat sleep consolidation as a first-class background function.
- Strengthen memories when they are retrieved, rather than relying only on recency.
- Let outcome signals affect decay; errors, breakthroughs, and high-value legal lessons should persist longer.
- Consider human-readable markdown/YAML mirrors for debugging and portability, even if the database remains authoritative.
- Keep cross-tool memory portability in mind for OpenClaw, Codex, Cursor, Pi, and related agent environments.

Important changes from the prior design:

- The memory system should be standalone and agent-agnostic. Pi is one possible integration, not the owning runtime.
- Roscoe-Hermes at `/Users/aaronwhaley/Github/Roscoe-hermes` is the first intended adapter target.
- Storage should be pluggable. Supabase/Postgres with pgvector is viable, but not settled.
- The hot path should not blindly embed every individual user turn and retrieve against memory. That was identified as likely noisy.
- The background monitor should maintain a rolling topic summary: "What are we talking about now?"
- Retrieval should compare that rolling topic representation against prior summaries, boxes, and anchors.
- Pre-compaction should occur when topic movement is clear, not only when token thresholds force compression.
- Sleep review becomes the main venue for proposed structural changes, especially new child boxes, merges, and splits.
- Early versions should require approval for every proposed sleep-review change, then graduate toward automatic low-risk updates.

## Core Principles

1. Nothing is lost during compaction. Raw turns remain available.
2. Wrong recall is worse than under-recall or visible machinery.
3. Memory should be quiet by default and auditable on request.
4. Retrieval should happen at the topic level, not from noisy per-turn triggers.
5. Compaction should happen when the topic moves, not only when context is almost full.
6. Organization starts as suggest-and-confirm, then gradually gains autonomy.
7. Anchored legal facts must not be summarized away.
8. The memory budget is a ceiling, not a target.
9. Decay means falling out of active recall, not deletion of source conversations.
10. Retrieval should strengthen memory relevance when the recall is useful.

## Runtime Architecture

The live conversation has two tracks:

- The main agent talks with the user.
- A background topic monitor watches the conversation, appends every event to durable storage, and maintains a rolling answer to: "What are we talking about now?"

The background monitor does not embed and retrieve memory for every isolated user turn. Instead, it builds a compact rolling topic summary and compares that topic representation against existing summaries and boxes.

When the monitor detects a clear topic change, it can run pre-compaction. It summarizes the prior subject, links that summary to exact source turns, attaches it to an existing box or proposes a new one, and lets the prior subject shrink out of active context before context pressure becomes urgent.

When the current topic resembles prior memory, the monitor produces an injection packet for the main agent. The packet contains selected memory, source references, confidence, and a reason for selection. The main agent may use this quietly in the answer, while keeping provenance available if the user asks why the memory was used.

The prior architecture separated the sidecar into Summarizer, Grouper, and Surfacer modules. This design keeps those modules but frames them as cooperating background agents:

- Topic Monitor: tracks current subject and topic movement.
- Summarizer: compacts inactive or oversized subject spans.
- Grouper: attaches summaries to boxes and proposes nested structure.
- Surfacer: prepares memory injection packets for the next agent turn.
- Sleep Reviewer: runs offline consolidation and proposes structural changes.

Hippo Memory's working/episodic/semantic distinction maps cleanly onto this architecture:

- Working memory: the current active conversation and rolling topic summary.
- Episodic memory: immutable transcript turns, compacted spans, source-linked summaries, and anchors.
- Semantic memory: consolidated box summaries, cross-thread patterns, durable preferences, and repeated lessons.

The system should not copy Hippo's garbage-collection behavior for source conversations. Verbatim turns remain durable. Decay only affects active recall priority and context inclusion.

## System Boundary

The memory platform should be a standalone service with a small adapter for each host agent. The adapter should be thin and replaceable. Its responsibilities are:

- send conversation events to the memory service
- receive prepared memory injection packets
- expose an explicit memory search/resume tool if the host supports tools
- pass user approvals or rejections back to the memory service
- report context-window budgets and compression events when available

The memory service owns:

- durable transcript storage
- topic monitoring
- pre-compaction
- summaries
- boxes
- anchors
- sleep review
- retrieval
- injection packet generation
- audit trail

The first integration target should be Roscoe-Hermes. Hermes already has a unified per-profile timeline, FTS5 search, persistent `MEMORY.md`/`USER.md`, context compression, gateway adapters, and memory provider plugins. The memory system should integrate with those surfaces instead of assuming Pi hooks.

Likely Hermes adapter surfaces:

- ingest from Hermes unified timeline or session store
- write memory injection packets into the context assembly path
- expose memory search/resume as Hermes tools or plugin actions
- observe `/new`, `/reset`, and `/compress` as compaction/resume signals
- preserve profile/user scoping

Pi integration can be a later adapter that follows the same contract.

## Data Model

### Turn

A turn is the append-only base record. Every user, assistant, tool, or system event is stored as a durable row.

Fields should include:

- `id`
- `thread_id`
- `role`
- `content`
- `created_at`
- `sequence`
- `metadata`
- `provenance`
- `trust_level`
- `content_hash`

Turns are never deleted as part of compaction.

Turns should distinguish direct user conversation from external content processing. This matters for legal work and for prompt-injection defense: memory derived from documents, web pages, emails, or tool output should carry lower trust than direct user statements unless explicitly approved.

### Summary

A summary is a derived durable record. It compresses one or more source turn ranges or prior summaries.

Fields should include:

- `id`
- `summary_text`
- `source_turn_ranges`
- `source_summary_ids`
- `box_ids`
- `embedding`
- `created_at`
- `model`
- `prompt_version`
- `confidence`
- `state`
- `detail_level`
- `token_count`
- `last_accessed_at`
- `version`
- `strength`
- `retrieval_count`
- `retrieved_at`
- `half_life`
- `outcome_score`

Summaries are the primary embedding target because they represent coherent subject chunks. Raw turns remain available for expansion, but they do not need to be the default vector unit.

Summaries should support multiple detail levels: full, medium, brief, and stub. Shorter detail levels help inactive memory decay out of active context without losing the underlying verbatim turns.

Summaries should also track strength. A summary that is retrieved and proves useful should become easier to recall again. A summary that is stale, rejected, or unhelpful should weaken. This keeps the system from treating all old memories equally.

### Box

A box is a topic container. It starts as one compacted span, then can mature into a durable subject node containing many non-contiguous spans over time.

Fields should include:

- `id`
- `title`
- `description`
- `parent_box_id`
- `child_box_ids`
- `summary_ids`
- `turn_ranges`
- `state`
- `created_at`
- `updated_at`
- `case_id`
- `box_type`
- `summary`
- `last_activity_at`

Boxes can represent personal topics, cases, clients, projects, workflows, or subtopics. For a law-firm case, a parent box might represent the case. Child boxes might represent PIP coverage, bodily injury coverage, medical bills, demand strategy, providers, or deadlines.

Boxes need both hierarchy and accumulated spans. A mature box can contain many non-contiguous turn ranges and summaries from different times. A child box should be created when a subject branch becomes durable enough to benefit from its own summary, embedding, and recall policy.

### Anchor

An anchor is a high-signal turn or compact fact that should survive decay at full fidelity.

Anchor types should include:

- `decision`
- `deadline`
- `key_fact`
- `strategic_insight`
- `bookmark`

Anchors should include:

- `id`
- `turn_id`
- `thread_id`
- `box_id`
- `anchor_type`
- `content`
- `embedding`
- `created_at`
- `trust_level`
- `source`

Anchors are not a replacement for conversation memory. They are guardrails against lossy summarization and precise retrieval handles for high-stakes details.

High-value negative events, such as errors, failed assumptions, missed deadlines, or corrected legal strategy, should receive longer half-lives. Hippo calls this emotional tagging; in this project the practical version is outcome-aware retention.

### Link

A link connects related memory objects.

Link types should include:

- `same_subject`
- `parent_child`
- `follow_up`
- `contradicts`
- `supersedes`
- `duplicate_candidate`
- `related`

Links are proposed conservatively in early phases and audited.

### Injection Packet

An injection packet is the handoff from the background monitor to the main agent.

Fields should include:

- `id`
- `current_topic_summary`
- `selected_memory`
- `source_summary_ids`
- `source_turn_ranges`
- `box_ids`
- `relevance_reason`
- `confidence`
- `disclosure_text`
- `created_at`

The packet is not necessarily shown to the user. It is context for the agent, with enough provenance to explain the recall later.

Injection packets should be consumed by the host adapter as a clearly delimited memory zone or equivalent host-native context artifact. The adapter should only read prepared injection packets and write captured conversation events; LLM calls, embedding calls, summarization, and topic analysis belong in the standalone memory service.

## Accordion Behavior

The system uses an accordion model:

- Active subject: raw turns and detailed summaries can expand into context.
- Inactive subjects: compact summaries remain available, but detailed turns fall out of active context.
- Returning subject: relevant summaries revive, and raw turns can be loaded when the conversation needs depth.
- New subject: the previous subject is pre-compacted and the new subject becomes active.

The `/clear` or new-conversation action should not mean forgetting. It should mean compact the current active context, preserve the transcript, and begin a new active subject.

The active context budget should default low, around 10% of the context window. The older 10-20% range is acceptable as a ceiling, but the system should not try to fill it. Every memory token should justify its place.

## Box Lifecycle

A box starts as a summarized span, such as "turns 1-30 about subject A."

If subject A returns later, the same box may also include later spans, such as "turns 4350-4380." Over time, if the subject becomes broad enough or semantically drifts far enough, the system can propose child boxes.

The default splitting policy is suggest-and-confirm. Manual box creation must always be available. As the system matures, high-confidence automatic organization can move into an offline sleep-review process.

## Sleep Review

Sleep review is an offline process that organizes memory after the fact. It should optimize for minimal user interruption.

Early behavior:

- Every proposed memory change waits for user approval.
- The morning review shows only high-value proposed changes.
- The full audit trail exists underneath but is not surfaced by default.

Later behavior:

- Low-risk, high-confidence updates can apply automatically.
- Structural changes still require approval.
- Durable facts, preferences, and commitments still require approval.

Sleep review can propose:

- new boxes
- child boxes
- box merges
- box splits
- links between related summaries
- stale boxes
- revived boxes
- disputed or contradictory memories

Sleep review is also where the system can become more automatic over time. Early versions should show every proposed change for approval. Later versions can auto-apply low-risk updates while still requiring confirmation for structural changes and durable facts, preferences, or commitments.

Sleep review should include consolidation work inspired by Hippo:

- replay recent episodes into higher-level semantic summaries
- decay inactive summaries out of active context priority
- strengthen repeatedly useful memories
- merge near-duplicate semantic entries
- flag contradictions
- propose child boxes or box merges
- promote high-value lessons into stable semantic memory

Any destructive cleanup should apply only to derived artifacts that can be regenerated. Raw turns and approved anchors are not garbage-collected.

## Trust And Error Handling

Every meaningful memory injection must be auditable. The system must be able to answer:

- What source turns or summaries caused this recall?
- When were they created?
- What box did they belong to?
- What was the confidence?
- Was this memory approved, inferred, stale, disputed, or superseded?

Memory objects should use explicit states:

- `active`
- `compacted`
- `stale`
- `revived`
- `proposed`
- `approved`
- `rejected`
- `superseded`
- `disputed`

Disputed memory should not be injected without explicit framing. Conflicting memory should preserve both sources and present the issue as a possible change over time, not silently overwrite one memory with another.

For legal-work use cases, provenance needs to be one request away. The answer can remain natural, but the system must be able to show the exact remembered conversation context behind a recall.

Summary updates should be additive by default. If a January summary says liability was denied and a later conversation says liability was accepted at 80/20, the system should preserve the timeline instead of overwriting the old statement as if it were false. This avoids legal-history corruption.

Prompt-injection risk must be handled at capture and surfacing time. Turns derived from external content should be tagged, lower-trust, and filtered more carefully before becoming durable memory or agent instructions.

## Implementation Constraints From Prior Research

The earlier research identified several technical constraints that should carry into implementation:

- Host adapter hooks must be verified against the target runtime before coding.
- Host adapter hooks must stay fast; no LLM calls or embedding calls inside synchronous agent hooks.
- If using Supabase/Postgres with pgvector, PostgREST does not expose pgvector operators directly, so vector search should use RPC functions or direct SQL through Drizzle/postgres.
- If using pgvector HNSW indexes, queries must order by the raw vector distance operator.
- Store embedding model and dimensions with every embedding.
- Build a re-embedding path early, because embeddings from different models cannot be mixed safely.
- Keep raw turns immutable and summaries mutable/versioned.
- Use content-hash deduplication to avoid duplicate capture.

The earlier TypeScript stack remains one viable implementation path, but it is no longer a settled decision:

- Node.js and TypeScript
- Supabase/Postgres with pgvector
- Drizzle ORM for schema and migrations
- Supabase RPC or direct SQL for vector search
- Vercel AI SDK for LLM and embedding calls
- Hono for sidecar HTTP endpoints
- PM2 for local sidecar process management
- Zod for structured LLM output and API validation
- Vitest for tests

Hippo's SQLite plus markdown/YAML mirror model is relevant for portability and inspection. It should be considered alongside Postgres/Supabase rather than dismissed. A later export/mirror layer could write selected summaries, boxes, anchors, and audit metadata to human-readable files for git tracking, debugging, and cross-agent portability regardless of the primary database.

Storage remains open. Candidate approaches:

- Postgres plus pgvector: strongest relational model, good for auditability, multi-agent use, server deployment, and future multi-user support.
- SQLite plus sqlite-vss/sqlite-vec or external vector index: attractive for local-first use, Hermes-style per-profile state, portability, and easy backup.
- Hybrid local-first plus server sync: local SQLite for host adapters and fast capture, Postgres/server store for consolidation, cross-device access, and longer-term operations.
- LanceDB/Qdrant/Chroma plus relational store: useful if vector workload grows, but adds infrastructure and sync complexity.

The implementation plan should compare these against the first deployment target, Roscoe-Hermes, before committing.

## Phases

### Phase 1: Conservative Accordion Core

Build:

- standalone memory service API
- Roscoe-Hermes adapter contract
- append-only turn storage
- summary rows with source ranges
- basic boxes
- anchors for decisions, deadlines, key facts, and strategic insights
- topic-change detection
- pre-compaction
- topic-level retrieval
- quiet injection packets
- full provenance

This phase should also verify Hermes integration surfaces, decide the first storage backend, create the schema, scaffold the memory service, and expose stubbed context injection and search paths. Pi hooks are not part of the first implementation unless the target changes.

### Phase 2: Sleep Review

Build:

- proposed splits
- proposed merges
- proposed child boxes
- stale and revived box detection
- summary-to-summary links
- approval workflow for every proposed change

This phase should also add box summaries, summary versions, context budget packing, detail-level summary compression, and explicit bookmarks.
It should add retrieval strengthening and sleep-review consolidation metrics: strength, retrieval count, half-life, and outcome score.

### Phase 3: Automatic Topic Graph

Build:

- automatic low-risk organization
- higher-confidence topic graph maintenance
- automatic linking where confidence is strong
- continued confirmation for structural changes and durable facts, preferences, and commitments

This phase can also add cross-case entity detection, automatic decay tuning, staleness review, and higher-confidence resumption workflows.

## Validation

Validation should focus on preventing wrong recall.

Test scenarios should include:

- stale memories
- similar but different legal cases
- topic drift
- returning to an old topic
- expanding from summary to raw turns
- asking why a memory was recalled
- rejecting a proposed box split
- approving a proposed child box
- conflicting prior summaries
- `/clear` as compaction rather than forgetting

Success means the system stores everything, injects little, recalls with provenance, and expands only when the active conversation needs depth.
