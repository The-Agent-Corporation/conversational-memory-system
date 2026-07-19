#!/usr/bin/env node

/**
 * Deterministic synthetic padding benchmark for CMS Sync Protocol v1.
 *
 * The input sizes model already-canonicalized operation bytes. They contain no
 * personal history or production data. The four-byte authenticated length
 * prefix and sixteen-byte XChaCha20-Poly1305 tag are included before rounding
 * ciphertext to a fixed bucket multiple.
 */

const LENGTH_PREFIX_BYTES = 4;
const AEAD_TAG_BYTES = 16;
const RETAINED_VERSIONS = 365;

const distributions = {
  canonical: [320, 480, 640, 900, 1_200, 1_700, 2_400, 3_200, 4_800, 7_200, 11_000],
  review: [240, 360, 520, 760, 1_100, 1_600, 2_300, 3_500, 5_200],
  tombstone: [144, 176, 208, 256, 320, 448, 640],
  "derived-cache": [700, 1_100, 1_800, 2_900, 4_600, 7_400, 12_000, 19_000, 30_000],
};

const policies = [4_096, 16_384];

function paddedCiphertextBytes(operationBytes, bucketBytes) {
  const unpaddedCiphertext = LENGTH_PREFIX_BYTES + operationBytes + AEAD_TAG_BYTES;
  return Math.ceil(unpaddedCiphertext / bucketBytes) * bucketBytes;
}

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function summarize(values, bucketBytes) {
  const samples = values.map((operationBytes) => {
    const unpaddedBytes = LENGTH_PREFIX_BYTES + operationBytes + AEAD_TAG_BYTES;
    const paddedBytes = paddedCiphertextBytes(operationBytes, bucketBytes);
    return {
      overheadBytes: paddedBytes - unpaddedBytes,
      overheadRatio: paddedBytes / unpaddedBytes - 1,
      paddedBytes,
      unpaddedBytes,
    };
  });
  const ratios = samples.map((sample) => sample.overheadRatio).sort((a, b) => a - b);
  const unpaddedTotal = samples.reduce((total, sample) => total + sample.unpaddedBytes, 0);
  const paddedTotal = samples.reduce((total, sample) => total + sample.paddedBytes, 0);
  return {
    count: samples.length,
    p50OverheadPercent: percentile(ratios, 0.5) * 100,
    p95OverheadPercent: percentile(ratios, 0.95) * 100,
    unpaddedTotal,
    paddedTotal,
    retainedPaddedBytes: paddedTotal * RETAINED_VERSIONS,
    cumulativeOverheadPercent: (paddedTotal / unpaddedTotal - 1) * 100,
  };
}

function formatBytes(bytes) {
  return `${bytes} B`;
}

console.log("CMS Sync Protocol v1 synthetic padding benchmark");
console.log(`retained versions per sample: ${RETAINED_VERSIONS} (append-only, indefinite-growth projection)`);

for (const bucketBytes of policies) {
  console.log(`\nPolicy: ${bucketBytes}-byte multiples`);
  let aggregateUnpadded = 0;
  let aggregatePadded = 0;
  for (const [objectType, values] of Object.entries(distributions)) {
    const result = summarize(values, bucketBytes);
    aggregateUnpadded += result.unpaddedTotal;
    aggregatePadded += result.paddedTotal;
    console.log(
      [
        objectType.padEnd(13),
        `n=${String(result.count).padStart(2)}`,
        `p50=${result.p50OverheadPercent.toFixed(1).padStart(7)}%`,
        `p95=${result.p95OverheadPercent.toFixed(1).padStart(7)}%`,
        `cumulative=${result.cumulativeOverheadPercent.toFixed(1).padStart(7)}%`,
        `retained-storage/full-sync-transfer=${formatBytes(result.retainedPaddedBytes)}`,
      ].join("  "),
    );
  }
  console.log(
    `aggregate      unpadded=${formatBytes(aggregateUnpadded)}  padded=${formatBytes(aggregatePadded)}  ` +
      `cumulative=${((aggregatePadded / aggregateUnpadded - 1) * 100).toFixed(1)}%  ` +
      `retained-storage/full-sync-transfer=${formatBytes(aggregatePadded * RETAINED_VERSIONS)}`,
  );
}

console.log("\nSelection: cms-sync-padding-v1 = 4096-byte ciphertext multiples (maximum ciphertext 16777216 bytes)");
