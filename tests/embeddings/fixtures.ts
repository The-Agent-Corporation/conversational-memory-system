import { createHash } from "node:crypto";
import { composeModelIdentity } from "../../src/embeddings/embedder-identity.js";
import type { Embedder } from "../../src/embeddings/embedder.js";
import type { Embedding } from "../../src/domain/types.js";

export interface DifferingIdentityEmbedderOptions {
  /** Bare model repo id — what a pre-GAP-12-A embedder would have advertised. */
  repo?: string;
  /** Pinned revision. Must be non-empty for this fixture to be worth anything. */
  revision?: string;
  provider?: string;
  dimensions?: number;
  /** Injected so the fixture needs no clock. */
  createdAt?: string;
}

/**
 * The shared two-identity fake embedder (GAP-12-A, F9).
 *
 * Its bare `repo` and its composed `model` are DIFFERENT strings — which is
 * exactly the condition under which the backfill's query key and write key can
 * drift apart. `DeterministicEmbedder` is the one embedder whose two identities
 * coincide, and Phase 10's backfill tests hardcoded it (`PROVIDER =
 * "deterministic"` / `MODEL = "keyword-hash-v1"`), which is why a two-key
 * mismatch stayed invisible for a whole phase.
 *
 * Plans 12-03 and 12-04 MUST import this fixture rather than define a local
 * "deterministic fake embedder" of their own: a fake whose advertised and
 * emitted identities coincide cannot detect the regression, and 12-04's
 * convergence test is precisely where a reintroduced mismatch would surface as an
 * endless per-tick re-embed loop over the live corpus.
 *
 * Deterministic (hash-based vector), clock-free (injected `createdAt`), needs no
 * model files and no network.
 */
export class DifferingIdentityEmbedder implements Embedder {
  readonly provider: string;
  /** The bare repo id: deliberately NOT equal to `model`. */
  readonly repo: string;
  readonly revision: string;
  /** The composed vector-key identity, from the one canonical composition function. */
  readonly model: string;
  readonly dimensions: number;

  /** How many times `embed()` ran — lets a convergence test assert "no re-embedding". */
  embedCalls = 0;

  private readonly createdAtValue: string;

  constructor(options: DifferingIdentityEmbedderOptions = {}) {
    this.provider = options.provider ?? "fake-differing";
    this.repo = options.repo ?? "fake-repo";
    this.revision = options.revision ?? "r1";
    this.dimensions = options.dimensions ?? 16;
    this.createdAtValue = options.createdAt ?? "2026-07-28T00:00:00.000Z";
    this.model = composeModelIdentity(this.repo, this.revision);
  }

  async embed(text: string): Promise<Embedding> {
    this.embedCalls += 1;

    const digest = createHash("sha256").update(text).digest();
    const vector = new Array<number>(this.dimensions);
    for (let index = 0; index < this.dimensions; index += 1) {
      vector[index] = (digest[index % digest.length] - 128) / 128;
    }

    return {
      provider: this.provider,
      // Composed from the same expression as `this.model` — the property under
      // test is that these are the same string, not two strings that agree.
      model: composeModelIdentity(this.repo, this.revision),
      dimensions: this.dimensions,
      vector,
      createdAt: this.createdAtValue
    };
  }
}
