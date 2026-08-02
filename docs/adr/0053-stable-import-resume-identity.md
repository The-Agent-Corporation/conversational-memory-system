# ADR 0053: A Remount-Stable Import Resume Identity

## Status

Accepted.

## Context

Import resume is checkpoint-based. For each history file the importers store an `ImportCheckpoint`
carrying `byteOffset`, `recordIndex`, `parserVersion`, and a `fileIdentity`, and on the next scan
they resume from `byteOffset` only if the checkpoint still describes the same file. `fileIdentity`
was built as `` `${metadata.dev}:${metadata.ino}` `` in six places — the four importers plus both
discovery modules.

**`st_dev` is not stable.** On macOS APFS the device number is assigned at mount time; a reboot or
remount can hand the same volume a different number. Nothing about the file changes.

This was not theoretical. Measured against the live corpus while diagnosing why a
`memory daemon once` ran 31 minutes at ~100% CPU and imported nothing:

| | |
|---|---|
| checkpoints where only the device changed | **6,758** |
| checkpoints whose identity still matched | **0** |
| checkpoints whose inode genuinely changed | **0** |
| distinct device transitions observed | **1** — `16777234 → 16777232` |

Every surviving checkpoint in the corpus was invalidated at once, by a single reboot, with every
inode unchanged. Resume was therefore disabled corpus-wide: each source scan re-read **10.81 GB** of
history from offset 0, re-parsed it, and imported nothing, because content-hash dedupe discarded
everything it produced.

**The failure is silent by construction.** A checkpoint that fails to match is indistinguishable
from a new file — the importer simply starts at offset 0. The corpus stays *correct*; only the cost
is wrong. Nothing in `memory status`, the receipts, or the event counts reports it. It was found
only by measuring a scan that appeared to hang.

`st_dev` was nominally guarding against inode reuse — a deleted file's inode being reassigned to a
new file, which would resume at a byte offset that means nothing in the new file. That is a real
hazard and the replacement must still cover it.

## Decision

### 1. The identity is `v2:<ino>:<birthtimeMs>`, and never contains a device number

`composeFileIdentity` lives in `src/imports/file-identity.ts` and is the single construction point
for all six former sites. `birthtimeMs` is truncated to whole milliseconds, because the raw value
carries sub-millisecond float precision and a value that reformats differently between two `stat`
calls would never compare equal to itself.

`birthtime` replaces what `dev` was guarding: a file that reuses a deleted inode has a later
birthtime, so it fails the match and is re-read from offset 0 — the safe direction. Verified on the
target platform that `birthtime` is non-zero, distinct from `mtime`, and **stable across appends**;
an `mtime`-derived value would change on every append and reintroduce the original bug in a worse
form. Where a filesystem reports no birthtime the composed value degrades to `:0` consistently
rather than becoming unstable.

### 2. Legacy `dev:ino` checkpoints are matched on the inode alone

`fileIdentityMatches` compares a stored `v2:` identity exactly, and compares any other two-part
value **ignoring its device component**.

This is not politeness toward old data; it is the whole migration. A strict format change would have
invalidated all 6,758 existing checkpoints simultaneously and forced exactly the 10.81 GB re-parse
this ADR exists to prevent. With the tolerant read, 6,758 checkpoints resume immediately and the
importers rewrite each one in the `v2:` format on its next successful pass, so the legacy format
drains as files are touched. **No schema migration, no backfill, no re-parse.**

The narrow cost is that during the drain window a legacy checkpoint cannot detect inode reuse. It is
bounded by the existing `size >= byteOffset` guard, it applies only to checkpoints written before
this change, and it ends the first time each file is scanned.

### 3. Measured effect

Per source scan against the live corpus: **10.81 GB → 2.85 GB (−73.6%)**, and the residual 2.85 GB
is genuinely new content (3,663 openclaw files and 394 Claude files that never had a checkpoint),
which is parsed once. Once those carry checkpoints, a steady-state scan reads only appended tails.

The old behaviour paid the full 10.81 GB on **every** scan, indefinitely.

## Consequences

- The daemon's source-scan prologue stops being the dominant cost of `memory daemon once`. It ran
  31 minutes without reaching the embedding repair pass at `daemon.ts:290`; that prologue is what
  blocked Phase 12's SC1/SC2 from ever being observed.
- `fileIdentity` must never again incorporate a value that is assigned by the host rather than
  derived from the file. The regression test asserts two full `stat` results differing only in `dev`
  produce the identical identity.
- The test that protects this asserts on `messagesProcessed`, **not** the event count. Dedupe hides a
  re-read from the event count completely — which is precisely why this survived unnoticed — so a
  count-based assertion would pass against the bug. It was confirmed to fail against the original
  code before being accepted.
- Discovery's `fileIdentity` (`codex-discovery.ts`, `file-history-utils.ts`) is not consumed by the
  resume path today, but was migrated with the rest. Leaving two formats alive invites a future
  comparison between a discovery identity and a checkpoint identity that could never match.
- Not addressed here: **1,953 checkpoints referencing files that no longer exist.** They are inert
  rows, not a correctness problem, and pruning them is a separate decision.
