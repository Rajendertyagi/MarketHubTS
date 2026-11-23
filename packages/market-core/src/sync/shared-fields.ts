import type { DerivativeSpec, ProviderId, SyncConflict } from "@markethub/contracts";

export const DERIVATIVE_SHARED_FIELD_CONFLICT = "DERIVATIVE_SHARED_FIELD_CONFLICT";
export const DERIVATIVE_ATTRIBUTES_META_KEY = "derivativeAttributes";

/**
 * Provider-neutral derivative attributes that are shared across providers for
 * one canonical contract. `contractLifecycleStatus` is deliberately excluded:
 * it is owned by canonical lifecycle rules, never inferred from a provider.
 */
export const SHARED_DERIVATIVE_FIELDS = [
  "lotSize",
  "tickSize",
  "quantityFreeze",
  "contractSource",
  "contractObservedAt"
] as const;
export type SharedDerivativeField = (typeof SHARED_DERIVATIVE_FIELDS)[number];

export interface SharedFieldAnalysis {
  /** Canonical derivative after filling absent values and preserving existing ones. */
  canonicalDerivative: DerivativeSpec;
  /** Deterministic WARNING conflicts for values that disagree with the canonical row. */
  warnings: SyncConflict[];
  /** Provider-reported values persisted in the importing mapping's sourceMeta. */
  derivativeAttributes: Record<string, unknown>;
}

function stableValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export interface AnalyzeSharedFieldsArgs {
  existing: DerivativeSpec | undefined;
  incoming: DerivativeSpec;
  lastRecorded: Record<string, unknown> | undefined;
  provider: ProviderId;
  nativeIdentifier: string;
  canonicalId: string;
  source: string;
  /** Provider imports must never set, clear or infer the canonical lifecycle status. */
  preserveLifecycle: boolean;
}

/**
 * Compare populated shared derivative attributes against the existing canonical
 * row. Absent canonical values are filled; disagreements preserve the existing
 * canonical value and emit a deterministic WARNING. The provider-reported value
 * is always retained in `derivativeAttributes` for the mapping's sourceMeta.
 * Re-importing an unchanged provider value does not repeat a warning; a changed
 * value emits one new warning.
 */
export function analyzeSharedDerivativeFields(args: AnalyzeSharedFieldsArgs): SharedFieldAnalysis {
  const canonicalDerivative: DerivativeSpec = { ...args.incoming };
  const derivativeAttributes: Record<string, unknown> = { ...(args.lastRecorded ?? {}) };
  const warnings: SyncConflict[] = [];

  for (const field of SHARED_DERIVATIVE_FIELDS) {
    const incomingValue = (args.incoming as Record<string, unknown>)[field];
    const incomingStable = stableValue(incomingValue);
    if (incomingStable === undefined) continue;

    derivativeAttributes[field] = incomingValue;

    const canonicalValue = (args.existing as Record<string, unknown> | undefined)?.[field];
    const canonicalStable = stableValue(canonicalValue);
    if (canonicalStable === undefined) {
      (canonicalDerivative as Record<string, unknown>)[field] = incomingValue;
      continue;
    }

    // Both populated: preserve the existing canonical value (no last-provider-wins).
    (canonicalDerivative as Record<string, unknown>)[field] = canonicalValue;
    if (canonicalStable === incomingStable) continue;

    const recordedStable = stableValue(args.lastRecorded?.[field]);
    if (recordedStable === incomingStable) continue;

    warnings.push({
      type: DERIVATIVE_SHARED_FIELD_CONFLICT,
      severity: "WARNING",
      message: `Shared derivative field ${field} differs from canonical value`,
      canonicalId: args.canonicalId,
      provider: args.provider,
      nativeIdentifier: args.nativeIdentifier,
      details: {
        field,
        canonicalValue: canonicalValue ?? null,
        providerValue: incomingValue,
        source: args.source
      }
    });
  }

  if (args.preserveLifecycle) {
    const existingLifecycle = args.existing?.contractLifecycleStatus;
    if (existingLifecycle === undefined) delete canonicalDerivative.contractLifecycleStatus;
    else canonicalDerivative.contractLifecycleStatus = existingLifecycle;
  }

  return { canonicalDerivative, warnings, derivativeAttributes };
}
