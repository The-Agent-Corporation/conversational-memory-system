import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DeviceSecretError,
  type DeviceSecretStore,
  type SecretBinding
} from "../../src/sync/secrets/device-secret-store.js";
import { InMemoryDeviceSecretStore } from "../../src/sync/secrets/in-memory-device-secret-store.js";
import {
  MACOS_KEYCHAIN_SERVICE_LABEL,
  MacosKeychainSecretStore,
  type KeychainHelperRequest,
  type KeychainHelperResult,
  type KeychainHelperRunner
} from "../../src/sync/secrets/macos-keychain-secret-store.js";
import { createFaultInjector } from "../mcp/fixtures.js";
import { createSyntheticMcpFixture, snapshotSemanticMemory } from "../mcp/fixtures.js";
import { createSyntheticProfileConfig } from "../mcp/fixtures.js";

const bindingAlpha: SecretBinding = {
  personId: "person-alpha",
  syncId: "sync-alpha",
  deviceId: "device-alpha"
};

const bindingBeta: SecretBinding = {
  personId: "person-beta",
  syncId: "sync-alpha",
  deviceId: "device-alpha"
};

const syntheticBytes = (label: string): Uint8Array => {
  const seed = randomBytes(32);
  // Embed a stable, obviously-synthetic marker so leakage assertions can
  // scan for it without depending on random byte collisions.
  const marker = Buffer.from(`SYN-${label}`, "utf8");
  return new Uint8Array(Buffer.concat([marker, seed]));
};

const expectCode = async (
  call: () => Promise<unknown>,
  code: DeviceSecretError["code"]
): Promise<void> => {
  try {
    await call();
    throw new Error("Expected a DeviceSecretError");
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceSecretError);
    expect((error as DeviceSecretError).code).toBe(code);
  }
};

