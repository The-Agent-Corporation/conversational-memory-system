# Phase 11 Plan 13 — Frozen Recall Query Set

**Frozen at:** 2026-07-27, before any probe run. This file is committed BEFORE `11-recall-probe.ts` is
executed against any database — `git log --follow` ordering on this file is itself acceptance evidence
(T-11-52). **No query below may be added, removed, or reworded after the first measurement run.** If a
future plan needs different queries, it must freeze a new file, not edit this one.

Each query is phrased as a `currentTopicSummary` string — the same shape `MemoryRetriever.prepareInjection`
receives from a live host in production. Candidates are drawn from real recurring topics in the corpus
(confirmed present via a direct read-only `LIKE` scan of `~/.memory/aaron.db` before freezing this list —
see the hit counts below each query), not invented topics.

Two conventions used below:
- **Answer shape: decision/rationale** — a correct injected packet should surface an ADR-style *why*, not
  just a narrated event.
- **Answer shape: event** — a correct injected packet should surface a specific thing that happened.

## Index (12 frozen queries)

- Q1: zero-knowledge sync relay design — decision/rationale
- Q2: ONNX embedder model choice for semantic recall — decision/rationale
- Q3: macOS Keychain storage for sync device secrets — event/decision
- Q4: daemon lease acquisition and single-writer design — decision/rationale
- Q5: contraction checkpoint and summarization pipeline — event
- Q6: Hermes agent bridge integration and control commands — event
- Q7: importer discovery for Claude Code and Codex host history — event
- Q8: pruning superseded derivations and the backup gate decision — decision/rationale
- Q9: ADR decision records for the conversational memory system — decision/rationale
- Q10: person and scope isolation boundary for memory retrieval — decision/rationale
- Q11: deterministic hash embedder as the default with no external model — decision/rationale
- Q12: quantum-encrypted recipe database for an interstellar spacecraft galley — expected nothing

---

## Q1 — Zero-knowledge sync relay design

`currentTopicSummary`: "zero-knowledge sync relay design decision"
**Answer shape: decision/rationale.** Correct answer references ADR 0047 — the relay stores only opaque
ciphertext, keys stay client-side (libsodium + macOS Keychain), and the design rationale for why the relay
must never be able to read plaintext. (Corpus hit count for "zero-knowledge sync": 5.)

## Q2 — ONNX embedder model choice

`currentTopicSummary`: "ONNX embedder model choice for semantic recall"
**Answer shape: decision/rationale.** Correct answer references the bge-small-en-v1.5 fp32 pinned-revision
local embedder decision, opt-in behind `memory embeddings enable`, and why the deterministic hash embedder
remains the zero-action default (REQ-040 no-external-model constraint). (Corpus hit count for "embedder":
16; "ONNX": 1 — a narrow, specific topic.)

## Q3 — macOS Keychain for sync secrets

`currentTopicSummary`: "macOS Keychain storage for sync device secrets"
**Answer shape: event or decision.** Correct answer touches how `sync/secrets/` stores keys in the macOS
Keychain rather than on disk in plaintext. (Corpus hit count for "keychain": 102.)

## Q4 — Daemon single-writer lease

`currentTopicSummary`: "daemon lease acquisition and single-writer design"
**Answer shape: decision/rationale.** Correct answer references `acquireDaemonLease` and why only one
daemon instance may run against a database at a time. (Narrow topic; low corpus hit count expected.)

## Q5 — Contraction and summarization pipeline

`currentTopicSummary`: "contraction checkpoint and summarization pipeline"
**Answer shape: event.** Correct answer touches the contraction runner turning canonical events into
summaries via checkpoints. (Corpus hit count for "contraction": 8.)

## Q6 — Hermes agent bridge

`currentTopicSummary`: "Hermes agent bridge integration and control commands"
**Answer shape: event.** Correct answer touches the live Hermes bridge (`src/integrations/hermes/`), ingest/
inject/resume/sleep commands. (Corpus hit count for "Hermes": 5,493 — a very common topic; the injected
packet should be specific, not a generic "Hermes was mentioned.")

## Q7 — History importer discovery

`currentTopicSummary`: "importer discovery for Claude Code and Codex host history"
**Answer shape: event.** Correct answer touches one of the four host importers (`claude-`, `codex-`,
`openclaw-`, `hermes-`) and the discovery step before import. (Corpus hit count for "importer": 103.)

## Q8 — Pruning superseded derivations and the backup gate

`currentTopicSummary`: "pruning superseded derivations and the backup gate decision"
**Answer shape: decision/rationale.** Correct answer references ADR 0050 — prune, not archive, because
superseded summaries are pure derivations reproducible from canonical events, plus the fail-closed
`--confirm-backup` gate. This is Phase 11's own work, so the corpus should NOT yet contain much about it
(most of Phase 11 postdates the last import at 2026-07-20) — a thin or partial answer is expected and
diagnostic, not a probe defect. (Corpus hit count for "pruning": 62 — but likely from unrelated legal/
document-pruning contexts predating Phase 11, worth checking in the judgement.)

## Q9 — ADR decision records

`currentTopicSummary`: "ADR decision records for the conversational memory system"
**Answer shape: decision/rationale.** Correct answer should surface an actual architecture decision (any
ADR), not a generic mention of the word "ADR" in an unrelated document context.

## Q10 — Person and scope retrieval boundaries

`currentTopicSummary`: "person and scope isolation boundary for memory retrieval"
**Answer shape: decision/rationale.** Correct answer references ADR 0046 — retrieval takes an explicit
personId and allowedScopeIds, and legacy unscoped retrieval is an explicit opt-in only.

## Q11 — Deterministic hash embedder default

`currentTopicSummary`: "deterministic hash embedder as the default with no external model"
**Answer shape: decision/rationale.** Correct answer references why `DeterministicEmbedder` is the
always-on default and the opt-in-only nature of the transformer embedder. (Corpus hit count for
"deterministic": 1,619 — broad; the packet should specifically discuss the embedder default, not any of
the many other deterministic-behavior discussions in the corpus, e.g. deterministic clocks/IDs.)

## Q12 — Nothing on record: quantum-encrypted interstellar spacecraft recipe

`currentTopicSummary`: "quantum-encrypted recipe database for an interstellar spacecraft galley"
**Answer shape: nothing.** This topic does not exist anywhere in the corpus (confirmed absent — no plausible
overlap with any real conversation this project has had). A correct packet is `null`, or a packet with
`confidence` near the floor and no genuinely relevant text. If the retriever returns something confident
and on-topic for this query, that is itself a diagnostic finding for the Plan 11-14 judgement, not evidence
the probe is broken.

---

**Fixed probe parameters (frozen alongside the queries, applied identically to every run):**
- `hostSessionId`: `"recall-probe-2026-07-27"`
- `requestedAt`: `"2026-07-27T00:00:00.000Z"`
- `maxMemoryTokens`: `800`
- `host`: `"recall-probe"`, `profileId`: `"aaron"`
- `personId`: `"aaron"`, `allowedScopeIds`: `["personal"]`
