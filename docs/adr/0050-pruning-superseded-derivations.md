# ADR 0050: Pruning Superseded Derivations

## Status

Accepted

## Context

ADR 0049 closed the retrieval-time leak (`GAP-11-A`): a `superseded` summary is no longer returned
by retrieval or injected into a packet. It explicitly left one question open: whether the 87,727
superseded summaries created by the Phase 11 derivation-hygiene rebuild (~155 MB of pre-hygiene,
tool-call-laden text, out of 50,551 active summaries / 74.1 MB) should also be **pruned** (deleted)
or **archived** (moved somewhere else) — pure storage reclamation, not a correctness fix.

Supersession already means "not deleted, only flagged": `state: "superseded"` rows sit indefinitely
in the same `summaries` table as active rows, unless something removes them. Plan 11-11 built
`commitSupersededSummaryPrune` — an atomic, reference-checked, receipt-producing removal path
implemented identically in `SqliteStore` and `InMemoryStore` — as the machinery a prune command
would need. This ADR records the decision to build that command (Plan 11-12, `memory
prune-superseded`) and the safety contract it must uphold before it is ever pointed at the live
4.6 GB corpus (Plan 11-13, owner-gated).

## Decision

**Prune, not archive.**

Superseded summaries are pure derivations: every one of them is fully reproducible from the
immutable canonical event timeline (`canonical_events`, never touched by hygiene, supersession, or
this prune) via `memory rebuild-derivations`. An archive table would durably store the exact
pre-hygiene tool-call text REQ-053 exists to keep out of the system, under a different table name,
while doubling the person/scope-isolation surface (a second table `applyRetrievalBoundary` and
every audit/export/backup path would need to reason about being safe against). Archiving trades a
one-line retrieval-boundary miss (ADR 0049's actual bug) for a second table that must be
independently proven never-retrievable, forever. Pruning has no such surface: the row is gone, and
the only way it comes back is the deliberate, already-tested `rebuild-derivations` path.

### Safety contract

`memory prune-superseded` (`src/operations/prune-superseded-command.ts`) wraps
`commitSupersededSummaryPrune`/`listSupersededSummaryIds`/`summarizeSupersededSummaries` (Plan
11-11) with five properties, because this is a corpus-wide, effectively destructive migration over
the owner's real database — the safety properties are as much the deliverable as the deletion:

1. **Dry-run is the default.** Invoking the command without `--apply` calls
   `summarizeSupersededSummaries` and pages `listSupersededSummaryIds` to report
   `candidateCount`, `estimatedBytes`, and `referencedSkipCount` (a read-only reference-set scan
   over boxes/traces/proposals/summaries, for reporting only — it duplicates no deletion logic).
   Nothing is written. `--apply` is the single explicit opt-in required before anything is deleted.
2. **The backup gate fails closed.** `--apply` additionally requires `--confirm-backup <path>`.
   `statSync` must show the path exists, is a regular file, and is non-empty, or the command throws
   before touching a single row. Absent, unreadable, or empty backups refuse the run identically to
   a missing flag — there is no code path where `--apply` deletes anything without a verified
   backup already on disk.
3. **In-transaction authoritative eligibility.** The command never decides what is safe to delete;
   it pages ids and hands them to `commitSupersededSummaryPrune`, which recomputes
   not_found/not_superseded/person_mismatch/referenced-by-{box,trace,proposal,summary} from scratch
   inside its own transaction on every call (Plan 11-11). The command's `summaryIds` list is a
   request, never an authorization.
4. **Atomic summary+vector+injection removal, reference refusal reported not silent.** Each
   committed batch atomically removes a superseded summary's row, its `summary_vectors` rows, and
   any injections that reference it — or refuses and records why. `skippedByReason` accumulates
   every skip reason across all batches into the command's result, so a referenced row surviving the
   run is visible in the output, not silently left behind (T-11-47).
5. **Id-cursor resumability, idempotent completion.** The cursor advances to the highest id in each
   page regardless of skips, so a reference-protected row at the head of the cursor can never wedge
   the loop (T-11-43). There is no checkpoint row: each page re-queries `listSupersededSummaryIds`
   against live state, so an interrupted run simply resumes — a still-superseded id shows up again,
   an already-pruned id does not. A completed run followed by a second run finds nothing left to
   page over and makes zero `commitSupersededSummaryPrune` calls.

### Revival interaction

A `stale` summary is **not** `superseded` — it is a distinct `MemoryState` reached only through
`SleepReviewer.decaySummary`'s strength/age threshold (see ADR 0049 "the inverse edge"), and it is
the one state `REVIVABLE_MEMORY_STATE` names as promotable back to `"revived"` via deferred
revival. `listSupersededSummaryIds` and `summarizeSupersededSummaries` query `state = "superseded"`
only (Plan 11-11's `idx_summaries_person_state`-backed queries); a `stale` summary is never returned
by either, and therefore never a prune candidate under any flag combination. Pruning can never
destroy a revivable memory: the two states do not overlap, and this command's cursor never touches
`stale` rows. This is asserted independently of the retrieval boundary tests, directly against the
prune command (Plan 11-12 test case (h)).

### Rebuild interaction

Pruning changes no `ContractionJob`/`ContractionCheckpoint` state — it never bumps a generation,
never writes a checkpoint, and never re-derives anything. A later `memory rebuild-derivations` still
walks the full canonical timeline exactly as it does today: supersession is found by
`sourceCanonicalEventIds` intersection between a newly-derived span and existing summaries (11-
RESEARCH Pitfall 5), not by the presence of an old row. If a rebuild's newly-derived summary would
have superseded a row this command already pruned, the rebuild's supersession check simply finds no
row to supersede (the intersection check tolerates a missing predecessor) and inserts the new
summary directly — pruning a row ahead of a rebuild changes nothing about what the rebuild produces,
only how much dead weight it has to skip over. Pruned rows are never "missing" in a way that could
orphan a rebuild; they are gone precisely because nothing else still needs them (enforced by the
same reference checks pruning itself uses).

### Recovery

Recovery from an incorrect or over-eager prune is: restore from the `--confirm-backup`-verified
backup, or — if only forward recovery is available — run `memory rebuild-derivations`, which
re-derives the full active summary set from the untouched canonical timeline regardless of what the
prune removed. The backup at `~/.memory/aaron.db.pre-phase11` (created before the Phase 11 rebuild)
must **not** be deleted until Plan 11-13's owner sign-off explicitly records that recall quality
against the live corpus is good post-prune. Until that sign-off, it is the last full-fidelity
snapshot predating both the hygiene rebuild and this prune.

### Rejected alternative — archive to a second table

Considered and rejected for the reason stated in the Decision: an archive table duplicates the
exact unwanted text under a new name and requires independently proving it is never retrievable,
forever, rather than relying on the single already-enforced `isRetrievableState` boundary (ADR
0049). Nothing about the live corpus's 87,727 rows is worth preserving that `rebuild-derivations`
cannot reconstruct from canonical events.

## Consequences

- `memory prune-superseded` exists as a standalone, dry-run-by-default, backup-gated operator
  command (`src/operations/prune-superseded-command.ts`), registered in the closed CLI
  command-registry allow-list (`src/cli/command-registry.ts`).
- Storage reclamation against the live corpus (the actual 87,727-row, ~155 MB deletion) is
  explicitly deferred to Plan 11-13, gated on the owner running the command with an already-verified
  backup in hand — this ADR and Plan 11-12 build the command only; no live data is touched here.
- `stale` summaries, active summaries, canonical events, turns, and anchors are structurally
  unreachable by this command — verified by `grep -c "delete from\|deleteIds(" 
  src/operations/prune-superseded-command.ts` returning 0 (the command owns no deletion SQL of its
  own) and by dedicated test coverage (Plan 11-12 tasks 1-2).
- ADRs 0044, 0048, and 0049 are unchanged by this decision.

## Requirement Traceability

| Requirement | Where |
|---|---|
| REQ-053 (derivation-input hygiene, cleanup of the pre-hygiene rebuild residue) | `commitSupersededSummaryPrune` (Plan 11-11, `src/storage/{sqlite,in-memory}-store.ts`); `memory prune-superseded` (Plan 11-12, `src/operations/prune-superseded-command.ts`) |
| REQ-054 (resumable/idempotent/checkpointed rebuild-safety properties applied to cleanup) | Id-cursor resumability and idempotent completion, tested in `tests/operations/prune-superseded-command.test.ts` cases (f)/(g) |
| GAP-11-A (storage-reclamation half, scoped out of ADR 0049) | This ADR; command built by Plan 11-12; live execution gated on Plan 11-13 |
