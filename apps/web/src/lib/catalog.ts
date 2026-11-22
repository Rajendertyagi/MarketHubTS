import { canonicalInstrumentSchema, type CanonicalInstrument } from "@markethub/contracts";

export type CatalogErrorKind = "forbidden" | "validation" | "internal";

export class CatalogHttpError extends Error {
  constructor(readonly kind: CatalogErrorKind, message: string) {
    super(message);
    this.name = "CatalogHttpError";
  }
}

function classify(status: number): CatalogErrorKind {
  if (status === 403) return "forbidden";
  if (status === 400) return "validation";
  return "internal";
}

function messageOf(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return `Catalog request failed (${status})`;
}

async function readPayload(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

export interface CatalogSearchQuery {
  text: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface CatalogSearchPage {
  instruments: CanonicalInstrument[];
  nextCursor: string | null;
}

export const CATALOG_DEFAULT_LIMIT = 25;
export const CATALOG_MAX_LIMIT = 100;

/** Build the exact query string sent to GET /api/catalog/search. */
export function buildCatalogQuery(query: CatalogSearchQuery): string {
  const params = new URLSearchParams();
  params.set("text", query.text.trim());
  const rawLimit = query.limit ?? CATALOG_DEFAULT_LIMIT;
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(Math.trunc(rawLimit), CATALOG_MAX_LIMIT))
    : CATALOG_DEFAULT_LIMIT;
  params.set("limit", String(limit));
  if (query.cursor) params.set("cursor", query.cursor);
  return params.toString();
}

/** Human-readable option label; canonicalId remains the selected value. */
export function formatInstrumentLabel(instrument: CanonicalInstrument): string {
  return `${instrument.displayName} (${instrument.canonicalSymbol}) · ${instrument.exchange}/${instrument.segment}`;
}

/**
 * Validate the response envelope without a new dependency: the web package has
 * no direct zod import, so the envelope is checked with type guards while each
 * instrument is validated by the shared canonicalInstrumentSchema.
 */
function parsePage(payload: unknown): CatalogSearchPage {
  if (!payload || typeof payload !== "object") throw new Error("Invalid catalog response");
  const envelope = payload as { instruments?: unknown; nextCursor?: unknown };
  if (!Array.isArray(envelope.instruments)) throw new Error("Invalid catalog response: instruments");
  if (envelope.nextCursor !== null && (typeof envelope.nextCursor !== "string" || envelope.nextCursor.length === 0)) {
    throw new Error("Invalid catalog response: nextCursor");
  }
  return {
    instruments: envelope.instruments.map((row) => canonicalInstrumentSchema.parse(row)),
    nextCursor: envelope.nextCursor as string | null
  };
}

export async function searchInstruments(query: CatalogSearchQuery): Promise<CatalogSearchPage> {
  const text = query.text.trim();
  if (!text) return { instruments: [], nextCursor: null };
  const qs = buildCatalogQuery(query);
  const response = await fetch(`/api/catalog/search?${qs}`, {
    headers: { Accept: "application/json" },
    ...(query.signal ? { signal: query.signal } : {})
  });
  const payload = await readPayload(response);
  if (!response.ok) throw new CatalogHttpError(classify(response.status), messageOf(payload, response.status));
  return parsePage(payload);
}
