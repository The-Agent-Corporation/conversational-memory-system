# 11-31 — Git history rewrite: backup evidence, commit map, verification sweep

Closes the history half of [GAP-11-F](11-GAP-11-F.md). Owner authorized the rewrite in principle on
2026-07-28. The credential itself was declined as stale (GAP-11-F, owner decision 2026-07-27); this
work is hygiene, not incident response.

> **Note for later readers — SHA citations.** Commits from `044b0e9` forward were rewritten by this
> plan. **Any SHA cited in a document written before 11-31 refers to a pre-rewrite commit and will not
> resolve.** The authority for translating old to new is the `commit-map` recorded in Task 2 below.
> This note is written before the rewrite runs; Task 3 records which citations were remapped.

---

## Task 1 — Backup evidence (pre-rewrite)

**Status: COMPLETE.** Owner gave go on 2026-07-28 against this evidence; Task 2 then ran.

> **Every SHA in this Task 1 section is a PRE-REWRITE SHA and is deliberately NOT remapped.**
> This section records the state the backups captured and quotes verbatim command output. The
> backup bundles physically contain the pre-rewrite commits, so rewriting these citations to their
> post-rewrite equivalents would describe artifacts that do not exist and would falsify quoted
> transcripts. An automated remap pass did rewrite them; that was reverted here deliberately.
> Old → new for the SHAs below, per `commit-map`:
> `394e869` → `0f9897d`, `f24268f` → `43059ba`, `e14d0b0` → `4aa61a4`, `00de5a3` → `044b0e9`.

### Pre-rewrite repository state

| Property | Value |
|---|---|
| Repository | `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system` |
| Branch | `main` |
| HEAD commit | `394e8696aa54373ffa40aa1c90562c00ca6f1781` (`394e869`) — pre-rewrite; now `0f9897d` |
| HEAD subject | `docs(11): mark SC7 signed off and 11-13 Tasks 2/3 closed as unneeded` (2026-07-28) |
| **HEAD tree** | **`4b8fe34a17c9860b49771b5e83bb2c46b43c053e`** (tree hash, unaffected by the rewrite) |
| Rewrite root | `00de5a3` — `docs(11-18): close GAP-11-D, raise GAP-11-E, record probe evidence` (2026-07-27); now `044b0e9` |
| Total commits (all refs) | 542 |
| Refs | 88 local / 90 heads in bundle |
| Tracked files | 3561 |
| Working tree | **clean** — `git status --porcelain` empty |

### Scope correction: 54 commits, not 40

The plan and GAP-11-F state that `00de5a3..HEAD` is **40** commits. It is now **54**. Fourteen more
commits landed between the plan being written and this execution (SC7 sign-off, plans 11-24 through
11-30, the phase-close work). The rewrite root is unchanged; the descendant set is larger. This does
not change the approach — it changes the count Task 2 must assert as preserved, which is **54**, not
40. Task 2 will verify against 54.

### Backup artifacts

All artifacts live in the session scratchpad, outside the repository:

`/private/tmp/claude-501/-Users-aaronwhaley-Agent-Corporation-conversational-memory-system/6ea0c5f7-ef88-4139-838b-47b0e29baa9d/scratchpad/backup/`

#### 1. Git bundle — all refs

| Property | Value |
|---|---|
| Path | `<scratchpad>/backup/repo-backup.bundle` |
| Size | 22,356,651 bytes (22 MB) |
| SHA-256 | `36d8e806eddbf827aab247ad54ecabebfb8c4844ac0bf07c2bc65eef0e6377cc` |
| Created by | `git bundle create <path> --all` |

`git bundle verify` output (tail):

```
7f9e23925d4df8a3a15c96a94703e21b6e0128d9 refs/remotes/forgejo/main
394e8696aa54373ffa40aa1c90562c00ca6f1781 HEAD
6562ae07d43642dcd84784c34f9b2d3c9475f87f worktrees/standalone-memory-foundation/HEAD
The bundle records a complete history.
The bundle uses this hash algorithm: sha1
```

Exit status 0. **"The bundle records a complete history"** — the bundle is self-contained and needs no
prerequisite objects to restore.

#### 2. Full filesystem copy including `.git`

| Property | Value |
|---|---|
| Path | `<scratchpad>/backup/repo-fullcopy` |
| Size | 908 MB (matches live repo exactly) |
| `.git` size | 55 MB (matches live) |
| Method | `cp -Rc` — APFS clonefile, copy-on-write, completed in 3.0s |
| HEAD | `394e8696aa54373ffa40aa1c90562c00ca6f1781` |
| HEAD tree | `4b8fe34a17c9860b49771b5e83bb2c46b43c053e` |
| Commits reachable | 542 |
| Refs | 88 |
| `git status --porcelain` | clean |

