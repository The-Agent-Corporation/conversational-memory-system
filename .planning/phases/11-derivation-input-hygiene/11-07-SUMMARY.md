# Plan 11-07 Summary — Live-Corpus Rebuild and Recall Sign-Off

**Status:** Tasks 1 and 2 executed. **Phase does NOT close — one blocking gap found (GAP-11-A).**
**Date:** 2026-07-26

## What was done

**Task 1 — live measurement (read-only).** Ran the hygiene sim against `~/.memory/aaron.db`. The fidelity
gate passed exactly (135,366 summaries / 228.9 MB reproduced), and every previously-measured synthetic
rule reproduced its hit count to the event. Full detail in `11-MEASUREMENT-VERIFIED.md`.

**Task 2 — live rebuild.** The plan specifies this as a manual owner-executed gate. The owner initially
replied "approved" without running it; the orchestrator verified against the database that no rebuild had
occurred (`user_version` still 1, summaries still 135,366, no backup) and declined to record a sign-off
that had not happened. The owner then directed the orchestrator to perform the backup and rebuild
in-session, which it did.

## Results

| Gate | Result |
|---|---|
| Canonical events unchanged | **PASS** — 292,407 before and after (D-1 held) |
| Active summaries | **PASS** — 50,551, exactly matching the simulation |
| Volume | **PASS** — 74.1 MB vs 74.0 MB simulated |
| Residual `[Tool call:` | **PASS** — 10,860, exact match |
| Duplicates / orphaned vectors | **PASS** — 0 and 0 |
| SC6 material reduction | **PASS** — −62.7% count / −67.7% volume vs −59% / −66% targets |
| SC5 idempotency on real data | **PASS** — second run `rebuilt: false, processed: 0` in 13s |
| SC4 explain rationale | **PASS** — `synthetic_injected` / `harness-system` / `hygiene-rules/v1` |
| **SC7 recall quality** | **FAIL — GAP-11-A** |

The real pipeline matching the simulation *exactly* (not approximately) is the substantive result: the sim
runs the production classifier, so this closes 11-CONTEXT's "silent divergence" risk with direct evidence.

## GAP-11-A (blocking) — superseded summaries remain retrievable and injectable

REQ-053 requires excluded content stay out of "summarization, embedding, trace discovery, and
**injection**." The injection path fails after rebuild.

Supersession flips `state`; it does not remove rows. The rebuild left **87,727 superseded summaries**
holding the pre-hygiene fragmented, tool-call-laden text. Retrieval never consults `state`:
`applyRetrievalBoundary` (`src/retrieval/memory-retriever.ts:142`) filters on `personId` and `scopeIds`
only, and `rankMemories` filters only on `score > 0`.

Reproduced in isolation with one active and one superseded summary on the same topic — the superseded row
was returned and its `[Tool call: Bash] {"cmd":"make"}` text was injected into the packet.

The bug predates Phase 11 but was latent (the corpus had ~0 superseded rows). The rebuild converts it into
an active one by creating 87,727 rows of exactly the content this phase removes. Every headline metric
above is genuine, but the user-visible recall benefit is blunted until this is fixed.

## Deviations

- **Task 2 was orchestrator-executed rather than owner-executed**, at the owner's explicit in-session
  direction. Backup taken and integrity-verified first.
- **Sim import paths fixed** (committed in `4231d43`). The sim could not execute at all — it imported
  `./src/topic/*.js`, which ESM resolves relative to the sim's own directory. The bad prefix dates to the
  original measurement commit `2f0f2a7`; Plan 01's instruction told its executor to mirror it, so the bug
  was faithfully propagated. `tsc` resolves these differently and never caught it.

## Not verified

- **Human semantic recall sign-off.** The orchestrator ran mechanical probes and can report *whether*
  recall changed, but cannot judge whether returned memories are *correct* for this corpus. That judgement
  remains outstanding and should be made after GAP-11-A is closed, since results will change.
- **Full-corpus before/after recall probes** were impractical: `prepareInjection` calls `listSummaries()`
  per query, loading every row each time (8 queries exceeded 10 minutes pre-rebuild). Worth its own
  performance look — it is the same O(all-summaries)-per-query shape as the hotspots fixed before v1.1.

## Artifacts

- `.planning/phases/11-derivation-input-hygiene/11-MEASUREMENT-VERIFIED.md` — full measurement + rebuild record
- Backup retained at `~/.memory/aaron.db.pre-phase11` (4.6 GB) — do not delete until GAP-11-A is closed
  and recall is confirmed good.

## Self-Check: PASSED (with blocking gap reported)

Tasks executed as specified; the blocking gap is reported rather than worked around.
