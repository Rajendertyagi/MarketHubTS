import type { FetchLike } from "@markethub/market-core";
import { createFyersRestCooldown, markFyersAccountBlock, type FyersRestCooldown } from "./cooldown";
import { FyersHistoricalAdapter } from "./historical";
import { FyersOptionChainAdapter } from "./option-chain";

export interface FyersRestRuntimeOptions {
  /** app_id:access_token */
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export interface FyersRestRuntime {
  /** The single shared runtime cooldown state owned by this provider runtime. */
  readonly cooldown: FyersRestCooldown;
  readonly history: FyersHistoricalAdapter;
  readonly optionChain: FyersOptionChainAdapter;
  /** Account-level REST block applies across all REST categories. */
  markAccountBlock(resetAtMs: number | null, detail: string): void;
}

/**
 * Compose one FYERS provider runtime: a single instance-owned cooldown state
 * shared by all its REST adapters (regular history, expired F&O, option chain).
 * This is the supported ownership contract for cross-adapter Data API and
 * account-level restrictions. It is NOT production wiring — activating a real
 * provider runtime remains Phase 4B/Stage G. Standalone adapter construction
 * stays available and testable; each standalone adapter owns fresh state.
 */
export function createFyersRestAdapters(options: FyersRestRuntimeOptions): FyersRestRuntime {
  const cooldown = createFyersRestCooldown();
  const history = new FyersHistoricalAdapter({ ...options, cooldown });
  const optionChain = new FyersOptionChainAdapter({ ...options, cooldown });
  return {
    cooldown,
    history,
    optionChain,
    markAccountBlock: (resetAtMs, detail) => markFyersAccountBlock(cooldown, resetAtMs, detail)
  };
}
