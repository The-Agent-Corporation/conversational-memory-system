---
phase: 11-derivation-input-hygiene
plan: 31
subsystem: planning-hygiene
tags: [security, git-history, credential-removal, gap-closure]
requires: ["11-14"]
provides: ["GAP-11-F-history closed"]
affects: [".planning/", "docs/", "git history from 00de5a3 forward"]
tech-stack:
  added: []
  patterns: ["git-filter-repo --replace-text", "classify-then-remap for SHA citations"]
key-files:
  created:
    - .planning/phases/11-derivation-input-hygiene/11-HISTORY-REWRITE.md
    - .planning/phases/11-derivation-input-hygiene/11-31-SUMMARY.md
  modified:
    - 19 markdown files under .planning/ and docs/ (SHA citation remap)
    - .planning/STATE.md
decisions:
  - "SHAs that reference commits were remapped; SHAs that state facts about backup artifacts were marked pre-rewrite, not remapped"
  - "Replace-text literals ordered longest-first because the 47-char key variant is a prefix of the 64-char key"
metrics:
  duration: ~35 min
  completed: 2026-07-28
---

# Phase 11 Plan 31: Git History Credential Removal Summary

Removed the GAP-11-F Mission Control credential from all 544 commits using `git-filter-repo
--replace-text`, verified its absence by two independent mechanisms that agree, proved byte-for-byte
that nothing changed beyond the redaction, and remapped the SHA citations the rewrite invalidated.

## What was done

**Task 1 — backup.** A `git bundle` of all refs (verified "records a complete history"), a full
APFS copy-on-write filesystem copy including `.git` and the 128M embedder fixtures a bundle cannot
carry, and a restore test proving a clone from the bundle reproduces the live HEAD tree exactly.
Presented at a blocking checkpoint; the owner gave the go.

**Task 2 — rewrite.** Three literals, all extracted from history rather than assumed: a 64-hex API
key, a **47-char truncated prefix** of that same key (cut off by a markdown table cell), and the
16-char password. Ordered longest-first in the replace-text file — reversed, the 47-char rule would
have fired inside the 64-char key and left 17 characters of live key material behind.

**Task 3 — SHA remap.** Classify-then-replace over every 7-to-40-char hex token in tracked
`.planning/` and `docs/` markdown. Tokens that resolve through `commit-map` were remapped; everything
else was left alone.

## Verification

| Check | Result |
|---|---|
| `git log --all -S<literal>` | 0 hits, all three literals |
| `git rev-list --all \| git grep -F -l` over 544 commits | 0 hits, all three literals |
| Two mechanisms agree | yes |
| Residual key-prefix variants (20-char sweep) | 0 |
| HEAD tree | `d10d4515…` identical pre and post; **zero paths differ** |
| Commits preserved | 544 → 544, `commit-map` shows 0 dropped |
| `commit-map` | 545 lines (1 header + 544); 57 changed, 487 unchanged |
| Paths differing anywhere in the rewrite | exactly 4, all MODIFIED |
| Blob pairs differing | 19; **19/19 reproduced byte-exactly** by the redaction alone, 0 unexplained |
| Remapped citations spot-checked | 19/19 resolve via `git cat-file -e` |
| Dead pre-rewrite SHAs outside the evidence doc | 0 |
| `forgejo` remote | restored; **nothing pushed** |
| Linked worktree | intact at `6562ae0`; only `refs/heads/main` changed |
| Suite / typecheck | 1,038 passed / 4 skipped; typecheck exit 0 |
| Replace-text file | deleted, absence confirmed, never staged |

The integrity proof is the strongest of these: every old blob was fetched from the backup, the
substitution applied independently, and the result compared byte-for-byte against what filter-repo
produced. All 19 matched, so nothing changed beyond the redaction.

## Deviations from Plan

**1. [Rule 1 - Bug] The password literal was invisible to the first search.**
Passing it through a double-quoted shell string let the shell expand its `$!` sequence, so
`git log -S` reported 0 commits for a credential that was demonstrably present. Switched to
argv-safe invocation, which revealed 4 commits including the rewrite root. Had this gone unnoticed,
the password would have been omitted from the replace-text file and survived the rewrite.

**2. [Rule 2 - Correctness] A truncated key variant needed its own rule.**
The 47-char prefix is a distinct literal requiring longest-first ordering. A prefix sweep confirmed
these are the only two truncations of the key and the only variant of the password.

**3. [Rule 1 - Bug] Corrected two factual errors in the concurrent agent's record.**
- "the password and username appeared in **zero** commit trees" — wrong. Measured directly, the
  password was in **16 commit trees** across 3 paths, and the union of all literals is exactly 16
  commits, independently reproducing GAP-11-F's figure. The claim that the gap doc overstated the
  exposure was itself the error, caused by reading `git log -S` (occurrence-count change) as
  tree containment.
- `commit-map` changed-SHA count recorded as 58; it is 57.

**4. [Rule 1 - Bug] Reverted the automated remap over the Task 1 backup evidence.**
The remap rewrote SHAs inside a **verbatim `git bundle verify` transcript** and in the identifiers of
backup artifacts, producing statements that were false — a bundle whose recorded HEAD is `394e869`
described as `0f9897d` — and one visibly corrupt token, `0f9897dd…f1781`, splicing a new-SHA prefix
onto an old-SHA suffix. Anyone restoring would have searched for a commit the bundle does not contain.
Restored to pre-rewrite values under an explicit banner, which is the plan's other sanctioned
treatment: "remapped **or explicitly marked pre-rewrite**."

**5. [scope] The rewrite spanned 57 commits, not the 40 the plan predicted** — 14 more commits landed
between planning and execution. Root unchanged, descendant set larger.

## Concurrency incident

I was briefed as the only agent with write access. That was not the case in practice: while I was
executing, another agent committed `5ab4a4a` (the Task 3 remap) and `12f4cd0` (phase close), moving
HEAD from `4aa61a4` to `12f4cd0`. My own remap pass consequently reported "0 files touched" — correct
but confusing, because the work had already been done seconds earlier.

No work was lost, and the outcome is fine. But the two factual errors in §3 and the falsified
transcript in §4 all originated in that concurrent pass, which did not have the pre-rewrite
measurements in hand. Recorded because the same race would be more damaging on a plan that edits code
rather than documents.

## Known Stubs

None.

## Standing caveat

The backups in `~/cms-pre-rewrite-backup/` and the session scratchpad hold the **pre-rewrite** history
and therefore still contain the credential — that is exactly what makes them a valid restore point.
Delete them once the rewrite is settled, or accept that the credential persists there. The owner
declined rotation as stale (2026-07-27), so this is recorded rather than escalated.

The underlying product defect from GAP-11-F remains open and is not addressed by this plan:
`secret-redactor.ts` missed a human-chosen password following a prose lead-in, and that single missed
redaction fanned out into 143 derived summaries. Corpus remediation (151 rows) also remains open.
