import {
  canonicalInstrumentSchema,
  providerInstrumentMappingSchema,
  instrumentAliasSchema,
  instrumentIdentifierSchema,
  type CanonicalInstrument,
  type InstrumentAlias,
  type InstrumentIdentifier,
  type ProviderInstrumentMapping
} from "@markethub/contracts";
import { computeIdentityKey, normalizeAliasValue, normalizeScope, normalizeStrike } from "../identity";

export function nowIso(): string {
  return new Date().toISOString();
}

export function makeRunId(): string {
  return crypto.randomUUID();
}

export function normalizeDerivative(inst: CanonicalInstrument): CanonicalInstrument {
  if (!inst.derivative) return inst;
  const d: any = { ...inst.derivative };
  if (d.strike !== undefined || d.strikeNormalized !== undefined) {
    const norm = d.strikeNormalized ?? normalizeStrike(d.strike);
    d.strikeNormalized = norm;
    const n = Number(norm);
    d.strike = Number.isFinite(n) ? n : norm;
  }
  return { ...inst, derivative: d } as CanonicalInstrument;
}

export function normalizeInstrument(input: CanonicalInstrument, now: string): CanonicalInstrument {
  const withDeriv = normalizeDerivative(input);
  const identityKey = computeIdentityKey({
    exchange: withDeriv.exchange,
    segment: withDeriv.segment,
    instrumentCategory: withDeriv.instrumentCategory,
    canonicalSymbol: withDeriv.canonicalSymbol,
    isin: withDeriv.isin,
    exchangeSecurityId: withDeriv.exchangeSecurityId,
    stableIdentifier: withDeriv.stableIdentifier,
    ...(withDeriv.derivative
      ? {
          derivative: {
            underlyingCanonicalId: withDeriv.derivative.underlyingCanonicalId,
            expiryDate: withDeriv.derivative.expiryDate,
            strike: withDeriv.derivative.strike,
            strikeNormalized: (withDeriv.derivative as any).strikeNormalized,
            optionType: withDeriv.derivative.optionType
          }
        }
      : {})
  });
  const canonicalId = withDeriv.canonicalId || crypto.randomUUID();
  return canonicalInstrumentSchema.parse({
    ...withDeriv,
    canonicalId,
    identityKey,
    identityVersion: withDeriv.identityVersion ?? 1,
    createdAt: withDeriv.createdAt ?? now,
    updatedAt: now
  });
}

export function normalizeMapping(input: ProviderInstrumentMapping, now: string): ProviderInstrumentMapping {
  return providerInstrumentMappingSchema.parse({
    ...input,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  });
}

export function normalizeAlias(input: InstrumentAlias, now: string): InstrumentAlias {
  const exchangeScope = normalizeScope(input.exchangeScope ?? input.exchange);
  const segmentScope = normalizeScope(input.segmentScope ?? input.segment);
  return instrumentAliasSchema.parse({
    ...input,
    aliasNormalized: normalizeAliasValue(input.alias),
    exchangeScope,
    segmentScope,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  });
}

export function normalizeIdentifier(input: InstrumentIdentifier, now: string): InstrumentIdentifier {
  const exchangeScope = normalizeScope(input.exchangeScope ?? input.exchange);
  const segmentScope = normalizeScope(input.segmentScope ?? input.segment);
  return instrumentIdentifierSchema.parse({
    ...input,
    identifierNormalized: normalizeAliasValue(input.identifierValue),
    exchangeScope,
    segmentScope,
    createdAt: input.createdAt ?? now,
    updatedAt: now
  });
}

export function mergeInstrument(existing: CanonicalInstrument, incoming: CanonicalInstrument, now: string): CanonicalInstrument {
  const merged: any = {
    ...existing,
    ...incoming,
    canonicalId: existing.canonicalId,
    identityVersion: existing.identityVersion ?? incoming.identityVersion ?? 1,
    // preserve identity-critical fields from existing if incoming omitted them (stability)
    isin: incoming.isin ?? existing.isin,
    exchangeSecurityId: incoming.exchangeSecurityId ?? existing.exchangeSecurityId,
    stableIdentifier: incoming.stableIdentifier ?? existing.stableIdentifier,
    createdAt: existing.createdAt ?? incoming.createdAt ?? now,
    updatedAt: now,
    sourceMeta: { ...(existing.sourceMeta ?? {}), ...(incoming.sourceMeta ?? {}) },
    cashIndexMembership: incoming.cashIndexMembership ?? existing.cashIndexMembership,
    exchangeDerivativeEligibility: incoming.exchangeDerivativeEligibility ?? existing.exchangeDerivativeEligibility,
    productScope: incoming.productScope ?? existing.productScope,
    derivative: incoming.derivative ?? existing.derivative,
    provenance: incoming.provenance ?? existing.provenance
  };
  const recomputed = computeIdentityKey({
    exchange: merged.exchange,
    segment: merged.segment,
    instrumentCategory: merged.instrumentCategory,
    canonicalSymbol: merged.canonicalSymbol,
    isin: merged.isin,
    exchangeSecurityId: merged.exchangeSecurityId,
    stableIdentifier: merged.stableIdentifier,
    ...(merged.derivative
      ? {
          derivative: {
            underlyingCanonicalId: merged.derivative.underlyingCanonicalId,
            expiryDate: merged.derivative.expiryDate,
            strike: merged.derivative.strike,
            strikeNormalized: merged.derivative.strikeNormalized,
            optionType: merged.derivative.optionType
          }
        }
      : {})
  });
  merged.identityKey = recomputed;
  return canonicalInstrumentSchema.parse(merged);
}

export function deriveIdentifiers(inst: CanonicalInstrument, source: string, now: string): InstrumentIdentifier[] {
  const out: InstrumentIdentifier[] = [];
  const base = {
    canonicalId: inst.canonicalId,
    exchange: inst.exchange,
    segment: inst.segment,
    exchangeScope: normalizeScope(inst.exchange),
    segmentScope: normalizeScope(inst.segment),
    source,
    status: "CURRENT" as const,
    createdAt: now,
    updatedAt: now
  };
  if (inst.isin) {
    out.push(normalizeIdentifier({ ...base, identifierType: "ISIN", identifierNamespace: inst.exchange, identifierValue: inst.isin, identifierNormalized: normalizeAliasValue(inst.isin) }, now));
  }
  if (inst.exchangeSecurityId) {
    out.push(normalizeIdentifier({ ...base, identifierType: "EXCHANGE_SECURITY_ID", identifierNamespace: inst.exchange, identifierValue: inst.exchangeSecurityId, identifierNormalized: normalizeAliasValue(inst.exchangeSecurityId) }, now));
  }
  if (inst.stableIdentifier) {
    out.push(normalizeIdentifier({ ...base, identifierType: "STABLE_ID", identifierNamespace: inst.exchange, identifierValue: inst.stableIdentifier, identifierNormalized: normalizeAliasValue(inst.stableIdentifier) }, now));
  }
  out.push(normalizeIdentifier({ ...base, identifierType: "SYMBOL", identifierNamespace: inst.exchange, identifierValue: inst.canonicalSymbol, identifierNormalized: normalizeAliasValue(inst.canonicalSymbol) }, now));
  return out;
}
