import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type ConfirmationErrorCode =
  | "CONFIRMATION_EXPIRED"
  | "CONFIRMATION_MISMATCH"
  | "CONFIRMATION_REPLAYED";

export class ConfirmationError extends Error {
  constructor(readonly code: ConfirmationErrorCode) {
    super(code);
    this.name = "ConfirmationError";
  }
}

export interface ConfirmationIntent {
  readonly profileFingerprint: string;
  readonly tool: string;
  readonly targetIds: readonly string[];
  readonly normalizedParameters: Readonly<Record<string, unknown>>;
  readonly effectsFingerprint: string;
}

export interface ConfirmationPreview {
  readonly token: string;
  readonly expiresAt: string;
}

export interface ConfirmationServiceOptions {
  clock?: () => string;
  ttlMs?: number;
  randomToken?: () => Buffer;
}

interface ConfirmationTicket {
  readonly intentDigest: Buffer;
  readonly expiresAtMs: number;
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

const normalizeIntent = (intent: ConfirmationIntent): string => stableJson({
  version: 1,
  profileFingerprint: intent.profileFingerprint,
  tool: intent.tool,
  targetIds: [...intent.targetIds].sort(),
  normalizedParameters: intent.normalizedParameters,
  effectsFingerprint: intent.effectsFingerprint
});

/** Process-local, content-free confirmation authority for one exact mutation preview. */
export class ConfirmationService {
  private readonly tickets = new Map<string, ConfirmationTicket>();
  private readonly consumed = new Set<string>();
  private readonly clock: () => string;
  private readonly ttlMs: number;
  private readonly randomToken: () => Buffer;

  constructor(options: ConfirmationServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.ttlMs = options.ttlMs ?? 2 * 60_000;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 5 * 60_000) {
      throw new Error("Confirmation TTL must be an integer from 1 to 300000 milliseconds");
    }
    this.randomToken = options.randomToken ?? (() => randomBytes(32));
  }

  issue(intent: ConfirmationIntent): ConfirmationPreview {
    const now = this.nowMs();
    let token: string;
    let tokenKey: string;
    do {
      token = this.randomToken().toString("base64url");
      tokenKey = digest(token).toString("hex");
    } while (this.tickets.has(tokenKey) || this.consumed.has(tokenKey));
    const expiresAtMs = now + this.ttlMs;
    this.tickets.set(tokenKey, {
      intentDigest: digest(normalizeIntent(intent)),
      expiresAtMs
    });
    return { token, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consumeExact(token: string, intent: ConfirmationIntent): void {
    if (!token) throw new ConfirmationError("CONFIRMATION_MISMATCH");
    const tokenKey = digest(token).toString("hex");
    if (this.consumed.has(tokenKey)) throw new ConfirmationError("CONFIRMATION_REPLAYED");
    const ticket = this.tickets.get(tokenKey);
    if (!ticket) throw new ConfirmationError("CONFIRMATION_MISMATCH");

    // Invalidate before any authorization result leaves this method. Callers can never
    // retry a failed commit, a drift result, an expired preview, or a mismatched execute.
    this.tickets.delete(tokenKey);
    this.consumed.add(tokenKey);

    if (this.nowMs() >= ticket.expiresAtMs) {
      throw new ConfirmationError("CONFIRMATION_EXPIRED");
    }
    const suppliedDigest = digest(normalizeIntent(intent));
    if (!timingSafeEqual(ticket.intentDigest, suppliedDigest)) {
      throw new ConfirmationError("CONFIRMATION_MISMATCH");
    }
  }

  private nowMs(): number {
    const value = Date.parse(this.clock());
    if (!Number.isFinite(value)) throw new Error("Confirmation clock returned an invalid timestamp");
    return value;
  }
}
