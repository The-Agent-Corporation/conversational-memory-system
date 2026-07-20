import { SyncProtocolError, type SyncErrorCode } from "../domain/types.js";
import type {
  ControlRecord,
  DataEnvelopeInput,
  DataEnvelopeRecord,
  EnrollmentRequestRecord,
  HeadObservationRecord,
  RecoveryChallengeRecord,
  RecoveryPackageRecord
} from "../../relay/domain/types.js";
import { RelayErrorCodeSchema } from "../../relay/domain/types.js";
import type { MembershipCasInput, MembershipCasOutcome, SyncRelay } from "./sync-relay.js";

/**
 * Production bounded HTTP client for the `SyncRelay` contract over the
 * Plan 05 versioned `/v1/*` boundary (ADR 0047 "Relay Wire, Limits, and
 * Logs"). Every method builds a strict JSON request, sets exactly one
 * `Authorization: Bearer` header from an injected async token supplier,
 * bounds connect/response/total time via `AbortController`, bounds
 * response bytes before parsing, and maps every documented server
 * status/error to a stable, content-free client outcome. Never logs or
 * persists the bearer token, and never places it in a URL.
 */

const ROUTES: Record<string, string> = {
  "membership.cas": "/v1/membership/cas",
  "envelope.append": "/v1/envelope/append",
  "envelope.list": "/v1/envelope/list",
  "envelope.head": "/v1/envelope/head",
  "enrollment.submit": "/v1/enrollment/submit",
  "enrollment.list": "/v1/enrollment/list",
  "recovery.upload": "/v1/recovery/upload",
  "recovery.fetch": "/v1/recovery/fetch",
  "head.observe": "/v1/head/observe"
};

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

export interface HttpSyncRelayLogEntry {
  operation: string;
  status: number;
  durationMs: number;
  errorCode?: SyncErrorCode;
}

export interface HttpSyncRelayOptions {
  /** Base URL, e.g. `https://relay.example.test`. Must be HTTPS unless `allowInsecureLoopback` is set. */
  baseUrl: string;
  /** Resolves the current bearer token immediately before each request. Never cached across requests. */
  bearerToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
  /** Acknowledges plaintext HTTP for a loopback test harness only. */
  allowInsecureLoopback?: boolean;
  /** Milliseconds to wait for the connection + headers. Default 10_000. */
  connectTimeoutMs?: number;
  /** Milliseconds bounding the entire request/response cycle. Default 30_000. */
  totalTimeoutMs?: number;
  /** Bytes. Default 20 MiB (bounded before JSON parsing). */
  maxResponseBytes?: number;
  logger?: (entry: HttpSyncRelayLogEntry) => void;
}

function isRetryableNetworkFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof TypeError) return true; // fetch network failure (connection refused/reset/DNS)
  return false;
}

export class HttpSyncRelay implements SyncRelay {
  private readonly baseUrl: string;
  private readonly bearerToken: () => Promise<string> | string;
  private readonly fetchImpl: typeof fetch;
  private readonly connectTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly logger: (entry: HttpSyncRelayLogEntry) => void;

  constructor(options: HttpSyncRelayOptions) {
    if (!options.baseUrl.startsWith("https://") && !(options.allowInsecureLoopback && options.baseUrl.startsWith("http://"))) {
      throw new Error("HttpSyncRelay requires an https:// baseUrl, or allowInsecureLoopback for a loopback test harness only");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.bearerToken = options.bearerToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.logger = options.logger ?? (() => {});
  }

  private async call(operation: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const route = ROUTES[operation];
    if (!route) throw new SyncProtocolError("SYNC_INTERNAL");

    const controller = new AbortController();
    const totalTimer = setTimeout(() => controller.abort(), this.totalTimeoutMs);
    const connectTimer = setTimeout(() => controller.abort(), this.connectTimeoutMs);
    const startMs = Date.now();
    let status = 0;
    let errorCode: SyncErrorCode | undefined;

    try {
      const token = await this.bearerToken();
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${route}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${token}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } catch (error) {
        if (isRetryableNetworkFailure(error)) {
          throw new SyncProtocolError("SYNC_INCOMPLETE");
        }
        throw new SyncProtocolError("SYNC_INTERNAL");
      }
      clearTimeout(connectTimer);
      status = response.status;

      const bounded = await this.readBoundedText(response);
      if (bounded === null) {
        errorCode = "SYNC_LIMIT_EXCEEDED";
        throw new SyncProtocolError("SYNC_LIMIT_EXCEEDED");
      }

      let parsed: unknown;
      try {
        parsed = bounded.length > 0 ? JSON.parse(bounded) : {};
      } catch {
        errorCode = "SYNC_SCHEMA_INVALID";
        throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
      }

      if (typeof parsed !== "object" || parsed === null) {
        errorCode = "SYNC_SCHEMA_INVALID";
        throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
      }
      const record = parsed as Record<string, unknown>;

      if (record.version !== 1) {
        errorCode = "SYNC_VERSION_UNSUPPORTED";
        throw new SyncProtocolError("SYNC_VERSION_UNSUPPORTED");
      }

      if (record.operation === "error") {
        const codeResult = RelayErrorCodeSchema.safeParse(record.code);
        errorCode = codeResult.success ? (codeResult.data as unknown as SyncErrorCode) : "SYNC_INTERNAL";
        throw new SyncProtocolError(errorCode);
      }

      if (!response.ok) {
        errorCode = "SYNC_INTERNAL";
        throw new SyncProtocolError("SYNC_INTERNAL");
      }

      if (record.operation !== operation) {
        errorCode = "SYNC_SCHEMA_INVALID";
        throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
      }

      return record;
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(connectTimer);
      this.logger({ operation, status, durationMs: Date.now() - startMs, errorCode });
    }
  }

