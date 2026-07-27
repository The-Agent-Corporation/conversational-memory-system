# ADR 0051: Anchor Derivation Hygiene — Gate Forward, Prune Backward, No Lifecycle

## Status

Accepted

## Context

`GAP-11-D` (found during Plan 11-13 Task 1, the frozen 12-query recall probe): Phase 11's
derivation-hygiene classifier (`src/topic/derivation-hygiene.ts`) reached contraction and topic
labeling, but never anchors. `AnchorDetector.detectForTurn` was called unconditionally for every
ingested turn (`src/integrations/hermes/adapter.ts:89`), with no equivalent to the
`drivesTopicLabel` gate topic labeling already used three lines above it. `buildAnchor` stored
`turn.content` verbatim — including, for a tool-call turn, the literal `[Tool call: Write]
{"file_path":...}` string. Tool-call argument payloads (ADR text, commit messages, plan prose) are
dense with the keyword regexes `detectAnchorTypes` scores against, so tool-call turns routinely
minted high-scoring anchors that outranked hygienic summary text in `prepareInjection`'s ranking.
The probe measured this directly: `containsToolCallText` went from 9/12 (pre-hygiene backup) to
**10/12** (live corpus, post-hygiene-rebuild, post-GAP-11-A state filter) — Phase 11's summary work
did not reduce tool-call text reaching injection packets, because the leak was never in summaries.

**Forward fix landed in `4d17978`.** `AnchorDetector.detectForTurn` now returns `{ anchors: [] }`
for any turn where `drivesTopicLabel({ content, role })` is false — the identical predicate topic
labeling uses, no new rule. This stops new unhygienic anchors from being created. It is
forward-looking only: it does not touch the 45,911 anchors already in the live corpus.

**Read-only census of `~/.memory/aaron.db`** (measured 2026-07-27, classified with the shipped
`classifyEvent` against content alone, since anchors persist no role/eventKind):

| derivationClass | anchors | share |
|---|---|---|
| conversational | 20,119 | 43.8% |
| synthetic_injected | 16,881 | 36.8% |
| tool_activity | 8,911 | 19.4% |
| **would be gated by the forward fix** | **25,792** | **56.2%** |

This ADR records the decision for the remediation half: how to remove the existing 25,792+
anchors without giving anchors a durable lifecycle they did not previously have.

## Decision

### 1. Anchors get no `MemoryState` lifecycle

**Alternative considered and rejected:** add `state`/supersession to `AnchorSchema`
(`src/domain/types.ts`) and teach `isRetrievableState` (ADR 0049) to recognize anchors, so an
unhygienic anchor could be flagged rather than deleted.

**Rejected for ADR 0050's reason, applied to anchors:** an anchor is a pure derivation over one
turn — `buildAnchor` computes it entirely from `turn.content`/`turn.role`/`turn.provenance` — and
is fully reproducible by re-deriving from the untouched canonical timeline. A lifecycle field
would durably retain the exact tool-call text REQ-053 exists to exclude, under a `superseded`-style
flag, while adding a second entity every retrieval-boundary proof (ADR 0049's `applyRetrievalBoundary`
enforcement, MCP read/search, subject expansion) would need to be re-verified safe against, forever.

**The asymmetry with summaries makes this easier, not harder.** A superseded summary can still be
*referenced* — by a box, a trace, a proposal, or another summary's `sourceSummaryIds` — which is
why `commitSupersededSummaryPrune` has four reference-kind skip reasons. An anchor has **no inbound
references at all**: `grep -rn "anchorIds" src/domain` finds none, `InjectionPacketSchema` records
no anchor ids, and `Anchor.boxId` points *outward* at a box rather than being pointed at by
anything. There is no reference-protection class of skip to preserve, so there is nothing a
lifecycle would protect that unconditional deletion does not already handle safely.

### 2. Gate forward, prune backward

