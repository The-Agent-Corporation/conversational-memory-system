import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  DeviceSecretError,
  type CreateSecretInput,
  type DeleteSecretInput,
  type DeviceSecretErrorCode,
  type DeviceSecretStore,
  type ReadSecretInput,
  type RotateSecretInput,
  type SecretBinding,
  type SecretKind,
  type SecretVersionHandle
} from "./device-secret-store.js";

/**
 * Fixed non-secret Keychain service label. Never derived from person,
 * sync, device, or any other value that could reveal identity.
 */
export const MACOS_KEYCHAIN_SERVICE_LABEL = "com.conversational-memory-system.device-secrets";

export type KeychainHelperOperation = "create" | "read" | "current_version" | "rotate" | "delete";

/**
 * Control-channel request. Every field is an opaque identifier, a fixed
 * label, or a small integer version. Secret bytes never appear here.
 */
export interface KeychainHelperRequest {
  readonly requestId: string;
  readonly operation: KeychainHelperOperation;
  readonly service: string;
  readonly account: string;
  readonly expectedVersion?: number;
  readonly newVersion?: number;
  readonly hasSecretInput: boolean;
  readonly wantsSecretOutput: boolean;
}

/**
 * Control-channel result. Only a stable status/code, version, and byte
 * length (never content) may appear here.
 */
export interface KeychainHelperResult {
  readonly requestId: string;
  readonly status: "ok" | "error";
  readonly code?: DeviceSecretErrorCode;
  readonly version?: number;
  readonly byteLength?: number;
}

/**
 * Boundary the adapter calls for exactly one helper request. Secret bytes,
 * when present, are exchanged only through `writeSecret`/`readSecret`,
 * never embedded in the request or result objects, and never observable on
 * argv, stdout, stderr, or any log.
 */
export interface KeychainHelperRunner {
  run(
    request: KeychainHelperRequest,
    secretIo: {
      writeSecret?: () => Uint8Array;
      readSecret?: (bytes: Uint8Array) => void;
    }
  ): Promise<KeychainHelperResult>;
}

let requestCounter = 0;
const nextRequestId = (): string => {
  requestCounter += 1;
  return `req-${process.pid}-${requestCounter}-${Date.now().toString(36)}`;
};

const mapHelperCode = (result: KeychainHelperResult): DeviceSecretError => {
  const code: DeviceSecretErrorCode = result.code ?? "SECRET_HELPER_FAILURE";
  return new DeviceSecretError(code);
};

/**
 * Maps `DeviceSecretStore` to non-synchronizable macOS Keychain items
 * through an injected `KeychainHelperRunner`. The adapter holds no local
 * cache of secret bytes and performs no plaintext file or SQLite
 * persistence: a helper failure simply propagates a controlled error and
 * leaves whatever the Keychain already holds as the sole authority.
 */
export class MacosKeychainSecretStore implements DeviceSecretStore {
  constructor(private readonly runner: KeychainHelperRunner) {}

  async create(input: CreateSecretInput): Promise<SecretVersionHandle> {
    const result = await this.runner.run(
      {
        requestId: nextRequestId(),
        operation: "create",
        service: MACOS_KEYCHAIN_SERVICE_LABEL,
        account: this.account(input.kind, input.secretId),
        newVersion: 1,
        hasSecretInput: true,
        wantsSecretOutput: false
      },
      { writeSecret: () => input.bytes }
    );
    if (result.status !== "ok" || result.version === undefined) {
      throw mapHelperCode(result);
    }
    return { secretId: input.secretId, kind: input.kind, version: result.version, bytes: Uint8Array.from(input.bytes) };
  }

  async read(input: ReadSecretInput): Promise<SecretVersionHandle> {
    let outputBytes: Uint8Array = new Uint8Array(0);
    const result = await this.runner.run(
      {
        requestId: nextRequestId(),
        operation: "read",
        service: MACOS_KEYCHAIN_SERVICE_LABEL,
        account: this.account(input.kind, input.secretId),
        expectedVersion: input.expectedVersion,
        hasSecretInput: false,
        wantsSecretOutput: true
      },
      { readSecret: (bytes) => { outputBytes = bytes; } }
    );
    if (result.status !== "ok" || result.version === undefined) {
      throw mapHelperCode(result);
    }
    return { secretId: input.secretId, kind: input.kind, version: result.version, bytes: outputBytes };
  }

  async currentVersion(binding: SecretBinding, kind: SecretKind, secretId: string): Promise<number> {
    void binding;
    const result = await this.runner.run(
      {
        requestId: nextRequestId(),
        operation: "current_version",
        service: MACOS_KEYCHAIN_SERVICE_LABEL,
        account: this.account(kind, secretId),
        hasSecretInput: false,
        wantsSecretOutput: false
      },
      {}
    );
    if (result.status !== "ok" || result.version === undefined) {
      throw mapHelperCode(result);
    }
    return result.version;
  }

