import {
  DeviceSecretError,
  type CreateSecretInput,
  type DeleteSecretInput,
  type DeviceSecretStore,
  type ReadSecretInput,
  type RotateSecretInput,
  type SecretBinding,
  type SecretKind,
  type SecretVersionHandle
} from "./device-secret-store.js";

interface FaultInjector {
  reach(boundary: string): void;
}

interface StoredVersion {
  readonly version: number;
  bytes: Uint8Array;
}

interface StoredSecret {
  readonly binding: SecretBinding;
  readonly kind: SecretKind;
  readonly versions: Map<number, StoredVersion>;
  currentVersion: number;
}

export interface InMemoryDeviceSecretStoreOptions {
  readonly faultInjector?: FaultInjector;
}

const storageKey = (kind: SecretKind, secretId: string): string => `${kind}:${secretId}`;

const sameBinding = (stored: SecretBinding, supplied: SecretBinding): boolean =>
  stored.personId === supplied.personId &&
  stored.syncId === supplied.syncId &&
  (stored.deviceId ?? null) === (supplied.deviceId ?? null) &&
  (stored.epoch ?? null) === (supplied.epoch ?? null);

const copyBytes = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes);

const zeroBytes = (bytes: Uint8Array): void => {
  bytes.fill(0);
};

/**
 * Deterministic, synthetic-bytes-only `DeviceSecretStore` for tests. This
 * adapter MUST NOT be selected by production configuration: it retains
 * secrets as ordinary process-heap `Uint8Array`s with no OS-backed
 * protection.
 */
export class InMemoryDeviceSecretStore implements DeviceSecretStore {
  private readonly secrets = new Map<string, StoredSecret>();
  private readonly faultInjector?: FaultInjector;

  constructor(options: InMemoryDeviceSecretStoreOptions = {}) {
    this.faultInjector = options.faultInjector;
  }

  async create(input: CreateSecretInput): Promise<SecretVersionHandle> {
    this.faultInjector?.reach("in-memory-device-secret-store:before-create");
    const key = storageKey(input.kind, input.secretId);
    if (this.secrets.has(key)) {
      throw new DeviceSecretError("SECRET_ALREADY_EXISTS");
    }
    const versions = new Map<number, StoredVersion>();
    versions.set(1, { version: 1, bytes: copyBytes(input.bytes) });
    this.secrets.set(key, {
      binding: { ...input.binding },
      kind: input.kind,
      versions,
      currentVersion: 1
    });
    return this.handle(input.secretId, input.kind, 1, versions.get(1)!.bytes);
  }

  async read(input: ReadSecretInput): Promise<SecretVersionHandle> {
    this.faultInjector?.reach("in-memory-device-secret-store:before-read");
    const stored = this.lookup(input.kind, input.secretId, input.binding);
    const version = input.expectedVersion ?? stored.currentVersion;
    const record = stored.versions.get(version);
    if (!record) throw new DeviceSecretError("SECRET_VERSION_NOT_FOUND");
    return this.handle(input.secretId, input.kind, record.version, record.bytes);
  }

  async currentVersion(binding: SecretBinding, kind: SecretKind, secretId: string): Promise<number> {
    return this.lookup(kind, secretId, binding).currentVersion;
  }

  async rotate(input: RotateSecretInput): Promise<SecretVersionHandle> {
    const stored = this.lookup(input.kind, input.secretId, input.binding);
    if (stored.currentVersion !== input.expectedCurrentVersion) {
      throw new DeviceSecretError("SECRET_VERSION_STALE");
    }
    this.faultInjector?.reach("in-memory-device-secret-store:before-rotate-commit");
    const nextVersion = stored.currentVersion + 1;
    const bytes = copyBytes(input.bytes);
    stored.versions.set(nextVersion, { version: nextVersion, bytes });
    stored.currentVersion = nextVersion;
    return this.handle(input.secretId, input.kind, nextVersion, bytes);
  }

  async delete(input: DeleteSecretInput): Promise<void> {
    this.faultInjector?.reach("in-memory-device-secret-store:before-delete");
    const key = storageKey(input.kind, input.secretId);
    const stored = this.secrets.get(key);
    if (!stored) throw new DeviceSecretError("SECRET_NOT_FOUND");
    if (!sameBinding(stored.binding, input.binding)) {
      throw new DeviceSecretError("SECRET_BINDING_MISMATCH");
    }
    for (const version of stored.versions.values()) {
      zeroBytes(version.bytes);
    }
    stored.versions.clear();
    this.secrets.delete(key);
  }

  private lookup(kind: SecretKind, secretId: string, binding: SecretBinding): StoredSecret {
    const stored = this.secrets.get(storageKey(kind, secretId));
    if (!stored) throw new DeviceSecretError("SECRET_NOT_FOUND");
    if (!sameBinding(stored.binding, binding)) {
      throw new DeviceSecretError("SECRET_BINDING_MISMATCH");
    }
    return stored;
  }

  private handle(secretId: string, kind: SecretKind, version: number, bytes: Uint8Array): SecretVersionHandle {
    return { secretId, kind, version, bytes: copyBytes(bytes) };
  }
}
