import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { MAX_CIPHERTEXT_LENGTH, RelayError, type RelayErrorCode } from "../domain/types.js";
import type { OpaqueRelayService } from "../service/opaque-relay-service.js";

/**
 * Strict versioned HTTP/HTTPS JSON boundary over `OpaqueRelayService` (ADR
 * 0047 "Relay Wire, Limits, and Logs"). Every route authenticates one
 * bearer header, enforces bounded header/body/page/time/rate/concurrency
 * limits before dispatch, calls only `OpaqueRelayService`, and maps
 * failures to stable content-free statuses. Logs never contain the bearer
 * token, request/response body, ciphertext, signature, keys, or semantic
 * metadata.
 */

const ROUTE_OPERATIONS: Record<string, string> = {
  "/v1/membership/cas": "membership.cas",
  "/v1/envelope/append": "envelope.append",
  "/v1/envelope/list": "envelope.list",
  "/v1/envelope/head": "envelope.head",
  "/v1/enrollment/submit": "enrollment.submit",
  "/v1/enrollment/list": "enrollment.list",
  "/v1/recovery/upload": "recovery.upload",
  "/v1/recovery/fetch": "recovery.fetch",
  "/v1/head/observe": "head.observe"
};

const ERROR_STATUS: Record<RelayErrorCode, number> = {
  SYNC_AUTH_REQUIRED: 401,
  SYNC_ACCOUNT_DENIED: 403,
  SYNC_DEVICE_DENIED: 403,
  SYNC_VERSION_UNSUPPORTED: 400,
  SYNC_SCHEMA_INVALID: 400,
  SYNC_LIMIT_EXCEEDED: 413,
  SYNC_CONTROL_CONFLICT: 409,
  SYNC_SEQUENCE_CONFLICT: 409,
  SYNC_GAP_LIMIT: 409,
  SYNC_INTEGRITY_FAILED: 400,
  SYNC_EXPIRED: 410,
  SYNC_ALREADY_USED: 409,
  SYNC_INCOMPLETE: 200,
  SYNC_INTERNAL: 500
};

/** Content-free operational log entry. Never contains token, body, ciphertext, signature, keys, or semantic metadata. */
export interface RelayHttpLogEntry {
  requestId: string;
  route: string;
  method: string;
  protocolMajor: number;
  status: number;
  errorCode?: RelayErrorCode;
  bytes: number;
  durationMs: number;
}

export interface RelayHttpServerTlsConfig {
  key: string;
  cert: string;
}

export interface RelayHttpServerConfig {
  service: OpaqueRelayService;
  host: string;
  /** Use `0` to bind an OS-assigned ephemeral port (loopback tests). */
  port: number;
  /** TLS termination material. Omit only when `allowInsecureLoopback` is also set. */
  tls?: RelayHttpServerTlsConfig;
  /**
   * Explicit acknowledgement that plaintext HTTP is used only for a
   * loopback test harness. Production deployments MUST supply `tls` or
   * terminate TLS at a documented trusted reverse proxy; plaintext public
   * ingress is forbidden (ADR 0047 "Relay Wire, Limits, and Logs").
   */
  allowInsecureLoopback?: boolean;
  clock?: () => string;
  logger?: (entry: RelayHttpLogEntry) => void;
  randomRequestId?: () => string;
  /** Bytes. Default 65_536 (64 KiB), per ADR protocol maximum. */
  maxHeaderBytes?: number;
  /** Bytes. Default sized to fit the 16 MiB ciphertext protocol maximum after base64url expansion. */
  maxBodyBytes?: number;
  /** Milliseconds. Default 30_000. */
  requestTimeoutMs?: number;
  /** Default 64. */
  maxConcurrentRequests?: number;
  /** Requests per rolling 60s window per bearer-token digest. Default 60 (ADR floor). */
  rateLimitPerMinute?: number;
}