  async rotate(input: RotateSecretInput): Promise<SecretVersionHandle> {
    const result = await this.runner.run(
      {
        requestId: nextRequestId(),
        operation: "rotate",
        service: MACOS_KEYCHAIN_SERVICE_LABEL,
        account: this.account(input.kind, input.secretId),
        expectedVersion: input.expectedCurrentVersion,
        newVersion: input.expectedCurrentVersion + 1,
        hasSecretInput: true,
        wantsSecretOutput: false
      },
      { writeSecret: () => input.bytes }
    );
    if (result.status !== "ok" || result.version === undefined) {
      // The Keychain item's prior version, if any, is left untouched by a
      // rejected CAS inside the helper. This adapter writes nothing on
      // failure and holds no fallback copy to reconcile.
      throw mapHelperCode(result);
    }
    return { secretId: input.secretId, kind: input.kind, version: result.version, bytes: Uint8Array.from(input.bytes) };
  }

  async delete(input: DeleteSecretInput): Promise<void> {
    const result = await this.runner.run(
      {
        requestId: nextRequestId(),
        operation: "delete",
        service: MACOS_KEYCHAIN_SERVICE_LABEL,
        account: this.account(input.kind, input.secretId),
        hasSecretInput: false,
        wantsSecretOutput: false
      },
      {}
    );
    if (result.status !== "ok") {
      throw mapHelperCode(result);
    }
  }

  private account(kind: SecretKind, secretId: string): string {
    // The account label is itself opaque: an already-random secret id
    // scoped by kind. It carries no person, sync, or device name.
    return `${kind}:${secretId}`;
  }
}

const HELPER_LENGTH_PREFIX_BYTES = 4;
const MAX_HELPER_FRAME_BYTES = 16 * 1024 * 1024;

const writeFrame = (writable: Writable, payload: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    const length = Buffer.alloc(HELPER_LENGTH_PREFIX_BYTES);
    length.writeUInt32BE(payload.length, 0);
    writable.write(Buffer.concat([length, payload]), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const readFrame = (readable: Readable): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    let expectedLength: number | null = null;
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (expectedLength === null && buffered.length >= HELPER_LENGTH_PREFIX_BYTES) {
        expectedLength = buffered.readUInt32BE(0);
        if (expectedLength < 0 || expectedLength > MAX_HELPER_FRAME_BYTES) {
          cleanup();
          reject(new DeviceSecretError("SECRET_HELPER_FAILURE"));
          return;
        }
      }
      if (expectedLength !== null && buffered.length >= HELPER_LENGTH_PREFIX_BYTES + expectedLength) {
        cleanup();
        resolve(buffered.subarray(HELPER_LENGTH_PREFIX_BYTES, HELPER_LENGTH_PREFIX_BYTES + expectedLength));
      }
    };
    const onEnd = (): void => {
      cleanup();
      reject(new DeviceSecretError("SECRET_HELPER_FAILURE"));
    };
    const onError = (): void => {
      cleanup();
      reject(new DeviceSecretError("SECRET_HELPER_FAILURE"));
    };
    const cleanup = (): void => {
      readable.off("data", onData);
      readable.off("end", onEnd);
      readable.off("error", onError);
    };
    readable.on("data", onData);
    readable.on("end", onEnd);
    readable.on("error", onError);
  });

export interface SpawnedKeychainHelperRunnerOptions {
  readonly helperPath: string;
}

/**
 * Production `KeychainHelperRunner`. Spawns the compiled Swift helper with
 * a fixed, secret-free argv and a bounded private-pipe protocol: fd 3/4
 * carry the JSON control request/result, fd 5/6 carry raw secret bytes
 * when present. stdout and stderr are never used to carry protocol data;
 * they are drained and discarded except for a bounded content-free status
 * line surfaced only on process failure.
 *
 * This runner is exercised only by the documented manual synthetic-account
 * UAT path (see macos-keychain-helper.swift). Automated tests use a fake
 * `KeychainHelperRunner` and never spawn this class.
 */
export class SpawnedKeychainHelperRunner implements KeychainHelperRunner {
  constructor(private readonly options: SpawnedKeychainHelperRunnerOptions) {}

  async run(
    request: KeychainHelperRequest,
    secretIo: { writeSecret?: () => Uint8Array; readSecret?: (bytes: Uint8Array) => void }
  ): Promise<KeychainHelperResult> {
    const child = spawn(this.options.helperPath, ["serve"], {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe", "pipe", "pipe"]
    });
    const [, , stderr, controlIn, controlOut, secretIn, secretOut] = child.stdio as unknown as [
      null,
      null,
      Readable,
      Writable,
      Readable,
      Writable,
      Readable
    ];

    let stderrTail = "";
    stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-256);
    });

    try {
      await writeFrame(controlIn, Buffer.from(JSON.stringify(request), "utf8"));
      if (request.hasSecretInput && secretIo.writeSecret) {
        await writeFrame(secretIn, Buffer.from(secretIo.writeSecret()));
      }
      const resultFrame = await readFrame(controlOut);
      const result = JSON.parse(resultFrame.toString("utf8")) as KeychainHelperResult;
      if (request.wantsSecretOutput && result.status === "ok" && secretIo.readSecret) {
        const secretFrame = await readFrame(secretOut);
        secretIo.readSecret(new Uint8Array(secretFrame));
      }
      return result;
    } catch {
      // The stderr tail is content-free by protocol (see the Swift
      // helper): it never carries secret bytes, only a short status
      // string. It is intentionally not included in the thrown error to
      // keep the adapter's public failure surface a stable code only.
      void stderrTail;
      return { requestId: request.requestId, status: "error", code: "SECRET_HELPER_FAILURE" };
    } finally {
      child.kill();
    }
  }
}
