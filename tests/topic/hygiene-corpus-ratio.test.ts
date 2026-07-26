/**
 * REQ-052/053/054 (Phase 11 Plan 06, T-11-19): proves the phase's measured mechanism —
 * "collapse fixes volume, not count" (11-MEASUREMENT.md) — on a CI-safe proportional
 * synthetic corpus, without the 5 GB personal database.
 *
 * The SAME corpus is contracted twice through the REAL `ContractionRunner`:
 *  - a PRE-HYGIENE reference, where every tool/synthetic event is relabeled to an ordinary
 *    `eventKind: "message"` conversational event with its hygiene-marker bracket prefix
 *    stripped (so it drives topic labels exactly as pre-Phase-11 code would have), and
 *  - the HYGIENE run, where the corpus is fed unchanged.
 *
 * Both `summaryCount` and total `summaryText.length` are asserted to fall by independent
 * conservative floors — never just one, which is exactly the variant 11-MEASUREMENT.md
 * warns an implementation could ship by accident (volume falls, count does not).
 *
 * Fixture independence: `tests/fixtures/hygiene-corpus.ts` is a from-scratch deterministic
 * generator (seeded LCG only) with its own vocabulary buckets, tool-name cycling, and
 * synthetic templates — it does not import or call anything from `src/topic/derivation-hygiene.ts`
 * to decide its own composition; only this test's `relabelForPreHygiene` step calls the real
 * `classifyEvent` (to build the honest "how would code before this phase have treated this
 * event" reference), and the HYGIENE run drives the completely unmodified real pipeline. The
 * expected-reduction thresholds are fixed conservative constants (40%/45%), not derived from
 * this run's own numbers, so the test cannot tautologically pass.
 */
import { describe, expect, it } from "vitest";
import { ContractionRunner } from "../../src/daemon/contraction-runner.js";
import type { ContractionJob, WriteAuthority } from "../../src/daemon/types.js";
import type { CanonicalEvent, MemorySource, Person } from "../../src/domain/canonical.js";
import { InMemoryStore } from "../../src/storage/in-memory-store.js";
import { buildHygieneCorpus } from "../fixtures/hygiene-corpus.js";
import { classifyEvent } from "../../src/topic/derivation-hygiene.js";

const PERSON_ID = "person_hygiene_ratio";
const SCOPE_ID = "scope_hygiene_ratio";
const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const EVENT_COUNT = 2000;
const SEED = 424242;

// Conservative floors — deliberately looser than the corpus-specific measured 59%/66%,
// because this fixture is proportional but not identical to the live 292k-event corpus.
const MIN_COUNT_REDUCTION = 0.4;
const MIN_VOLUME_REDUCTION = 0.45;

describe("hygiene corpus ratio (T-11-19: count AND volume, never volume alone)", () => {
  it("buildHygieneCorpus is deterministic: same seed produces a byte-identical array", () => {
    const first = buildHygieneCorpus({ eventCount: EVENT_COUNT, seed: SEED });
    const second = buildHygieneCorpus({ eventCount: EVENT_COUNT, seed: SEED });
    expect(second.events).toEqual(first.events);
    expect(second.composition).toEqual(first.composition);
  });

  it("contracts a proportional corpus twice and shows BOTH a large count and volume reduction, not volume alone", async () => {
    const { events, composition } = buildHygieneCorpus({
      eventCount: EVENT_COUNT,
      seed: SEED,
      personId: PERSON_ID,
      scopeId: SCOPE_ID
    });

    // Sanity: the fixture actually reproduces the measured class shares (within rounding).
    const shareOf = (n: number) => n / EVENT_COUNT;
    expect(shareOf(composition.toolActivity)).toBeCloseTo(0.638, 1);
    expect(shareOf(composition.conversational)).toBeCloseTo(0.295, 1);
    expect(shareOf(composition.syntheticInjected)).toBeCloseTo(0.067, 1);

    const preHygieneEvents = events.map(relabelForPreHygiene);

    const hygieneResult = await contractCorpus(events);
    const preHygieneResult = await contractCorpus(preHygieneEvents);

    const countReduction = 1 - hygieneResult.summaryCount / preHygieneResult.summaryCount;
    const volumeReduction = 1 - hygieneResult.totalVolume / preHygieneResult.totalVolume;

    // Visible in CI logs, per the plan's explicit instruction.
    // eslint-disable-next-line no-console
    console.log(
      `[hygiene-corpus-ratio] pre-hygiene: ${preHygieneResult.summaryCount} summaries / ${preHygieneResult.totalVolume} chars` +
      ` | hygiene: ${hygieneResult.summaryCount} summaries / ${hygieneResult.totalVolume} chars` +
      ` | count reduction: ${(countReduction * 100).toFixed(1)}%` +
      ` | volume reduction: ${(volumeReduction * 100).toFixed(1)}%`
    );

    expect(countReduction).toBeGreaterThanOrEqual(MIN_COUNT_REDUCTION);
    expect(volumeReduction).toBeGreaterThanOrEqual(MIN_VOLUME_REDUCTION);

    // Isolated tool singles survive verbatim inside conversational spans (11-MEASUREMENT's
    // intended ~11,571 residual) — some hygiene summaries must still contain "[Tool call:".
    const toolCallResidual = hygieneResult.summaries.filter((text) => text.includes("[Tool call:"));
    expect(toolCallResidual.length).toBeGreaterThan(0);

    // Synthetic content is excluded from derivation entirely — no hygiene summary may contain
    // either synthetic template's marker prefix.
    const syntheticLeak = hygieneResult.summaries.filter(
      (text) => text.includes("[SYSTEM:") || text.includes("[cron:")
    );
    expect(syntheticLeak).toHaveLength(0);
  }, 20_000);
});

