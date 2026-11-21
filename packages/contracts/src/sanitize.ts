/**
 * Shared redaction for text that may be persisted or displayed (activity
 * summaries, error messages, diagnostics). Removes anything that looks like a
 * credential or token and bounds the result. Never use for protocol payloads.
 *
 * Covers common variants: bearer tokens, JSON-quoted credential keys (string
 * or numeric values), camelCase and multi-segment UPPER_SNAKE env-var prefixed
 * keys, key=value / key: value forms, and URL query parameters (including CSRF
 * `state`). Market-data identifiers and ordinary descriptive text are
 * deliberately not redacted. The only numeric exemption is for ordinary
 * error/status prose such as "error code: 500" — credential-shaped fields
 * (appSecret, client_secret, token, code=, etc.) always redact their values,
 * regardless of length.
 */
const CREDENTIAL_KEYS =
  "appIdHash|appSecret|clientSecret|apiSecret|accessToken|refreshToken|idToken|authorizationCode|access_token|refresh_token|id_token|authorization_code|client_secret|app_secret|api_secret|api[_-]?key|apikey|authorization|password|passwd|secret|token|code|session|signature|private[_-]?key";

/** Zero or more UPPER_SNAKE segments, e.g. UPSTOX_ACCESS_TOKEN, MARKETHUB_FYERS_APP_SECRET. */
const ENV_PREFIX = "(?:[A-Z][A-Z0-9]*[_-])*";

/** Query-string keys additionally include the CSRF `state` parameter. */
const QUERY_KEYS = `${CREDENTIAL_KEYS}|state`;

export function sanitizeSensitiveText(value: unknown, maxLength = 300): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    // Bearer / authorization scheme values.
    .replace(/\b(?:Bearer|Basic|Token)\s+[^\s"',}&]+/gi, "[redacted]")
    // JSON-quoted keys with string OR numeric values (incl. env-var prefixes).
    .replace(new RegExp(`("${ENV_PREFIX}(?:${CREDENTIAL_KEYS})"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`, "gi"), '$1"[redacted]"')
    // Unquoted key=value / key: value forms. Every credential key redacts its
    // value, including short numerics. The sole exception is ordinary prose
    // ("error code: 500", "HTTP status code: 401"), detected by the `code` key
    // preceded by "error"/"status" and a short numeric value.
    .replace(
      new RegExp(`\\b(${ENV_PREFIX}(?:${CREDENTIAL_KEYS}))\\s*[:=]\\s*[^,\\s}&"']+`, "gi"),
      (match: string, key: string, offset: number, whole: string) => {
        const value = match.slice(match.search(/[:=]/) + 1).trim();
        const proseCode =
          /^code$/i.test(key) &&
          /^\d{1,5}$/.test(value) &&
          /(?:error|status)\s+$/i.test(whole.slice(0, offset));
        return proseCode ? match : `${key}=[redacted]`;
      }
    )
    // URL query parameters: ?token=abc / ?state=csrf / &code=123456789
    .replace(new RegExp(`([?&]${ENV_PREFIX}(?:${QUERY_KEYS})=)[^&\\s"']+`, "gi"), "$1[redacted]")
    .slice(0, maxLength);
}