The gate (`4d17978`) stops creation; it cannot retract existing rows. The GAP-11-A machinery
(`applyRetrievalBoundary`, `isRetrievableState`) could not be extended to close this gap either,
even in principle: `prepareInjection` loads anchors through a separate, unfiltered
`store.listAnchors()` call (`src/retrieval/memory-retriever.ts:40`) with no state predicate and no
relationship to summary supersession. `commitSupersededSummaryPrune` changes which summaries are
stored; it changes nothing about which anchors rank. The two leaks (superseded summaries reaching
retrieval, unhygienic anchors reaching retrieval) share a root cause (an unfiltered load path) but
are structurally independent fixes over independent tables — this is why GAP-11-D required its own
plan (11-16) rather than falling out of Plan 11-13's live prune.

`commitUnhygienicAnchorPrune` (`src/storage/{sqlite,in-memory}-store.ts`) is the removal path:
named, contracted (`CommitUnhygienicAnchorPruneInputSchema` /
`UnhygienicAnchorPruneReceiptSchema`, `src/storage/mcp-mutation-contracts.ts`), implemented
identically in both stores, following this repo's convention (established by
`commitSupersededSummaryPrune`) that multi-row derivation removal goes through a named `commit*`
method rather than an ad-hoc delete script.

### 3. Classification is recomputed, never persisted

Consistent with the CONTEXT decision that hygiene classification is "computed at contraction time;
only the rule version is persisted" — `commitUnhygienicAnchorPrune` classifies an anchor from its
`content`, enriched with `role`/`eventKind` resolved from its `canonicalEventId` when present
(falling back to content-only classification when the id is absent or does not resolve, since
`AnchorSchema.canonicalEventId` is optional). This enrichment is a **strict superset** of the
forward gate's inputs — `AnchorDetector.detectForTurn` passes `{ content, role }` from a `Turn`,
which has no `eventKind` field at all — so the prune can never retain an anchor the forward gate
would have refused.

**Consequence: the census is a floor, not a target.** The 25,792-row census above is content-only,
because anchors carry no persisted role/eventKind. Enriching from the resolved canonical event
lets role-gated rules (`silent-sentinel`, which only fires for `role: "assistant"`) and the
`role === "tool"` / `eventKind === "tool_call"` branches of `classifyEvent`'s tool-activity check
fire on anchors whose *content alone* reads as ordinary prose. The live prune is expected to remove
more than 25,792 rows for this reason; no plan or test in this repo should assert an exact prune
count as a pass/fail criterion.

### 4. Safety contract

Mirrors ADR 0050's five properties, restated for anchors:

1. **In-transaction authoritative eligibility.** `commitUnhygienicAnchorPrune` never trusts the
   caller's `anchorIds` list as an authorization — every id is reclassified from live store state
   inside the method's own transaction (SqliteStore: `begin immediate`/`commit`/`rollback`;
   InMemoryStore: arrays mutated only after every decision is made). A conversational anchor's id
   passed explicitly by the caller is still retained (`retained_conversational`).
