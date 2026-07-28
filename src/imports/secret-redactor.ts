const REDACTION = "[REDACTED]";

// The keyword set trusted since ADR 0045. Deliberately NOT widened by GAP-11-F: the
// escaped-quote rule below reuses this exact set so its false-positive profile is
// identical to the keyword rule already in production.
const SECRET_KEYWORDS = "api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret";

// GAP-11-F (c). Tool-call content arrives with JSON bodies embedded in shell commands, so
// its quotes are backslash-escaped: \"password\":\"…\". The keyword rule's `["']?` matches
// at most one character and cannot skip the backslash sitting between the keyword and its
// `:`, so escaped secrets were invisible to it entirely. Measured on the live corpus: 300
// previously-plaintext values across canonical events, summaries, and anchors, with no
// false positives observed. See .planning/phases/11-derivation-input-hygiene/11-REDACTOR-AUDIT.md
const ESCAPED_KEYWORD_PAIR = new RegExp(
  `(\\\\+["'\`]\\b(?:${SECRET_KEYWORDS})\\b\\\\+["'\`]\\s*[:=]\\s*\\\\+["'\`])([^"'\`\\\\\\s,;}]+)`,
  "giu"
);

// GAP-11-F (a)+(b). The credential that escaped was a human-chosen password following a
// prose lead-in — "Your MC login: `user` / `pass`". The lead-in word `login` was absent
// from the keyword set, and the keyword rule's value grammar could not have expressed the
// pair anyway: it captures a single non-whitespace run, so it would have taken the
// username and stopped at the space before the password.
//
// The password side is gated on shape rather than on quoting. An ungated version of this
// rule was measured at a 50% false-positive rate on the live corpus (it redacted prose of
// the form `Antipattern = "Note / NoteABC map"`). Requiring at least one digit AND one
// symbol, forbidding `/` so paths do not qualify, and rejecting date-leading values takes
// that to zero false positives across 292,407 canonical events, 138,373 summaries, and
// 18,938 anchors. Do not relax these guards without re-measuring.
const CREDENTIAL_PAIR =
  /(\b(?:login|logins|credentials?|creds)\b\s*[:=]\s*["'`]?[A-Za-z0-9._@+-]{2,64}["'`]?\s*\/\s*["'`]?)((?!\d{4}-\d{2}-\d{2})(?=[^\s,;"'`/]*[0-9])(?=[^\s,;"'`/]*[!@#$%^&*_+=~?.-])[^\s,;"'`/]{8,64})/giu;

// GAP-11-F, adjacent class found by the same census. `api[_-]?key` admits `_` and `-` but
// not whitespace, so "API key: <token>" was never matched. Ungated, this rule redacted the
// first prose word after a heading ("API key: rotation", "API key: pending") at a ~40%
// false-positive rate. Requiring a 16+ character value mixing letters and digits, and
// forbidding a leading `$`, drops every measured false positive while keeping the real
// vendor tokens.
const SPACED_KEY_PHRASE =
  /(\b(?:api|access|auth|secret)\s+(?:key|token)\b\s*[:=]\s*["'`]?)((?=[^"'`\s,;{}]*[A-Za-z])(?=[^"'`\s,;{}]*[0-9])[^"'`\s,;{}$][^"'`\s,;{}]{15,})/giu;

// GAP-11-F, adjacent class. Passwords in URI userinfo position — Postgres DSNs and HTTP
// basic-auth URLs. 51 plaintext values measured across the corpus, no false positives.
const URI_USERINFO =
  /(\b[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~%+-]+:)([^@\s/"'`]{3,})@/giu;

export const redactKnownSecrets = (content: string): string => {
  let redacted = content.replace(
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/gu,
    REDACTION
  );
  redacted = redacted.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/gu, REDACTION);
  redacted = redacted.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu,
    `Bearer ${REDACTION}`
  );
  redacted = redacted.replace(
    /((?:["']?\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\b["']?)\s*[:=]\s*["']?)([^"'\s,;}]+)/giu,
    `$1${REDACTION}`
  );
  redacted = redacted.replace(ESCAPED_KEYWORD_PAIR, `$1${REDACTION}`);
  redacted = redacted.replace(CREDENTIAL_PAIR, `$1${REDACTION}`);
  redacted = redacted.replace(SPACED_KEY_PHRASE, `$1${REDACTION}`);
  redacted = redacted.replace(URI_USERINFO, `$1${REDACTION}@`);
  return redacted;
};
