import canonicalize from "canonicalize";
import sodium from "libsodium-wrappers-sumo";
import {
  ENVELOPE_AAD_DOMAIN,
  ENVELOPE_SIGNATURE_DOMAIN,
  EncryptedSyncEnvelopeHeaderSchema,
  EncryptedSyncEnvelopeSchema,
  MAX_CIPHERTEXT_LENGTH,
  PlainSyncOperationSchema,
  SyncProtocolError,
  type EncryptedSyncEnvelope,
  type EncryptedSyncEnvelopeHeader,
  type PlainSyncOperation
} from "../domain/types.js";
import type {
  Argon2idParameters,
  CryptoKeyPair,
  CryptoProvider,
  PassphraseWrappedPackage
} from "./crypto-provider.js";

const AEAD_KEY_BYTES = 32;
const AEAD_NONCE_BYTES = 24;
const AEAD_TAG_BYTES = 16;
const LENGTH_PREFIX_BYTES = 4;
const PADDING_BUCKET_BYTES = 4_096;
const GENERIC_HASH_BYTES = 32;
const ARGON2ID_ALGORITHM = 2; // crypto_pwhash_ALG_ARGON2ID13 (fixed by ADR 0047; not read from sodium constants to avoid a version-drift surprise)

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/**
 * Encodes an RFC 8785 canonical JSON value as UTF-8 bytes. Throws
 * `SYNC_SCHEMA_INVALID` on non-I-JSON input (NaN, Infinity, cycles, etc.)
 * rather than propagating an uncontrolled error.
 */
function canonicalBytesOf(value: unknown): Uint8Array {
  const text = canonicalize(value);
  if (text === undefined) {
    throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
  }
  return new TextEncoder().encode(text);
}

/**
 * Approved libsodium implementation of the protocol-v1 cryptography
 * boundary. Every randomness-consuming method draws from
 * `sodium.randombytes_buf`; there is no seed or deterministic-nonce
 * parameter anywhere on this class.
 */
export class LibsodiumCryptoProvider implements CryptoProvider {
  async ready(): Promise<void> {
    await sodium.ready;
  }

  randomBytes(byteLength: number): Uint8Array {
    return sodium.randombytes_buf(byteLength);
  }

  canonicalBytes(value: unknown): Uint8Array {
    return canonicalBytesOf(value);
  }

  hash(message: Uint8Array): Uint8Array {
    return sodium.crypto_generichash(GENERIC_HASH_BYTES, message, null);
  }

  generateSigningKeyPair(): CryptoKeyPair {
    const pair = sodium.crypto_sign_keypair();
    return { publicKey: pair.publicKey, secretKey: pair.privateKey };
  }

  generateWrappingKeyPair(): CryptoKeyPair {
    const pair = sodium.crypto_box_keypair();
    return { publicKey: pair.publicKey, secretKey: pair.privateKey };
  }

  generateSigningKeyPairFromSeed(seed: Uint8Array): CryptoKeyPair {
    if (seed.length !== 32) throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
    const pair = sodium.crypto_sign_seed_keypair(seed);
    return { publicKey: pair.publicKey, secretKey: pair.privateKey };
  }

  generateWrappingKeyPairFromSeed(seed: Uint8Array): CryptoKeyPair {
    if (seed.length !== 32) throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
    const pair = sodium.crypto_box_seed_keypair(seed);
    return { publicKey: pair.publicKey, secretKey: pair.privateKey };
  }

