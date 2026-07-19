# Phase 4 Pattern Map: Continuous Local Daemon

**Mapped:** 2026-07-17  
**Scope:** Closest production and test analogs only. Every code hit below was confirmed under `src/` or `tests/`; no `example/` implementation is used.

## Executive mapping

Phase 4 should add a portable orchestration layer around three existing authorities rather than inventing replacements:

1. `SourceLifecycleService` owns durable approval/revocation and person/scope binding.
2. The four history importers own native-format discovery, deterministic identities, redaction, complete-record checkpoint semantics, and read-only source access.
3. `HistoricalBootstrapper` owns deterministic topic/summary/anchor derivation and review-only proposal creation, but its full-prefix reset and per-event checkpoint writes must be replaced behind a sliced contraction runner.

The missing foundation is a domain-specific atomic storage API. `MemoryStore` currently exposes individual writes, `SqliteStore` exposes no transaction boundary, and `MemoryService.ingestEvent()` saves a canonical event and native turn separately. Phase 4 must atomically couple import writes, grant revalidation, checkpoint advancement, and affected-range job merge; it must likewise atomically couple each contraction slice with its checkpoint.

## Likely file/module responsibility map

| Likely Phase 4 file | Role and data flow | Closest existing analog | Pattern to reuse or change |
|---|---|---|---|
| `src/daemon/types.ts` | Zod schemas for lease, source health, import receipt, contraction job/checkpoint, and CLI/status payloads | `src/bootstrap/types.ts`, `src/imports/types.ts`, `src/domain/source-lifecycle.ts` | Export schema plus `z.infer` type; use ISO timestamps, explicit enums, person/candidate IDs, nullable lifecycle timestamps, and stable IDs. Never persist raw errors or conversation content in health records. |
| `src/storage/memory-store.ts` | Host-neutral daemon persistence contract | Existing `MemoryStore` interface | Add domain-specific atomic methods, not a SQLite transaction callback. Include list/get methods needed to reconstruct all work from the DB after restart. Every person-owned operation must take or validate `personId`. |
| `src/storage/sqlite-store.ts` | SQLite authority for daemon state and atomic commits | Current JSON-payload tables and indexed ordering columns | Keep Zod parsing at boundaries and ownership checks. Add short explicit `BEGIN IMMEDIATE`/commit/rollback blocks inside store methods. Store indexed scheduling/state columns separately from JSON payloads. |
| `src/storage/in-memory-store.ts` | Semantically equivalent test store | Array-backed clone-on-read/write store | Preserve `structuredClone`, deterministic sorting, ownership checks, and all-or-nothing emulation by staging cloned arrays before replacing live state. |
| `src/daemon/approved-source-runner.ts` | Enumerate approved grants, revalidate, reconstruct format approval, dispatch one incremental importer, return new/changed canonical order range | `history-import-command.ts`, `codex-import-command.ts`; four importer classes | Reuse dispatch only. Do **not** call command wrappers because both call `lifecycle.approve()`. Input should be `SourceGrant`; dispatch on exact `(application, format)` and fail closed for unsupported pairs. |
| `src/daemon/source-state.ts` | Per-source attempt/success/failure episode, bounded backoff, degraded transition, notification latch | `SourceLifecycleService` explicit state transitions and audits | Persist controlled error category, counts, times, next due, degraded/notified state. Success resets the episode. Do not save exception messages, record bodies, or unapproved paths. |
| `src/daemon/scheduler.ts` | Fair single-writer selection across watcher-prompt scans, due rescans, and contraction slices | No production queue analog; canonical event ordering and deterministic test patterns are the nearest constraints | Inject clock/jitter. Deduplicate by `(personId,candidateId,stage)`. Serve a bounded prompt burst, then force round-robin due work so a hot source cannot starve others. Persist source due/backoff and jobs; rebuild ephemeral rings on startup. |
| `src/daemon/watch-controller.ts` | Advisory filesystem wakeups with approximately 2-second per-source coalescing | Import discovery maps approved roots to source resources | Watchers enqueue candidate IDs only; they never write or prove completeness. Unsupported/lost watches degrade to periodic rescan. Inject watcher and timer factories. |
| `src/daemon/contraction-runner.ts` | Drain affected ranges in bounded slices; immediate topics/summaries/anchors; durable resume and bounded rewind | `HistoricalBootstrapper`, `TopicMonitor`, `AnchorDetector`, deterministic summarizer, `BoxAssigner` | Preserve canonical ordering and provenance. Replace prefix reset with earliest-affected-topic rewind. Default limits: 250 events or ~2 seconds, checked through injected clock. Publish slice outputs and checkpoint atomically. |
| `src/daemon/proposal-scheduler.ts` | Quiet/hourly box and trace proposal tier | `SleepReviewer.proposeBoxes()` and `.proposeTraces()` | Run after 10 minutes quiet or at least hourly while immediate derivations changed. Keep boxes, traces, and proposals in `proposed`; never approve automatically. |
| `src/daemon/daemon.ts` | Lease owner and portable loop: reconstruct state, heartbeat, watches, due scans, contraction, graceful stop | `SqliteStore` lifecycle plus command `try/finally` close pattern | One loop owns one DB writer. Timers/watchers only enqueue. Revalidate grants before source open and at stage commit. Catch failures per source. Finish or roll back current atomic stage before releasing lease. |
| `src/daemon/daemon-command.ts` | `run`, `start`, `stop`, `restart`, `status`, `once` parsing and JSON output | `bootstrap-command.ts`, `status-command.ts`, import commands | Zod-validate exported command options; keep `run...Command()` directly testable; CLI `main()` writes JSON and sets `process.exitCode`. `status` should extend/compose existing memory status, not create a second authority. |
| `src/daemon/macos/launch-agent.ts` | Explicitly enabled LaunchAgent config and lifecycle adapter | No existing OS-service analog | Inject command runner and filesystem. Generate deterministic plist/arguments. Never create/load at import, bootstrap, install, or test time; only explicit `start`/enablement. Capability absence must be reportable. |
| `src/daemon/macos/power-source.ts` | `external | battery | unknown` adapter controlling only safety-rescan interval | No existing OS adapter | Inject command runner; parse fixture output. Treat `unknown` as conservative 60-second cadence. Watcher prompt timing stays immediate on battery. |
| `src/daemon/macos/notification.ts` | Best-effort one-shot degraded-episode notification | No existing OS adapter | Accept only privacy-safe source identity/category. Notification failure cannot fail synchronization. The persisted episode latch, not adapter memory, prevents repeats. |
| `src/bootstrap/historical-bootstrapper.ts` | Compatibility one-shot facade over contraction behavior | Existing class itself | Retain `bootstrap(personId)` behavior for scripts/tests, but delegate immediate work to the new runner and avoid invoking proposal generation per slice. |
| `src/bootstrap/status-command.ts` | Read-only combined memory and daemon snapshot | Existing `runMemoryStatusCommand()` | Preserve DB-open/`try/finally`/parallel-read pattern; add lease heartbeat, process identity, last scan, degraded source count/details, and queued contraction counts. |
| `package.json` | Lifecycle script surface | Existing `memory:*` scripts via `tsx` | Prefer one `memory:daemon` entry with subcommands or explicit aliases; preserve current discover/import/bootstrap/status commands. No new dependency is required. |

