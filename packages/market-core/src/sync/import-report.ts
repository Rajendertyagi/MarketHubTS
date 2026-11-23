import type { ProviderId } from "@markethub/contracts";

/** Dry-run/validation summary for one provider master import. No DB writes involved. */
export interface ProviderImportReport {
  provider: ProviderId;
  rowsSeen: number;
  inScopeOptions: number;
  inScopeUnderlyings: number;
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
    skippedOutOfScope: 0,
    invalidRows: 0,
    unresolvedUnderlyings: [],
    duplicateIdentities: [],
    mappingConflicts: []
  };
}

/**
 * Provider-neutral canonical ID derived from the canonical identity key. Both
 * providers therefore produce the same ID for the same canonical contract, and
 * the sync service still resolves it to any pre-existing canonical row.
 */
export function canonicalIdFromIdentity(identityKey: string): string {
  return `cat:${identityKey}`;
}
