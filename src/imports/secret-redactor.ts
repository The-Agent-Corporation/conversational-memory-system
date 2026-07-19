const REDACTION = "[REDACTED]";

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
  return redacted;
};
