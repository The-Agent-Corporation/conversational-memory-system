# ADR 0049: Retrievable Memory States

## Status

Accepted

## Context

`GAP-11-A` (found during Phase 11 Plan 07's post-implementation measurement against the live
292,407-event corpus, recorded in `.planning/phases/11-derivation-input-hygiene/11-MEASUREMENT-VERIFIED.md`):
supersession flips a `Summary`'s `state` to `"superseded"`; it never deletes the row. Phase 11's
derivation-hygiene rebuild (ADR 0048) ran `rebuild-derivations` against the live database and
produced **87,727 superseded summaries still carrying the pre-hygiene fragmented, tool-call-laden
text** that REQ-053 exists to keep out of summarization, embedding, trace discovery, and
injection.

Retrieval never consulted `state` at all. `applyRetrievalBoundary`
(`src/retrieval/memory-retriever.ts`) filtered candidates on `personId` and `scopeIds` only;
`rankMemories` filtered only on `score > 0`. Reproduced in isolation with one active and one
superseded summary sharing a topic:

```json
{ "returnedSummaryIds": ["s_new", "s_old"],
  "supersededWasRetrieved": true,
  "injectedTextContainsToolCall": true }
```

The injected packet contained the superseded summary's `[Tool call: Bash] {"cmd":"make"}` text.

**Severity.** The defect predates Phase 11 — superseded summaries were always retrievable — but
was latent because the live corpus had approximately zero superseded rows before the rebuild.
The rebuild converted a dormant bug into an active one holding exactly the content Phase 11
exists to remove, blunting the user-visible recall benefit of the hygiene rules until fixed.
This blocked SC7 (recall quality) sign-off on Plan 07 and was routed to gap closure as Plan 08.

## Decision

**Retrievable = `active`, `compacted`, `revived`. Excluded = `superseded`, `stale`, `proposed`,
`approved`, `rejected`, `disputed`** (D-GAP-1, owner-locked partition). This is an allow-list,
not a blacklist: a `MemoryState` not explicitly named as retrievable is excluded by default, so
a future addition to `MemoryStateSchema` fails closed instead of silently becoming retrievable.

The partition is recorded once, as the single source of truth, in
`src/retrieval/retrievable-state.ts`:

