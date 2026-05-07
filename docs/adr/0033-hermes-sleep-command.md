# ADR 0033: Hermes Sleep Command

## Status

Accepted.

## Context

The Roscoe loop can ingest timeline rows, compact control boundaries, inject recalled memory, and resume verbatim source turns. The next phase is background organization: decay stale summaries, refresh box states, and propose useful topic boxes without blocking the foreground agent.

The existing `SleepReviewer` already implements the first deterministic pieces of that behavior. It needs a command bridge surface so hosts can run sleep review on demand or from a scheduler without importing TypeScript internals.

## Decision

Add `hermes:sleep`.

The command:

- opens the configured SQLite memory store
- accepts JSON on stdin
- runs summary decay
- refreshes approved/active/revived/stale box states
- proposes new topic boxes and trace links
- returns compact JSON with changed ids and a no-op reason when nothing changed

Input:

```json
{
  "reviewed_at": "2026-05-03T00:00:00.000Z",
  "minimum_summaries_per_box": 2,
  "stale_strength_threshold": 0.25
}
```

All fields are optional. If `reviewed_at` is omitted, the command uses the current time.

Output:

```json
{
  "ok": true,
  "reviewedAt": "2026-05-03T00:00:00.000Z",
  "updatedSummaryIds": ["summary_1"],
  "updatedBoxIds": ["box_topic_smith_pip"],
  "proposedBoxIds": ["box_topic_new_case"],
  "proposalIds": ["proposal_box_box_topic_new_case"],
  "proposedTraceIds": ["trace_smith_pip_provider_bill"],
  "noopReason": null
}
```

## Consequences

- Hosts can invoke sleep review without a long-running worker.
- The first background organization loop stays deterministic and testable.
- Richer MemBox/Graphiti-inspired proposal planning can be layered behind this command without changing the host contract.
- Proposed boxes remain unapproved until a review path accepts them.
- Proposal ids provide a stable review handle without dumping large proposal payloads into foreground context.