  sign(secretKey: Uint8Array, message: Uint8Array): Uint8Array {
    return sodium.crypto_sign_detached(message, secretKey);
  }

  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
    try {
      return sodium.crypto_sign_verify_detached(signature, message, publicKey);
    } catch {
      return false;
    }
  }

  aeadSeal(key: Uint8Array, nonce: Uint8Array, associatedData: Uint8Array, plaintext: Uint8Array): Uint8Array {
    return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, associatedData, null, nonce, key);
  }

  aeadOpen(key: Uint8Array, nonce: Uint8Array, associatedData: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, associatedData, nonce, key);
    } catch {
      throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
    }
  }

  sealedBox(recipientPublicKey: Uint8Array, message: Uint8Array): Uint8Array {
    return sodium.crypto_box_seal(message, recipientPublicKey);
  }

  openSealedBox(recipientPublicKey: Uint8Array, recipientSecretKey: Uint8Array, sealed: Uint8Array): Uint8Array {
    try {
      return sodium.crypto_box_seal_open(sealed, recipientPublicKey, recipientSecretKey);
    } catch {
      throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
    }
  }

  box(senderSecretKey: Uint8Array, recipientPublicKey: Uint8Array, nonce: Uint8Array, message: Uint8Array): Uint8Array {
    return sodium.crypto_box_easy(message, nonce, recipientPublicKey, senderSecretKey);
  }

  openBox(recipientSecretKey: Uint8Array, senderPublicKey: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    try {
      return sodium.crypto_box_open_easy(ciphertext, nonce, senderPublicKey, recipientSecretKey);
    } catch {
      throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
    }
  }

  deriveSubkey(masterKey: Uint8Array, subkeyId: number, context: string, subkeyByteLength: number): Uint8Array {
    if (context.length !== 8) {
      throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
    }
    return sodium.crypto_kdf_derive_from_key(subkeyByteLength, subkeyId, context, masterKey);
  }

  wrapWithPassphrase(passphrase: string, plaintext: Uint8Array, parameters: Argon2idParameters): PassphraseWrappedPackage {
    const key = sodium.crypto_pwhash(
      AEAD_KEY_BYTES,
      passphrase,
      parameters.salt,
      parameters.opsLimit,
      parameters.memLimit,
      ARGON2ID_ALGORITHM
    );
    const nonce = this.randomBytes(AEAD_NONCE_BYTES);
    try {
      const ciphertext = this.aeadSeal(key, nonce, this.canonicalPassphraseHeader(parameters, nonce), plaintext);
      return {
        algorithm: "argon2id",
        opsLimit: parameters.opsLimit,
        memLimit: parameters.memLimit,
        salt: parameters.salt,
        nonce,
        ciphertext
      };
    } finally {
      this.zero(key);
    }
  }

  unwrapWithPassphrase(passphrase: string, packageValue: PassphraseWrappedPackage): Uint8Array {
    const key = sodium.crypto_pwhash(
      AEAD_KEY_BYTES,
      passphrase,
      packageValue.salt,
      packageValue.opsLimit,
      packageValue.memLimit,
      ARGON2ID_ALGORITHM
    );
    try {
      const aad = this.canonicalPassphraseHeader(
        { opsLimit: packageValue.opsLimit, memLimit: packageValue.memLimit, salt: packageValue.salt },
        packageValue.nonce
      );
      return this.aeadOpen(key, packageValue.nonce, aad, packageValue.ciphertext);
    } catch {
      throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
    } finally {
      this.zero(key);
    }
  }

  private canonicalPassphraseHeader(parameters: Pick<Argon2idParameters, "opsLimit" | "memLimit" | "salt">, nonce: Uint8Array): Uint8Array {
    return this.canonicalBytes({
      domain: "cms.sync.v1/passphrase-package",
      opsLimit: parameters.opsLimit,
      memLimit: parameters.memLimit,
      salt: toBase64Url(parameters.salt),
      nonce: toBase64Url(nonce)
    });
  }

  constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    return sodium.memcmp(left, right);
  }

  zero(buffer: Uint8Array): void {
    sodium.memzero(buffer);
  }
}

// ---------------------------------------------------------------------------
// Protocol-v1 envelope composition (ADR 0047 "Operation envelope")
// ---------------------------------------------------------------------------

export interface SealSyncEnvelopeInput {
  header: Omit<EncryptedSyncEnvelopeHeader, "ciphertextLength">;
  operation: PlainSyncOperation;
  aeadKey: Uint8Array;
  signingSecretKey: Uint8Array;
}

function paddedCiphertextLength(operationByteLength: number): number {
  const unpaddedCiphertextLength = LENGTH_PREFIX_BYTES + operationByteLength + AEAD_TAG_BYTES;
  if (unpaddedCiphertextLength > MAX_CIPHERTEXT_LENGTH) {
    throw new SyncProtocolError("SYNC_LIMIT_EXCEEDED");
  }
  return Math.ceil(unpaddedCiphertextLength / PADDING_BUCKET_BYTES) * PADDING_BUCKET_BYTES;
}

/**
 * Seals a plain sync operation into a protocol-v1 envelope. Always draws a
 * fresh 192-bit nonce from `provider.randomBytes`; there is no way to pass a
 * caller-selected nonce through this function.
 */
