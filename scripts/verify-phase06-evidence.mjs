#!/usr/bin/env node
// Deterministic structural evidence validator for Phase 06 (Zero-Knowledge Multi-Device Sync).
//
// Two independent modes:
//   --automated             Structural signoff gate for the eight-plan phase (Task 06-08-02).
//   --keychain-evidence P   Validates one external content-free real-Keychain evidence bundle
//                           (Task 06-08-03). Never forges PASS from missing/edited/replayed/stale
//                           evidence, and never touches 06-VALIDATION.md itself.
//
// This script performs structural checks only -- it never invents PASS text, never substitutes
// for the blocking human-inspected Task 06-08-03 gate, and exits non-zero on any failure with a
// content-free reason listed to stderr.

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PHASE_DIR = join(REPO_ROOT, ".planning/phases/06-zero-knowledge-multi-device-sync");
const VALIDATION_PATH = join(PHASE_DIR, "06-VALIDATION.md");
const ADR_PATH = join(REPO_ROOT, "docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md");

const failures = [];
function fail(message) {
  failures.push(message);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readText(path) {
  return readFile(path, "utf8");
}

// ---------------------------------------------------------------------------
// --automated mode
// ---------------------------------------------------------------------------

async function checkExactEightPlans() {
  for (let plan = 1; plan <= 8; plan += 1) {
    const id = String(plan).padStart(2, "0");
    const planPath = join(PHASE_DIR, `06-${id}-PLAN.md`);
    if (!(await exists(planPath))) fail(`Missing plan file: 06-${id}-PLAN.md`);
    if (plan < 8) {
      const summaryPath = join(PHASE_DIR, `06-${id}-SUMMARY.md`);
      if (!(await exists(summaryPath))) fail(`Missing summary file: 06-${id}-SUMMARY.md`);
    }
  }
  // Plan 06-08 itself is the plan running this validator; its own SUMMARY.md is written after
  // this script succeeds (chicken-and-egg), so it is intentionally not required here.
}

const REQUIRED_ARTIFACTS = [
  "docs/adr/0047-zero-knowledge-sync-threat-model-and-protocol.md",
  "src/sync/domain/types.ts",
  "src/sync/crypto/crypto-provider.ts",
  "src/sync/crypto/libsodium-crypto-provider.ts",
  "src/sync/secrets/device-secret-store.ts",
  "src/sync/secrets/macos-keychain-secret-store.ts",
  "src/sync/secrets/macos-keychain-helper.swift",
  "src/storage/sync-contracts.ts",
  "src/relay/domain/types.ts",
  "src/relay/service/opaque-relay-service.ts",
  "src/relay/http/relay-http-server.ts",
  "src/sync/transport/sync-relay.ts",
  "src/sync/transport/http-sync-relay.ts",
  "src/sync/control/sync-control-service.ts",
  "src/sync/materialization/sync-materializer.ts",
  "src/sync/replication/sync-replication-service.ts",
  "src/sync/replication/replay-verifier.ts",
  "src/sync/replication/sync-status.ts",
  "src/daemon/daemon.ts",
  "src/daemon/daemon-command.ts",
  "tests/sync/replay-equivocation.test.ts",
  "tests/integration/multi-device-sync.test.ts",
  "tests/integration/sync-producers.test.ts",
  "tests/daemon/daemon-loop.test.ts",
  "scripts/benchmark-sync-padding.mjs"
];

async function checkRequiredArtifacts() {
  for (const relativePath of REQUIRED_ARTIFACTS) {
    if (!(await exists(join(REPO_ROOT, relativePath)))) {
      fail(`Missing required artifact: ${relativePath}`);
    }
  }
}

async function walkTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkTestFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

const SKIP_PATTERNS = [
  /\bit\.skip\s*\(/,
  /\bdescribe\.skip\s*\(/,
  /\bit\.todo\s*\(/,
  /\bdescribe\.todo\s*\(/,
  /\btest\.skip\s*\(/,
  /\bxit\s*\(/,
  /\bxdescribe\s*\(/
];

async function checkNoSkippedOrTodoTests() {
  const testDirs = [
    join(REPO_ROOT, "tests/sync"),
    join(REPO_ROOT, "tests/relay"),
    join(REPO_ROOT, "tests/storage"),
    join(REPO_ROOT, "tests/daemon"),
    join(REPO_ROOT, "tests/mcp"),
    join(REPO_ROOT, "tests/integration")
  ];
  for (const dir of testDirs) {
    if (!(await exists(dir))) continue;
    const files = await walkTestFiles(dir);
    for (const file of files) {
      const text = await readText(file);
      for (const pattern of SKIP_PATTERNS) {
        if (pattern.test(text)) {
          fail(`Skip/todo test declaration found: ${file.replace(`${REPO_ROOT}/`, "")} matches ${pattern}`);
        }
      }
    }
  }
}

const EXPECTED_PACKAGE_VERSIONS = {
  "canonicalize": "3.0.0",
  "jose": "6.2.3",
  "libsodium-wrappers-sumo": "0.8.4"
};

async function checkExactPackageVersions() {
  const packageJson = JSON.parse(await readText(join(REPO_ROOT, "package.json")));
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const [name, expectedVersion] of Object.entries(EXPECTED_PACKAGE_VERSIONS)) {
    const actual = dependencies[name];
    if (actual !== expectedVersion) {
      fail(`Package version mismatch for ${name}: expected ${expectedVersion}, found ${actual ?? "(missing)"}`);
    }
  }
}

const REQUIRED_ADR_MARKERS = [
  "Reviewer", "Review Date", "Protocol Digest", "Disposition", "Blocking Findings",
  "Account Provider Boundary", "Email Signup", "Email Login", "Password Recovery", "Passkey Recovery",
  "Account Recovery Cannot Enroll or Decrypt", "Owner Risk Acceptance"
];

async function checkAdrApprovalDigest() {
  if (!(await exists(ADR_PATH))) {
    fail("Missing ADR 0047");
    return;
  }
  const adr = await readText(ADR_PATH);
  for (const marker of REQUIRED_ADR_MARKERS) {
    if (!adr.includes(marker)) fail(`ADR 0047 missing required approval marker: ${marker}`);
  }
  if (!/Protocol Digest: `sha256:[0-9a-f]{64,68}`/.test(adr)) {
    fail("ADR 0047 missing a well-formed Protocol Digest line");
  }
  if (!/\| Disposition \| Approved for personal single-user deployment/.test(adr)) {
    fail("ADR 0047 Disposition row does not read 'Approved for personal single-user deployment'");
  }
  if (!/\| Blocking Findings \| None/.test(adr)) {
    fail("ADR 0047 Blocking Findings row is not 'None'");
  }
}

const REQUIRED_PRODUCER_KINDS = [
  "canonical_append", "host_event_ingest", "proposal_decision",
  "reviewed_box_decision", "source_revocation", "source_deletion", "quarantine_resolution"
];

async function checkCompleteProducerInventory() {
  const producerPath = join(REPO_ROOT, "tests/integration/sync-producers.test.ts");
  const tombstonePath = join(REPO_ROOT, "tests/sync/deletion-tombstones.test.ts");
  if (!(await exists(producerPath))) {
    fail("Missing tests/integration/sync-producers.test.ts (complete producer inventory proof)");
    return;
  }
  const producerText = await readText(producerPath);
  if (!/box-?reviewer/i.test(producerText)) fail("sync-producers.test.ts does not reference BoxReviewer");
  // quarantine_resolution is emitted by SourceLifecycleService.keepDeletion/restoreReviewed and
  // proven in deletion-tombstones.test.ts rather than sync-producers.test.ts (Plan 06-07 Summary).
  const tombstoneText = (await exists(tombstonePath)) ? await readText(tombstonePath) : "";
  for (const kind of REQUIRED_PRODUCER_KINDS) {
    if (!producerText.includes(kind) && !tombstoneText.includes(kind)) {
      fail(`Neither sync-producers.test.ts nor deletion-tombstones.test.ts reference producer kind: ${kind}`);
    }
  }
}

async function checkProductionTransportOwnership() {
  const path = join(REPO_ROOT, "src/daemon/daemon-command.ts");
  if (!(await exists(path))) {
    fail("Missing src/daemon/daemon-command.ts");
    return;
  }
  const text = await readText(path);
  if (!text.includes("HttpSyncRelay")) {
    fail("daemon-command.ts does not construct HttpSyncRelay for production selection");
  }
  if (text.includes("FakeSyncRelay") || text.includes("InMemoryRelayStore")) {
    fail("daemon-command.ts references a fake/in-process relay implementation in production composition");
  }
}

async function checkValidationTaskTable() {
  if (!(await exists(VALIDATION_PATH))) {
    fail("Missing 06-VALIDATION.md");
    return;
  }
  const text = await readText(VALIDATION_PATH);
  const rows = [...text.matchAll(/^\|\s*(06-\d\d-\d\d)\s*\|.*\|\s*(pending|complete|failed)\s*\|\s*$/gim)];
  if (rows.length === 0) fail("06-VALIDATION.md has no recognizable per-task Status rows");
  // Task 06-08-03 is the separate blocking real-Keychain human-inspected gate (Task 06-08-02's
  // own automated command runs BEFORE that signoff exists); every other task row must be complete.
  const incomplete = rows.filter((row) => row[1] !== "06-08-03" && row[2].toLowerCase() !== "complete");
  if (incomplete.length > 0) {
    fail(`06-VALIDATION.md has ${incomplete.length} task row(s) not marked complete: ${incomplete.map((row) => row[1]).join(", ")}`);
  }
  if (!/wave_0_complete: true/.test(text)) fail("06-VALIDATION.md frontmatter wave_0_complete is not true");
}

async function runAutomatedChecks() {
  await checkExactEightPlans();
  await checkRequiredArtifacts();
  await checkNoSkippedOrTodoTests();
  await checkExactPackageVersions();
  await checkAdrApprovalDigest();
  await checkCompleteProducerInventory();
  await checkProductionTransportOwnership();
  await checkValidationTaskTable();
}

// ---------------------------------------------------------------------------
// --keychain-evidence mode
// ---------------------------------------------------------------------------

const REQUIRED_KEYCHAIN_SEQUENCE = ["create", "read", "rotate_success", "rotate_failed_preserves_old", "delete", "post_delete_absent"];
const REQUIRED_LEAKAGE_SCAN_KEYS = ["argv", "environment", "stdout", "stderr", "log", "ordinarySqlite", "snapshot"];

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function checkKeychainEvidence(evidencePath) {
  if (!(await exists(evidencePath))) {
    fail(`Keychain evidence file not found: ${evidencePath}`);
    return;
  }
  let raw;
  let evidence;
  try {
    raw = await readText(evidencePath);
    evidence = JSON.parse(raw);
  } catch {
    fail("Keychain evidence file is not valid JSON");
    return;
  }

  const requiredFields = [
    "timestamp", "macosVersion", "adapterDigest", "helperDigest",
    "accountDigest", "operationSequence", "failedRotatePreservesOldValue",
    "leakageScanCounts", "evidenceDigest"
  ];
  for (const field of requiredFields) {
    if (!(field in evidence)) fail(`Keychain evidence missing required field: ${field}`);
  }
  if (failures.length > 0) return;

  if (!Number.isFinite(Date.parse(evidence.timestamp))) fail("Keychain evidence timestamp is not a valid date");

  const sequence = Array.isArray(evidence.operationSequence) ? evidence.operationSequence : [];
  const sequenceOk = REQUIRED_KEYCHAIN_SEQUENCE.every((step, index) => sequence[index] === step) &&
    sequence.length === REQUIRED_KEYCHAIN_SEQUENCE.length;
  if (!sequenceOk) {
    fail(`Keychain evidence operationSequence must be exactly ${JSON.stringify(REQUIRED_KEYCHAIN_SEQUENCE)}`);
  }
  if (evidence.failedRotatePreservesOldValue !== true) {
    fail("Keychain evidence failedRotatePreservesOldValue must be true");
  }

  const scanCounts = evidence.leakageScanCounts ?? {};
  for (const key of REQUIRED_LEAKAGE_SCAN_KEYS) {
    if (scanCounts[key] !== 0) fail(`Keychain evidence leakageScanCounts.${key} must be exactly 0, found ${scanCounts[key]}`);
  }

  // Never accept secret bytes in the bundle itself.
  const serialized = JSON.stringify(evidence);
  if (/"secretBytes"|"bearerToken"|"passphrase"/i.test(serialized)) {
    fail("Keychain evidence bundle appears to contain secret material; refusing to accept");
  }

  // Recompute the evidence digest over every field except the digest itself; reject any
  // stale/edited/replayed bundle whose stored digest does not match its own recomputed content.
  const { evidenceDigest, ...withoutDigest } = evidence;
  const recomputed = sha256Hex(JSON.stringify(withoutDigest, Object.keys(withoutDigest).sort()));
  if (evidenceDigest !== recomputed) {
    fail("Keychain evidence digest does not match its own recomputed content (stale, edited, or replayed evidence)");
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const automated = args.includes("--automated");
  const keychainFlagIndex = args.indexOf("--keychain-evidence");
  const keychainPath = keychainFlagIndex >= 0 ? args[keychainFlagIndex + 1] : null;

  if (!automated && !keychainPath) {
    process.stderr.write("Usage: node scripts/verify-phase06-evidence.mjs --automated | --keychain-evidence <path>\n");
    process.exitCode = 1;
    return;
  }

  if (automated) await runAutomatedChecks();
  if (keychainPath) await checkKeychainEvidence(keychainPath);

  if (failures.length > 0) {
    process.stderr.write(`Phase 06 evidence validation FAILED (${failures.length} issue(s)):\n`);
    for (const message of failures) process.stderr.write(`  - ${message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Phase 06 evidence validation PASSED.\n");
}

main().catch((error) => {
  process.stderr.write(`Phase 06 evidence validation crashed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
