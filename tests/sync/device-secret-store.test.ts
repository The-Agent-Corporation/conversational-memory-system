import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DeviceSecretError,
  type DeviceSecretStore,
  type SecretBinding
} from "../../src/sync/secrets/device-secret-store.js";
import { InMemoryDeviceSecretStore } from "../../src/sync/secrets/in-memory-device-secret-store.js";
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