## Concrete existing patterns to reuse

### 1. Domain schemas and durable identity

Existing records use Zod at every durable boundary:

```ts
export const ImportCheckpointSchema = z.object({
  id: z.string().min(1),
  personId: z.string().min(1),
  candidateId: z.string().min(1),
  resourcePath: z.string().min(1),
  fileIdentity: z.string().min(1),
  byteOffset: z.number().int().nonnegative(),
  recordIndex: z.number().int().nonnegative(),
  nativeSessionId: z.string().min(1).nullable(),
  parserVersion: z.string().min(1),
  updatedAt: IsoDateTimeSchema,
  rowHighWaterMark: z.string().min(1).nullable().optional()
});
```

`SourceGrantSchema` is the daemon source registry. It already preserves `personId`, `candidateId`, `application`, `format`, `sourceLocator`, `profileId`, immutable `scopeId`, `state`, approval/revocation times, and stable grant ID. The daemon should enumerate only grants with `state === "approved"`, retain the grant ID/token expected at commit, and fail closed if that exact grant is no longer approved.

Recommended daemon record fields:

- `DaemonLease`: database/instance ID, owner token, PID, acquired/heartbeat/expiry times, stop-request time, last global success.
- `DaemonSourceState`: `personId`, grant/candidate identity, next due, attempt/success times, consecutive failures, first/last failure, controlled category, degraded time, notification-sent time.
- `ImportBatchReceipt`: `personId`, candidate/grant identity, stable IDs/order keys for only new or materially changed canonical events, committed checkpoint IDs.
- `ContractionJob`: person, earliest affected `(occurredAt,nativeSequence,id)`, latest affected event, state/attempts, immediate/proposal dirty flags, timestamps. Pending jobs for one person merge to earliest start/latest end.
- `ContractionCheckpoint`: processor version, generation/job ID, next stable order key/event ID, restored topic state, slice count, immediate/proposal stage, timestamps.

