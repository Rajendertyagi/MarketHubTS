import { z } from "zod";

/**
 * Dependency-light provider identity leaf.
 *
 * This module deliberately imports nothing from the contracts package so it can
 * be imported as a VALUE by provider.ts, live.ts, market.ts, historical.ts,
 * snapshots.ts and live-components.ts without creating a runtime cycle
 * (provider.ts already value-imports the connection-state schema from live.ts).
 */
export const providerIdSchema = z.enum(["UPSTOX", "FYERS"]);
export type ProviderId = z.infer<typeof providerIdSchema>;
