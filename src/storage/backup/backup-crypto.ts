import sodium from "libsodium-wrappers-sumo";
import { z } from "zod";
import type { CryptoProvider } from "../../sync/crypto/crypto-provider.js";
import { ARGON2ID_REVIEWED_FLOOR } from "../../sync/crypto/crypto-provider.js";

/**
 * Backup-specific Argon2id + AEAD envelope (D-07, ADR 0047 domain
 * separation). This module composes ONLY the low-level `CryptoProvider`
 * primitives (`randomBytes`, `aeadSeal`, `aeadOpen`, `canonicalBytes`,
 * `zero`) plus a local Argon2id key derivation. It MUST NEVER import the
 * sync-domain passphrase wrap/unwrap helpers from
 * `../../sync/crypto/libsodium-crypto-provider.js` — those are bound to the
 * `cms.sync.v1/passphrase-package` domain and typed around a fixed 32-byte
 * recovery seed. Reusing them here would make a backup file cryptographically
 * interchangeable with a sync passphrase-recovery package, which ADR 0047
 * forbids (07-RESEARCH.md Pitfall 1).
 */

const BACKUP_PASSPHRASE_DOMAIN = "cms.backup.v1/passphrase-package";
const AEAD_KEY_BYTES = 32;
const AEAD_NONCE_BYTES = 24;
const ARGON2ID_SALT_BYTES = 16; // crypto_pwhash_SALTBYTES
// crypto_pwhash_ALG_ARGON2ID13 — fixed by ADR 0047, mirrored verbatim from
// libsodium-crypto-provider.ts rather than read off `sodium` constants, to
// avoid a version-drift surprise.
const ARGON2ID_ALGORITHM = 2;

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export const BackupEnvelopeSchema = z
  .object({
    domain: z.literal(BACKUP_PASSPHRASE_DOMAIN),
    opsLimit: z.number().int().positive(),
    memLimit: z.number().int().positive(),
    salt: z.string().min(1).max(1_024),
    nonce: z.string().min(1).max(1_024),
    ciphertext: z.string().min(1).max(2_000_000_000),
    schemaVersion: z.number().int().nonnegative(),
    createdAt: z.string().min(1).max(64)
  })
  .strict();

export type BackupEnvelope = z.infer<typeof BackupEnvelopeSchema>;

/**
 * Single uniform failure for any decrypt-time problem (malformed envelope,
 * below-floor Argon2id parameters, wrong passphrase, tampered ciphertext).
 * Never distinguishes which check failed (mirrors `SYNC_INTEGRITY_FAILED`
 * discipline in `libsodium-crypto-provider.ts:177-209`).
 */
export class BackupIntegrityError extends Error {
  constructor() {
    super("BACKUP_INTEGRITY_FAILED");
    this.name = "BackupIntegrityError";
  }
}

function deriveArgon2idKey(passphrase: string, salt: Uint8Array, opsLimit: number, memLimit: number): Uint8Array {
  return sodium.crypto_pwhash(AEAD_KEY_BYTES, passphrase, salt, opsLimit, memLimit, ARGON2ID_ALGORITHM);
}

function canonicalHeader(
  provider: CryptoProvider,
  parameters: { opsLimit: number; memLimit: number; salt: string; nonce: string; schemaVersion: number }
): Uint8Array {
  return provider.canonicalBytes({ domain: BACKUP_PASSPHRASE_DOMAIN, ...parameters });
}

/**
 * Seals `plaintext` (a full logical database dump) under a backup-specific
 * Argon2id-derived key at the reviewed floor. Always draws a fresh salt and
 * nonce from `provider.randomBytes`.
 */
export function sealBackup(
  provider: CryptoProvider,
  passphrase: string,
  plaintext: Uint8Array,
  schemaVersion: number,
  now: string
): BackupEnvelope {
  const salt = provider.randomBytes(ARGON2ID_SALT_BYTES);
  const { opsLimit, memLimit } = ARGON2ID_REVIEWED_FLOOR;
  const key = deriveArgon2idKey(passphrase, salt, opsLimit, memLimit);
  try {
    const nonce = provider.randomBytes(AEAD_NONCE_BYTES);
    const saltEncoded = toBase64Url(salt);
    const nonceEncoded = toBase64Url(nonce);
    const aad = canonicalHeader(provider, { opsLimit, memLimit, salt: saltEncoded, nonce: nonceEncoded, schemaVersion });
    const ciphertext = provider.aeadSeal(key, nonce, aad, plaintext);
    return BackupEnvelopeSchema.parse({
      domain: BACKUP_PASSPHRASE_DOMAIN,
      opsLimit,
      memLimit,
      salt: saltEncoded,
      nonce: nonceEncoded,
      ciphertext: toBase64Url(ciphertext),
      schemaVersion,
      createdAt: now
    });
  } finally {
    provider.zero(key);
  }
}

/**
 * Opens a backup envelope. Rejects below-reviewed-floor Argon2id parameters
 * before deriving any key, and collapses every failure path (schema
 * validation, floor rejection, wrong passphrase, AEAD tamper detection) into
 * a single uniform `BackupIntegrityError` — never reveals which check
 * failed.
 */
export function openBackup(provider: CryptoProvider, passphrase: string, envelope: unknown): Uint8Array {
  const parsed = BackupEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new BackupIntegrityError();
  }
  const value = parsed.data;
  if (value.opsLimit < ARGON2ID_REVIEWED_FLOOR.opsLimit || value.memLimit < ARGON2ID_REVIEWED_FLOOR.memLimit) {
    throw new BackupIntegrityError();
  }
  const salt = fromBase64Url(value.salt);
  const nonce = fromBase64Url(value.nonce);
  const key = deriveArgon2idKey(passphrase, salt, value.opsLimit, value.memLimit);
  try {
    const aad = canonicalHeader(provider, {
      opsLimit: value.opsLimit,
      memLimit: value.memLimit,
      salt: value.salt,
      nonce: value.nonce,
      schemaVersion: value.schemaVersion
    });
    return provider.aeadOpen(key, nonce, aad, fromBase64Url(value.ciphertext));
  } catch {
    throw new BackupIntegrityError();
  } finally {
    provider.zero(key);
  }
}