export function sealSyncEnvelope(provider: CryptoProvider, input: SealSyncEnvelopeInput): EncryptedSyncEnvelope {
  if (input.operation.originDeviceId !== input.header.deviceId || input.operation.originSequence !== input.header.sequence) {
    throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
  }

  const operationBytes = provider.canonicalBytes(input.operation);
  const ciphertextLength = paddedCiphertextLength(operationBytes.length);
  const paddedPlaintextLength = ciphertextLength - AEAD_TAG_BYTES;
  const paddingLength = paddedPlaintextLength - LENGTH_PREFIX_BYTES - operationBytes.length;

  const plaintext = new Uint8Array(paddedPlaintextLength);
  new DataView(plaintext.buffer).setUint32(0, operationBytes.length, false);
  plaintext.set(operationBytes, LENGTH_PREFIX_BYTES);
  if (paddingLength > 0) {
    plaintext.set(provider.randomBytes(paddingLength), LENGTH_PREFIX_BYTES + operationBytes.length);
  }

  const header: EncryptedSyncEnvelopeHeader = EncryptedSyncEnvelopeHeaderSchema.parse({
    ...input.header,
    ciphertextLength
  });

  const nonce = provider.randomBytes(AEAD_NONCE_BYTES);
  const aad = provider.canonicalBytes({ domain: ENVELOPE_AAD_DOMAIN, header });
  const ciphertext = provider.aeadSeal(input.aeadKey, nonce, aad, plaintext);
  const ciphertextDigest = provider.hash(ciphertext);
  const signaturePreimage = provider.canonicalBytes({
    ciphertextDigest: toBase64Url(ciphertextDigest),
    domain: ENVELOPE_SIGNATURE_DOMAIN,
    header,
    nonce: toBase64Url(nonce)
  });
  const signature = provider.sign(input.signingSecretKey, signaturePreimage);

  return EncryptedSyncEnvelopeSchema.parse({
    header,
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext),
    ciphertextDigest: toBase64Url(ciphertextDigest),
    signature: toBase64Url(signature)
  });
}

export interface OpenSyncEnvelopeInput {
  envelope: unknown;
  aeadKey: Uint8Array;
  verifyingKey: Uint8Array;
}

export interface OpenedSyncEnvelope {
  header: EncryptedSyncEnvelopeHeader;
  operation: PlainSyncOperation;
}

/**
 * Opens and fully authenticates a protocol-v1 envelope. Authorization
 * (schema), digest, and signature are verified before any AEAD or plaintext
 * parsing work; plaintext is parsed only after AEAD authentication succeeds.
 * Every failure path is a stable content-free `SyncProtocolError`.
 */
export function openSyncEnvelope(provider: CryptoProvider, input: OpenSyncEnvelopeInput): OpenedSyncEnvelope {
  const parsed = EncryptedSyncEnvelopeSchema.safeParse(input.envelope);
  if (!parsed.success) {
    throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
  }
  const envelope = parsed.data;

  const ciphertext = fromBase64Url(envelope.ciphertext);
  const nonce = fromBase64Url(envelope.nonce);
  const signature = fromBase64Url(envelope.signature);
  const claimedDigest = fromBase64Url(envelope.ciphertextDigest);

  const actualDigest = provider.hash(ciphertext);
  if (!provider.constantTimeEqual(actualDigest, claimedDigest)) {
    throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
  }

  const signaturePreimage = provider.canonicalBytes({
    ciphertextDigest: envelope.ciphertextDigest,
    domain: ENVELOPE_SIGNATURE_DOMAIN,
    header: envelope.header,
    nonce: envelope.nonce
  });
  if (!provider.verify(input.verifyingKey, signaturePreimage, signature)) {
    throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
  }

  const aad = provider.canonicalBytes({ domain: ENVELOPE_AAD_DOMAIN, header: envelope.header });
  let plaintext: Uint8Array;
  try {
    plaintext = provider.aeadOpen(input.aeadKey, nonce, aad, ciphertext);
  } catch {
    throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
  }

  if (plaintext.length < LENGTH_PREFIX_BYTES) {
    throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
  }
  const operationByteLength = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength).getUint32(0, false);
  if (operationByteLength > plaintext.length - LENGTH_PREFIX_BYTES) {
    throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
  }
  const operationBytes = plaintext.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + operationByteLength);

  let operationValue: unknown;
  try {
    operationValue = JSON.parse(new TextDecoder().decode(operationBytes));
  } catch {
    throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
  }
  const recanonicalized = provider.canonicalBytes(operationValue);
  if (!provider.constantTimeEqual(recanonicalized, operationBytes)) {
    throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
  }

  const operationResult = PlainSyncOperationSchema.safeParse(operationValue);
  if (!operationResult.success) {
    throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
  }
  const operation = operationResult.data;

  if (
    operation.originDeviceId !== envelope.header.deviceId ||
    operation.originSequence !== envelope.header.sequence ||
    operation.protocol !== envelope.header.protocol
  ) {
    throw new SyncProtocolError("SYNC_INTEGRITY_FAILED");
  }

  return { header: envelope.header, operation };
}
