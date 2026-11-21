/**
 * Shared redaction for text that may be persisted or displayed (activity
 * summaries, error messages, diagnostics). Removes anything that looks like a
 * credential or token and bounds the result. Never use for protocol payloads.
 *
 * Covers common variants: bearer tokens, JSON-quoted credential keys (string
 * or numeric values), key=value / key: value forms, and URL query parameters.
 * Market-data identifiers and ordinary descriptive text are deliberately not
 * redacted — the unquoted form skips purely numeric values so prose such as
 * "error code: 500" survives.
 */
const CREDENTIAL_KEYS =
  "appIdHash|access_token|refresh_token|id_token|authorization_code|client_secret|app_secret|api_secret|api[_-]?key|apikey|authorization|password|passwd|secret|token|code|session|signature|private[_-]?key";

export function sanitizeSensitiveText(value: unknown, maxLength = 300): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    // Bearer / authorization scheme values.
    .replace(/\b(Bearer|Basic|Token)\s+[^\s"',}&]+/gi, "$1 [redacted]")
    // JSON-quoted keys with string OR numeric values: "client_secret":"abc" / {"token":12345}
    .replace(new RegExp(`("(?:${CREDENTIAL_KEYS})"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`, "gi"), '$1"[redacted]"')
    // Unquoted key=value / key: value forms. Skip purely numeric values so
    // ordinary prose ("error code: 500") is not corrupted.
    .replace(new RegExp(`\\b(${CREDENTIAL_KEYS})\\s*[:=]\\s*(?!\\d+(?:[,\\s}&]|$))[^,\\s}&"']+`, "gi"), "$1=[redacted]")
    // URL query parameters: ?token=abc / &code=abc
    .replace(new RegExp(`([?&](?:${CREDENTIAL_KEYS})=)[^&\\s"']+`, "gi"), "$1[redacted]")
    .slice(0, maxLength);
}