Use controlled enums for source health (`healthy | retrying | degraded`) and error category (`temporarily_absent`, `rotated`, `permission_denied`, `malformed_source`, `grant_revoked`, `unsupported_format`, `storage_failure`, `unknown`). Do not persist arbitrary thrown strings.

### 2. Canonical ordering and person isolation

Both stores define the one canonical timeline order:

```sql
order by occurred_at asc, native_sequence asc, id asc
```

```ts
left.occurredAt.localeCompare(right.occurredAt) ||
left.nativeSequence - right.nativeSequence ||
left.id.localeCompare(right.id)
```

All affected-range keys, job merges, late-event tests, and contraction checkpoints must use that same tuple. Counts or dense indices alone are unsafe because a late event shifts later indices.

`SqliteStore.saveSource`, `saveCanonicalEvent`, `saveImportCheckpoint`, and `saveSourceGrant` parse first, load the existing record, and call `assertPersonOwnership(existing, parsed)` before upsert. Mirror this for every daemon record and atomic operation. A daemon job for person A must never load events, derivations, or grants for person B.

### 3. Atomic storage operations

Current flow is deliberately fine-grained:

```ts
await this.store.saveCanonicalEvent(canonicalEvent);
await this.store.saveTurn(turn);
```

Importers then save a file/row checkpoint after processing a resource. This converges on replay because canonical IDs are deterministic, but it does not satisfy Phase 4 crash boundaries.

Prefer explicit store methods with input/output schemas such as:

```ts
commitImportBatch(input: {
  expectedGrant: { id: string; personId: string; candidateId: string; updatedAt: string };
  people: Person[];
  sources: MemorySource[];
  canonicalEvents: CanonicalEvent[];
  turns: Turn[];
  quarantineChanges: QuarantineRecord[];
  checkpoint: ImportCheckpoint;
  receipt: ImportBatchReceipt;
}): Promise<ImportBatchReceipt>;

commitContractionSlice(input: {
  personId: string;
  jobId: string;
  expectedCheckpoint: ContractionCheckpoint | null;
  turns: Turn[];
  summaries: Summary[];
  anchors: Anchor[];
  supersessions: DerivationSupersession[];
  nextCheckpoint: ContractionCheckpoint;
}): Promise<ContractionCheckpoint>;
```

The exact shape is discretionary, but these invariants are not:

- Re-read the expected grant inside the SQLite transaction immediately before writes.
- Event/source/turn/quarantine writes, checkpoint advancement, and contraction-job merge commit together.
- Contraction outputs and its next checkpoint commit together.
- A failed compare or write rolls back everything.
- `InMemoryStore` emulates atomicity using staged clones, not sequential mutation of live arrays.
- SQLite migrations remain additive and idempotent (`create table/index if not exists`). Indexed columns should cover person, state, due time, heartbeat, and canonical range ordering; payload JSON remains the schema-validated durable record.

### 4. Approved-source dispatch

The existing explicit commands show the dispatch matrix but are unsafe as daemon entry points because each calls `lifecycle.approve()`:

```ts
if (candidate.application === "claude-code") {
  imported = await new ClaudeHistoryImporter(store, ...).importApprovedSource(...);
} else if (candidate.application === "openclaw") {
  imported = await new OpenClawHistoryImporter(store, ...).importApprovedSource(...);
} else {
  imported = await new HermesHistoryImporter(store, ...).importApprovedSource(...);
}
```

Add Codex to the same exact-pair dispatcher:

| Grant application | Grant format | Importer | Native locator |
|---|---|---|---|
| `codex` | `codex-rollout-jsonl` | `CodexHistoryImporter` | approved root |
| `claude-code` | `claude-project-jsonl` | `ClaudeHistoryImporter` | approved root |
| `openclaw` | `openclaw-session-jsonl` | `OpenClawHistoryImporter` | approved root |
| `hermes` | `hermes-state-sqlite` | `HermesHistoryImporter` | approved DB/root resolved to DB |

