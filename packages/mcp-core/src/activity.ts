import { CLIENT_INFO_META_KEY, type ServerContext } from "@modelcontextprotocol/server";
import {
  candleIntervalSchema, mcpActivitySummarySchema, MCP_ACTIVITY_SUMMARY_KEYS,
  sanitizeSensitiveText, type McpActivityResultRef, type McpActivitySummary
} from "@markethub/contracts";
import type { McpServices } from "./services";

export type ActivityTransport = "HTTP" | "STDIO";

export interface WithActivityArgs<T> {
  services: McpServices;
  transport: ActivityTransport;
  toolName: string;
  context: ServerContext;
  summary: McpActivitySummary;
  operation: () => Promise<T>;
  /** Lazy validated range hint for historical refs (the result alone lacks the request range). */
  resultRefHint?: (() => McpActivityResultRef | undefined) | undefined;
}

/**
 * Report an activity-write failure without ever throwing. A diagnostic callback
 * is strictly best-effort: it must not prevent the operation, replace its result
 * or exception, or change outcome classification.
 */
function reportDiagnostic(services: McpServices, error: unknown): void {
  try {
    // The callback is typed `=> void` but an async implementation is assignable;
    // swallow both synchronous throws and rejected promises so neither becomes
    // an unhandled rejection that could crash the process.
    void Promise.resolve(services.onActivityError?.(error)).catch(() => {});
  } catch {
    // A throwing diagnostic is swallowed — it is never allowed to escape.
  }
}

/** Extract bounded, untrusted, sanitized client identity from the envelope. */
function clientIdentity(context: ServerContext): { name?: string; version?: string } {
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
  const raw = envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown; version?: unknown } | undefined;
  if (!raw || typeof raw !== "object") return {};
  const out: { name?: string; version?: string } = {};
  if (typeof raw.name === "string" && raw.name.length > 0 && raw.name.length <= 120) {
    out.name = sanitizeSensitiveText(raw.name, 120);
  }
  if (typeof raw.version === "string" && raw.version.length > 0 && raw.version.length <= 120) {
    out.version = sanitizeSensitiveText(raw.version, 120);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

/** Extract a snapshot reference from any successful result shape. */
function snapshotRefOf(value: unknown): McpActivityResultRef | undefined {
  const outer = asRecord(value);
  if (!outer) return undefined;
  const structured = asRecord(outer.structuredContent);
  if (!structured) return undefined;

  // Shapes observed in the registered tools:
  //  - option_chain_snapshot mode=get: structuredContent IS the snapshot { id, ... }
  //  - option_chain_snapshot mode=capture: structuredContent = { snapshot, error }
  //  - on_demand_retrieval option_chain: structuredContent = { kind, status, result: { snapshot, error } }
  const candidates: unknown[] = [
    structured.id,
    asRecord(structured.snapshot)?.id,
    asRecord(asRecord(structured.result)?.snapshot)?.id
  ];
  for (const id of candidates) {
    if (typeof id === "string" && id.length > 0 && id.length <= 200) {
      return { kind: "snapshot", snapshotId: id };
    }
  }
  return undefined;
}

/** Emit a historical reference only for a successful data read with a validated hint. */
function historicalRefOf(value: unknown, hint: McpActivityResultRef | undefined): McpActivityResultRef | undefined {
  if (!hint || hint.kind !== "historical") return undefined;
  const interval = candleIntervalSchema.safeParse(hint.interval);
  if (!interval.success) return undefined;
  const outer = asRecord(value);
  const structured = outer ? asRecord(outer.structuredContent) : null;
  if (!structured) return undefined;
  // A successful historical read exposes candles (cached/onDemand) or coverage
  // (gaps/unavailableNotes), directly or nested under on_demand_retrieval.result.
  const nested = asRecord(structured.result);
  const hasData =
    Array.isArray(structured.candles) || Array.isArray(structured.gaps) || Array.isArray(structured.unavailableNotes) ||
    (nested !== null && (Array.isArray(nested.candles) || Array.isArray(nested.gaps)));
  if (!hasData) return undefined;
  return {
    kind: "historical",
    canonicalId: hint.canonicalId,
    interval: interval.data,
    fromMs: hint.fromMs,
    toMs: hint.toMs
  };
}

function isErrorResult(value: unknown): boolean {
  const outer = asRecord(value);
  return outer !== null && outer.isError === true;
}

/** Resolve a typed reference from a successful result; never from a failed one. */
function resultRefOf(value: unknown, hint?: McpActivityResultRef): McpActivityResultRef | undefined {
  if (isErrorResult(value)) return undefined;
  return snapshotRefOf(value) ?? historicalRefOf(value, hint);
}

/** Extract an error object from either structuredContent or text content. */
function errorObjectOf(value: unknown): Record<string, unknown> | null {
  const outer = asRecord(value);
  if (!outer) return null;
  const structured = asRecord(outer.structuredContent);
  if (structured) {
    const err = asRecord(structured.error);
    if (err) return err;
  }
  // tools.ts failure() places { ok:false, error } in text content, not structuredContent.
  const content = outer.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const text = asRecord(part)?.text;
      if (typeof text !== "string") continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        const err = asRecord(parsed)?.error;
        if (err && typeof err === "object") return asRecord(err);
      } catch { /* not JSON text */ }
    }
  }
  return null;
}

