/**
 * Shared redaction for text that may be persisted or displayed (activity
 * summaries, error messages, diagnostics). Removes anything that looks like a
 * credential or token and bounds the result. Never use for protocol payloads.
 */
export function sanitizeSensitiveText(value: unknown, maxLength = 300): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/"(appIdHash|access_token|refresh_token|app_secret|authorization_code|api[_-]?key|password|token|secret|code)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/(appIdHash|access_token|refresh_token|app_secret|authorization_code|api[_-]?key|password|token|secret|code)\s*[:=]\s*[^,\s}&"']+/gi, "$1=[redacted]")
    .replace(/[?&](code|state|access_token|token|secret)=[^&\s"']+/gi, "?$1=[redacted]")
    .slice(0, maxLength);
}