The runner should reconstruct the importer approval directly from the durable grant, assert `SourceLifecycleService.assertApproved(personId,candidateId)` before opening the source, and pass the already-bound profile/scope. It must never rediscover-and-approve in background work. Discovery may verify current candidate identity, but rotation/absence must retain the durable candidate identity and retry rather than create a new approval.

### 5. Importer resume and idempotency patterns

File importers already implement the important complete-record rule:

```ts
const canResume = previous !== null &&
  previous.fileIdentity === currentIdentity &&
  previous.parserVersion === PARSER_VERSION &&
  currentMetadata.size >= previous.byteOffset;
const startingOffset = canResume ? previous.byteOffset : 0;
for await (const line of readCompleteLines(path, startingOffset)) {
  committedOffset = line.nextOffset;
  // parse, redact/quarantine, emit deterministic events
}
```

`readCompleteLines` yields only newline-complete JSONL records. Tests prove an appended partial record imports zero messages until its terminating newline appears. File rotation/truncation resets scan position, while deterministic canonical IDs prevent duplicate events.

Hermes uses a read-only DB and row high-water mark:

```ts
const database = openHermesReadonlyDatabase(databasePath);
where m.id > ?
order by m.id asc
...
rowHighWaterMark: String(committedHighWaterMark)
```

Preserve device/inode identity, parser version, offset/record index, native session, and Hermes row high-water semantics. Tighten them by committing bounded complete-record batches rather than one checkpoint after a whole resource. The returned receipt must distinguish a deterministic upsert that changed nothing from a new/materially changed event; `messagesProcessed` is insufficient for contraction scheduling.

`MemoryService` supplies deterministic IDs and provenance:

```ts
event_${sha256(JSON.stringify([sourceId, nativeSessionId, nativeEventId]))}
source_${sha256(JSON.stringify([personId, application, profileId, instanceId]))}
```

The atomic import seam should reuse this construction, ideally by extracting pure event/source/turn builders from `MemoryService` so the store can commit the built batch without reimplementing identity rules.

### 6. Scheduler and source health

No production scheduler exists, so keep the new core small and injected:

```ts
interface DaemonClock {
  now(): string;
  monotonicMs(): number;
}

interface WatcherFactory {
  watch(grant: SourceGrant, onHint: () => void): WatchHandle;
}

interface PowerStateProvider {
  current(): Promise<"external" | "battery" | "unknown">;
}
```

Recommended deterministic service rule:

- Watch hints debounce per `(personId,candidateId)` for ~2 seconds and enter a prompt FIFO.
- Safety scans become due every 60 seconds on external/unknown power and every 300 seconds on battery.
- After a configurable small prompt burst, force one due source from a round-robin ring.
- Contraction is a durable work class in the same writer loop; a scan returns after its atomic import commit/job merge.
- One source exception updates only that source episode and the loop continues.
- Backoff is bounded exponential with injectable deterministic jitter; success clears failures and returns the source to normal cadence.
- Degraded transition is `failures >= 3 || now - firstFailureAt >= 15 minutes`; notify once per episode using persisted `notificationSentAt`.

The privacy-safe status/diagnostic record may contain candidate/grant identity, category, count, and timestamps. It must not contain transcript text, raw exception messages, unredacted native records, or new paths beyond the approved locator.

### 7. Incremental contraction

`HistoricalBootstrapper.bootstrap(personId)` currently:

1. reads canonically ordered person events;
2. checks `{processorVersion, processedEventCount, lastCanonicalEventId, rollingPrefixHash}`;
3. restores `activeTopic` for append-only resume;
4. writes a personal compatibility turn;
5. runs `AnchorDetector.detectForTurn()`;
6. feeds `TopicMonitor.observe()` and compacts completed spans;
7. saves a checkpoint after every event;
8. on changed prefix, restarts at zero and supersedes old unproduced summaries;
9. invokes both proposal planners at the end.

Reusable signatures:

```ts
new TopicMonitor().observe(event): TopicMonitorResult
monitor.restore(state: RollingTopicState): void
new AnchorDetector(store).detectForTurn(turn)
summarizer.summarize({ span, sourceTurns })
new BoxAssigner(store).assignSummary(summary)
new SleepReviewer(store).proposeBoxes({ personId, reviewedAt })
new SleepReviewer(store).proposeTraces({ personId, reviewedAt })
```

For append-only work, resume the active topic and process only events after the stable checkpoint. For a late event:

