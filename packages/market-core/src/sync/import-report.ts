import type { ProviderId } from "@markethub/contracts";

/** Dry-run/validation summary for one provider master import. No DB writes involved. */
export interface ProviderImportReport {
  provider: ProviderId;
  rowsSeen: number;
  inScopeOptions: number;
  inScopeUnderlyings: number;
  /** In-scope rows actually imported, keyed by the provider's own segment value. */
  inScopeBySegment: Record<string, number>;
  skippedOutOfScope: number;
  invalidRows: number;
  unresolvedUnderlyings: string[];
  duplicateIdentities: string[];
  mappingConflicts: string[];
}

export function emptyImportReport(provider: ProviderId): ProviderImportReport {
  return {
    provider,
    rowsSeen: 0,
    inScopeOptions: 0,
    inScopeUnderlyings: 0,
    inScopeBySegment: {},
    skippedOutOfScope: 0,
    invalidRows: 0,
    unresolvedUnderlyings: [],
    duplicateIdentities: [],
    mappingConflicts: []
  };
}

/** Required in-scope FO segments for a complete Upstox BOD snapshot. */
export const REQUIRED_UPSTOX_SEGMENTS = ["NSE_FO", "BSE_FO"] as const;
/** Required in-scope segments for a complete FYERS Symbol Master snapshot. */
export const REQUIRED_FYERS_SEGMENTS = ["NSE_FO", "BSE_FO", "NSE_CM", "BSE_CM"] as const;

export interface CompleteImportValidation {
  ok: boolean;
  /** Stable, concise failure codes; never contains raw rows or credentials. */
  errors: string[];
}

/**
 * Fail-closed validation of a complete provider import report. The refresh
 * owner calls this BEFORE `applyCompleteProviderSnapshot` so a malformed or
 * unexpectedly empty master can never trigger destructive reconciliation.
 * Expected `skippedOutOfScope` rows are deliberately not a failure.
 */
export function validateCompleteImportReport(
  report: ProviderImportReport,
  provider: ProviderId
): CompleteImportValidation {
  const errors: string[] = [];
  if (report.invalidRows > 0) errors.push(`INVALID_ROWS:${report.invalidRows}`);
  if (report.unresolvedUnderlyings.length > 0) {
    errors.push(`UNRESOLVED_UNDERLYINGS:${report.unresolvedUnderlyings.length}`);
  }
  if (report.duplicateIdentities.length > 0) {
    errors.push(`DUPLICATE_IDENTITIES:${report.duplicateIdentities.length}`);
  }
  if (report.mappingConflicts.length > 0) {
    errors.push(`MAPPING_CONFLICTS:${report.mappingConflicts.length}`);
  }
  if (report.inScopeOptions === 0) errors.push("NO_IN_SCOPE_OPTIONS");
  if (report.inScopeUnderlyings === 0) errors.push("NO_IN_SCOPE_UNDERLYINGS");
  const required = provider === "UPSTOX" ? REQUIRED_UPSTOX_SEGMENTS : REQUIRED_FYERS_SEGMENTS;
  for (const segment of required) {
    if ((report.inScopeBySegment?.[segment] ?? 0) === 0) {
      errors.push(`EMPTY_REQUIRED_SEGMENT:${segment}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Provider-neutral canonical ID derived from the canonical identity key. Both
 * providers therefore produce the same ID for the same canonical contract, and
 * the sync service still resolves it to any pre-existing canonical row.
 */
export function canonicalIdFromIdentity(identityKey: string): string {
  return `cat:${identityKey}`;
}