/** Sanitized failure detail from a thrown error or an isError tool result. */
function failureDetail(value: unknown): { category: string; message: string } {
  if (value instanceof Error) {
    return { category: "internal", message: sanitizeSensitiveText(value.message, 300) };
  }
  const err = errorObjectOf(value);
  if (err) {
    const category = typeof err.category === "string" ? sanitizeSensitiveText(err.category, 64) : "internal";
    const sanitized = typeof err.message === "string" ? sanitizeSensitiveText(err.message, 300) : "";
    // The complete schema requires a non-empty message; fall back so a row is
    // never left `started` because an isError result carried an empty message.
    return { category, message: sanitized.length > 0 ? sanitized : "tool returned isError" };
  }
  return { category: "internal", message: "tool returned isError" };
}

/**
 * Record one executed MCP callback. Activity persistence is best-effort: a
 * start/complete failure or a throwing diagnostic never changes the operation
 * result or replaces its exception.
 */
export async function withActivity<T>(args: WithActivityArgs<T>): Promise<T> {
  const { services, transport, toolName, context, summary, operation, resultRefHint } = args;
  const operationId = crypto.randomUUID();
  const identity = clientIdentity(context);

  let started = false;
  try {
    const start = await services.startActivity({
      operationId,
      toolName,
      transport,
      ...(identity.name !== undefined ? { clientName: identity.name } : {}),
      ...(identity.version !== undefined ? { clientVersion: identity.version } : {}),
      summaryJson: JSON.stringify(summary)
    });
    if (start.ok) started = true;
    else reportDiagnostic(services, new Error(`activity start failed: ${start.error.message}`));
  } catch (error) {
    reportDiagnostic(services, error);
  }

  let result: T | undefined;
  let thrown: unknown;
  let didThrow = false;
  try {
    result = await operation();
  } catch (error) {
    didThrow = true;
    thrown = error;
  }

  if (started) {
    const cancelled = didThrow && context.mcpReq.signal.aborted;
    const status = didThrow
      ? (cancelled ? "interrupted" : "failed")
      : isErrorResult(result) ? "failed" : "succeeded";
    const detail = didThrow ? failureDetail(thrown) : isErrorResult(result) ? failureDetail(result) : null;
    // Hint evaluation is best-effort too: a throwing hint must never discard a
    // successful result or replace the original exception.
    let hint: McpActivityResultRef | undefined;
    if (!didThrow) {
      try { hint = resultRefHint?.(); } catch { hint = undefined; }
    }
    const ref = didThrow ? undefined : resultRefOf(result, hint);
    try {
      const complete = await services.completeActivity({
        operationId,
        status,
        ...(detail ? { errorCategory: detail.category, errorMessage: detail.message } : {}),
        ...(ref ? { dataResultRef: ref } : {})
      });
      if (!complete.ok) reportDiagnostic(services, new Error(`activity complete failed: ${complete.error.message}`));
    } catch (error) {
      reportDiagnostic(services, error);
    }
  }

  if (didThrow) throw thrown;
  return result as T;
}

/** Build a bounded safe summary from the strict allow-list of primitive inputs. */
export function safeSummary(input: Record<string, unknown>, keys: readonly string[]): McpActivitySummary {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(MCP_ACTIVITY_SUMMARY_KEYS as readonly string[]).includes(key)) continue;
    const value = input[key];
    if (typeof value === "string") out[key] = sanitizeSensitiveText(value, 200);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  // Preserve the original bounded behavior: drop trailing keys until the
  // summary fits, rather than discarding all legitimate fields on overflow.
  while (Object.keys(out).length > 0 && JSON.stringify(out).length > 1000) {
    delete out[Object.keys(out)[Object.keys(out).length - 1]!];
  }
  const parsed = mcpActivitySummarySchema.safeParse(out);
  return parsed.success ? parsed.data : {};
}
