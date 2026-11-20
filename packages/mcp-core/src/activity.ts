import { CLIENT_INFO_META_KEY, type ServerContext } from "@modelcontextprotocol/server";
import { sanitizeSensitiveText, type McpActivityResultRef, type McpActivitySummary } from "@markethub/contracts";
import type { McpServices } from "./services";

export type ActivityTransport = "HTTP" | "STDIO";

export interface WithActivityArgs<T> {
  services: McpServices;
  transport: ActivityTransport;
  toolName: string;
  context: ServerContext;
  summary: McpActivitySummary;
  operation: () => Promise<T>;
}

/** Extract bounded, untrusted client identity from the documented envelope. */
function clientIdentity(context: ServerContext): { name?: string; version?: string } {
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
  const raw = envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown; version?: unknown } | undefined;
  if (!raw || typeof raw !== "object") return {};
  const out: { name?: string; version?: string } = {};
  if (typeof raw.name === "string" && raw.name.length > 0 && raw.name.length <= 120) out.name = raw.name;
  if (typeof raw.version === "string" && raw.version.length > 0 && raw.version.length <= 120) out.version = raw.version;
  return out;
}

/**
 * Best-effort typed reference to a stored snapshot result; never a payload.
 * Historical refs are intentionally omitted: the wrapper sees only the result,
 * not the original validated range, so a historical link cannot be constructed
 * reliably. The contract variant remains available for future callers that can
 * supply validated range fields.
 */
function resultRefOf(value: unknown): McpActivityResultRef | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const outer = value as Record<string, unknown>;
  const structured = outer.structuredContent;
  if (structured === null || typeof structured !== "object") return undefined;
  const snapshot = (structured as Record<string, unknown>).snapshot;
  if (snapshot === null || typeof snapshot !== "object") return undefined;
  const id = (snapshot as Record<string, unknown>).id;
  if (typeof id === "string" && id.length > 0 && id.length <= 200) {
    return { kind: "snapshot", snapshotId: id };
  }
  return undefined;
}

/** Extract an error object from either structuredContent or text content. */
function errorObjectOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const outer = value as Record<string, unknown>;
  const structured = outer.structuredContent;
  if (structured && typeof structured === "object") {
    const err = (structured as Record<string, unknown>).error;
    if (err && typeof err === "object") return err as Record<string, unknown>;
  }
  // tools.ts failure() places { ok:false, error } in text content, not structuredContent.
  const content = outer.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text !== "string") continue;
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object") {
          const err = (parsed as Record<string, unknown>).error;
          if (err && typeof err === "object") return err as Record<string, unknown>;
        }
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
    const message = typeof err.message === "string" ? sanitizeSensitiveText(err.message, 300) : "tool returned isError";
    return { category, message };
  }
  return { category: "internal", message: "tool returned isError" };
}

function isErrorResult(value: unknown): boolean {
  return value !== null && typeof value === "object" && (value as Record<string, unknown>).isError === true;
}

/**
 * Record one executed MCP callback. Activity persistence is best-effort: a
 * start/complete failure is reported through the optional diagnostic hook and
 * never changes the operation result or replaces its exception.
 */
export async function withActivity<T>(args: WithActivityArgs<T>): Promise<T> {
  const { services, transport, toolName, context, summary, operation } = args;
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
    else services.onActivityError?.(new Error(`activity start failed: ${start.error.message}`));
  } catch (error) {
    services.onActivityError?.(error);
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
    const ref = didThrow ? undefined : resultRefOf(result);
    try {
      const complete = await services.completeActivity({
        operationId,
        status,
        ...(detail ? { errorCategory: detail.category, errorMessage: detail.message } : {}),
        ...(ref ? { dataResultRef: ref } : {})
      });
      if (!complete.ok) services.onActivityError?.(new Error(`activity complete failed: ${complete.error.message}`));
    } catch (error) {
      services.onActivityError?.(error);
    }
  }

  if (didThrow) throw thrown;
  return result as T;
}

/** Build a bounded safe summary from an allow-listed set of primitive inputs. */
export function safeSummary(input: Record<string, unknown>, keys: readonly string[]): McpActivitySummary {
  const out: McpActivitySummary = {};
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") out[key] = sanitizeSensitiveText(value, 200);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  if (JSON.stringify(out).length > 1000) {
    for (const key of Object.keys(out)) {
      delete out[key];
      if (JSON.stringify(out).length <= 1000) break;
    }
  }
  return out;
}