1. Find the earliest new/changed canonical order tuple.
2. Find the existing summary/topic span containing that tuple; rewind to its first canonical event, or the inserted event if no span intersects.
3. Preserve all derivations strictly before the rewind boundary.
4. Rebuild personal turn sequence/topic state from the boundary in a new generation.
5. Compare source canonical IDs, scope union, summary text/model/prompt version, and dependency fingerprint before superseding.
6. Reuse the fail-closed dependency walk in `SourceLifecycleService.deleteRevokedSource()` for changed summaries: dependent boxes/proposals/traces/injections must be superseded/removed only when their source dependencies changed.
7. Publish at most 250 events or ~2 seconds per slice, then persist resumable state and yield.

Immediate work is topics, summaries, and anchors. Persist a dirty marker/activity time for proposal work. Box/trace planning occurs only after 10 quiet minutes or at least hourly and keeps state `proposed`.

### 8. Daemon loop, lease, and lifecycle

Use a database lease as authority and PID only as supporting identity:

- `run`: acquire compare-and-set lease, reconstruct durable source/jobs, install signal handlers, heartbeat, and loop until stop/abort.
- `once`: acquire the same lease, perform one due rescan pass plus bounded queued contraction, report remaining work, release, exit.
- `stop`: persist stop request and optionally signal matching PID/token. The owner completes or rolls back its atomic stage, checkpoints, closes watches, releases lease, exits.
- `restart`: graceful stop then explicit start.
- `status`: combine lease freshness/token/PID, heartbeat, LaunchAgent capability/state, last successful scan, source degradation, and queued contraction counts.
- `start`: the only operation that writes/loads LaunchAgent configuration and enables login autostart.

Suggested loop dependency shape:

```ts
interface DaemonRuntime {
  clock: DaemonClock;
  watchers: WatcherFactory;
  power: PowerStateProvider;
  notifier: NotificationAdapter;
  signals: SignalAdapter;
}
```

The loop must never hold a SQLite transaction while waiting for timers, filesystem events, power probes, notification commands, or optional model calls. External LLMs remain optional; the deterministic summarizer is the offline correctness path.

### 9. CLI and status patterns

Existing commands expose a testable function and keep process glue at the edge:

