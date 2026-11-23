import {
  derivativeExpiriesResponseSchema,
  type DerivativeExpiriesResponse,
  type ProviderId
} from "@markethub/contracts";

export type ExpiriesErrorKind = "validation" | "internal";

export class ExpiriesHttpError extends Error {
  constructor(readonly kind: ExpiriesErrorKind, message: string) {
    super(message);
    this.name = "ExpiriesHttpError";
  }
}

function classify(status: number): ExpiriesErrorKind {
  if (status === 400) return "validation";
  return "internal";
}

function messageOf(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return `Expiry request failed (${status})`;
}

async function readPayload(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

export interface DerivativeExpiriesQuery {
  underlyingCanonicalId: string;
  provider: ProviderId;
  signal?: AbortSignal;
}

/** Build the exact query string sent to GET /api/catalog/derivative-expiries. */
export function buildExpiriesQuery(query: DerivativeExpiriesQuery): string {
  const params = new URLSearchParams();
  params.set("underlyingCanonicalId", query.underlyingCanonicalId.trim());
  params.set("provider", query.provider);
  return params.toString();
}

/**
 * Typed client for the bounded, provider-aware WP4B expiry endpoint. The
 * response envelope is validated with the shared contract schema; no
 * provider-native identifier is accepted, returned or logged here.
 */
export async function fetchDerivativeExpiries(query: DerivativeExpiriesQuery): Promise<DerivativeExpiriesResponse> {
  const underlyingCanonicalId = query.underlyingCanonicalId.trim();
  if (!underlyingCanonicalId) {
    throw new ExpiriesHttpError("validation", "underlyingCanonicalId is required");
  }
  const qs = buildExpiriesQuery(query);
  const response = await fetch(`/api/catalog/derivative-expiries?${qs}`, {
    headers: { Accept: "application/json" },
    ...(query.signal ? { signal: query.signal } : {})
  });
  const payload = await readPayload(response);
  if (!response.ok) throw new ExpiriesHttpError(classify(response.status), messageOf(payload, response.status));
  return derivativeExpiriesResponseSchema.parse(payload) as DerivativeExpiriesResponse;
}
