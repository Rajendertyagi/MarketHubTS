import type { CanonicalInstrument, SyncConflict } from "@markethub/contracts";
import { normalizeAliasValue, normalizeScope } from "../identity";
import type { CatalogRepositoryTx } from "../types";

export type EnrichmentResult =
  | { canonicalId: string; existing: CanonicalInstrument }
  | { conflict: SyncConflict }
  | null;

export async function tryResolveEnrichment(tx: CatalogRepositoryTx, incoming: CanonicalInstrument): Promise<EnrichmentResult> {
  // Minimal enrichment: symbol-only existing equity/index can be enriched with ISIN in same exchange/segment/category.
  // Never auto-enrich using expired/historical symbol alone; require current, contextually matching and unambiguous identifier.
  if (!incoming.isin) return null;
  if (incoming.instrumentCategory !== "EQUITY" && incoming.instrumentCategory !== "INDEX") return null;
  const symbolNorm = normalizeAliasValue(incoming.canonicalSymbol);
  const candidates = await tx.findIdentifiers({
    identifierType: "SYMBOL",
    identifierNamespace: incoming.exchange,
    identifierNormalized: symbolNorm,
    exchangeScope: normalizeScope(incoming.exchange),
    segmentScope: normalizeScope(incoming.segment),
    status: "CURRENT"
  });
  const uniqueCanonicalIds = [...new Set(candidates.map((c) => c.canonicalId))];
  if (uniqueCanonicalIds.length === 0) return null;
  if (uniqueCanonicalIds.length > 1) {
    return { conflict: { type: "AMBIGUOUS_ENRICHMENT", severity: "ERROR", message: "Multiple instruments match current symbol for ISIN enrichment", details: { symbol: incoming.canonicalSymbol, isin: incoming.isin } } };
  }
  const canonicalId = uniqueCanonicalIds[0]!;
  const existing = await tx.getInstrumentByCanonicalId(canonicalId);
  if (!existing) return null;
  if (existing.exchange !== incoming.exchange || existing.segment !== incoming.segment || existing.instrumentCategory !== incoming.instrumentCategory) {
    return { conflict: { type: "AMBIGUOUS_ENRICHMENT", severity: "ERROR", message: "Symbol match does not align with instrument context for enrichment", canonicalId } };
  }
  // detect symbol reuse/conflict: if existing already has a different current ISIN, do not enrich
  if (existing.isin && normalizeAliasValue(existing.isin) !== normalizeAliasValue(incoming.isin)) {
    return { conflict: { type: "IDENTIFIER_CONFLICT", severity: "ERROR", message: "Existing instrument has different ISIN; enrichment ambiguous", canonicalId, details: { existingIsin: existing.isin, incomingIsin: incoming.isin } } };
  }
  // ensure no other instrument already has this ISIN identity in same context (current or historical ownership conflict)
  const isinNorm = normalizeAliasValue(incoming.isin);
  const isinMatches = await tx.findIdentifiers({ identifierType: "ISIN", identifierNamespace: incoming.exchange, identifierNormalized: isinNorm, exchangeScope: normalizeScope(incoming.exchange), segmentScope: normalizeScope(incoming.segment) });
  const otherIsinOwners = [...new Set(isinMatches.map((m) => m.canonicalId))].filter((id) => id !== canonicalId);
  if (otherIsinOwners.length > 0) {
    return { conflict: { type: "IDENTIFIER_CONFLICT", severity: "ERROR", message: "ISIN already associated with different canonical instrument", canonicalId, details: { isin: incoming.isin, otherCanonicalIds: otherIsinOwners } } };
  }
  return { canonicalId, existing };
}