The copy is a fully functioning repository, not an archive: git commands run against it directly.
Copy-on-write means the copy is logically independent — modifying the live repo does not modify it.

**Ignored (untracked-by-git) content is preserved in the copy**, which the bundle by construction
cannot carry:

| Path | Live | In copy |
|---|---|---|
| `node_modules/` | 609M | 609M |
| `tests/fixtures/models/` | 128M | 128M |
| `.superpowers/` | 36K | 36K |
| `.claude/` | 12K | 12K |

`tests/fixtures/models/` matters specifically — it is the vendored embedder fixture set that
`npm run test:golden` needs and that is not reproducible from the repo alone.

#### 3. Restore test — clone from the bundle

`git clone <bundle> <scratchpad>/backup/restore-test`

| Check | Live repo | Restored clone | Match |
|---|---|---|---|
| HEAD | `394e8696…f1781` | `394e8696…f1781` | yes |
| **HEAD tree** | **`4b8fe34a17c9860b49771b5e83bb2c46b43c053e`** | **`4b8fe34a17c9860b49771b5e83bb2c46b43c053e`** | **yes** |
| Commits (all refs) | 542 | 542 | yes |
| Tracked files | 3561 | 3561 | yes |
| Checkout vs HEAD | clean | clean | yes |

The tree-hash match is a cryptographic proof that every tracked byte is identical. Byte-level
`diff -r` was additionally run over the three directories that hold the work product, as
human-legible corroboration:

```
diff -r .planning  <restore-test>/.planning   -> IDENTICAL
diff -r src        <restore-test>/src         -> IDENTICAL
diff -r docs       <restore-test>/docs        -> IDENTICAL   (excluding .DS_Store)
```

#### 4. Untracked working-tree state

`git status --porcelain` is **empty** — there is no uncommitted or untracked-but-wanted work to
preserve. Everything not tracked is in the ignored set enumerated above, and all of it is carried in
the full filesystem copy.

#### 5. Refreshed backup at the true pre-rewrite HEAD

Recording this evidence created a commit (`f24268f`, now `43059ba`), which put the backups above one commit behind
the state the rewrite will actually launch from. All four artifacts were therefore regenerated and
re-verified at the new HEAD:

| Artifact | Path | Result |
|---|---|---|
| Bundle | `<scratchpad>/backup/repo-backup-pre-rewrite.bundle` | 22,355,173 bytes; SHA-256 `74982a450d82870cfc8e9beffa8728c0216daa2f43518d5a689eaef481af80d1`; `git bundle verify` → "records a complete history" |
| Restore test | `<scratchpad>/backup/restore-test-pre-rewrite` | HEAD `f24268fa88c733af9269d4e6d5fd09b6b92ee412`, tree `df7405300af147b95cf9d881367b0ba0100004c6`, 543 commits, clean checkout — all match live exactly |
| Filesystem copy | `<scratchpad>/backup/repo-fullcopy-pre-rewrite` | 908M, HEAD and tree match live, clean |
| Prior generation | `repo-backup.bundle`, `repo-fullcopy`, `restore-test` (@ `394e869`) | retained, not deleted |

Both generations are kept. `00de5a3..HEAD` is now **55** commits (54 + this evidence commit).

**Breaking the regress:** each new commit invalidates the previous backup by one commit. Rather than
chase it, Task 2 takes one final `git bundle create --all` + `git bundle verify` immediately before
invoking `git-filter-repo`, with no commit in between, and records its hash. That final bundle is the
authoritative restore point.

### Restorability statement

Two independent restore paths exist, and each was exercised or verified:

1. **From the bundle** — proven by the restore test: `git clone` reproduces HEAD tree
   `4b8fe34` exactly. Recovers all git history and all tracked content.
2. **From the filesystem copy** — recovers the same, *plus* `node_modules/` and the 128M embedder
   fixtures, i.e. a directly runnable working environment.

The bar the plan set — "restorable to exactly here" — is met.

---

## Pre-flight findings for Task 2

Recorded now because they affect how the rewrite must be run. Neither is a reason not to proceed.

### A linked worktree exists and `git-filter-repo` will not maintain it

```
/Users/aaronwhaley/Agent-Corporation/conversational-memory-system                    394e869 [main]
/Users/aaronwhaley/.config/superpowers/worktrees/conversational-memory-system/
    standalone-memory-foundation                                                     6562ae0 [feature/standalone-memory-foundation]
```

The second worktree sits on `feature/standalone-memory-foundation` at `6562ae0`, which is far older
than the rewrite root `044b0e9` and is **not** a descendant of it, so its commits are not in the
rewrite set. It should survive untouched. It is recorded here so that if it does end up stale after
the rewrite, the cause is known rather than mysterious. `.claude/worktrees/` is empty.

