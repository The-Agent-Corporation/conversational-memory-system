# Backlog — Import the six un-imported Hermes profile databases

**Recorded:** 2026-08-04. **Owner decisions made in session; they are locked inputs, not open questions.**
**Sequencing: this runs AFTER Phase 13 wave 1 lands.** Not before.

## The finding

Hermes is retired as a *runtime* — its only scheduled job,
`com.roscoe.memory-test-sleep-review`, was booted out of launchd and its plist renamed
`.retired-20260804` on 2026-08-04. It had been failing daily with exit 254 since the repo moved out
of `~/Github/`, and its target database (`~/.hermes/profiles/memory-test/memory.sqlite`) had not
been written since 2026-05-15.

**The conversations are a separate matter and are wanted.** The Hermes *importer*
(`src/imports/hermes-*`) stays — it is a host-neutral feature, and another user running Hermes
should still have their history picked up. Only the *runtime bridge* is dead.

Investigating that turned up something not previously known: **only one of seven Hermes databases
was ever imported.**

Every Hermes source in the live corpus carries the same `instanceId`
(`hermes_1034a89a0fc1450dcb4b04cc9ff7e0593635a5da18a4e024278fa3d01fdbfaec`) and a `default/*`
`profileId` — `default/cli`, `default/telegram`, `default/cron`, `default/openclaw-main`,
`default/openclaw-coder`, `default/openclaw-paralegal`, `default/openclaw-brainstorm`,
`default/api_server`, `default/acp`, `default/unknown`. Those are *channels within one instance*,
not the named profiles. The instance is `~/.hermes/state.db`, and it is fully imported: 9,930
sessions → **102,809 canonical events**, spanning 2026-03-21 → 2026-06-10, matching that file's
last write exactly.

`discoverHermesHistory` takes **one explicit database path at a time**
(`hermes-discovery.ts:39-66`, via `resolveHermesDatabasePath`), so a per-profile database is only
found if someone points at it. Nobody did.

## What is un-imported

Measured 2026-08-04 read-only, through the repo's own `discoverHermesHistory` — so the schema is
validated and these are genuinely importable, not merely present on disk.

| profile | sessions | size | session range |
|---|---|---|---|
| `~/.hermes/profiles/brainstorm/state.db` | 2,339 | 758 MB | 2026-03-25 → 2026-06-24 |
| `~/.hermes/profiles/paralegal/state.db` | 1,499 | 825 MB | 2026-04-03 → 2026-06-09 |
| `~/.hermes/profiles/gary/state.db` | 642 | 649 MB | 2026-05-02 → 2026-06-05 |
| `~/.hermes/profiles/coder/state.db` | 181 | 171 MB | 2026-03-29 → 2026-06-07 |
| `~/.hermes/profiles/storysmith/state.db` | 84 | 50 MB | 2026-04-13 → 2026-06-05 |
| `~/.hermes/profiles/memory-test/state.db` | 4 | 0 MB | 2026-05-08 — **test fixture, skip** |

**4,745 real sessions, ~2.45 GB** — roughly 70% again on top of the 3.49 GB already imported.
A proportional estimate is ~70,000 additional canonical events, but that is an *estimate from
bytes* and must be measured on a clone, not projected. ADR 0054's 1.9× optimistic projection is the
standing precedent for why.

Note `paralegal/state.db` has an mtime of 2026-07-31 while its newest session is 2026-06-09 — the
recent writes are not new conversations.

## Locked decision 1 — import all six, with paralegal under its own scope

The paralegal profile is the FirmVault agent and contains client legal material. It **is** imported,
but under a **distinct `scopeId`**, not `personal`.

This makes person/scope isolation load-bearing rather than incidental: retrieval and vector queries
already take an explicit `personId` + `allowedScopeIds`, so a separate scope keeps privileged
content out of ordinary retrieval unless a caller explicitly asks for it.

Consequences to plan for, stated rather than discovered later:

- **The scope fence becomes a correctness boundary.** `findNearestSummaries` filters on
  `allowedScopeIds` (`sqlite-store.ts:1836-1839`) and legacy unscoped retrieval exists only behind
  the explicit `allowLegacyUnscopedRetrieval` opt-in. Both must be verified against the new scope,
  with a test that asserts paralegal summaries are *absent* from a `personal`-scoped query.
- **The contraction scope assertion must accept it.** `assertEventScopes` compares each event's
  scope against its source's; migration 5's expression index defaults a missing scope to
  `'personal'` (ADR 0054 decision 2). A new scope value must flow through both without tripping the
  invariant.
- **Redaction is not classification.** `secret-redactor.ts` targets keys and tokens; it does not
  detect privileged client content. The scope fence is the control, not redaction — do not let the
  presence of redaction stand in for it.
- GAP-11-F is the precedent for why this is being handled deliberately: a credential reached the
  corpus and cost a 57-commit history rewrite.

## Locked decision 2 — this runs after Phase 13 wave 1

Wave 1 lands GAP-12-E (neutralise the all-pairs trace pass) and GAP-12-D (decay idempotency).
Importing first would put ~70,000 new events into a corpus whose proposal review still cannot run —
the exact condition that OOMed the daemon on 2026-08-03.

## Preconditions, all of which currently fail

Do not begin until each is satisfied:

1. **Phase 13 wave 1 landed.**
2. **A consistent, verified backup.** `~/.memory/aaron.db-wal` is **9,228,832 bytes** as of
   2026-08-04. A `cp` of the main file alone is torn. Use SQLite's `.backup` API (Phase 13 plan
   13-09 establishes the mechanism and the three-way verification: `integrity_check`, row-count
   parity against live, recorded `ls -l`). This is Phase 12's F7, and it has now bitten twice.
3. **The stale `daemon_lease` row cleared.** Owner `fa1d7895-f233-4e99-9c2e-6576e95da5c8`, pid
   98966 (dead), acquired `2026-08-03T18:35:53.304Z`, expired `2026-08-03T18:36:36.696Z` — the
   residue of the OOM crash. Harmless (expiry gates writes) but it contradicts the "0 rows" claim
   in earlier notes and should not be carried into an import.
4. **Rehearsed on a `cp -c` clone first** — real event count, wall clock, quarantine rate, and the
   scope fence assertion, before any writable open of the live corpus.

## Fences

- The importer (`src/imports/hermes-*`) is **kept**. Only the runtime bridge is retired.
- `~/Github/Roscoe-hermes` and `~/.hermes/profiles/*` are **not to be deleted** — they are the
  source data for this import.
- The FirmVault LaunchAgents (`com.whaley.firmvault.*`, `com.firmvault.*`) reference `~/.hermes/`
  only as a directory path and are **not** Hermes runtime. They were deliberately left loaded.
- `memory-test` is a test fixture (4 sessions, 0 MB) and is **not** imported.