2. **Refusal reported, not silent.** `person_mismatch` (a different person's anchor) and
   `person_unattributed` (`Anchor.personId` absent — `AnchorSchema` makes it optional) are both
   live, tested skip reasons: an anchor with unknown ownership never defaults to belonging to the
   requester.
3. **Structurally scoped deletion.** SqliteStore deletes through an inline
   `delete from anchors where id = ?` inside its own transaction — never `deleteAnchors`, which
   opens its own transaction and would nest. Neither store's implementation touches
   `canonical_events`, `turns`, `summaries`, `boxes`, `traces`, `proposals`, or `injections`;
   this is asserted by a before/after control-count equality test across all seven, not a spot
   check.
4. **Id-cursor resumability.** `listAnchorIds(personId, { limit, afterId })` mirrors
   `listSupersededSummaryIds` (`src/storage/sqlite-store.ts:1278`) exactly: a
   `json_extract(payload,'$.personId') = ?` clause plus an `id > ?` clause when `afterId` is
   present, `order by id asc limit ?`. **No column, no index, and no schema migration is
   involved** — `anchors` has the identical `(id, payload)` shape as `summaries`, so the identical
   predicate works unchanged. Because `anchors` has no person index (unlike `summaries`, which
   gained `idx_summaries_person_state` in Plan 11-09), this cursor is an unindexed table scan per
   page. That is an accepted tradeoff for a one-time cleanup over the live corpus's tens of
   thousands of rows, not a reason to migrate the schema.
5. **Idempotent completion.** A second commit over an already-pruned id set reports every id
   `not_found` and prunes nothing; a completed prune followed by a re-run over the same id list is
   a no-op.

### Recovery

Recovery from an incorrect or over-eager anchor prune is: restore from a verified backup, or —
forward recovery — anchors re-derive automatically on subsequent contraction, since
`AnchorDetector.detectForTurn` runs against every ingested turn and is idempotent per
`turn.id`/`anchorType` (`buildAnchor`'s `id: anchor_${turn.id}_${anchorType}`). **There is no
`rebuild-anchors` command today** — unlike summaries, which have an explicit `memory
rebuild-derivations` path (ADR 0048), anchor re-derivation only happens as a side effect of turns
being processed again; nothing in this repo re-walks the canonical timeline purely to regenerate
anchors on demand. Say this plainly rather than implying such a command exists: the honest recovery
story for a mis-pruned anchor is "restore from backup," not "run a rebuild command."

The backup at `~/.memory/aaron.db.pre-phase11` (created before the Phase 11 rebuild, retained per
ADR 0050's Recovery section) remains the last full-fidelity snapshot predating both the hygiene
rebuild and any anchor prune, and must not be deleted until the owner records sign-off on
post-prune recall quality.

## Consequences

- `commitUnhygienicAnchorPrune` / `listAnchorIds` / `summarizeAnchorDerivationClasses` exist,
  identically, in `SqliteStore` and `InMemoryStore` (`src/storage/{sqlite,in-memory}-store.ts`),
  contracted in `src/storage/mcp-mutation-contracts.ts`.
- No operator-facing command (analogous to `memory prune-superseded`) is built by this plan; the
  live-corpus execution against `~/.memory/aaron.db` is explicitly deferred, owner-gated, the same
  way Plan 11-12 built the summary-prune machinery ahead of Plan 11-13's live execution.
- `Anchor` remains, by construction, the one derivation object in this codebase with no `state`
  field and no inbound references — this ADR documents why that stays true rather than being
  extended to match `Summary`'s lifecycle.
- Canonical events, turns, summaries, boxes, traces, proposals, and injections are structurally
  unreachable by this prune — enforced by inline, scoped delete SQL and verified by dedicated
  before/after control-count tests (`tests/storage/anchor-hygiene-prune.test.ts`).
- ADRs 0048, 0049, and 0050 are unchanged by this decision.

## Requirement Traceability

| Requirement / Gap | Where |
|---|---|
| REQ-052 (shared hygiene classifier reused, no new rules) | `classifyEvent` reused unmodified inside `commitUnhygienicAnchorPrune`; role/eventKind enrichment documented above |
| REQ-053 (derivation-input hygiene, cleanup of pre-gate anchor residue) | `commitUnhygienicAnchorPrune` (Plan 11-16, `src/storage/{sqlite,in-memory}-store.ts`) |
| REQ-054 (resumable/idempotent safety properties applied to cleanup) | Id-cursor resumability (`listAnchorIds`) and idempotent completion, tested in `tests/storage/anchor-hygiene-prune.test.ts` |
| GAP-11-D | This ADR; forward gate landed in `4d17978`; store-layer removal path built by Plan 11-16; live execution against the real corpus remains owner-gated and out of this plan's scope |