/**
 * Reproduces "today's" (pre-Phase-11) behavior: every event the real classifier would call
 * `tool_activity` or `synthetic_injected` is relabeled to an ordinary `eventKind: "message"`
 * event with its bracket marker stripped, so the runner treats it exactly like plain
 * conversational content — feeding its full text to topic-label extraction and summarization,
 * fragmenting spans the way tool/harness noise fragmented the real corpus before this phase.
 */
function relabelForPreHygiene(event: CanonicalEvent): CanonicalEvent {
  const { derivationClass } = classifyEvent(event);
  if (derivationClass === "conversational") return event;

  return {
    ...event,
    eventKind: "message",
    content: event.content.replace(/^\[[^\]]*\]\s*/, "")
  };
}

async function contractCorpus(
  events: CanonicalEvent[]
): Promise<{ summaryCount: number; totalVolume: number; summaries: string[] }> {
  const store = await seededStore();
  for (const item of events) await store.saveCanonicalEvent(item);

  const first = events[0]!;
  const last = events.at(-1)!;
  const job: ContractionJob = {
    id: "job-hygiene-ratio",
    personId: PERSON_ID,
    generation: 1,
    earliestAffected: { occurredAt: first.occurredAt, nativeSequence: first.nativeSequence, id: first.id },
    latestAffected: { occurredAt: last.occurredAt, nativeSequence: last.nativeSequence, id: last.id },
    state: "pending",
    attempts: 0,
    immediateDirty: true,
    proposalDirty: true,
    lastProposalRunAt: null,
    lastActivityAt: FIXED_NOW,
    nextDueAt: FIXED_NOW,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW
  };
  await store.saveContractionJob(job);

  const runner = new ContractionRunner(store, { authority: foregroundContractionAuthority() });
  for (;;) {
    const result = await runner.drainSlice(PERSON_ID, job.id);
    if (result.complete) break;
  }

  const summaries = await store.listSummaries();
  const texts = summaries.map((summary) => summary.summaryText);
  return {
    summaryCount: summaries.length,
    totalVolume: texts.reduce((sum, text) => sum + text.length, 0),
    summaries: texts
  };
}

async function seededStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  const person: Person = { id: PERSON_ID, displayName: null, createdAt: FIXED_NOW };
  const source: MemorySource = {
    id: `source_${PERSON_ID}`,
    personId: PERSON_ID,
    application: "synthetic",
    profileId: "default",
    instanceId: "test",
    scopeId: SCOPE_ID,
    createdAt: FIXED_NOW,
    lastImportedAt: FIXED_NOW
  };
  await store.savePerson(person);
  await store.saveSource(source);
  return store;
}

function foregroundContractionAuthority(): WriteAuthority {
  return { kind: "foreground", personId: PERSON_ID, operation: "historical-bootstrap" };
}