  private async readBoundedText(response: Response): Promise<string | null> {
    if (!response.body) {
      const text = await response.text();
      return Buffer.byteLength(text, "utf8") > this.maxResponseBytes ? null : text;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > this.maxResponseBytes) {
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }

  async compareAndSwapMembership(input: MembershipCasInput): Promise<MembershipCasOutcome> {
    const response = await this.call("membership.cas", {
      commit: input.commit,
      signature: input.signature,
      enrollmentRequestId: input.enrollmentRequestId,
      recoveryAuthorization: input.recoveryAuthorization
    });
    if (response.status === "committed") {
      if (!response.record) throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
      return { status: "committed", record: response.record as ControlRecord };
    }
    if (response.status === "conflict") {
      return { status: "conflict", currentRecord: (response.currentRecord as ControlRecord | null | undefined) ?? null };
    }
    throw new SyncProtocolError("SYNC_SCHEMA_INVALID");
  }

  async appendEnvelope(envelope: DataEnvelopeInput): Promise<{ status: "accepted" | "replayed"; record: DataEnvelopeRecord }> {
    const response = await this.call("envelope.append", { envelope });
    return { status: response.status as "accepted" | "replayed", record: response.record as DataEnvelopeRecord };
  }

  async listEnvelopes(
    deviceId: string,
    fromSequence?: number,
    limit?: number
  ): Promise<{ records: DataEnvelopeRecord[]; nextFromSequence: number | null }> {
    const response = await this.call("envelope.list", { deviceId, fromSequence, limit });
    return {
      records: response.records as DataEnvelopeRecord[],
      nextFromSequence: (response.nextFromSequence as number | null | undefined) ?? null
    };
  }

  async headEnvelope(deviceId: string): Promise<{ sequence: number | null; digest: string | null }> {
    const response = await this.call("envelope.head", { deviceId });
    return {
      sequence: (response.sequence as number | null | undefined) ?? null,
      digest: (response.digest as string | null | undefined) ?? null
    };
  }

  async submitEnrollmentRequest(request: Omit<EnrollmentRequestRecord, "status">): Promise<EnrollmentRequestRecord> {
    const response = await this.call("enrollment.submit", { request });
    return response.record as EnrollmentRequestRecord;
  }

  async listEnrollmentRequests(): Promise<EnrollmentRequestRecord[]> {
    const response = await this.call("enrollment.list", {});
    return response.records as EnrollmentRequestRecord[];
  }

  async uploadRecoveryPackage(packageValue: Omit<RecoveryPackageRecord, "status" | "createdAt">): Promise<RecoveryPackageRecord> {
    const response = await this.call("recovery.upload", { package: packageValue });
    return response.record as RecoveryPackageRecord;
  }

  async fetchRecoveryPackage(): Promise<{ package: RecoveryPackageRecord | null; challenge: RecoveryChallengeRecord | null }> {
    const response = await this.call("recovery.fetch", {});
    return {
      package: (response.record as RecoveryPackageRecord | null | undefined) ?? null,
      challenge: (response.challenge as RecoveryChallengeRecord | null | undefined) ?? null
    };
  }

  async observeHead(observation: Omit<HeadObservationRecord, "createdAt">): Promise<HeadObservationRecord> {
    const response = await this.call("head.observe", { observation });
    return response.record as HeadObservationRecord;
  }
}
