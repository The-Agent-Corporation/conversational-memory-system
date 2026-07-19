/**
 * Host-neutral retention boundary for production device secrets: device
 * signing/wrapping seeds, the recovery seed, the keyring-wrapping key, and
 * epoch keys (ADR 0047). Every method is byte-oriented and binding-scoped;
 * no implementation may accept or return an arbitrary serialized record,
 * and no adapter may fall back to ordinary SQLite, config, or plaintext
 * file persistence when the backing OS secret store is unavailable.
 */

export type SecretKind =
  | "device_signing_seed"
  | "device_wrapping_seed"
  | "recovery_seed"
  | "keyring_wrapping_key"
  | "epoch_key";

/**
 * Opaque, person/sync/device bound binding checked on every operation.
 * `deviceId` scopes device-owned seeds; `epoch` scopes epoch keys. Bindings
 * are immutable once a secret is created and are never used as a lookup
 * shortcut in place of the exact stored binding comparison.
 */
export interface SecretBinding {
  readonly personId: string;
  readonly syncId: string;
  readonly deviceId?: string;
  readonly epoch?: number;
}

export type DeviceSecretErrorCode =
  | "SECRET_NOT_FOUND"
  | "SECRET_ALREADY_EXISTS"
  | "SECRET_VERSION_STALE"
  | "SECRET_VERSION_NOT_FOUND"
  | "SECRET_BINDING_MISMATCH"
  | "SECRET_HELPER_FAILURE"
  | "SECRET_INTERNAL";

/** Content-free secret-store failure. Never carries secret material. */
export class DeviceSecretError extends Error {
  constructor(readonly code: DeviceSecretErrorCode, message: string = code) {
    super(message);
    this.name = "DeviceSecretError";
  }
}

export interface CreateSecretInput {
  readonly binding: SecretBinding;
  readonly kind: SecretKind;
  /** Caller-issued opaque identifier. Non-reassignable once created. */
  readonly secretId: string;
  readonly bytes: Uint8Array;
}

export interface ReadSecretInput {
  readonly binding: SecretBinding;
  readonly kind: SecretKind;
  readonly secretId: string;
  /** Omit to read the current version. */
  readonly expectedVersion?: number;
}

export interface RotateSecretInput {
  readonly binding: SecretBinding;
  readonly kind: SecretKind;
  readonly secretId: string;
  readonly expectedCurrentVersion: number;
  readonly bytes: Uint8Array;
}

export interface DeleteSecretInput {
  readonly binding: SecretBinding;
  readonly kind: SecretKind;
  readonly secretId: string;
}

export interface SecretVersionHandle {
  readonly secretId: string;
  readonly kind: SecretKind;
  readonly version: number;
  /** Defensive copy; mutating it never affects stored state. */
  readonly bytes: Uint8Array;
}

/**
 * Byte-oriented device secret retention contract. Implementations MUST
 * treat `bytes` as opaque, return defensive copies, enforce exact binding
 * equality, and enforce expected-version checks atomically on rotation.
 */
export interface DeviceSecretStore {
  create(input: CreateSecretInput): Promise<SecretVersionHandle>;
  read(input: ReadSecretInput): Promise<SecretVersionHandle>;
  currentVersion(binding: SecretBinding, kind: SecretKind, secretId: string): Promise<number>;
  rotate(input: RotateSecretInput): Promise<SecretVersionHandle>;
  delete(input: DeleteSecretInput): Promise<void>;
}
