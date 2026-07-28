# 11-31 — Git history rewrite: backup evidence, commit map, verification sweep

Closes the history half of [GAP-11-F](11-GAP-11-F.md). Owner authorized the rewrite in principle on
2026-07-28. The credential itself was declined as stale (GAP-11-F, owner decision 2026-07-27); this
work is hygiene, not incident response.

> **Note for later readers — SHA citations.** Commits from `00de5a3` forward were rewritten by this
> plan. **Any SHA cited in a document written before 11-31 refers to a pre-rewrite commit and will not
> resolve.** The authority for translating old to new is the `commit-map` recorded in Task 2 below.
> This note is written before the rewrite runs; Task 3 records which citations were remapped.

---

## Task 1 — Backup evidence (pre-rewrite)

**Status: COMPLETE. Blocking checkpoint — awaiting owner go/no-go before Task 2 runs.**

### Pre-rewrite repository state

| Property | Value |
|---|---|
| Repository | `/Users/aaronwhaley/Agent-Corporation/conversational-memory-system` |
| Branch | `main` |
| HEAD commit | `394e8696aa54373ffa40aa1c90562c00ca6f1781` (`394e869`) |
| HEAD subject | `docs(11): mark SC7 signed off and 11-13 Tasks 2/3 closed as unneeded` (2026-07-28) |
| **HEAD tree** | **`4b8fe34a17c9860b49771b5e83bb2c46b43c053e`** |
| Rewrite root | `00de5a3` — `docs(11-18): close GAP-11-D, raise GAP-11-E, record probe evidence` (2026-07-27) |
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
than the rewrite root `00de5a3` and is **not** a descendant of it, so its commits are not in the
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

## Task 2 — Rewrite and verification

_Not started. Blocked on the Task 1 checkpoint._

## Task 3 — SHA citation remap

_Not started._