export interface RelayHttpServer {
  readonly server: HttpServer;
  /** Resolves once the server is bound and listening. Await before calling `address()`. */
  readonly ready: Promise<void>;
  address(): { host: string; port: number };
  close(): Promise<void>;
  /**
   * Diagnostic-only: current count of live rate-limit window entries.
   * Content-free (no token, bearer, or semantic data); exists so tests can
   * prove stale windows are evicted rather than retained forever (WR-08).
   */
  rateLimitWindowCount(): number;
}

function statusForCode(code: RelayErrorCode): number {
  return ERROR_STATUS[code] ?? 500;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  }
  res.end(text);
}

function sendError(res: ServerResponse, code: RelayErrorCode, status?: number): void {
  sendJson(res, status ?? statusForCode(code), { version: 1, operation: "error", code });
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Creates (but does not start) a bounded, versioned relay HTTP/HTTPS
 * server. Call `.server.listen(...)` implicitly happens inside; use the
 * returned handle's `address()`/`close()` for loopback test lifecycles.
 */
export function createRelayHttpServer(config: RelayHttpServerConfig): RelayHttpServer {
  if (!config.tls && !config.allowInsecureLoopback) {
    throw new Error("createRelayHttpServer requires tls config, or allowInsecureLoopback for a loopback test harness only");
  }

  const clock = config.clock ?? (() => new Date().toISOString());
  const logger = config.logger ?? (() => {});
  const randomRequestId = config.randomRequestId ?? (() => randomBytes(16).toString("hex"));
  const maxHeaderBytes = config.maxHeaderBytes ?? 65_536;
  const maxBodyBytes = config.maxBodyBytes ?? Math.ceil((MAX_CIPHERTEXT_LENGTH * 4) / 3) + 8_192;
  const requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
  const maxConcurrentRequests = config.maxConcurrentRequests ?? 64;
  const rateLimitPerMinute = config.rateLimitPerMinute ?? 60;

  let activeRequests = 0;
  const rateWindows = new Map<string, { windowStartMs: number; count: number }>();
  const rateLimitWindowMs = 60_000;

  /**
   * Evicts every rate-limit window whose `windowStartMs` has aged out of the
   * rolling window (ADR 0047 "Relay Wire, Limits, and Logs"; WR-08). Runs on
   * every access so a rotating set of bearer-token digests cannot
   * permanently accumulate map entries -- only currently-live windows are
   * retained.
   */
  function evictExpiredRateWindows(nowMs: number): void {
    for (const [digest, window] of rateWindows) {
      if (nowMs - window.windowStartMs >= rateLimitWindowMs) {
        rateWindows.delete(digest);
      }
    }
  }

  function withinRateLimit(token: string): boolean {
    const digest = tokenDigest(token);
    const nowMs = Date.now();
    evictExpiredRateWindows(nowMs);
    const existing = rateWindows.get(digest);
    if (!existing) {
      rateWindows.set(digest, { windowStartMs: nowMs, count: 1 });
      return true;
    }
    if (existing.count >= rateLimitPerMinute) return false;
    existing.count += 1;
    return true;
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startMs = Date.now();
    const requestId = randomRequestId();
    const method = req.method ?? "GET";
    const route = (req.url ?? "").split("?")[0];
    let status = 500;
    let errorCode: RelayErrorCode | undefined;
    let bodyBytes = 0;

    const finish = () => {
      logger({
        requestId,
        route,
        method,
        protocolMajor: 1,
        status,
        errorCode,
        bytes: bodyBytes,
        durationMs: Date.now() - startMs
      });
    };

    try {
      const operation = ROUTE_OPERATIONS[route];
      if (!operation) {
        status = 404;
        errorCode = "SYNC_SCHEMA_INVALID";
        sendError(res, errorCode, status);
        return;
      }
      if (method !== "POST") {
        status = 405;
        errorCode = "SYNC_SCHEMA_INVALID";
        res.setHeader("allow", "POST");
        sendError(res, errorCode, status);
        return;
      }

      const contentTypeHeader = req.headers["content-type"];
      const contentType = typeof contentTypeHeader === "string" ? contentTypeHeader : "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        status = 415;
        errorCode = "SYNC_SCHEMA_INVALID";
        sendError(res, errorCode, status);
        return;
      }

      const authorizationHeader = req.headers["authorization"];
      const bearerToken = typeof authorizationHeader === "string" && authorizationHeader.startsWith("Bearer ")
        ? authorizationHeader.slice("Bearer ".length).trim()
        : "";
      if (!bearerToken) {
        status = 401;
        errorCode = "SYNC_AUTH_REQUIRED";
        sendError(res, errorCode, status);
        return;
      }

      if (!withinRateLimit(bearerToken)) {
        status = 429;
        errorCode = "SYNC_LIMIT_EXCEEDED";
        sendError(res, errorCode, status);
        return;
      }

      if (activeRequests >= maxConcurrentRequests) {
        status = 503;
        errorCode = "SYNC_LIMIT_EXCEEDED";
        sendError(res, errorCode, status);
        return;
      }

      activeRequests += 1;
      try {
        const bodyText = await readBoundedBody(req, maxBodyBytes);
        if (bodyText === null) {
          status = 413;
          errorCode = "SYNC_LIMIT_EXCEEDED";
          sendError(res, errorCode, status);
          return;
        }
        bodyBytes = Buffer.byteLength(bodyText, "utf8");

        let parsedBody: unknown;
        try {
          parsedBody = bodyText.length === 0 ? {} : JSON.parse(bodyText);
        } catch {
          status = 400;
          errorCode = "SYNC_SCHEMA_INVALID";
          sendError(res, errorCode, status);
          return;
        }
        if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
          status = 400;
          errorCode = "SYNC_SCHEMA_INVALID";
          sendError(res, errorCode, status);
          return;
        }
        if ("version" in parsedBody || "operation" in parsedBody) {
          status = 400;
          errorCode = "SYNC_SCHEMA_INVALID";
          sendError(res, errorCode, status);
          return;
        }

        const requestBody = { version: 1, operation, ...(parsedBody as Record<string, unknown>) };

        if (res.destroyed || res.writableEnded) {
          // Client disconnected (response socket already closed): never mutate on a dead connection.
          return;
        }

        const responseBody = await config.service.handle(bearerToken, requestBody);
        status = 200;
        sendJson(res, status, responseBody);
      } finally {
        activeRequests -= 1;
      }
    } catch (error) {
      if (error instanceof RelayError) {
        status = statusForCode(error.code);
        errorCode = error.code;
        sendError(res, error.code, status);
      } else {
        status = 500;
        errorCode = "SYNC_INTERNAL";
        sendError(res, "SYNC_INTERNAL");
      }
    } finally {
      finish();
    }
  }

  const requestListener = (req: IncomingMessage, res: ServerResponse) => {
    req.setTimeout(requestTimeoutMs, () => {
      if (!res.headersSent) {
        sendError(res, "SYNC_INCOMPLETE", 408);
      }
      req.destroy();
    });
    dispatch(req, res).catch(() => {
      if (!res.headersSent) {
        sendError(res, "SYNC_INTERNAL");
      } else {
        res.end();
      }
    });
  };

  const server: HttpServer = config.tls
    ? (createHttpsServer({ key: config.tls.key, cert: config.tls.cert, maxHeaderSize: maxHeaderBytes }, requestListener) as unknown as HttpServer)
    : createHttpServer({ maxHeaderSize: maxHeaderBytes }, requestListener);

  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(config.port, config.host);

  return {
    server,
    ready,
    address() {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Relay HTTP server has no bound network address");
      }
      return { host: config.host, port: addr.port };
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    rateLimitWindowCount() {
      evictExpiredRateWindows(Date.now());
      return rateWindows.size;
    }
  };
}

/** Reads the request body up to `maxBytes`; returns `null` (and aborts the connection) if exceeded. */
function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let exceeded = false;

    req.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      total += chunk.length;
      if (total > maxBytes) {
        exceeded = true;
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (exceeded) return;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (exceeded) return;
      reject(error);
    });
    req.on("aborted", () => {
      if (exceeded) return;
      resolve(null);
    });
  });
}
