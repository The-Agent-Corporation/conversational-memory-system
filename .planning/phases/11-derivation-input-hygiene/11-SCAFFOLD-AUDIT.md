# 11-SCAFFOLD-AUDIT.md — Plan 11-20 Task 1 census

**Run date:** 2026-07-27
**Clone path:** `/var/folders/0m/6rps8nhn6p9180d8gzj40m1c0000gn/T/gsd-11-20-census-Js9lCK/census.db` (throwaway, in a tmpdir, deleted by OS cleanup — not committed)
**Clone byte size:** 5,031,448,576 bytes
**Live db before:** mtime `2026-07-27T18:59:51.713Z`, size 5,031,448,576 bytes
**Live db after:** mtime `2026-07-27T18:59:51.713Z`, size 5,031,448,576 bytes
**Unchanged:** YES

**Person:** `aaron`
**Total canonical events:** 292,407
**Composition:** tool_activity 186,548 · conversational 80,528 · synthetic_injected 25,331

**`<task-notification>` containment (anywhere in content, among `conversational`-classified events):** 1,060 events

Sample positions:
- index 0 of 426 chars, role=user: "<task-notification>
<task-id>bz9v60jo5</task-id>
<tool-use-i"
- index 0 of 430 chars, role=user: "<task-notification>
<task-id>blyz9bkoy</task-id>
<tool-use-i"
- index 0 of 433 chars, role=user: "<task-notification>
<task-id>b3d4pmak5</task-id>
<tool-use-i"
- index 0 of 426 chars, role=user: "<task-notification>
<task-id>bw1fz4voj</task-id>
<tool-use-i"
- index 0 of 426 chars, role=user: "<task-notification>
<task-id>bttous9ov</task-id>
<tool-use-i"

## Table (a): existing rule hit counts vs. 11-CONTEXT.md baseline

| Rule id | Current count | Baseline (2026-07-26) | Delta |
|---|---:|---:|---:|
| skill-invocation | 1,038 | 1,038 | 0 |
| harness-system | 5,561 | 5,561 | 0 |
| cron-session-tag | 7,909 | 7,909 | 0 |
| automated-followup | 2,210 | 2,210 | 0 |
| automated-task-block | 168 | 168 | 0 |
| skill-body-injection | 127 | 127 | 0 |
| context-compaction | 262 | 262 | 0 |
| session-continuation | 86 | 86 | 0 |
| local-command-stdout | 109 | 109 | 0 |
| system-reminder-only | 1,786 | 1,786 | 0 |
| city-harness-preamble | 274 | 274 | 0 |
| silent-sentinel | 2,784 | 2,784 | 0 |
| structured-json-emission | 3,017 | 3,023 | -6 |

## Table (b): top unrecognised-shape signatures among `conversational` events

Verdict legend: `add-rule` = unambiguous anchored harness scaffolding, propose adding a rule.
`leave` = genuine conversation or too ambiguous to anchor on. `needs-owner` = high-volume and genuinely arguable.

