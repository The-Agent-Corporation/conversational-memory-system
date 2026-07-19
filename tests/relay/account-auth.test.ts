import { describe, expect, it } from "vitest";
import {
  FakeRelayAccountAuthenticator,
  joseRelayAccountAuthenticatorConfigFromEnv,
  JoseRelayAccountAuthenticator
} from "../../src/relay/auth/relay-account-authenticator.js";
import { RelayError } from "../../src/relay/domain/types.js";

describe("FakeRelayAccountAuthenticator (D-16 deterministic lifecycle, zero network)", () => {
  it("signup then login yields stable pseudonymous (iss, sub) authority", async () => {
    const auth = new FakeRelayAccountAuthenticator();
    const signupToken = auth.emailSignup("owner@example.test");
    const loginToken = auth.emailLogin("owner@example.test");

    const fromSignup = await auth.authenticate(signupToken);
    const fromLogin = await auth.authenticate(loginToken);

    expect(fromSignup.issuerHash).toBe(fromLogin.issuerHash);
    expect(fromSignup.subjectHash).toBe(fromLogin.subjectHash);
  });

  it("login before signup is denied", async () => {
    const auth = new FakeRelayAccountAuthenticator();
    expect(() => auth.emailLogin("never-signed-up@example.test")).toThrow(RelayError);
  });

  it("password recovery restores relay service authority only, identical to login", async () => {
    const auth = new FakeRelayAccountAuthenticator();
    auth.emailSignup("owner@example.test");
    const loginToken = auth.emailLogin("owner@example.test");
    const recoveryToken = auth.passwordRecovery("owner@example.test");

    const fromLogin = await auth.authenticate(loginToken);
    const fromRecovery = await auth.authenticate(recoveryToken);
    expect(fromRecovery).toEqual(fromLogin);

    // Structural proof of D-16: the returned authority object exposes only
    // pseudonymous digests, and the authenticator class exposes no
    // enrollment/device/crypto capability whatsoever.
    expect(Object.keys(fromRecovery).sort()).toEqual(["issuerHash", "subjectHash"]);
    expect((auth as unknown as Record<string, unknown>).enrollDevice).toBeUndefined();
    expect((auth as unknown as Record<string, unknown>).unwrapKeyPackage).toBeUndefined();
    expect((auth as unknown as Record<string, unknown>).decrypt).toBeUndefined();
  });

  it("passkey recovery restores relay service authority only, identical to login", async () => {
    const auth = new FakeRelayAccountAuthenticator();
    auth.emailSignup("owner@example.test");
    const loginToken = auth.emailLogin("owner@example.test");
    const recoveryToken = auth.passkeyRecovery("owner@example.test");

    const fromLogin = await auth.authenticate(loginToken);
    const fromRecovery = await auth.authenticate(recoveryToken);
    expect(fromRecovery).toEqual(fromLogin);
  });

  it("recovery before signup is denied", async () => {
    const auth = new FakeRelayAccountAuthenticator();
    expect(() => auth.passwordRecovery("ghost@example.test")).toThrow(RelayError);
    expect(() => auth.passkeyRecovery("ghost@example.test")).toThrow(RelayError);
  });

  it("different accounts derive different pseudonymous authority", async () => {
    const auth = new FakeRelayAccountAuthenticator();
    const tokenA = auth.emailSignup("alice@example.test");
    const tokenB = auth.emailSignup("bob@example.test");

    const authorityA = await auth.authenticate(tokenA);
    const authorityB = await auth.authenticate(tokenB);

    expect(authorityA.subjectHash).not.toBe(authorityB.subjectHash);
    expect(authorityA.issuerHash).toBe(authorityB.issuerHash);
  });

  it("rejects malformed, empty, and tampered-issuer bearer tokens with content-free codes", async () => {
    const auth = new FakeRelayAccountAuthenticator();
    const token = auth.emailSignup("owner@example.test");

    await expect(auth.authenticate("")).rejects.toMatchObject({ code: "SYNC_AUTH_REQUIRED" });
    await expect(auth.authenticate("not-a-token")).rejects.toMatchObject({ code: "SYNC_AUTH_REQUIRED" });
    await expect(auth.authenticate("fake-relay-token.not-base64url-json!!!")).rejects.toMatchObject({ code: "SYNC_AUTH_REQUIRED" });

    const otherIssuerAuth = new FakeRelayAccountAuthenticator({ issuer: "https://different-issuer.test/" });
    await expect(otherIssuerAuth.authenticate(token)).rejects.toMatchObject({ code: "SYNC_ACCOUNT_DENIED" });
  });

  it("performs zero live-provider or network access (in-process only, no fetch/http)", async () => {
    const auth = new FakeRelayAccountAuthenticator();
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalled = true;
      throw new Error("network access is forbidden in this test");
    }) as typeof fetch;
    try {
      const token = auth.emailSignup("owner@example.test");
      await auth.authenticate(token);
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("joseRelayAccountAuthenticatorConfigFromEnv (injectable configuration boundary)", () => {
  it("builds config from exact env vars without hardcoding tenant values", () => {
    const config = joseRelayAccountAuthenticatorConfigFromEnv({
      MEMORY_RELAY_OIDC_ISSUER: "https://tenant.example.auth0.com/",
      MEMORY_RELAY_OIDC_AUDIENCE: "https://relay.example.test/",
      MEMORY_RELAY_OIDC_JWKS_URI: "https://tenant.example.auth0.com/.well-known/jwks.json"
    });
    expect(config.issuer).toBe("https://tenant.example.auth0.com/");
    expect(config.audience).toBe("https://relay.example.test/");
    expect(config.jwksUri).toBe("https://tenant.example.auth0.com/.well-known/jwks.json");
  });

  it("throws when required env vars are missing rather than defaulting to a hardcoded issuer", () => {
    expect(() => joseRelayAccountAuthenticatorConfigFromEnv({})).toThrow(/MEMORY_RELAY_OIDC_ISSUER/);
    expect(() => joseRelayAccountAuthenticatorConfigFromEnv({
      MEMORY_RELAY_OIDC_ISSUER: "https://tenant.example.auth0.com/"
    })).toThrow(/MEMORY_RELAY_OIDC_AUDIENCE/);
  });
});

describe("JoseRelayAccountAuthenticator (invalid JWT claims fail closed, no network)", () => {
  it("rejects an empty bearer token with SYNC_AUTH_REQUIRED without contacting a JWKS endpoint", async () => {
    const authenticator = new JoseRelayAccountAuthenticator({
      issuer: "https://tenant.example.auth0.com/",
      audience: "https://relay.example.test/",
      jwksUri: "https://tenant.example.auth0.com/.well-known/jwks.json"
    });
    await expect(authenticator.authenticate("")).rejects.toMatchObject({ code: "SYNC_AUTH_REQUIRED" });
  });

  it("rejects a syntactically invalid JWT with SYNC_AUTH_REQUIRED without contacting a JWKS endpoint", async () => {
    const authenticator = new JoseRelayAccountAuthenticator({
      issuer: "https://tenant.example.auth0.com/",
      audience: "https://relay.example.test/",
      jwksUri: "https://tenant.example.auth0.com/.well-known/jwks.json"
    });
    await expect(authenticator.authenticate("not-a-jwt")).rejects.toMatchObject({ code: "SYNC_AUTH_REQUIRED" });
  });
});
