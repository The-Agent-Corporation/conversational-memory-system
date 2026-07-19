/**
 * Narrow byte-oriented cryptography boundary for CMS Sync Protocol v1
 * (ADR 0047). Every method operates on raw bytes only; no method knows about
 * envelopes, operations, or wire schemas. The production implementation
 * (`LibsodiumCryptoProvider`) exposes no deterministic-randomness option:
 * every method that needs randomness draws it from `randomBytes`, which is
 * OS/libsodium-backed in production. Deterministic keys and nonces exist
 * only in synthetic test fixtures, constructed independently of this
 * interface (see `tests/sync/fixtures.ts`).
 */

export interface CryptoKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface Argon2idParameters {
  /** libsodium `opslimit`. */
  opsLimit: number;
  /** libsodium `memlimit` in bytes. */
  memLimit: number;
  /** Salt bytes (`crypto_pwhash_SALTBYTES`). */
  salt: Uint8Array;
}

export interface PassphraseWrappedPackage {
  algorithm: "argon2id";
  opsLimit: number;
  memLimit: number;
  salt: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export interface CryptoProvider {
  /** Resolves once the underlying primitive library has finished loading. */
  ready(): Promise<void>;

  /** Cryptographically secure random bytes of the requested length. */
  randomBytes(byteLength: number): Uint8Array;

  /** RFC 8785 (JCS) canonical UTF-8 bytes for a strict I-JSON value. */
  canonicalBytes(value: unknown): Uint8Array;

  /** 32-byte libsodium generic hash (BLAKE2b) of `message`. */
  hash(message: Uint8Array): Uint8Array;

  /** Generates a fresh random Ed25519 signing keypair. No seed parameter. */
  generateSigningKeyPair(): CryptoKeyPair;

  /** Generates a fresh random X25519 keypair for box/seal wrapping. No seed parameter. */
  generateWrappingKeyPair(): CryptoKeyPair;

  /**
   * Deterministically derives an Ed25519 keypair from a 32-byte seed.
   * Production callers MUST only pass a seed already produced by
   * `deriveSubkey` from a random recovery seed (ADR 0047 "Recovery
   * derivation", context `CMSRSIG1`) - this is the sole sanctioned seeded
   * key-generation path and exists only for recovery-credential derivation,
   * never for ordinary device keys.
   */
  generateSigningKeyPairFromSeed(seed: Uint8Array): CryptoKeyPair;

  /**
   * Deterministically derives an X25519 keypair from a 32-byte seed
   * (ADR 0047 "Recovery derivation", context `CMSRBOX1`). Sole sanctioned
   * seeded key-generation path for recovery-credential wrapping keys.
   */
  generateWrappingKeyPairFromSeed(seed: Uint8Array): CryptoKeyPair;

  /** Detached Ed25519 signature over `message`. Deterministic given (secretKey, message); no internal randomness. */
  sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array;

  /** Verifies a detached Ed25519 signature. Returns false rather than throwing on any mismatch. */
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;

  /**
   * XChaCha20-Poly1305-IETF AEAD seal. Caller supplies the nonce; callers
   * that need production freshness MUST draw it from `randomBytes(24)`
   * immediately before sealing and MUST NOT reuse a nonce for a given key.
   */
  aeadSeal(key: Uint8Array, nonce: Uint8Array, associatedData: Uint8Array, plaintext: Uint8Array): Uint8Array;

  /** XChaCha20-Poly1305-IETF AEAD open. Throws on any authentication failure; never returns partial plaintext. */
  aeadOpen(key: Uint8Array, nonce: Uint8Array, associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array;

  /** Anonymous X25519 sealed box (`crypto_box_seal`): sender identity is not authenticated. */
  sealedBox(recipientPublicKey: Uint8Array, message: Uint8Array): Uint8Array;

  /** Opens an anonymous X25519 sealed box. Throws on authentication failure. */
  openSealedBox(recipientPublicKey: Uint8Array, recipientSecretKey: Uint8Array, sealed: Uint8Array): Uint8Array;

  /** Authenticated X25519 `crypto_box` for device-to-device key package wrapping. */
  box(senderSecretKey: Uint8Array, recipientPublicKey: Uint8Array, nonce: Uint8Array, message: Uint8Array): Uint8Array;

  /** Opens an authenticated X25519 `crypto_box`. Throws on authentication failure. */
  openBox(recipientSecretKey: Uint8Array, senderPublicKey: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array;

  /** Domain-separated subkey derivation (`crypto_kdf_derive_from_key`). `context` MUST be exactly 8 ASCII characters. */
  deriveSubkey(masterKey: Uint8Array, subkeyId: number, context: string, subkeyByteLength: number): Uint8Array;

  /** Wraps `plaintext` (typically a recovery seed) with an Argon2id-derived key. Parameters MUST meet the reviewed floor. */
  wrapWithPassphrase(passphrase: string, plaintext: Uint8Array, parameters: Argon2idParameters): PassphraseWrappedPackage;

  /** Unwraps a passphrase package. Throws a single uniform failure; never reveals which check failed. */
  unwrapWithPassphrase(passphrase: string, packageValue: PassphraseWrappedPackage): Uint8Array;

  /** Constant-time byte comparison. */
  constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean;

  /** Best-effort in-place secret zeroization. Not a guarantee against a compacting/copying runtime. */
  zero(buffer: Uint8Array): void;
}

/** Reviewed floor for optional passphrase recovery packages (ADR 0047 "Optional passphrase recovery package"). */
export const ARGON2ID_REVIEWED_FLOOR = {
  opsLimit: 3,
  memLimit: 268_435_456 // 256 MiB
} as const;
