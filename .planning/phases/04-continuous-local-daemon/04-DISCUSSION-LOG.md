# Phase 4: Continuous Local Daemon - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-07-17
**Phase:** 4-continuous-local-daemon
**Areas discussed:** Process lifecycle, Scan timing, Failure handling, Contraction scheduling

---

## Process lifecycle

| Question | Alternatives considered | Selected |
|----------|-------------------------|----------|
| Normal startup | Explicitly enabled login startup; manual only; client-triggered | Explicitly enabled login startup, with foreground debugging |
| Service packaging | Portable core plus macOS LaunchAgent; all platforms now; foreground only | Portable core plus macOS LaunchAgent |
| Instance ownership | One daemon per database; one per person; multiple writers | One daemon per database |
| Controls | Full run/start/stop/restart/status/once; minimal controls; OS-only | Full lifecycle controls with heartbeat and graceful stop |

**User's choice:** Selected the recommended option for all four questions.
**Notes:** The database is the physical SQLite file; a person is a logical identity within it. The normal installation is expected to have one person, while the process boundary remains one daemon per database.

---

## Scan timing

| Question | Alternatives considered | Selected |
|----------|-------------------------|----------|
| Freshness | Watcher wake plus one-minute rescan; five minutes; fifteen minutes; configuration-only | Watcher wake plus one-minute safety rescan |
| Burst writes | Two-second coalescing; every event; ten-second quiet period | Two-second coalescing |
| Battery policy | Relax rescan to five minutes; keep one minute; pause periodic scans | Relax only the safety rescan to five minutes |
| Multiple sources | Fair single-writer queue; fixed source order; concurrent scans | Fair single-writer queue |

**User's choice:** Selected the recommended option for all four questions.
**Notes:** Filesystem watchers reduce latency but never replace incremental rescans as the correctness mechanism.

---

## Failure handling

| Question | Alternatives considered | Selected |
|----------|-------------------------|----------|
| Source failure | Isolate and retry; stop daemon; require manual recovery | Isolate and retry while other sources continue |
| Visibility | Privacy-safe status plus delayed notification; logs only; notify every time | Status plus one notification after sustained degradation |
| Crash recovery | Separate durable stage checkpoints; one large transaction; best-effort full rescan | Separate checkpoints and replay the incomplete stage |
| Mid-scan change | Revalidate at boundaries; finish scan; lock grant state | Revalidate at every stage boundary |

**User's choice:** Selected the recommended option for all four questions.
**Notes:** Diagnostics exclude conversation content. Revocation stops additional committed work; deletion remains separately confirmed.

---

## Contraction scheduling

| Question | Alternatives considered | Selected |
|----------|-------------------------|----------|
| Pipeline entry | Enqueue after each import batch; wait for quiet; hourly | Enqueue each new committed range asynchronously |
| Late event | Bounded rewind; append in arrival order; full rebuild | Bounded rewind from the earliest affected topic span |
| Resource budget | Short interactive slices; throughput batches; idle-only | About two seconds or 250 events before yielding |
| Higher-level memory | Immediate deterministic layer plus delayed proposals; derive everything each batch; manual proposals only | Immediate topics/summaries/anchors plus quiet/hourly box and trace proposals |

**User's choice:** Selected the recommended option for all four questions.
**Notes:** Box and trace proposals remain review-only and are never auto-approved.

## the agent's Discretion

- Internal module decomposition, schema names, LaunchAgent identifiers and paths, status serialization, backoff cap and jitter, power and notification adapters, and exact queue implementation.
- Synthetic test fixture design and exact verification command decomposition.

## Deferred Ideas

- Windows and Linux service adapters.
- MCP access, encrypted multi-device synchronization, and onboarding UI remain in their existing later phases.
