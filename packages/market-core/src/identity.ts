import type { CanonicalInstrument, InstrumentCategory, OptionType } from "@markethub/contracts";

export const IDENTITY_VERSION = 1;

function norm(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

function normSymbol(value: string): string {
  return norm(value).replace(/[^A-Z0-9._-]+/g, "_");
}

function normCode(value: string): string {
  return norm(value).replace(/[^A-Z0-9._:-]+/g, "_");
}

export function normalizeStrike(strike: number | string): string {
  if (typeof strike === "number") {
    if (!Number.isFinite(strike)) throw new Error("Strike must be finite");
    const s = strike.toString();
    if (/e/i.test(s)) {
      return trimDecimal(strike.toFixed(12));
    }
    return trimDecimal(s);
  }
  const raw = strike.trim();
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) {
    throw new Error("Strike must be a valid decimal number");
  }
  return trimDecimal(raw);
}

function trimDecimal(s: string): string {
  let t = s.trim().replace(/^\+/, "");
  if (t.startsWith(".")) t = "0" + t;
  if (t.startsWith("-.")) t = "-0" + t.slice(1);
  if (!t.includes(".")) return t === "-0" ? "0" : t;
  t = t.replace(/(\.\d*?[1-9])0+$/u, "$1").replace(/\.0+$/u, "");
  return t === "-0" ? "0" : t;
}

export function isDerivativeCategory(cat: InstrumentCategory): boolean {
  return cat === "STOCK_FUTURE" || cat === "STOCK_OPTION" || cat === "INDEX_FUTURE" || cat === "INDEX_OPTION";
}

export function isOptionCategory(cat: InstrumentCategory): boolean {
  return cat === "STOCK_OPTION" || cat === "INDEX_OPTION";
}

export function isFutureCategory(cat: InstrumentCategory): boolean {
  return cat === "STOCK_FUTURE" || cat === "INDEX_FUTURE";
}

export interface IdentityInput {
  exchange: string;
  segment: string;
  instrumentCategory: InstrumentCategory;
  canonicalSymbol: string;
  isin?: string | undefined;
  exchangeSecurityId?: string | undefined;
  stableIdentifier?: string | undefined;
  derivative?: {
    underlyingCanonicalId: string;
    expiryDate: string;
    strike?: number | string | undefined;
    strikeNormalized?: string | undefined;
    optionType?: OptionType | undefined;
  } | undefined;
}

function equityIdentityBasis(input: IdentityInput): string {
  const isin = input.isin?.trim();
  if (isin) return `ISIN:${norm(isin)}`;
  const sec = input.exchangeSecurityId?.trim();
  if (sec) return `SECID:${normCode(sec)}`;
  const stable = input.stableIdentifier?.trim();
  if (stable) return `STABLE:${normCode(stable)}`;
  return `SYMBOL:${normSymbol(input.canonicalSymbol)}`;
}

function indexIdentityBasis(input: IdentityInput): string {
  const sec = input.exchangeSecurityId?.trim();
  if (sec) return `CODE:${normCode(sec)}`;
  const stable = input.stableIdentifier?.trim();
  if (stable) return `CODE:${normCode(stable)}`;
  // Deterministic exchange-specific canonical index identity fallback (code-like normalized symbol)
  return `CODE:${normCode(input.canonicalSymbol)}`;
}

export function computeIdentityKey(input: IdentityInput): string {
  const ex = norm(input.exchange);
  const seg = norm(input.segment);
  const cat = norm(input.instrumentCategory);
  const v = `v${IDENTITY_VERSION}`;

  if (isDerivativeCategory(input.instrumentCategory)) {
    const d = input.derivative;
    if (!d) throw new Error("Derivative identity requires derivative spec");
    if (!d.underlyingCanonicalId?.trim()) throw new Error("Derivative identity requires underlyingCanonicalId");
    const underlying = norm(d.underlyingCanonicalId);
    if (isFutureCategory(input.instrumentCategory)) {
      return `${v}|${ex}|${seg}|${cat}|${underlying}|${d.expiryDate}`;
    }
    const strikeNorm = d.strikeNormalized ?? (d.strike !== undefined ? normalizeStrike(d.strike) : undefined);
    if (d.optionType === undefined || strikeNorm === undefined) {
      throw new Error("Option identity requires strike and optionType");
    }
    return `${v}|${ex}|${seg}|${cat}|${underlying}|${d.expiryDate}|${strikeNorm}|${d.optionType}`;
  }

  if (input.instrumentCategory === "EQUITY") {
    return `${v}|${ex}|${seg}|EQUITY|${equityIdentityBasis(input)}`;
  }
  if (input.instrumentCategory === "INDEX") {
    return `${v}|${ex}|${seg}|INDEX|${indexIdentityBasis(input)}`;
  }
  // fallback (should be rare)
  const stable = input.stableIdentifier?.trim() || input.exchangeSecurityId?.trim() || input.isin?.trim();
  const basis = stable ? `STABLE:${normCode(stable)}` : `SYMBOL:${normSymbol(input.canonicalSymbol)}`;
  return `${v}|${ex}|${seg}|${cat}|${basis}`;
}

export function computeIdentityKeyFromInstrument(instrument: CanonicalInstrument): string {
  return computeIdentityKey({
    exchange: instrument.exchange,
    segment: instrument.segment,
    instrumentCategory: instrument.instrumentCategory,
    canonicalSymbol: instrument.canonicalSymbol,
    isin: instrument.isin,
    exchangeSecurityId: instrument.exchangeSecurityId,
    stableIdentifier: instrument.stableIdentifier,
    ...(instrument.derivative
      ? {
          derivative: {
            underlyingCanonicalId: instrument.derivative.underlyingCanonicalId,
            expiryDate: instrument.derivative.expiryDate,
            strike: instrument.derivative.strike,
            strikeNormalized: instrument.derivative.strikeNormalized,
            optionType: instrument.derivative.optionType
          }
        }
      : {})
  });
}

export function normalizeAliasValue(alias: string): string {
  return norm(alias);
}

export function normalizeScope(value: string | undefined | null): string {
  const v = value?.trim();
  return v ? norm(v) : "*";
}

export function normalizeAliasKey(alias: string, exchange?: string, segment?: string): string {
  return `${normalizeAliasValue(alias)}|${normalizeScope(exchange)}|${normalizeScope(segment)}`;
}
