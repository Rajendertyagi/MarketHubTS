import * as z from "zod/v4";
import { candleIntervalSchema } from "@markethub/contracts";

/** Parse ISO-8601 date strings into an epoch-ms range. Shared by historical tools. */
export function parseRange(from: string, to: string): { fromMs: number; toMs: number } | { error: string } {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { error: "from and to must be valid ISO-8601 date strings" };
  }
  if (fromMs > toMs) return { error: "from must not be after to" };
  return { fromMs, toMs };
}

const provider = z.enum(["UPSTOX", "FYERS"]);
const interval = candleIntervalSchema;

export const healthInput = z.object({});

export const catalogSearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().optional()
});

export const providerStatusInput = z.object({});

export const marketSnapshotInput = z.object({ canonicalId: z.string().min(1).optional() });

export const historicalCandlesInput = z.object({
  canonicalId: z.string().min(1),
  interval,
  from: z.string().min(1),
  to: z.string().min(1),
  mode: z.enum(["cached", "coverage", "onDemand"])
});

/** Strict mode-specific option-chain input. */
export const optionChainSnapshotInput = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("list"),
    configId: z.string().min(1).optional(),
    fromMs: z.number().finite().optional(),
    toMs: z.number().finite().optional()
  }).refine((v) => !(v.fromMs !== undefined && v.toMs !== undefined && v.fromMs > v.toMs), {
    message: "fromMs must not be after toMs"
  }),
  z.object({ mode: z.literal("get"), snapshotId: z.string().min(1) }),
  z.object({
    mode: z.literal("capture"),
    underlyingCanonicalId: z.string().min(1),
    expiryDate: z.string().min(1),
    provider: provider.optional(),
    strikeRangeJson: z.string().optional(),
    nativeIdentifier: z.string().optional()
  })
]);

export const onDemandRetrievalInput = z.object({
  kind: z.enum(["historical", "option_chain"]),
  canonicalId: z.string().min(1),
  interval: candleIntervalSchema.optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  expiryDate: z.string().min(1).optional(),
  provider: provider.optional()
});

export const unavailableToolInput = z.object({});