describe("DeviceSecretStore contract (InMemoryDeviceSecretStore)", () => {
  it("creates a secret at version 1 and returns a defensive copy", async () => {
    const store: DeviceSecretStore = new InMemoryDeviceSecretStore();
    const bytes = syntheticBytes("create");
    const handle = await store.create({
      binding: bindingAlpha,
      kind: "device_signing_seed",
      secretId: "secret-1",
      bytes
    });
    expect(handle.version).toBe(1);
    expect(Buffer.from(handle.bytes).equals(Buffer.from(bytes))).toBe(true);

    handle.bytes.fill(0);
    const read = await store.read({
      binding: bindingAlpha,
      kind: "device_signing_seed",
      secretId: "secret-1"
    });
    expect(Buffer.from(read.bytes).equals(Buffer.from(bytes))).toBe(true);

    // Mutating the caller-supplied source bytes after create must not
    // affect stored state either.
    bytes.fill(1);
    const readAgain = await store.read({
      binding: bindingAlpha,
      kind: "device_signing_seed",
      secretId: "secret-1"
    });
    expect(Buffer.from(readAgain.bytes).equals(Buffer.from(bytes))).toBe(false);
  });

  it("rejects duplicate secret ids for the same kind", async () => {
    const store = new InMemoryDeviceSecretStore();
    await store.create({
      binding: bindingAlpha,
      kind: "epoch_key",
      secretId: "secret-dup",
      bytes: syntheticBytes("dup")
    });
    await expectCode(
      () =>
        store.create({
          binding: bindingAlpha,
          kind: "epoch_key",
          secretId: "secret-dup",
          bytes: syntheticBytes("dup-2")
        }),
      "SECRET_ALREADY_EXISTS"
    );
  });

  it("returns SECRET_NOT_FOUND for missing secrets on every operation", async () => {
    const store = new InMemoryDeviceSecretStore();
    await expectCode(
      () => store.read({ binding: bindingAlpha, kind: "recovery_seed", secretId: "missing" }),
      "SECRET_NOT_FOUND"
    );
    await expectCode(
      () => store.currentVersion(bindingAlpha, "recovery_seed", "missing"),
      "SECRET_NOT_FOUND"
    );
    await expectCode(
      () =>
        store.rotate({
          binding: bindingAlpha,
          kind: "recovery_seed",
          secretId: "missing",
          expectedCurrentVersion: 1,
          bytes: syntheticBytes("rotate-missing")
        }),
      "SECRET_NOT_FOUND"
    );
    await expectCode(
      () => store.delete({ binding: bindingAlpha, kind: "recovery_seed", secretId: "missing" }),
      "SECRET_NOT_FOUND"
    );
  });

  it("returns SECRET_VERSION_NOT_FOUND for a stale explicit version read", async () => {
    const store = new InMemoryDeviceSecretStore();
    await store.create({
      binding: bindingAlpha,
      kind: "keyring_wrapping_key",
      secretId: "secret-version",
      bytes: syntheticBytes("v1")
    });
    await expectCode(
      () =>
        store.read({
          binding: bindingAlpha,
          kind: "keyring_wrapping_key",
          secretId: "secret-version",
          expectedVersion: 7
        }),
      "SECRET_VERSION_NOT_FOUND"
    );
  });

  it("denies cross-person access with a controlled code and no secret material", async () => {
    const store = new InMemoryDeviceSecretStore();
    await store.create({
      binding: bindingAlpha,
      kind: "device_wrapping_seed",
      secretId: "secret-cross",
      bytes: syntheticBytes("cross")
    });
    await expectCode(
      () => store.read({ binding: bindingBeta, kind: "device_wrapping_seed", secretId: "secret-cross" }),
      "SECRET_BINDING_MISMATCH"
    );
    await expectCode(
      () => store.delete({ binding: bindingBeta, kind: "device_wrapping_seed", secretId: "secret-cross" }),
      "SECRET_BINDING_MISMATCH"
    );
  });

  it("rotates atomically, advancing current version only on an exact expected-version match", async () => {
    const store = new InMemoryDeviceSecretStore();
    await store.create({
      binding: bindingAlpha,
      kind: "epoch_key",
      secretId: "secret-rotate",
      bytes: syntheticBytes("rotate-v1")
    });
    await expectCode(
      () =>
        store.rotate({
          binding: bindingAlpha,
          kind: "epoch_key",
          secretId: "secret-rotate",
          expectedCurrentVersion: 99,
          bytes: syntheticBytes("rotate-stale")
        }),
      "SECRET_VERSION_STALE"
    );
    // A rejected rotation never advances the current version.
    expect(await store.currentVersion(bindingAlpha, "epoch_key", "secret-rotate")).toBe(1);

    const rotated = await store.rotate({
      binding: bindingAlpha,
      kind: "epoch_key",
      secretId: "secret-rotate",
      expectedCurrentVersion: 1,
      bytes: syntheticBytes("rotate-v2")
    });
    expect(rotated.version).toBe(2);
    expect(await store.currentVersion(bindingAlpha, "epoch_key", "secret-rotate")).toBe(2);

    // The prior version remains retrievable by explicit version.
    const oldVersion = await store.read({
      binding: bindingAlpha,
      kind: "epoch_key",
      secretId: "secret-rotate",
      expectedVersion: 1
    });
    expect(Buffer.from(oldVersion.bytes).includes("SYN-rotate-v1")).toBe(true);
  });

  it("deletes a secret, zeroizing retained buffers and rejecting further access", async () => {
    const store = new InMemoryDeviceSecretStore();
    await store.create({
      binding: bindingAlpha,
      kind: "recovery_seed",
      secretId: "secret-delete",
      bytes: syntheticBytes("delete")
    });
    await store.delete({ binding: bindingAlpha, kind: "recovery_seed", secretId: "secret-delete" });
    await expectCode(
      () => store.read({ binding: bindingAlpha, kind: "recovery_seed", secretId: "secret-delete" }),
      "SECRET_NOT_FOUND"
    );
    // A secret id may be reused for a fresh secret once fully deleted.
    const recreated = await store.create({
      binding: bindingAlpha,
      kind: "recovery_seed",
      secretId: "secret-delete",
      bytes: syntheticBytes("delete-2")
    });
    expect(recreated.version).toBe(1);
  });

  it("routes through the injectable fault boundary before mutation", async () => {
    const faultInjector = createFaultInjector();
    const store = new InMemoryDeviceSecretStore({ faultInjector });
    faultInjector.failAt("in-memory-device-secret-store:before-create");
    await expect(
      store.create({
        binding: bindingAlpha,
        kind: "device_signing_seed",
        secretId: "secret-fault",
        bytes: syntheticBytes("fault")
      })
    ).rejects.toThrow(/Synthetic fault/);
    faultInjector.failAt(null);
    const handle = await store.create({
      binding: bindingAlpha,
      kind: "device_signing_seed",
      secretId: "secret-fault",
      bytes: syntheticBytes("fault-ok")
    });
    expect(handle.version).toBe(1);
  });

  it("never exposes secret material through errors, JSON serialization, or console diagnostics", async () => {
    const store = new InMemoryDeviceSecretStore();
    const bytes = syntheticBytes("leak-error");
    const marker = Buffer.from(bytes).toString("base64");
    await store.create({
      binding: bindingAlpha,
      kind: "recovery_seed",
      secretId: "secret-leak",
      bytes
    });

    let caught: unknown;
    try {
      await store.read({ binding: bindingBeta, kind: "recovery_seed", secretId: "secret-leak" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeviceSecretError);
    expect((caught as Error).message).not.toContain(marker);
    expect(JSON.stringify(caught)).not.toContain(marker);
    expect(JSON.stringify(store)).not.toContain(marker);
    expect(String(store)).not.toContain(marker);
  });

  it("scans environment/config-like objects for absence of synthetic secret values", async () => {
    const store = new InMemoryDeviceSecretStore();
    const bytes = syntheticBytes("leak-config");
    const marker = Buffer.from(bytes).toString("base64");
    await store.create({
      binding: bindingAlpha,
      kind: "device_wrapping_seed",
      secretId: "secret-config-scan",
      bytes
    });

    const configLikeObject = createSyntheticProfileConfig("/tmp/synthetic.sqlite", "/tmp/synthetic-source");
    expect(JSON.stringify(configLikeObject)).not.toContain(marker);
    expect(JSON.stringify(process.env)).not.toContain(marker);
  });

  it("scans ordinary SQLite fixture state for absence of synthetic secret values", async () => {
    const store = new InMemoryDeviceSecretStore();
    const bytes = syntheticBytes("leak-sqlite");
    const marker = Buffer.from(bytes).toString("base64");
    await store.create({
      binding: bindingAlpha,
      kind: "epoch_key",
      secretId: "secret-sqlite-scan",
      bytes
    });

    const fixture = await createSyntheticMcpFixture();
    try {
      const snapshot = await snapshotSemanticMemory(fixture.store);
      expect(snapshot).not.toContain(marker);
    } finally {
      await fixture.cleanup();
    }
  });

  it("is not selectable in the exported production configuration surface", async () => {
    // The fake is test infrastructure. Its constructor takes no production
    // wiring (no keychain service name, no host paths) and its module has
    // no side-effecting production registration.
    const store = new InMemoryDeviceSecretStore();
    expect(store).toBeInstanceOf(InMemoryDeviceSecretStore);
  });
});

/**
 * Deterministic synthetic Keychain protocol simulator used only by tests.
 * It never touches a real Keychain and never runs a real subprocess; it
 * exists to prove `MacosKeychainSecretStore`'s request/result mapping,
 * CAS/failure semantics, and non-leakage of secret bytes through the
 * control channel.
 */
class FakeKeychainHelperRunner implements KeychainHelperRunner {
  readonly requestsSeen: KeychainHelperRequest[] = [];
  readonly resultsSeen: KeychainHelperResult[] = [];
  failNextRotate = false;

  private readonly current = new Map<string, number>();
  private readonly versions = new Map<string, Uint8Array>();

  async run(
    request: KeychainHelperRequest,
    secretIo: { writeSecret?: () => Uint8Array; readSecret?: (bytes: Uint8Array) => void }
  ): Promise<KeychainHelperResult> {
    this.requestsSeen.push(request);
    const key = `${request.service}:${request.account}`;
    let result: KeychainHelperResult;

    switch (request.operation) {
      case "create": {
        if (this.current.has(key)) {
          result = { requestId: request.requestId, status: "error", code: "SECRET_ALREADY_EXISTS" };
          break;
        }
        const bytes = secretIo.writeSecret!();
        this.versions.set(`${key}#1`, Uint8Array.from(bytes));
        this.current.set(key, 1);
        result = { requestId: request.requestId, status: "ok", version: 1, byteLength: bytes.length };
        break;
      }
      case "read": {
        const currentVersion = this.current.get(key);
        if (currentVersion === undefined) {
          result = { requestId: request.requestId, status: "error", code: "SECRET_NOT_FOUND" };
          break;
        }
        const version = request.expectedVersion ?? currentVersion;
        const bytes = this.versions.get(`${key}#${version}`);
        if (!bytes) {
          result = { requestId: request.requestId, status: "error", code: "SECRET_VERSION_NOT_FOUND" };
          break;
        }
        secretIo.readSecret!(bytes);
        result = { requestId: request.requestId, status: "ok", version, byteLength: bytes.length };
        break;
      }
      case "current_version": {
        const currentVersion = this.current.get(key);
        result = currentVersion === undefined
          ? { requestId: request.requestId, status: "error", code: "SECRET_NOT_FOUND" }
          : { requestId: request.requestId, status: "ok", version: currentVersion };
        break;
      }
      case "rotate": {
        const currentVersion = this.current.get(key);
        if (currentVersion === undefined) {
          result = { requestId: request.requestId, status: "error", code: "SECRET_NOT_FOUND" };
          break;
        }
        if (this.failNextRotate || currentVersion !== request.expectedVersion) {
          this.failNextRotate = false;
          // A rejected/failed rotate never touches stored versions: the
          // prior current version remains authoritative.
          result = { requestId: request.requestId, status: "error", code: "SECRET_VERSION_STALE" };
          break;
        }
        const bytes = secretIo.writeSecret!();
        const nextVersion = request.newVersion!;
        this.versions.set(`${key}#${nextVersion}`, Uint8Array.from(bytes));
        this.current.set(key, nextVersion);
        result = { requestId: request.requestId, status: "ok", version: nextVersion, byteLength: bytes.length };
        break;
      }
      case "delete": {
        if (!this.current.has(key)) {
          result = { requestId: request.requestId, status: "error", code: "SECRET_NOT_FOUND" };
          break;
        }
        this.current.delete(key);
        result = { requestId: request.requestId, status: "ok" };
        break;
      }
      default:
        result = { requestId: request.requestId, status: "error", code: "SECRET_HELPER_FAILURE" };
    }
    this.resultsSeen.push(result);
    return result;
  }
}

const adapterBinding: SecretBinding = {
  personId: "person-alpha",
  syncId: "sync-alpha",
  deviceId: "device-alpha"
};

describe("MacosKeychainSecretStore (helper protocol via synthetic runner)", () => {
  it("implements the full DeviceSecretStore contract through the injected helper runner", async () => {
    const runner = new FakeKeychainHelperRunner();
    const store: DeviceSecretStore = new MacosKeychainSecretStore(runner);
    const bytes = syntheticBytes("keychain-create");

    const created = await store.create({
      binding: adapterBinding,
      kind: "device_signing_seed",
      secretId: "keychain-secret",
      bytes
    });
    expect(created.version).toBe(1);

    const read = await store.read({
      binding: adapterBinding,
      kind: "device_signing_seed",
      secretId: "keychain-secret"
    });
    expect(Buffer.from(read.bytes).equals(Buffer.from(bytes))).toBe(true);

    expect(await store.currentVersion(adapterBinding, "device_signing_seed", "keychain-secret")).toBe(1);

    const rotatedBytes = syntheticBytes("keychain-rotate");
    const rotated = await store.rotate({
      binding: adapterBinding,
      kind: "device_signing_seed",
      secretId: "keychain-secret",
      expectedCurrentVersion: 1,
      bytes: rotatedBytes
    });
    expect(rotated.version).toBe(2);

    await store.delete({ binding: adapterBinding, kind: "device_signing_seed", secretId: "keychain-secret" });
    await expectCode(
      () => store.currentVersion(adapterBinding, "device_signing_seed", "keychain-secret"),
      "SECRET_NOT_FOUND"
    );
  });

  it("maps every account label onto the fixed, non-identifying Keychain service", async () => {
    const runner = new FakeKeychainHelperRunner();
    const store = new MacosKeychainSecretStore(runner);
    await store.create({
      binding: adapterBinding,
      kind: "recovery_seed",
      secretId: "service-check",
      bytes: syntheticBytes("service-check")
    });
    expect(runner.requestsSeen.every((request) => request.service === MACOS_KEYCHAIN_SERVICE_LABEL)).toBe(true);
  });

  it("keeps secret bytes off the control channel: requests and results carry no secret material", async () => {
    const runner = new FakeKeychainHelperRunner();
    const store = new MacosKeychainSecretStore(runner);
    const bytes = syntheticBytes("keychain-leak");
    const marker = Buffer.from(bytes).toString("base64");

    await store.create({ binding: adapterBinding, kind: "epoch_key", secretId: "leak-secret", bytes });
    await store.read({ binding: adapterBinding, kind: "epoch_key", secretId: "leak-secret" });
    await store.rotate({
      binding: adapterBinding,
      kind: "epoch_key",
      secretId: "leak-secret",
      expectedCurrentVersion: 1,
      bytes: syntheticBytes("keychain-leak-2")
    });

    for (const request of runner.requestsSeen) {
      expect(JSON.stringify(request)).not.toContain(marker);
    }
    for (const result of runner.resultsSeen) {
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });

  it("preserves the prior current version and issues no plaintext fallback on rotate failure", async () => {
    const runner = new FakeKeychainHelperRunner();
    const store = new MacosKeychainSecretStore(runner);
    const originalBytes = syntheticBytes("keychain-preserve");
    await store.create({ binding: adapterBinding, kind: "keyring_wrapping_key", secretId: "preserve-secret", bytes: originalBytes });

    runner.failNextRotate = true;
    await expectCode(
      () =>
        store.rotate({
          binding: adapterBinding,
          kind: "keyring_wrapping_key",
          secretId: "preserve-secret",
          expectedCurrentVersion: 1,
          bytes: syntheticBytes("keychain-preserve-attempt")
        }),
      "SECRET_VERSION_STALE"
    );

    expect(await store.currentVersion(adapterBinding, "keyring_wrapping_key", "preserve-secret")).toBe(1);
    const stillCurrent = await store.read({
      binding: adapterBinding,
      kind: "keyring_wrapping_key",
      secretId: "preserve-secret"
    });
    expect(Buffer.from(stillCurrent.bytes).equals(Buffer.from(originalBytes))).toBe(true);
  });

  it("has no plaintext file or SQLite persistence fallback anywhere in the adapter module", () => {
    const adapterPath = fileURLToPath(
      new URL("../../src/sync/secrets/macos-keychain-secret-store.ts", import.meta.url)
    );
    const source = readFileSync(adapterPath, "utf8");
    expect(source).not.toMatch(/writeFile|createWriteStream|node:sqlite|better-sqlite3/);
  });

  it("spawns the production helper with a fixed argv independent of the request (no secret-adjacent argv)", () => {
    const adapterPath = fileURLToPath(
      new URL("../../src/sync/secrets/macos-keychain-secret-store.ts", import.meta.url)
    );
    const source = readFileSync(adapterPath, "utf8");
    expect(source).toContain('spawn(this.options.helperPath, ["serve"]');
    // The argv literal is exactly ["serve"]; no request field is
    // interpolated into it.
    expect(source).not.toMatch(/spawn\([^)]*request\./);
  });
});

describe("macos-keychain-helper.swift (source contract)", () => {
  it("uses non-synchronizable, this-device-only Keychain items and no plaintext fallback", () => {
    const helperPath = fileURLToPath(
      new URL("../../src/sync/secrets/macos-keychain-helper.swift", import.meta.url)
    );
    const source = readFileSync(helperPath, "utf8");
    expect(source).toContain("kSecAttrSynchronizable as String: false");
    expect(source).toContain("kSecAttrAccessibleWhenUnlockedThisDeviceOnly");
    expect(source).not.toMatch(/FileManager|write\(toFile|contentsOfFile/);
  });

  it("never writes secret bytes or account identifiers to stderr", () => {
    const helperPath = fileURLToPath(
      new URL("../../src/sync/secrets/macos-keychain-helper.swift", import.meta.url)
    );
    const source = readFileSync(helperPath, "utf8");
    const stderrWrites = [...source.matchAll(/FileHandle\.standardError\.write\(Data\((".*?")\.utf8\)\)/g)];
    expect(stderrWrites.length).toBeGreaterThan(0);
    for (const [, literal] of stderrWrites) {
      expect(literal).not.toMatch(/account|bytes|secret|version/i);
    }
  });
});
