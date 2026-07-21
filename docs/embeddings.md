# Embeddings

The memory system embeds summaries into vectors for trace discovery and
semantic recall. Two embedder providers exist:

- **`deterministic`** (`DeterministicEmbedder`, `keyword-hash-v1`, 64-dim) —
  always available, no dependencies, no network. This is the **default**
  and remains in effect for every user who takes no action (REQ-040:
  external models are optional adapters, never a local correctness
  dependency).
- **`onnx-transformers`** (`TransformerEmbedder`, `Xenova/bge-small-en-v1.5`,
  384-dim, ONNX fp32) — a real local sentence-transformer, opt-in only.

## Enable / disable / show

The embedder is controlled by a persisted, disabled-by-default config
sidecar at `${databasePath}.embeddings.json` (`src/embeddings/embeddings-config.ts`),
managed exclusively through the `memory embeddings` CLI command
(`src/operations/embeddings-command.ts`):

```bash
# One-time opt-in: vendors (downloads + hash-verifies) the pinned model,
# then flips the config to enabled:true. This is the ONLY code path that
# ever touches the network.
memory embeddings enable --db <path-to-db>

# Revert to the hash embedder. Vendored model files on disk are left in
# place; only the config flag flips back to enabled:false.
memory embeddings disable --db <path-to-db>

# Print the current (or default, if unset) config as JSON.
memory embeddings show --db <path-to-db>
```

`enable` sequences vendor-then-persist: `vendorModel` (see
`src/embeddings/model-vendor.ts`) must resolve successfully — including
its hash verification — before `enabled: true` is ever written. A failed
or partial vendor call leaves the config untouched, so `resolveEmbedder`
keeps returning the hash embedder rather than silently pointing at a
broken model directory.

## Offline guarantee (REQ-040 / D-04)

`env.allowRemoteModels` is `false` everywhere in the codebase except
inside the one-shot `enable` command's vendoring call. Concretely:

- The **daemon** and **MCP server** never set `allowRemoteModels`, never
  call `vendorModel`, and never touch the network for embeddings — they
  only ever call `resolveEmbedder`/`probeEmbedderHealth` against
  already-vendored, on-disk model files (or run the hash embedder).
- The **CLI embed paths** (anything that calls `resolveEmbedder`) load
  the model from `env.localModelPath` with remote model resolution
  disabled.
- Only `memory embeddings enable` is permitted to fetch model artifacts
  from the network, and only for the duration of that one vendoring call.

This means every long-running process (daemon, MCP server) and every
embed-time code path in this repo is 100% offline by construction; the
network is reachable only through the explicit, user-initiated `enable`
command.

## Enabled-but-broken semantics (D-05 / D-06)

If the embeddings config is `enabled: true` but the vendored model files
are missing, corrupted, or fail to load:

- **`resolveEmbedder`** (used by CLI embed paths) **hard-errors** — it
  never silently falls back to the hash embedder. A mixed-provider
  vector store (some vectors hash-based, some transformer-based, written
  without anyone noticing) must never happen by surprise. Recovery is to
  re-run `memory embeddings enable` (re-vendor the model) or
  `memory embeddings disable` (revert to the hash embedder).
- **`probeEmbedderHealth`** (used by the daemon and `memory status`)
  **never throws**. It returns
  `{ enabled: true, healthy: false, reason: "<error message>" }` instead.
  The unattended daemon tick uses this to **skip** embedding work for
  that cycle while every other pipeline stage (import, contraction,
  sync) keeps running normally — a broken embedder degrades gracefully,
  it never crashes the daemon loop.

### `memory status` embedder block

`runMemoryStatusCommand` (`src/bootstrap/status-command.ts`) includes an
`embedder` field on its result, sourced from `probeEmbedderHealth`:

```json
{
  "embedder": {
    "enabled": false,
    "provider": "onnx-transformers",
    "model": "Xenova/bge-small-en-v1.5",
    "revision": "",
    "healthy": true,
    "reason": null
  }
}
```

- Disabled (default): `enabled: false, healthy: true, reason: null` — the
  hash embedder is the default, not an error.
- Enabled and working: `enabled: true, healthy: true, reason: null`.
- Enabled but broken: `enabled: true, healthy: false, reason: "<message>"`
  — and the status command still **resolves**, it never rejects.

## Determinism contract (D-07 / REQ-051)

The transformer embedder is pinned end to end so its output is
reproducible:

- **Fixed weights:** fp32 (not int8-quantized) — see D-02; this keeps
  same-machine determinism airtight.
- **Fixed pooling:** CLS pooling per the bge-small-en-v1.5 training
  recipe.
- **Fixed ONNX session options:** CPU execution provider, a fixed
  `intraOpNumThreads`, and a fixed graph-optimization level — no
  runtime-dependent numeric variance from session configuration.
- **Asymmetric embedding (D-03):** queries are embedded with the bge
  instruction prefix ("Represent this sentence for searching relevant
  passages: "); stored summaries/passages are embedded bare. Both modes
  are pinned and covered by the golden set.

### Golden-set verification

Two complementary checks (`src/embeddings/transformer-embedder.ts` +
`tests/embeddings/transformer-embedder.golden.test.ts`,
`tests/fixtures/embedding-golden-set.json`):

- **Quantized-hash test:** rounds each vector component (to 1e-4) before
  hashing, producing one committed golden hash that stays stable across
  CPU architectures (AVX2 / AVX-512 / Apple Silicon) while still catching
  real model/tokenizer/config drift. This tolerates legitimate
  cross-architecture floating-point noise.
- **Exact byte-hash test:** asserts bit-identical output on repeated runs
  on the *same* machine — the strict form of REQ-051's determinism claim.

## The golden gate (local, no CI in this repo)

This repository has no `.github/workflows/` — there is no CI today. The
real-model golden suite is therefore a **local, explicit gate**: run it
once with a vendored model before `/gsd:verify-work` (or any change
touching `src/embeddings/`):

```bash
npm run test:golden
```

This runs `MEMORY_MODEL_PATH=./tests/fixtures/models vitest run
tests/embeddings/transformer-embedder.golden.test.ts` — the real ONNX
model against the committed golden set, not a mock. It requires the
vendored model to already be present under `./tests/fixtures/models`
(no network access is attempted by the test itself); vendor it first via
`memory embeddings enable --db <scratch-db> --model-path
./tests/fixtures/models` if it is not already cached locally.

## Ready-to-enable CI snippet (for when CI is added)

If/when this repo adds `.github/workflows/`, cache the vendored model
directory between runs, keyed on the pinned revision, so CI does not
re-download the ~130MB model on every run (D-08):

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Cache vendored embedding model
        uses: actions/cache@v4
        with:
          path: tests/fixtures/models
          # Keyed on the pinned model revision (src/embeddings/model-vendor.ts
          # BGE_SMALL_EN_V1_5_MANIFEST.revision) so a future model-version
          # bump invalidates the cache instead of silently testing a stale
          # cached artifact.
          key: embedding-model-${{ hashFiles('src/embeddings/model-vendor.ts') }}
      - run: npm run test
      - run: npm run test:golden
```

Until this workflow exists, `npm run test:golden` run locally is the
explicit, repeatable phase gate (documented here per D-08/T-09-14).