### `git-filter-repo` is present and `--force` is required

`/opt/anaconda3/bin/git-filter-repo` reports version `a40bce548d2c`. The repository is not a fresh
clone, so filter-repo's sanity check will refuse without `--force`; the plan already specifies it.

### Remote-tracking refs

filter-repo removes the `forgejo` remote by design. It also rewrites/discards `refs/remotes/forgejo/*`.
Task 2 re-adds the remote (`ssh://git@localhost:2222/aaron/conversational-memory-system.git`).
**Nothing is pushed** — `main` is roughly 400 commits ahead of `forgejo/main`, so the rewrite has no
coordination cost, and pushing is explicitly out of scope for this plan.

### Databases not touched

The four `~/.memory/` database backups are out of scope for this plan and were not read, moved, or
modified. Baseline recorded for later comparison:

| File | Bytes | mtime |
|---|---|---|
| `aaron.db` | 5,031,448,576 | 2026-07-28 10:56 |
| `aaron.db.pre-anchor-prune` | 5,031,448,576 | 2026-07-27 11:23 |
| `aaron.db.pre-phase11` | 4,962,574,336 | 2026-07-26 19:26 |
| `aaron.db.pre-rebuild-v3` | 5,031,448,576 | 2026-07-27 19:30 |
| `aaron.db.pre-v4` | 5,031,448,576 | 2026-07-27 21:55 |

---

## Task 2 — Rewrite and verification (executor, 2026-07-28)

**Literals removed.** Three, all extracted from history rather than assumed:

| # | shape | length | where it came from |
|---|---|---:|---|
| 0 | 64-hex API key | 64 | `API_KEY = "…"` inside a `[Tool call: execute_code]` block |
| 1 | **truncated** prefix of #0 | 47 | the same key, cut off mid-string by a markdown table cell |
| 2 | password from the login pair | 16 | `` MC login: `aaron` / `…` `` |

Literal #1 matters: it is a strict prefix of #0, so the replace-text file lists them **longest first**.
Reversed, the 47-char rule would have fired inside the 64-char key and left 17 characters of live key
material behind. A prefix sweep confirmed these are the only two truncations of the key anywhere in
history, and the only variant of the password.

The 64-hex key was one of **36 distinct 64-hex tokens** in that single blob — the rest are content
hashes. That is why the literals were identified by surrounding context, never by hex shape.

**Pre-rewrite exposure, measured two ways.** `git log -S` reports commits where the occurrence *count
changed*; a tree sweep reports commits whose tree *contains* the literal. They answer different
questions and both were recorded:

| literal | `git log -S` | commit trees containing it | paths |
|---|---:|---:|---:|
| #0 (64-hex key) | 2 | 1 | 1 |
| #1 (47-char key) | 2 | 1 | 2 |
| #2 (password) | 4 | **16** | 3 |
| **union** | — | **16** | **4** |

**The union is exactly 16 commits, independently reproducing `11-GAP-11-F.md`'s figure.**

**Verification after the rewrite** — both mechanisms, and they agree:

| check | result |
|---|---|
| `git log --all -S<literal>` | **0** hits for all three literals |
| `git rev-list --all \| git grep -F -l` over 544 commits | **0** hits for all three literals |
| residual key-prefix variants (20-char prefix sweep) | **0** |
| HEAD tree | `d10d45159b1a679637da8645961b46793bd62e01` — **identical** pre and post, zero paths differ |
| commits preserved | 544 → 544; `commit-map` shows **0** dropped |
| `commit-map` | 545 lines (1 header + 544); **57** SHAs changed, 487 unchanged |
| `forgejo` remote | restored; **nothing pushed** |
| linked worktree | intact at `6562ae0`; only `refs/heads/main` changed |
| suite / typecheck | 1,038 passed / 4 skipped; typecheck exit 0 |
| replace-text file | deleted, absence confirmed, never staged |

**Content integrity, proved rather than asserted.** Of the 57 rewritten commits, 41 had an unchanged
tree (only the parent SHA shifted) and 16 had content changes. Across those, exactly **4 paths** ever
differ, all `MODIFIED` — none added, none removed:

```
.planning/phases/11-derivation-input-hygiene/11-probe-after-anchor-prune.json
.planning/phases/11-derivation-input-hygiene/probe-v2/after-filter-v2.json
.planning/phases/11-derivation-input-hygiene/probe-v2/after-filter-v2.md
.planning/phases/11-derivation-input-hygiene/probe-v2/current-v2.json
```

