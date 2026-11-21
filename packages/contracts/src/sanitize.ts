/**
 * Shared redaction for text that may be persisted or displayed (activity
 * summaries, error messages, diagnostics). Removes anything that looks like a
 * credential or token and bounds the result. Never use for protocol payloads.
 *
 * Covers common variants: bearer tokens, JSON-quoted credential keys (string
 * or numeric values), camelCase and UPPER_SNAKE env-var prefixed keys,
 * key=value / key: value forms, and URL query parameters (including CSRF
 * `state`). Market-data identifiers and ordinary descriptive text are
 * deliberately not redacted — the unquoted form skips only short purely
 * numeric values so prose such as "error code: 500" survives, while long
 * numeric authorization codes are still redacted.
 */
const CREDENTIAL_KEYS =
  "appIdHash|clientSecret|apiSecret|accessToken|refreshToken|idToken|authorizationCode|access_token|refresh_token|id_token|authorization_code|client_secret|app_secret|api_secret|api[_-]?key|apikey|authorization|password|passwd|secret|token|code|session|signature|private[_-]?key";

/** Optional UPPER_SNAKE env-var prefix, e.g. UPSTOX_ACCESS_TOKEN, MY_API_KEY. */
const ENV_PREFIX = "(?:[A-Z][A-Z0-9]*[_-])?";

/** Query-string keys additionally include the CSRF `state` parameter. */
const QUERY_KEYS = `${CREDENTIAL_KEYS}|state`;

export function sanitizeSensitiveText(value: unknown, maxLength = 300): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    // Bearer / authorization scheme values.
    .replace(/\b(Bearer|Basic|Token)\s+[^\s"',}&]+/gi, "$1 [redacted]")
    // JSON-quoted keys with string OR numeric values (incl. env-var prefixes).
    .replace(new RegExp(`("${ENV_PREFIX}(?:${CREDENTIAL_KEYS})"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`, "gi"), '$1"[redacted]"')
    // Unquoted key=value / key: value forms. Skip only short (<=5 digit)
    // numeric values so ordinary prose survives but long codes are redacted.
    .replace(new RegExp(`\\b(${ENV_PREFIX}(?:${CREDENTIAL_KEYS}))\\s*[:=]\\s*(?!\\d{1,5}(?:[,\\s}&]|$))[^,\\s}&"']+`, "gi"), "$1=[redacted]")
    // URL query parameters: ?token=abc / ?state=csrf / &code=123456789
    .replace(new RegExp(`([?&]${ENV_PREFIX}(?:${QUERY_KEYS})=)[^&\\s"']+`, "gi"), "$1[redacted]")
    .slice(0, maxLength);
}