```ts
export async function runBootstrapCommand(options): Promise<Result> {
  const parsed = OptionsSchema.parse(options);
  const store = new SqliteStore(parsed.databasePath);
  try { return { ok: true, ... }; }
  finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${safeMessage}\n`);
    process.exitCode = 1;
  });
}
```

Reuse this for `once`, `status`, and adapter lifecycle commands. `run` is long-lived and must keep the store open until graceful shutdown. JSON result schemas should be stable and content-free. Existing `runMemoryStatusCommand()` uses parallel read-only calls and person filters; extend it with daemon state instead of duplicating memory counts in another authority.

`package.json` already uses `tsx` for all commands. A minimal addition is:

```json
"memory:daemon": "tsx src/daemon/daemon-command.ts"
```

with subcommands `run|start|stop|restart|status|once`. Explicit aliases are acceptable if they all delegate to the same parser/service.

### 10. macOS adapters

There is no production macOS adapter analog in this repo. Follow the command seam above and inject all side effects:

- `CommandRunner.run(executable, args, options)` returns structured exit/stdout/stderr; tests supply fixtures.
- LaunchAgent adapter exposes deterministic plist generation separately from filesystem/`launchctl` mutation.
- Power adapter maps `pmset` fixture output to `external | battery | unknown`; unknown uses 60-second safety scans.
- Notification adapter receives a pre-sanitized title/body or structured source episode; it is best effort.
- Tests must never call real `launchctl`, `pmset`, `osascript`, modify `~/Library/LaunchAgents`, or send a real notification.

Keep all OS paths/labels/log locations in the macOS module. The portable daemon, domain schemas, storage, and importers must not import macOS modules.

## Wave 0 test map

All new tests belong under `tests/daemon/`; use temporary synthetic roots and DBs only. Existing fixtures prove the appropriate style: `mkdtemp(join(tmpdir(), ...))`, `afterEach rm(..., {recursive:true,force:true})`, injected fixed ISO clocks, `InMemoryStore` for state-machine tests, and close/reopen `SqliteStore` for recovery proof.

| Wave 0 file | Assertions to establish before implementation | Closest existing test analog |
|---|---|---|
| `tests/daemon/fixtures.ts` | Fake clock/timer advancement; fake watcher; power/notifier/command runner; approved four-source grant builders; synthetic Codex/Claude/OpenClaw JSONL and Hermes SQLite | Builders in `universal-import-bootstrap.test.ts`, `multi-source-history.test.ts`, and `sqlite-store.test.ts` |
| `tests/daemon/daemon-store.test.ts` | Lease CAS/expiry/token mismatch; grant-at-commit rejection; atomic import+checkpoint+job; rollback fault injection; atomic contraction+checkpoint; close/reopen recovery; person ownership | `sqlite-store.test.ts` persistence, global ordering, invalid-save, and reassignment tests |
| `tests/daemon/source-runner.test.ts` | Dispatch exact four grant formats without `approve()`; revoked-before-open and revoked-at-commit; append/no-op; partial JSONL; truncation/rotation; temporary absence; Hermes high-water; source remains read-only | `codex-history.test.ts`, `multi-source-history.test.ts`, `universal-import-bootstrap.test.ts`, `source-lifecycle-service.test.ts` |
| `tests/daemon/scheduler.test.ts` | 2-second coalescing under fake time; 60/300 cadence and restoration; prompt priority; round-robin starvation bound; bounded backoff/reset; one source failure does not block another; degraded at third failure or 15 minutes; one notification per episode | No queue analog; use deterministic unit-test style and injected clocks from importer/bootstrap tests |
| `tests/daemon/contraction-runner.test.ts` | Append touches suffix only; late event rewinds affected topic span; unaffected prefix IDs/states unchanged; 251 events yields after 250; fake elapsed-time yield; crash replay convergence; immediate derivations precede quiet proposals; proposals remain review-only | `historical-bootstrapper.test.ts` no-op/append/reset/person-isolation cases |
| `tests/daemon/daemon-loop.test.ts` | Startup solely from SQLite; one DB writer; multi-person independent scheduling; lost watch recovered by rescan; source failure isolation; graceful stop; stale lease takeover; `once` exits and reports remaining work | `universal-import-bootstrap.test.ts` end-to-end four-source DB plus bootstrap/status |
| `tests/daemon/daemon-commands.test.ts` | `run/start/stop/restart/status/once` option/result parsing; missing args; live/stale lease status; only explicit start enables autostart; safe JSON output | `bootstrap-commands.test.ts` and exported `run...Command` tests |
| `tests/daemon/macos-adapters.test.ts` | Exact deterministic plist/args; capability absence; fixture power parsing; unknown fallback; one notification request per persisted episode; no real OS mutation | No existing OS analog; use injected command runner and temp paths |

Mandatory synthetic fault boundaries:

- Before and after grant check.
- Before first import write, between event/turn construction and atomic commit, and after commit before return.
- Before and after import checkpoint/job merge.
- Before and after each contraction slice commit.
- During graceful stop request.

For each boundary: restart from the same SQLite DB and compare normalized final state with a clean run. Assert no duplicate canonical IDs, turns, summaries, anchors, boxes, traces, proposals, or jobs.

Privacy/isolation assertions belong in every relevant suite:

- daemon health/notifications contain no message text, raw errors, secrets, or client content;
- source reads never modify source fixtures;
- revoked grants produce no later commits;
- person A work never changes person B state;
- scope IDs remain inherited from the grant/source and derived summary scope union;
- external model configuration is absent and deterministic contraction still succeeds.

## Planner/executor guardrails

- Do not create a second approval registry or silently call `approve()`.
- Do not make watchers a correctness dependency.
- Do not enqueue contraction in a best-effort write after import commit.
- Do not checkpoint counts alone or append late events out of canonical order.
- Do not run full contraction or proposal generation inside a source scan.
- Do not let one failing source reject a loop-wide `Promise.all`.
- Do not treat PID existence as liveness without a fresh matching lease token.
- Do not put raw exception strings or transcript content in durable diagnostics.
- Do not auto-approve boxes, traces, proposals, or sleep-review conclusions.
- Do not access real personal histories in tests.
- Do not import any implementation pattern from `example/`; all patterns above are from production `src/` or `tests/`.

## Focused verification boundary

```bash
npx vitest run tests/daemon
npx vitest run tests/daemon \
  tests/imports/codex-history.test.ts \
  tests/imports/multi-source-history.test.ts \
  tests/imports/universal-import-bootstrap.test.ts \
  tests/bootstrap/historical-bootstrapper.test.ts \
  tests/service/source-lifecycle-service.test.ts \
  tests/storage/sqlite-store.test.ts
npm run typecheck
git diff --check
```

The worktree was already substantially dirty before this mapping. This artifact does not interpret those unrelated changes as Phase 4 implementation and does not rely on stale `example/` or graph hits.
