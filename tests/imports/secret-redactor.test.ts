import { describe, expect, it } from "vitest";
import { redactKnownSecrets } from "../../src/imports/secret-redactor.js";

// Every credential in this file is SYNTHETIC. GAP-11-F exists partly because a real
// credential was written into probe artifacts; nothing resembling a live secret may be
// reproduced here. Shapes are copied from the audit, values are invented.

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

  describe("GAP-11-F — credential classes that escaped the original rules", () => {
    // Audit §2(a)+(b): the lead-in word `login` was absent from the keyword set, and even
    // with it added the value grammar captured only the backtick-quoted username, stopping
    // at the space before the password.
    it("redacts a quoted user/password pair after a credential lead-in", () => {
      const content = "Your MC login: `synthuser` / `Synthpw42$!2026`";

      const redacted = redactKnownSecrets(content);

      expect(redacted).not.toContain("Synthpw42$!2026");
      expect(redacted).toContain("[REDACTED]");
    });

    it("redacts the same pair under other lead-in words and quote styles", () => {
      for (const content of [
        "credentials: 'synthuser' / 'Synthpw42$!2026'",
        'creds = "synthuser" / "Synthpw42$!2026"',
        "Login: `synth.user@example.test` / `Synthpw42$!2026`"
      ]) {
        expect(redactKnownSecrets(content)).not.toContain("Synthpw42$!2026");
      }
    });

    // Audit §2(c): JSON bodies embedded in `[Tool call: Bash]` content arrive with
    // backslash-escaped quotes. Rule 4's `["']?` cannot skip the backslash between the
    // keyword and its `:`, so escaped-JSON secrets were invisible to it entirely.
    // This is the highest-volume defect: 300 plaintext values across the corpus.
    it("redacts secrets inside backslash-escaped JSON from tool-call content", () => {
      const content =
        '[Tool call: Bash] {"command":"curl -d \\"{\\"username\\":\\"synth@example.test\\",\\"password\\":\\"Synthpw42$\\"}\\" https://example.test/login"}';

      const redacted = redactKnownSecrets(content);

      expect(redacted).not.toContain("Synthpw42$");
      expect(redacted).toContain("[REDACTED]");
    });

    it("redacts escaped api_key and token fields too", () => {
      const content = '\\"api_key\\":\\"synthkey0123456789abcdef\\", \\"token\\":\\"synthtok0123456789\\"';

      const redacted = redactKnownSecrets(content);

      expect(redacted).not.toContain("synthkey0123456789abcdef");
      expect(redacted).not.toContain("synthtok0123456789");
    });

    // Audit §3 C3n: `API key:` with a SPACE was never matched — the shipped alternation
    // was `api[_-]?key`, which admits `_` and `-` but not whitespace.
    it("redacts a token-shaped value after a spaced key phrase", () => {
      const content = "Mission Control API key: synthkey0123456789abcdef0123";

      const redacted = redactKnownSecrets(content);

      expect(redacted).not.toContain("synthkey0123456789abcdef0123");
    });

    // Audit §3 C4: DSN passwords in URI userinfo position.
    it("redacts a password in URI userinfo position", () => {
      const content = "psql postgresql://postgres:synthpw42@localhost:5432/appdb";

      const redacted = redactKnownSecrets(content);

      expect(redacted).not.toContain("synthpw42");
      expect(redacted).toContain("postgresql://postgres:[REDACTED]@localhost:5432/appdb");
    });
  });

  describe("GAP-11-F false-positive controls — measured on the real corpus, do not widen", () => {
    // Audit §3 C2u: dropping the quote requirement from the slash-pair rule produced a
    // 50% false-positive rate. This is the prose shape it wrongly redacted.
    it("leaves unquoted prose containing a slash-separated phrase alone", () => {
      const content =
        'All user stories: - (SubAgentDelegate rules) Antipattern = "Note / NoteABC map" - next item';

      expect(redactKnownSecrets(content)).toBe(content);
    });

    it("leaves a slash-separated path or date after a lead-in word alone", () => {
      for (const content of [
        "Codex credentials: openrouter / moonshotai/kimi-k2.6",
        "Account: reports / 2026-07-28-summary.md"
      ]) {
        expect(redactKnownSecrets(content)).toBe(content);
      }
    });

    // Audit §3 C3: the unnarrowed spaced-key-phrase rule had a ~40% false-positive rate,
    // redacting the first prose word after a heading. The shipped rule requires a value of
    // at least 16 characters mixing letters and digits.
    it("leaves prose and env-var names after a spaced key phrase alone", () => {
      for (const content of [
        "- API key: rotation pending, owner declined",
        "- API key: missing",
        "- `MC_API_KEY`: exported in the shell profile"
      ]) {
        expect(redactKnownSecrets(content)).toBe(content);
      }
    });

    // Audit §3 C5: a bare 64-hex rule would have caught the incident's API key and also
    // roughly 1,080 content digests and git object IDs — the identifiers that make derived
    // memory traceable. Rejected on measured precision. If someone adds it, this breaks.
    it("leaves bare hex digests and object IDs alone", () => {
      for (const content of [
        "Checkpoint content hash: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
        "for d in 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd; do echo $d; done"
      ]) {
        expect(redactKnownSecrets(content)).toBe(content);
      }
    });

    // The shipped keyword rule already redacts `${VAR}` values after `api_key:`, and that
    // is left alone — redacting an env-var name is harmless and changing it would be a
    // regression. What these controls pin is that the NEW rules do not fire on
    // placeholders in the positions the new rules cover.
    it("leaves placeholder and template values alone in the new rules' positions", () => {
      for (const content of [
        "API key: $MC_API_KEY",
        "API key: ${ANTHROPIC_API_KEY}",
        "Mission Control API key: {{mc_api_key}}"
      ]) {
        expect(redactKnownSecrets(content)).toBe(content);
      }
    });
  });

  describe("existing redaction behavior is unchanged", () => {
    it("still redacts unescaped JSON credential fields byte-identically", () => {
      const content = '{"email":"a@example.test","password":"Synthpw42$"}';

      expect(redactKnownSecrets(content)).toBe('{"email":"a@example.test","password":"[REDACTED]"}');
    });

    it("still redacts vendor-prefixed tokens and Bearer headers byte-identically", () => {
      expect(redactKnownSecrets("use sk-abcdefghijklmnopqrst here")).toBe("use [REDACTED] here");
      expect(redactKnownSecrets("Authorization: Bearer abcdefghijklmnop")).toBe(
        "Authorization: Bearer [REDACTED]"
      );
    });

    it("is idempotent — redacting twice changes nothing further", () => {
      const content = [
        "Your MC login: `synthuser` / `Synthpw42$!2026`",
        '\\"password\\":\\"Synthpw42$\\"',
        "postgresql://postgres:synthpw42@localhost:5432/appdb",
        "api_key=sk-abcdefghijklmnopqrstuvwxyz"
      ].join("\n");

      const once = redactKnownSecrets(content);

      expect(redactKnownSecrets(once)).toBe(once);
    });
  });
});