- `RETRIEVABLE_MEMORY_STATES` — `["active", "compacted", "revived"]`
- `REVIVABLE_MEMORY_STATE` — `"stale"`, the one non-retrievable state that can be promoted
- `RETRIEVAL_CANDIDATE_STATES` — the retrievable set plus `REVIVABLE_MEMORY_STATE`, the set a
  store-level query must load (consumed by Plan 11-10's store-level query surface)
- `isRetrievableState(state)` — the predicate

**Enforcement is centralized inside `applyRetrievalBoundary` (D-GAP-2)**, not at any
`prepareInjection` call site. `scopedSummaries` (and the legacy-unscoped equivalent) are filtered
through `isRetrievableState` before `summaryIds` is built, so every downstream membership test —
`scopedTraces`'s and `scopedBoxes`'s `summaryIds.every((id) => summaryIds.has(id))` — inherits
the exclusion automatically. No per-call-site filter was added anywhere; the acceptance criterion
for Plan 08 explicitly forbade one, and `grep -rn "isRetrievableState" src/` confirms the boundary
function is the only enforcement site (T-11-19, T-11-20).

The legacy unscoped retrieval path (`allowLegacyUnscoped`) applies the identical state partition
in its own early-return branch, so it cannot be used as a bypass (T-11-21).

### Per-object-kind disposition

| Object | State field | Disposition |
|---|---|---|
| `Summary` | `state: MemoryState` | Filtered directly by `isRetrievableState` inside `applyRetrievalBoundary`. |
| `MemoryTrace` | `state: ProposalState` | Inherits via the `summaryIds.every(...)` membership test — a trace whose linked summaries are not all retrievable is excluded even though its own `state` is a different enum. Traces are additionally pre-filtered by `listTraces({ state: "approved" })` before `applyRetrievalBoundary` ever sees them. |
| `Box` | `state: MemoryState` | Inherits via the same `summaryIds.every(...)` membership test as traces. Box parent-context promotion (`addParentBoxContext`) is additionally gated on `parent.state` being one of `["active", "approved", "revived"]` before a parent box's summary text is spliced into a packet. |
| `Anchor` | none | `AnchorSchema` (`src/domain/types.ts`) carries no `state` field at all, so there is nothing for it to inherit. Anchors are gated at derivation time instead, by Plan 11-02's anchor gating (excluded synthetic/tool-run content never produces an anchor in the first place). |

### Revival consequence

Excluding `stale` from the retrievable set removes the only event that used to promote a summary
to `"revived"` — the on-selection promotion in `recordSelectedSummaryAccess`
(`state: summary.state === "stale" ? "revived" : summary.state`). That promotion is in turn what
`SleepReviewer.refreshBoxState` (`src/sleep/sleep-reviewer.ts`) uses to revive a box: `box.state
=== "stale" && linkedSummaries.some((summary) => summary.state === "revived")`. Making `stale`
non-retrievable without another path to `"revived"` would make `"revived"` — and therefore box
revival — permanently unreachable.

**Resolution: deferred revival.** `applyRetrievalBoundary` returns a second list,
`revivableSummaries` (summaries in the caller's person/scope with `state === "stale"`), alongside
the retrievable `summaries` list. After `prepareInjection` computes `selected` for the current
packet, it scores every revivable summary with the same `rankSummary` scorer and options used for
retrievable summaries. Any revivable summary whose score is `> 0` AND `>= Math.min(...selected.map(m
=> m.score))` — the "selected floor" — is written back via `store.saveSummary` with `state:
"revived"`, refreshed `lastAccessedAt`/`retrievedAt`, an incremented `retrievalCount`, and
`strengthen(strength)`. Critically, this write happens **after** `ranked`/`selected`/the packet are
already finalized: a promoted summary never enters `ranked`, `selected`, `packet.selectedMemory`,
or `packet.sourceSummaryIds` for the packet whose scoring triggered its promotion. It only becomes
retrievable — and therefore only reaches `selectedMemory` — on a **subsequent** `prepareInjection`
call. When `selected` is empty (or the packet is null), nothing is promoted.

**Rejected alternative 1 — drop revival entirely.** Simplest, but leaves `"revived"` and
`refreshBoxState`'s box-revival branch permanently unreachable dead code, silently regressing a
DoS-shaped behavior (T-11-23): a summary that decays past the stale threshold could never recover
strength or reactivate its parent box again, for the lifetime of the database.

**Rejected alternative 2 — keep `stale` summaries retrievable.** Trivially preserves the
`state === "stale" ? "revived" : summary.state` promotion on direct selection, but violates
D-GAP-1: `stale` is explicitly in the excluded set, and this alternative would let content that
already decayed past the strength/age threshold (see `SleepReviewer.decaySummary`, the inverse
edge below) re-enter injection packets exactly like the superseded-summary defect this ADR fixes,
just with a different trigger state.

**The inverse edge — `SleepReviewer.decaySummary`.** `decaySummary` moves a summary from a
retrievable state into `"stale"` when `decayedStrength < staleStrengthThreshold`. This ADR's
deferred-revival mechanism is the pre-existing decay threshold's counterpart: decay pushes a
summary out of the retrievable set on a schedule; deferred revival is the only path back in, gated
by the summary actually out-scoring the current retrieval's selected floor rather than by simple
elapsed time.

### Scope not covered by this ADR

Whether the 87,727 superseded rows created by the Phase 11 rebuild (approximately 155 MB) should
also be pruned or archived is explicitly out of scope for this decision — this ADR only closes the
retrieval-time leak (REQ-053's injection clause). Storage reclamation, if wanted, is a separate
decision.

## Consequences

- A superseded summary is never returned by retrieval and its text never appears in an injection
  packet — REQ-053's injection clause now holds, closing SC7's blocker from Plan 07.
- `Summary`, `Box`, and `MemoryTrace` share one enforcement point; `Anchor` is unaffected by
  construction (no state field) and was already gated at derivation time.
- Revival remains reachable, but is now always deferred by exactly one retrieval cycle relative to
  the query that discovers a stale summary outranks the current packet's floor. This is an
  intentional trade against ever injecting decayed/excluded content, not an oversight.
- `RETRIEVAL_CANDIDATE_STATES` is exported now, ahead of need, so Plan 11-10's store-level query
  surface (loading only retrievable + revivable rows from the store instead of every row) has a
  ready-made constant instead of restating the union.

## Requirement Traceability

| Requirement / Gap | Where |
|---|---|
| REQ-053 (injection clause) | `isRetrievableState`, `RETRIEVABLE_MEMORY_STATES` — `src/retrieval/retrievable-state.ts`; enforcement in `applyRetrievalBoundary` — `src/retrieval/memory-retriever.ts` |
| SC7 (recall quality, Plan 07 blocker) | Regression suite in `tests/retrieval/retrievable-state.test.ts` and the `GAP-11-A` describe block in `tests/retrieval/memory-retriever.test.ts` |
| GAP-11-A | This ADR; closed by Plan 11-08 |