| # | Count | Role | EventKind | Verdict | Signature | Example (200 chars) |
|---:|---:|---|---|---|---|---|
| 1 | 5,348 | assistant | message | leave | `HEARTBEAT_OK` | `HEARTBEAT_OK` |
| 2 | 1,451 | user | message | leave | `[Image: original #x#, displayed at #x#` | `[Image: original 1695x2172, displayed at 1561x2000. Multiply coordinates by 1.09 to map to original image.]` |
| 3 | 1,240 | user | message | leave | `You are an ADVERSARIAL citation verifier for a l` | `You are an ADVERSARIAL citation verifier for a legal-grade medical knowledge layer. Your job is to REFUTE, not confirm. Assume the page is wrong until the source proves otherwise.\n\nTarget page: /Users` |
| 4 | 814 | user | message | needs-owner | `[phase:evaluation] Evaluate the responses and pr` | `[phase:evaluation] Evaluate the responses and propose a base per your seeded instructions.` |
| 5 | 733 | user | message | leave | `You are a COMPLETENESS critic for a medical know` | `You are a COMPLETENESS critic for a medical knowledge layer in a personal-injury case (DOI 2025-08-19).\n\nTarget page: /Users/aaronwhaley/Agent-Corporation/lawyerincorporated/caselogic/completed knowle` |
| 6 | 673 | assistant | message | leave | `[toolCall]` | `[toolCall]` |
| 7 | 443 | assistant | message | leave | `Selected task: none. Actions taken: - Resolved` | `Selected task: none.\n\nActions taken:\n- Resolved Mission Control config: `MC_URL=http://127.0.0.1:3000`, API key present.\n- Health check passed overall: Mission Control healthy; Gateway check reports “` |
| 8 | 397 | assistant | message | leave | `Run log (Roscoe verification worker, project_id=` | `Run log (Roscoe verification worker, project_id=8):\n\n- **Selected task:** none  \n- **Actions taken:** preflight failed — missing required env vars: `MC_URL`, `MC_API_KEY`  \n- **Resulting status:** no ` |
| 9 | 314 | user | message | leave | `Repair the medical-knowledge-layer page at /User` | `Repair the medical-knowledge-layer page at /Users/aaronwhaley/Agent-Corporation/lawyerincorporated/caselogic/completed knowledge layers/Medical Knowledge Layer/medical-knowledge-layer-prototype/cases/` |
| 10 | 304 | user | message | leave | `Reply with exactly: pong` | `Reply with exactly: pong` |
| 11 | 277 | assistant | message | leave | `Mission Control Roscoe verification worker run l` | `Mission Control Roscoe verification worker run log\n- Selected task: none\n- Actions taken: preflight failed (env check)\n- Resulting status: no_action\n- Blocker: Missing MC_URL and/or MC_API_KEY in envi` |
| 12 | 275 | assistant | message | leave | `pong` | `pong` |
| 13 | 258 | user | message | leave | `Hello` | `Hello` |
| 14 | 257 | user | message | add-rule | `<task-notification> <task-id><id></` | `<task-notification>\n<task-id>aca5357393a5eb2d3</task-id>\n<tool-use-id>toolu_01TnmeZPEnKCd38qfjLzESWb</tool-use-id>\n<output-file>/private/tmp/claude-501/-Users-aaronwhaley-Agent-Corporation-lawyerincor` |
| 15 | 254 | assistant | message | leave | `FirmVault case wiki-agent batch refresh complete` | `FirmVault case wiki-agent batch refresh complete.\n\n- Requested root: `/Users/aaronwhaley/Github/paralegal_workspace/FirmVault`\n- Active root used: `/Users/aaronwhaley/.hermes/agents/paralegal/workspac` |
| 16 | 224 | user | message | needs-owner | `[phase:draft] Draft the document per your seeded` | `[phase:draft] Draft the document per your seeded instructions.` |
| 17 | 202 | user | message | leave | `You are a repair agent for a medical knowledge l` | `You are a repair agent for a medical knowledge layer. Fix the page at /Users/aaronwhaley/Agent-Corporation/lawyerincorporated/caselogic/completed knowledge layers/Medical Knowledge Layer/medical-knowl` |
| 18 | 182 | assistant | message | leave | `Run log — Roscoe Platform verification worker (p` | `Run log — Roscoe Platform verification worker (project_id=8)\n\n- Preflight:\n  - Mission Control reachable at `http://127.0.0.1:3000`.\n  - Health check returned `healthy`, but Gateway check is `unhealth` |
| 19 | 178 | user | message | needs-owner | `[phase:response] Respond to the reviews of your` | `[phase:response] Respond to the reviews of your draft per your seeded instructions.` |
| 20 | 170 | user | message | leave | `Read HEARTBEAT.md if it exists (workspace contex` | `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.\nWhen reading HEARTBEAT.md, us` |
| 21 | 168 | user | message | needs-owner | `[phase:review] Review the peer drafts in this fo` | `[phase:review] Review the peer drafts in this folder per your seeded instructions.` |
| 22 | 152 | user | message | needs-owner | `[phase:integration] Integrate the agreed additio` | `[phase:integration] Integrate the agreed additions into the base per your seeded instructions.` |
| 23 | 150 | user | message | leave | `You convert verified encounter pages into struct` | `You convert verified encounter pages into structured CHRONOLOGY rows. Return data only — do not edit files.\nDOI: 2023-04-01. For EACH of these encounter pages under /Users/aaronwhaley/Agent-Corporatio` |
| 24 | 146 | assistant | message | leave | `--- phase: evaluation round: # author: "claude-#` | `---\nphase: evaluation\nround: 1\nauthor: "claude-1"\nproposedBase: "claude-1"\nremainingDisagreements: []\ncitations:\n  - artifact: "003-codex-1-review.md"\n    evidence: "codex-1 opens 'Your draft is the s` |
| 25 | 143 | assistant | message | leave | `Run log (Roscoe verification worker, project #):` | `Run log (Roscoe verification worker, project 8):\n\n- **Selected task:** `#2` (id `116`) — **“Infra Preflight: local stack boot + dependency health checks”**\n- **Preflight actions:**\n  - Checked MC heal` |
| 26 | 140 | user | message | needs-owner | `[phase:validation] Validate the integrated docum` | `[phase:validation] Validate the integrated document per your seeded instructions.` |
| 27 | 129 | user | message | leave | `do the thing` | `do the thing` |
| 28 | 128 | user | message | leave | `[Mission Control task comment relay] Task: test-` | `[Mission Control task comment relay]\nTask: test-02"\nTask ID: 1935\nComment ID: 29\nAuthor: Aaron\n\ncomments coming through? Please reply\n` |
| 29 | 122 | user | message | add-rule | `<local-command-caveat>Caveat: The messages below` | `<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user e` |
| 30 | 113 | assistant | message | leave | `[toolCall] [toolCall]` | `[toolCall]\n[toolCall]` |
| 31 | 113 | assistant | message | leave | `API Error: Request rejected (#) · This request` | `API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.` |
| 32 | 103 | user | message | leave | `You have been assigned a task in Mission Control` | `You have been assigned a task in Mission Control.\n\n**[TP-002] test**\nPriority: medium\n\nTest just return "test passed"\n\nComplete this task and provide your response. Be concise and actionable.` |
| 33 | 102 | user | message | leave | `{"total_count": #, "files": ["/Users/aaronwhaley` | `{"total_count": 1, "files": ["/Users/aaronwhaley/.hermes/skills/gstack/browse/.gstack/browse-startup-error.log"]}` |
| 34 | 101 | user | message | leave | `{"todos": [{"id": "t#", "content": "Run fresh-sh` | `{"todos": [{"id": "t1", "content": "Run fresh-shell persistence checks for bun/PATH and browse health", "status": "in_progress"}, {"id": "t2", "content": "Run full gstack skill sweep (browse, review, ` |
| 35 | 96 | assistant | message | leave | `--- phase: "evaluation" round: # author: "claude` | `---\nphase: "evaluation"\nround: 1\nauthor: "claude-1"\nproposedBase: "shared/001-claude-1-draft.md"\nremainingDisagreements: []\ncitations:\n  - artifact: "011-codex-1-evaluation-r1.md"\n    evidence: "codex` |
| 36 | 95 | assistant | message | leave | `ok` | `ok` |
| 37 | 92 | assistant | message | leave | `Run log — Roscoe verification worker (project_id` | `Run log — Roscoe verification worker (project_id=8)\n\n- Preflight: Mission Control reachable at `http://127.0.0.1:3000`; health returned `healthy` overall, with Gateway check unhealthy.\n- Agent heartbe` |
| 38 | 90 | user | message | leave | `System: [#-#-# #:#:# EDT] Slack message` | `System: [2026-04-03 18:27:33 EDT] Slack message in #aa-paralegal from U09UA9EEECX: Can you convert it to PDF and then share it with me here?\n\nConversation info (untrusted metadata):\n```json\n{\n  "messa` |
| 39 | 90 | assistant | message | leave | `--- phase: evaluation round: # author: claude-#` | `---\nphase: evaluation\nround: 1\nauthor: claude-1\nproposedBase: "001-claude-1-draft.md (claude-1), with codex-1's two distinctive findings already folded in as I6/I7 per the resolved-decisions ledger"\nr` |
| 40 | 89 | user | message | leave | `You are an ingestion agent for a medical-records` | `You are an ingestion agent for a medical-records knowledge layer in a personal-injury case.\nCase: sean-may. DOI (date of incident): 2025-08-19. Run date: 2026-07-10.\n\nFIRST read, in order: the schema ` |
| 41 | 81 | user | message | leave | `Delegate exactly one A#A ping from Roscoe to Par` | `Delegate exactly one A2A ping from Roscoe to Paralegal. Ask Paralegal to reply exactly SERIAL_OK::Roscoe->Paralegal::ede2e2 and return only that token.` |
| 42 | 78 | user | message | leave | `Run the # Doc semantic chain test and then repo` | `Run the 30 Doc semantic chain test and then report the results back to me` |
| 43 | 78 | assistant | message | leave | `Yes, I checked the actual cron list and here’s t` | `Yes, I checked the actual cron list and here’s the clean answer:\n\n## Relevant cron jobs right now\n\n### 1) Main autotune job\n- **Job ID:** `f6f87510f471`\n- **Name:** `firmvault-autotune-continuous`\n- *` |
| 44 | 78 | assistant | message | leave | `Yes. I updated it and restarted the run. ## Wha` | `Yes. I updated it and restarted the run.\n\n## What I changed\nI patched the new semantic-chain runner in the Abby worktree:\n\n- File: `/Users/aaronwhaley/Github/mission-control-firmvault-abby/scripts/fir` |
| 45 | 78 | user | message | leave | `Stop testing.` | `Stop testing.` |
| 46 | 78 | assistant | message | leave | `Stopped. I paused both testing jobs: - `f#f#` | `Stopped.\n\nI paused both testing jobs:\n\n- `f6f87510f471` — **firmvault-autotune-continuous** → paused  \n- `01e4caa5c109` — **firmvault-autotune-watchdog** → paused\n\nNo active background test process is` |
| 47 | 78 | user | message | leave | `I'm going to revert FirmVault back to status fro` | `I'm going to revert FirmVault back to status from April 16th, and that will undo all the harmful changes that we were trying to correct here.` |
| 48 | 78 | assistant | message | leave | `Good move. Given where this drifted, resetting t` | `Good move. Given where this drifted, resetting to a known-good state is the right call.\n\nBefore you do it, preserve these so we don’t lose the useful parts:\n\n1. **Manual answer key artifacts**\n   - `/` |
| 49 | 77 | assistant | message | leave | `Done. ## #) Dedicated git worktree created I mo` | `Done.\n\n## 1) Dedicated git worktree created\nI moved the experiment into its own clean worktree.\n\n- **Repo:** `/Users/aaronwhaley/Github/mission-control`\n- **Worktree:** `/Users/aaronwhaley/Github/miss` |
| 50 | 77 | user | message | leave | `What is the status of the Testing?` | `What is the status of the Testing?` |
| 51 | 77 | assistant | message | leave | `Current testing status: ## #) New Abby semantic` | `Current testing status:\n\n## 1) New Abby semantic-chain rebuild\n**Status:** built, committed, smoke-tested, **not yet scaled**\n\n**Worktree**\n- Path: `/Users/aaronwhaley/Github/mission-control-firmvault` |
| 52 | 76 | user | message | leave | `#. Medical, insurance, expenses, liens, investig` | `1. Medical, insurance, expenses, liens, investigation, litigation, client, \n2. Pleadings, discovery, correspondence \n3. Pip, bi, um, UIM, workers comp\n4.medical records, medical bills, medical request` |
| 53 | 76 | assistant | message | leave | `Yes. This experiment code should be in a **dedic` | `Yes. This experiment code should be in a **dedicated git worktree** under `~/Github/mission-control`. Right now it’s still running from the main repo tree, which is not ideal.\n\n## Why\nWe’re changing:\n` |
| 54 | 76 | user | message | leave | `Yes, do all of that # # and three` | `Yes, do all of that 1 2 and three` |
| 55 | 76 | user | message | leave | `Why don't you save those into your workspace?` | `Why don't you save those into your workspace?` |
| 56 | 76 | assistant | message | leave | `Done — saved into my workspace. ### Saved locat` | `Done — saved into my workspace.\n\n### Saved location\n`/Users/aaronwhaley/Github/mission-control-firmvault-abby/artifacts/firmvault-recovery-20260423-091703`\n\n### Included\n- `abby-answer-key-manual/` (f` |
| 57 | 76 | user | message | add-rule | `<task-notification> <task-id>bnv#cr</task-id>` | `<task-notification>\n<task-id>bnv1398cr</task-id>\n<summary>Monitor event: "pass-20 detached run: delta + errors every 3 min, pid-based exit detection"</summary>\n<event>pass20 delta: 4372 \| run3 errors:` |
| 58 | 75 | user | message | leave | `Here is how I want this structured. The first ta` | `Here is how I want this structured. The first task is determine the date for the document. It is strictly an LLM call.  Want you to look through the Abby Segra‘s folder in various documents with dates` |
| 59 | 75 | assistant | message | leave | `We’re mostly on the same page. I inspected the c` | `We’re mostly on the same page. I inspected the current runner, and your new structure is a **real architecture change**, not a prompt tweak.\n\n## What I understand you want\n\nFor each eligible document,` |
| 60 | 74 | user | message | leave | `Status` | `Status` |

## Verdict rationale

- `<task-notification>` — **add-rule**. Content beginning `<task-notification>` is an unambiguous harness-injected marker (Q12's post-prune top memory, GAP-11-E anomaly 2). Predicate: `c.startsWith("<task-notification>")`, no role gate (mirrors `local-command-stdout` / `system-reminder-only`).
- `<local-command-caveat>` — **add-rule**. Same class of Claude Code-injected wrapper tag as the already-covered `<local-command-stdout>` / `<system-reminder>` rules: the body ("Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages...") is harness boilerplate, not user-authored content. Predicate: `c.startsWith("<local-command-caveat>")`, no role gate.
- `[phase:draft]` / `[phase:evaluation]` / `[phase:review]` / `[phase:integration]` / `[phase:validation]` / `[phase:response]` (rows 4, 16, 19, 21, 22, 26; combined ~1,676 events) — **needs-owner**. Anchored (`[phase:` bracket prefix) and templated ("per your seeded instructions" recurs verbatim), consistent with a multi-agent orchestration harness. But unlike pure metadata noise, a `[phase:X]` line is the literal instruction that drove real work the agent then did — excluding it changes what the derivation remembers about *why* the agent acted, which is a product judgment call, not a pure hygiene one. Flagged for the Plan 11-23 owner checkpoint rather than decided here, per this plan's explicit instruction that a `needs-owner` shape waits.
- `[Mission Control task comment relay]` (row 28, 128 events) and `System: [...] Slack message` (row 38, 90 events) were considered and left **leave**, not `add-rule`, despite the anchored system-relay prefix: both wrap genuine human-authored content underneath the wrapper (an actual Slack message body, an actual task comment with `Author: Aaron`). Excluding the whole event would silently delete the human content along with the relay boilerplate — the worse failure mode this plan's constraints warn against.
- All other top-60 signatures are **leave**: ordinary prose leads (greetings, questions, task descriptions, agent report text like the Roscoe run-log rows) with no anchored structural marker, or short/generic fragments (`HEARTBEAT_OK`, `pong`, `[toolCall]`, `ok`, `Status`) that are genuine reply content following the user's own conventions, not harness injection. Per 11-CONTEXT.md's conservative-by-default stance ("a rule fires only on unambiguous harness markers"), no further rule is proposed from this run.

