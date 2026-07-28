/**
 * The ONE place in the codebase permitted to join a model repo id and a pinned
 * revision into a vector-key model string.
 *
 * Why it exists — GAP-12-A: `TransformerEmbedder` advertised
 * `"Xenova/bge-small-en-v1.5"` on its `model` field but stamped
 * `"Xenova/bge-small-en-v1.5@<revision>"` onto every `Embedding` it emitted.
 * `backfill-embeddings-command.ts` queried the missing set with the former and
 * wrote rows keyed by the latter, so a row written by the backfill never
 * satisfied the `not exists` predicate that produced it: the missing set never
 * shrank, resume restarted from zero, `memory status` reported
 * `missingVectors == totalSummaries` forever, and a daemon repair pass driven by
 * that set would re-embed the whole corpus every tick. The same two-key bug had a
 * silent second instance in `memory-retriever.ts`'s `embeddingScore`, where a
 * stored `model` could never equal `embedder.model`.
 *
 * The fix is not "make the two strings agree" — it is "make them the same
 * expression". Every surface that needs a vector-key identity calls this
 * function; nothing else composes one. If you are about to write `` `${repo}@${rev}` ``
 * anywhere else, that is the bug coming back.
 *
 * REQ-045 requires provider/model/version be recorded so stale-model vectors are
 * detectable, which is why the pinned revision stays inside the persisted
 * identity rather than being dropped to make the two keys match.
 */

/**
 * Composes the canonical vector-key model identity for a (repo, revision) pair.
 *
 * - An empty, whitespace-only, or absent revision appends nothing, so
 *   `DeterministicEmbedder`'s `"keyword-hash-v1"` key and every deterministic row
 *   already persisted in any store keep their exact bytes.
 * - Composition is idempotent for the same revision: re-composing an identity
 *   that already ends in `@<revision>` returns it unchanged, so a value that has
 *   round-tripped through a config sidecar cannot become `repo@r1@r1`. Composing
 *   against a *different* revision does append — that is a real identity change.
 *
 * @throws if `repo` is empty or whitespace-only — a revision-only key would be
 *   indistinguishable across models.
 */
export function composeModelIdentity(repo: string, revision: string): string {
  if (typeof repo !== "string" || repo.trim().length === 0) {
    throw new Error("composeModelIdentity: repo id must be a non-empty string");
  }

  const trimmedRevision = typeof revision === "string" ? revision.trim() : "";
  if (trimmedRevision.length === 0) return repo;

  const suffix = `@${trimmedRevision}`;
  if (repo.endsWith(suffix)) return repo;

  return `${repo}${suffix}`;
}
