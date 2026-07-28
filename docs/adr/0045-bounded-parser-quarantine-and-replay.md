# ADR 0045: Bounded Parser Quarantine and Replay

## Status

Accepted

## Context

Native agent history formats evolve. Silently discarding malformed or unsupported records makes later parser recovery impossible, but copying raw records into a durable error log would create a second unbounded store of sensitive conversation data and tool output.

## Decision

Add a person- and source-owned parser quarantine with the following contract:

- Quarantine only malformed JSON, unsupported records, and malformed tool-call metadata.
- Recognized exclusions—tool results, system prompts, indexes, progress records, and compaction metadata—are skipped and never quarantined.
- Store a deterministic record identity, relative resource path, record position, parser version, reason, raw byte length, and SHA-256 hash.
- Store at most 8 KiB of locally redacted source text. Never store an unbounded raw record.
- Keep quarantine state explicit: `pending`, `replay_requested`, `replayed`, or `discarded`.
- Replay requires an active durable source grant and exact candidate-ID confirmation.
- A replay request resets only that candidate's import checkpoints and writes an audit event. The next normal import rereads the native source and marks records replayed when the current parser recognizes them.
- Source deletion removes that source's quarantine records along with imported memory.

## Consequences

- Parser upgrades can recover previously unsupported history without silently expanding the durable data boundary.
- Replay remains read-only against native history and uses the ordinary idempotent importer path.
- Tool-result payloads do not enter canonical memory or quarantine.
- Quarantine inspection exposes only bounded, redacted content plus provenance and hashes.

## Addendum — 2026-07-28: GAP-11-F, the import redaction boundary, and whether derivation should re-scan

This addendum records an incident, a fix, and a design decision. It amends nothing above; the
quarantine contract stands as accepted.

### What happened

A credential escaped `src/imports/secret-redactor.ts` at import and propagated into 143 derived
summaries and 8 anchors. Full detail, including per-rule predicate analysis and corpus measurements, is
in `.planning/phases/11-derivation-input-hygiene/11-REDACTOR-AUDIT.md`. The owner declined rotating
that particular credential on 2026-07-28 on the grounds that it is stale; that decision concerns the
incident, not the defect, and the defect was treated as live work.

### The detection gap, and what was fixed

The redactor was not broken — its rules fire on nearly 18,000 spans in the canonical corpus. It had one
missing class and two quoting blind spots, each verified empirically rather than inferred from the
regex:

1. **A credential lead-in it did not know.** The escaped text was `login: \`user\` / \`pass\`` — a
   human-chosen password after a prose lead-in. `login` was absent from the keyword set, and the
   keyword rule's value grammar could not have expressed a `user / pass` pair regardless: it captures
   one non-whitespace run, so it would have taken the username and stopped at the space.
2. **Backslash-escaped quotes.** The keyword rule's optional-quote class matches at most one character
   and cannot skip a `\`. Tool-call content carries JSON bodies embedded in shell commands, so it
   reaches the redactor as `\"password\":\"…\"`. **Every secret in that form was invisible to the
   redactor.** This is the higher-volume defect by an order of magnitude: 300 previously-plaintext
   values across canonical events, summaries, and anchors.
3. **Whitespace inside a key phrase.** `api[_-]?key` admits `_` and `-` but not a space, so
   `API key: <token>` never matched.

Four rules were added, each measured on the live corpus for both true and false positives before
shipping. Two candidate rules were **rejected on measured precision** and their false-positive control
cases are pinned as passing tests, so re-adding them breaks the suite:

- An ungated `user / pass` rule measured a 50% false-positive rate on prose.
- A bare 64-hex rule would have caught the incident's API key and also roughly 1,080 content digests
  and git object IDs — the identifiers that make derived memory traceable to its source.

Corpus-scale verification of the shipped change: 449,718 rows scanned, 321 changed (0.071%), 406
redaction spans added, **0 existing redactions lost**.

### The propagation question: should derivation re-scan for secrets?

One missed redaction at import became 143 contaminated summaries. That is a real fan-out and deserves
an argued answer rather than a reflex.

**The case for re-scanning at derivation.** Defense in depth is the ordinary response to a boundary
that failed. The import redactor is one regex battery, and this incident proves it is fallible; a
second independent scan on the derivation path would have caught what the first missed. Summaries and
anchors are the objects that actually reach an injection packet, so scanning where content is *served*
rather than only where it is *admitted* puts the check closest to the exposure. And the derived corpus
is where contamination multiplies — 1 raw event became 151 retrievable rows.

**The case against.** Three arguments, in ascending order of weight.

First, single responsibility. If derivation also redacts, then redaction has two owners and no single
authoritative boundary. Every future secret class must be added in two places, and the failure mode
where they drift apart is silent. A second scanner is a second thing to get wrong.

Second, determinism and cost. Derivation is a much hotter path than import — contraction alone
processes thousands of slices, and this project has already had to fix O(n²) hotspots there. Adding a
regex battery to every slice is a standing cost paid on every derivation, forever, to guard against a
class of event that has happened once.

Third, and decisively: **it would not have worked.** The census measured this directly. Of the 143
contaminated summaries, the verbatim escaped rendering survives into exactly **one**. The summarizer
paraphrased the credential into the other 142 — restating it in prose that no import-shaped rule
matches. A re-scan at derivation using the same rules would therefore have caught roughly 0.7% of the
contamination it appears to promise. The intuition that a second scanner recovers the fan-out is simply
false here, because the fan-out is *reworded*, not copied. Catching paraphrased secrets is a semantic
problem, not a regex problem, and nothing in the deterministic derivation path can do it.

### Decision

**Redaction remains authoritative at import. Derivation does not re-scan.** The pipeline is right to
trust the boundary, and the correct response to a boundary failure is to fix the boundary — which is
what was done, with measured precision — not to add a weaker duplicate of it downstream.

Two obligations follow from choosing not to re-scan, and they are the real deliverable of this
decision:

1. **Changes to the redaction boundary are corpus-affecting.** Because nothing downstream will catch
   what import misses, a new secret class means the already-derived corpus is contaminated until
   remediated in place. Remediation of the existing 151 rows is out of scope here and needs its own
   plan; GAP-11-F records it.
2. **New rules must be measured before they ship.** The false-positive controls now in
   `tests/imports/secret-redactor.test.ts` exist because an over-broad rule at an authoritative
   boundary has no downstream check either — it shreds legitimate memory with the same finality that a
   missing rule leaks. Both directions of error are now pinned by tests.

No re-scan is implemented by this decision, and none should be added without re-opening this addendum.

See also ADR 0048 (derivation input hygiene), which governs what derivation filters for reasons other
than secrets.
