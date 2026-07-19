import type { DerivationSupersession } from "../daemon/types.js";
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
    const summaries = await this.store.listSummaries();
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

    for (const anchor of await this.store.listAnchors()) {
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

    for (const box of await this.store.listBoxes()) {
      if (box.personId !== input.personId) continue;
      if (validateSummaryDependencies(`Box ${box.id}`, box.summaryIds)) add("box", box.id);
    }
    for (const proposal of await this.store.listProposals()) {
      if (proposal.personId !== input.personId) continue;
      if (validateSummaryDependencies(`Proposal ${proposal.id}`, proposal.sourceSummaryIds)) {
        add("proposal", proposal.id);
      }
    }
    for (const trace of await this.store.listTraces()) {
      if (trace.personId !== input.personId) continue;
      if (validateSummaryDependencies(`Trace ${trace.id}`, trace.summaryIds)) add("trace", trace.id);
    }

    return supersessions.sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
    );
  }
}
