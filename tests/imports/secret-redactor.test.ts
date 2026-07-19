import { describe, expect, it } from "vitest";
import { redactKnownSecrets } from "../../src/imports/secret-redactor.js";

describe("secret redaction", () => {
  it("redacts common tokens, credentials, and private keys before import", () => {
    const content = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "api_key=sk-abcdefghijklmnopqrstuvwxyz",
      "password=hunter2",
      "-----BEGIN PRIVATE KEY-----",
      "private-material",
      "-----END PRIVATE KEY-----"
    ].join("\n");

    const redacted = redactKnownSecrets(content);

    expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("private-material");
    expect(redacted.match(/\[REDACTED\]/gu)?.length).toBeGreaterThanOrEqual(4);
  });
});