That yields **19 differing blob pairs**. Each old blob was fetched from the pre-rewrite backup, the
literal→`[REDACTED]` substitution applied independently, and the result compared byte-for-byte against
the rewritten blob: **19 of 19 reproduced exactly, 0 unexplained differences.** Nothing changed beyond
the redaction.

**Why the HEAD tree is unchanged.** The credential had already been redacted from the working tree by
`b9737e3` and `9f1742f`, so it survived only in historical blobs. Those changed; the checkout did not.

---

## Task 3 — SHA citation remap (completed by the orchestrator 2026-07-28)

The Plan 11-31 executor completed the rewrite but stalled before Task 3, leaving dead SHA citations
throughout the planning docs. The orchestrator completed the remap.

**Method — classify, then replace.** `filter-repo`'s `commit-map` records 57 commits that changed SHA
(545 lines = 1 header + 544 commits; 57 changed, 487 unchanged — an earlier draft said 58).
Every 7-to-40-character hex token in tracked `.planning/` and `docs/` markdown was tested against it:

| classification | count | action |
|---|---:|---|
| unique prefix of a changed commit | **110** | remapped to the new SHA at the same prefix length |
| not a changed commit (event ids, anchor ids, content hashes, unchanged commits) | **570** | **left untouched** |
| ambiguous prefix (matched >1 changed commit) | 0 | would have been left untouched |

19 files updated. The 570 left alone are the reason a blanket find-and-replace was forbidden: canonical
event ids, anchor ids, and content hashes are hex and indistinguishable by shape from short commit SHAs.
The `probe-v2/` artifacts, which are dense with 64-hex event ids, were not modified at all.

**Verification:** all 36 distinct new tokens introduced by the remap resolve via `git cat-file -e
<sha>^{commit}`; zero dead.

**Exception applied afterwards — the Task 1 evidence section was reverted to pre-rewrite SHAs.**
The automated pass was correct for citations that *point at* commits, but it also rewrote the Task 1
backup evidence, where the SHAs are not pointers into current history. They identify what the backup
bundles physically contain, and two of them sat inside a **verbatim `git bundle verify` transcript**.
Remapping produced statements that were false (a bundle whose recorded HEAD is `394e869` described as
`0f9897d`) and one visibly corrupt token, `0f9897dd…f1781`, splicing a new-SHA prefix onto an old-SHA
suffix. Anyone restoring from that bundle would have looked for a commit it does not contain.

Those citations were restored to their pre-rewrite values and the section carries an explicit banner
saying so, with the old→new mapping given inline. This is the plan's other sanctioned treatment:
"remapped **or explicitly marked pre-rewrite**." The distinction is whether a SHA is a *reference*
(remap) or a *historical fact about an artifact* (mark, do not remap).

## Orchestrator verification of Task 2

Independently re-run after the executor's rewrite, not taken on report:

| check | result |
|---|---|
| credential absent — `git log --all -S` | 0 for all three literals |
| credential absent — `git grep` over every commit tree | 0 for all three literals |
| HEAD tree hash | `d10d45159b1a679637da8645961b46793bd62e01` — **identical** pre and post |
| commit count | 544 → 544 |
| `commit-map` | 545 entries, 58 SHAs changed |
| remote | `forgejo` restored; **nothing pushed** |
| suite / typecheck | 1,038 passed / 4 skipped; typecheck clean |

The identical HEAD tree is the expected result, not a sign the rewrite did nothing: the credential was
already redacted from the working tree in an earlier commit, so it survived only in **historical** blobs.
Those blobs changed; the current checkout did not.

**Correction — the earlier "16 commits" figure was right.** An earlier draft of this section claimed
that only one commit tree contained a live literal and that "the password and username appeared in
**zero** commit trees." That is wrong, and the executor's pre-rewrite measurement (recorded in the
Task 2 tables above) disproves it. The password was present in **16 commit trees** across three paths,
and the union of all three literals is **exactly 16 commits** — precisely the figure
`11-GAP-11-F.md` recorded for `00de5a3..9f1742f`.

The confusion is the same `git log -S` versus tree-containment distinction noted above: `-S` reports
only the two commits where the password's occurrence count changed, which is easily misread as the
total exposure. The gap doc's number needed no correction, and the rewrite's scope was **not** smaller
than it implied.

## Standing caveat — the backup contains the unredacted credential

`~/cms-pre-rewrite-backup/repo-backup-FINAL-e14d0b0.bundle` and the scratchpad copies hold the
**pre-rewrite** history, which by definition still contains the credential. That is what makes them a
valid restore point. Delete them once the rewrite is settled, or accept that the credential persists
there. The owner declined rotation as stale (2026-07-28), so this is recorded rather than escalated.
