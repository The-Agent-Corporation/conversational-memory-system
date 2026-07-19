import sodium from "libsodium-wrappers-sumo";
import { InMemoryRelayStore } from "../../src/relay/storage/in-memory-relay-store.js";
import { OpaqueRelayService } from "../../src/relay/service/opaque-relay-service.js";
import { FakeRelayAccountAuthenticator } from "../../src/relay/auth/relay-account-authenticator.js";
import { FakeSyncRelay } from "../../src/sync/transport/sync-relay.js";
import { SyncControlService } from "../../src/sync/control/sync-control-service.js";
import { LibsodiumCryptoProvider } from "../../src/sync/crypto/libsodium-crypto-provider.js";
import { InMemoryDeviceSecretStore } from "../../src/sync/secrets/in-memory-device-secret-store.js";

await sodium.ready;

/**
 * Shared test-only harness for Plan 06-06's control-service test suites.
 * Wires an in-process relay (real `OpaqueRelayService` + `InMemoryRelayStore`
 * + `FakeRelayAccountAuthenticator`) behind two independent authenticated
 * `SyncRelay` sessions bound to the SAME pseudonymous account, so device
 * enrollment/recovery/revocation exercise the real relay authorization and
 * CAS rules end-to-end without any network transport.
 */
export function createControlTestHarness() {
  const store = new InMemoryRelayStore();
  const authenticator = new FakeRelayAccountAuthenticator();
  const service = new OpaqueRelayService({ authenticator, store });
  const email = "owner@example.test";
  const bearerToken = authenticator.emailSignup(email);

  function newRelaySession(): FakeSyncRelay {
    return new FakeSyncRelay({ service, bearerToken });
  }

  function newControlService(clock?: () => string): SyncControlService {
    return new SyncControlService({
      relay: newRelaySession(),
      crypto: new LibsodiumCryptoProvider(),
      secrets: new InMemoryDeviceSecretStore(),
      clock
    });
  }

  /**
   * Resolves the relay-assigned pseudonymous `syncId` for this harness's
   * account (the relay - not the caller - chooses this ID; tests must fetch
   * it before constructing a genesis commit or enrollment request).
   */
  async function resolveSyncId(): Promise<string> {
    const authority = await authenticator.authenticate(bearerToken);
    const namespace = await store.ensureAccountNamespace(
      authority.issuerHash,
      authority.subjectHash,
      "00000000000000000000000000000000".slice(0, 32),
      "2030-01-02T03:04:05.000Z"
    );
    return namespace.syncId;
  }

  return { store, authenticator, service, email, bearerToken, newRelaySession, newControlService, resolveSyncId };
}

export function fixedClock(iso = "2030-01-02T03:04:05.000Z"): () => string {
  let current = iso;
  return () => current;
}
