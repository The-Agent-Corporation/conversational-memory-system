import { createHmac, timingSafeEqual } from "node:crypto";

export const TOKEN_ESTIMATOR_VERSION = "words-v1" as const;

export interface CanonicalOrderTuple {
  occurredAt: string;
  nativeSequence: number;
  id: string;
}

export interface ContinuationCursorPayload {
  authorityFingerprint: string;
  subjectHash: string;
  next: CanonicalOrderTuple;
  tokenBudget: number;
  estimatorVersion: typeof TOKEN_ESTIMATOR_VERSION;
  expiresAt: string;
}

export interface ContinuationCursorExpectation {
  authorityFingerprint: string;
  subjectHash: string;
  tokenBudget: number;
  estimatorVersion: typeof TOKEN_ESTIMATOR_VERSION;
}

interface CursorEnvelope {
  payload: string;
  signature: string;
}

const INVALID_CURSOR = "Invalid continuation cursor";

export class ContinuationCursorCodec {
  readonly #secret: Buffer;
  readonly #now: () => string;
  readonly #ttlMilliseconds: number;

  constructor(
    secret: string | Uint8Array,
    options: { now?: () => string; ttlMilliseconds?: number } = {}
  ) {
    this.#secret = Buffer.from(secret);
    if (this.#secret.byteLength < 32) throw new Error("Continuation cursor secret is too short");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#ttlMilliseconds = options.ttlMilliseconds ?? 5 * 60 * 1000;
    if (!Number.isInteger(this.#ttlMilliseconds) || this.#ttlMilliseconds <= 0) {
      throw new Error("Continuation cursor TTL must be a positive integer");
    }
  }

  create(input: Omit<ContinuationCursorPayload, "expiresAt">): string {
    const payload: ContinuationCursorPayload = {
      ...input,
      expiresAt: new Date(Date.parse(this.#now()) + this.#ttlMilliseconds).toISOString()
    };
    const serialized = JSON.stringify(payload);
    return Buffer.from(JSON.stringify({
      payload: serialized,
      signature: this.sign(serialized)
    } satisfies CursorEnvelope), "utf8").toString("base64url");
  }

  verify(cursor: string, expected: ContinuationCursorExpectation): ContinuationCursorPayload {
    try {
      const envelope = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorEnvelope;
      if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error("shape");
      const actualSignature = Buffer.from(envelope.signature, "base64url");
      const expectedSignature = Buffer.from(this.sign(envelope.payload), "base64url");
      if (
        actualSignature.byteLength !== expectedSignature.byteLength ||
        !timingSafeEqual(actualSignature, expectedSignature)
      ) throw new Error("signature");

      const payload = JSON.parse(envelope.payload) as ContinuationCursorPayload;
      if (
        payload.authorityFingerprint !== expected.authorityFingerprint ||
        payload.subjectHash !== expected.subjectHash ||
        payload.tokenBudget !== expected.tokenBudget ||
        payload.estimatorVersion !== expected.estimatorVersion ||
        payload.estimatorVersion !== TOKEN_ESTIMATOR_VERSION ||
        !isOrderTuple(payload.next) ||
        !Number.isFinite(Date.parse(payload.expiresAt)) ||
        Date.parse(payload.expiresAt) <= Date.parse(this.#now())
      ) throw new Error("binding");
      return payload;
    } catch {
      throw new Error(INVALID_CURSOR);
    }
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.#secret).update(payload).digest("base64url");
  }
}

const isOrderTuple = (value: unknown): value is CanonicalOrderTuple => {
  if (!value || typeof value !== "object") return false;
  const tuple = value as Partial<CanonicalOrderTuple>;
  return typeof tuple.occurredAt === "string" &&
    Number.isFinite(Date.parse(tuple.occurredAt)) &&
    Number.isInteger(tuple.nativeSequence) &&
    (tuple.nativeSequence ?? -1) >= 0 &&
    typeof tuple.id === "string" &&
    tuple.id.length > 0;
};
