# ADR 0060: Bounded Substring Presence Filter

## Status

Accepted

## Context

The isolated GitHub retrieval benchmark at `87f87bd` measured 998,109 anchor/summary
pairs per second against the existing 1,000,000 minimum. Normalization is already
hoisted, but absent anchors still cause repeated substring scans over large bodies.
The benchmark fixture, oracle, and sufficiency threshold remain unchanged.

## Decision

For normalized summary strings of at least 1,024 UTF-16 code units, build a 1 KiB
bitset recording hashed three-code-unit substrings. Before an exact search, test
the first trigram of the normalized anchor. An absent bit proves no match exists;
a present bit still requires the original exact `String.includes` check, plus the
existing box and thread guards. Hash collisions only add exact searches.
Construct the filter lazily after those guards pass and only for anchors with
at least three code units; summaries with no eligible comparison incur no scan.

Short summaries and anchors shorter than three code units retain direct matching.
The bitset is ephemeral and local to one deduplication call, with no persistence,
provider access, scope expansion, or change to ordering, provenance, or selection.
UTF-16 indexing intentionally matches JavaScript substring semantics, including
surrogate pairs and isolated surrogates.

## Consequences

The first eligible comparison adds a linear scan and 1 KiB per large summary. Inputs that saturate
the filter still use exact matching and may see little benefit. The unchanged
benchmark establishes performance on its measured runner, not on every machine.

The frozen naive oracle remains the semantic authority for differential tests.
Additional tests cover collisions, Unicode normalization, short/empty anchors,
arbitrary UTF-16 fixtures, and original box/thread restrictions. Scope filtering
before deduplication and ADR 0049's retrievable-state rules remain unchanged.
