import type { CapabilityResult, SubscriptionRuntimeStatus } from "@markethub/contracts";
import { StatusBadge } from "./StatusBadge";

// Local presentation-only mapping. The contract status values are rendered
// verbatim as the badge label; this only chooses the visual tone. The two
// capability vocabularies (ProviderCapability vs CapabilityResult) stay separate.
type BadgeTone = "ok" | "warn" | "error" | "neutral";

const CAPABILITY_TONES: Record<CapabilityResult["status"], BadgeTone> = {
  SUPPORTED: "ok",
  LIMITED: "warn",
  UNSUPPORTED: "error",
  UNAVAILABLE: "neutral"
};

/**
 * Pure presentational view of one subscription runtime status entry.
 * Renders connection state, last error and the optional structured
 * component-capability report supplied by the backend.
 */
export function SubscriptionRuntimeView({
  runtime,
  providerKey
}: {
  runtime: SubscriptionRuntimeStatus;
  providerKey?: string;
}) {
  const capabilities = runtime.capabilities ?? [];

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      {providerKey && (
        <h5 className="mb-2 text-xs font-semibold text-slate-200 break-all">{providerKey}</h5>
      )}
      <p className="text-xs text-slate-400">
        Connection: {runtime.connectionState.replaceAll("_", " ")} · Generation: {runtime.generation}
      </p>
      {runtime.lastError && <p className="mt-1 text-xs text-amber-300">{runtime.lastError}</p>}

      <div className="mt-2">
        <p className="mb-1 text-xs font-semibold text-slate-300">Capabilities</p>
        {capabilities.length === 0 ? (
          <p className="text-xs text-slate-400">No runtime capability report</p>
        ) : (
          <ul className="space-y-2">
            {capabilities.map((capability, index) => (
              <li
                key={`${capability.provider}-${capability.component}-${index}`}
                className="rounded border border-slate-800 bg-slate-900/40 p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-200">{capability.component}</span>
                  <StatusBadge label={capability.status} tone={CAPABILITY_TONES[capability.status]} />
                </div>
                {capability.fields && capability.fields.length > 0 && (
                  <p className="mt-1 text-xs text-slate-400">Fields: {capability.fields.join(", ")}</p>
                )}
                {capability.levels !== undefined && (
                  <p className="mt-1 text-xs text-slate-400">Levels: {capability.levels}</p>
                )}
                {capability.reason !== undefined && (
                  <p className="mt-1 text-xs text-slate-400">Reason: {capability.reason}</p>
                )}
                {capability.entitlementUnverified === true && (
                  <p className="mt-1 text-xs text-amber-300">Entitlement not verified</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
