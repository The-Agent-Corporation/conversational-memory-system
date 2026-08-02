import type { DerivationSupersession } from "../daemon/types.js";
import { createEventLoopYielder } from "../imports/cooperative-yield.js";
import type { MemoryStore } from "../storage/memory-store.js";

export interface InvalidateDependenciesInput {
  personId: string;
  summaryIds?: Iterable<string>;
  canonicalEventIds?: Iterable<string>;
  preserveIds?: Iterable<string>;
  supersededAt: string;
}

/**
 * Computes the fail-closed dependency closure shared by deletion and
 * incremental re-contraction. It deliberately returns mutations for the
 * caller's atomic store boundary instead of mutating storage itself.
 */
export class DerivationInvalidator {
  constructor(private readonly store: MemoryStore) {}

  async invalidateDependencies(input: InvalidateDependenciesInput): Promise<DerivationSupersession[]> {
    const preserve = new Set(input.preserveIds ?? []);
    const eventIds = new Set(input.canonicalEventIds ?? []);
    const requestedSummaryIds = new Set(input.summaryIds ?? []);
    // Five unfiltered full-table loads follow, each a single synchronous `node:sqlite` call that
    // cannot be broken up, so the yields sit BETWEEN them. Their SUM is what matters: this runs
    // inside a contraction slice, whose commit `assertFreshDaemonAuthority` rejects once the daemon's
    // 30 s write lease lapses, and the lease is renewed from a `setTimeout` heartbeat that only runs
    // when the loop reaches the timer phase. Measured on the live corpus: `listSummaries` alone took
    // 7.7 s over 138,373 rows here, on top of ~29 s already spent earlier in the same slice.
    //
    // None of these loads can be narrowed the way the runner's two could. `summariesById` must cover
    // EVERY summary, superseded included: it is what makes a box/proposal/trace referencing a
    // vanished summary throw instead of silently passing. Filtering would turn that fail-closed
    // integrity check into a fail-open one.
    //
    // The yielder is time-based, so a small store (every test, every foreground caller) crosses none
    // of these boundaries and behaves exactly as before.
    const maybeYield = createEventLoopYielder();
    const summaries = await this.store.listSummaries();
    await maybeYield();
    const summariesById = new Map(summaries.map((summary) => [summary.id, summary]));

    for (const summary of summaries) {
      if (summary.personId !== input.personId) continue;
      if ((summary.sourceCanonicalEventIds ?? []).some((id) => eventIds.has(id))) {
        requestedSummaryIds.add(summary.id);
      }
    }

    for (const id of requestedSummaryIds) {
      const summary = summariesById.get(id);
      if (!summary || summary.personId !== input.personId) {
        throw new Error(`Summary dependency ${id} has missing or cross-person ownership`);
      }
    }

    const affectedSummaryIds = new Set([...requestedSummaryIds].filter((id) => !preserve.has(id)));
    const supersessions: DerivationSupersession[] = [];
    const add = (kind: DerivationSupersession["kind"], id: string): void => {
      if (preserve.has(id) || supersessions.some((item) => item.kind === kind && item.id === id)) return;
      supersessions.push({ personId: input.personId, kind, id, supersededAt: input.supersededAt });
    };

    for (const id of affectedSummaryIds) add("summary", id);

    const anchors = await this.store.listAnchors();
    await maybeYield();
    for (const anchor of anchors) {
      if (anchor.personId !== input.personId) continue;
      if (anchor.canonicalEventId && eventIds.has(anchor.canonicalEventId)) add("anchor", anchor.id);
    }

    const validateSummaryDependencies = (owner: string, ids: string[]): boolean => {
      let affected = false;
      for (const id of ids) {
        const summary = summariesById.get(id);
        if (!summary || summary.personId !== input.personId) {
          throw new Error(`${owner} has a missing or cross-person summary dependency`);
        }
        affected ||= affectedSummaryIds.has(id);
      }
      return affected;
    };

    const boxes = await this.store.listBoxes();
    await maybeYield();
    for (const box of boxes) {
      if (box.personId !== input.personId) continue;
      if (validateSummaryDependencies(`Box ${box.id}`, box.summaryIds)) add("box", box.id);
    }
    const proposals = await this.store.listProposals();
    await maybeYield();
    for (const proposal of proposals) {
      if (proposal.personId !== input.personId) continue;
      if (validateSummaryDependencies(`Proposal ${proposal.id}`, proposal.sourceSummaryIds)) {
        add("proposal", proposal.id);
      }
    }
    const traces = await this.store.listTraces();
    await maybeYield();
    for (const trace of traces) {
      if (trace.personId !== input.personId) continue;
      if (validateSummaryDependencies(`Trace ${trace.id}`, trace.summaryIds)) add("trace", trace.id);
    }

    return supersessions.sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
    );
  }
}
