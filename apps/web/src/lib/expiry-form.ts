import {
  parseIstDateOnly,
  type DerivativeExpiriesResponse,
  type ProviderId
} from "@markethub/contracts";

/** Where the current expiry value came from. */
export type ExpiryOrigin = "Catalogue" | "Manual";

export const CATALOGUE_ORIGIN_LABEL = "Catalogue";
export const MANUAL_ORIGIN_LABEL = "Manual — not verified against the current provider master";

/** True only for a real `YYYY-MM-DD` calendar date (rejects e.g. 2026-02-30). */
export function isValidExpiryDate(value: string): boolean {
  return Number.isFinite(parseIstDateOnly(value.trim()));
}

/**
 * Catalogue only when the exact trimmed value is in the current response list;
 * otherwise Manual. A typed date that is absent from the list stays unverified.
 */
export function expiryOrigin(value: string, options: readonly string[]): ExpiryOrigin {
  const trimmed = value.trim();
  return trimmed.length > 0 && options.includes(trimmed) ? "Catalogue" : "Manual";
}

export function expiryOriginLabel(origin: ExpiryOrigin): string {
  return origin === "Catalogue" ? CATALOGUE_ORIGIN_LABEL : MANUAL_ORIGIN_LABEL;
}

export type ExpiryLoadState = "idle" | "loading" | "loaded" | "error";
export type ExpiryStatusKind = "idle" | "loading" | "empty" | "error" | "stale" | "unknown" | "fresh";

export interface ExpiryStatusInfo {
  kind: ExpiryStatusKind;
  /** Visible status text; empty when there is nothing to report. */
  text: string;
  /** True when the list is not confirmed fresh (STALE or UNKNOWN). */
  stale: boolean;
  /** Manual entry is always available; kept explicit for the UI and tests. */
  manualAvailable: true;
}

/**
 * Derive the honest loading/empty/error/stale/fresh message from the API
 * freshness metadata. Manual entry remains available in every state.
 */
export function expiryStatusInfo(
  state: ExpiryLoadState,
  response: DerivativeExpiriesResponse | null,
  error: string | null
): ExpiryStatusInfo {
  if (state === "loading") {
    return { kind: "loading", text: "Loading expiries from the catalogue…", stale: false, manualAvailable: true };
  }
  if (state === "error") {
    return {
      kind: "error",
      text: `Could not load expiries: ${error ?? "unknown error"}. Retry or enter a date manually.`,
      stale: false,
      manualAvailable: true
    };
  }
  if (state === "loaded" && response) {
    const parts: string[] = [];
    let kind: ExpiryStatusKind = "fresh";
    let stale = false;
    if (response.freshness.state === "STALE") {
      parts.push("Catalogue expiries are stale — showing the last successful import, not confirmed fresh.");
      kind = "stale";
      stale = true;
    } else if (response.freshness.state === "UNKNOWN") {
      parts.push("Catalogue freshness is unknown — suggestions are not confirmed fresh.");
      kind = "unknown";
      stale = true;
    }
    if (response.expiries.length === 0) {
      parts.push("No catalogue expiries for this underlying and provider.");
      if (kind === "fresh") kind = "empty";
    }
    if (parts.length > 0) parts.push("You can still enter a date manually.");
    return { kind, text: parts.join(" "), stale, manualAvailable: true };
  }
  return { kind: "idle", text: "", stale: false, manualAvailable: true };
}

export interface ExpirySelection {
  underlyingCanonicalId: string;
  provider: ProviderId;
}

export interface ExpiryState {
  /** Current expiry value (catalogue-selected or manually typed). */
  value: string;
  origin: ExpiryOrigin | null;
  /** Suggestions come only from the WP4B response; never hardcoded. */
  options: string[];
  loadState: ExpiryLoadState;
  error: string | null;
  response: DerivativeExpiriesResponse | null;
  /** The underlying/provider the current options belong to. */
  selection: ExpirySelection | null;
}

export function initialExpiryState(): ExpiryState {
  return { value: "", origin: null, options: [], loadState: "idle", error: null, response: null, selection: null };
}

export interface ExpiryFetchQuery {
  underlyingCanonicalId: string;
  provider: ProviderId;
  signal?: AbortSignal;
}

export interface ExpiryControllerDeps {
  fetchExpiries: (query: ExpiryFetchQuery) => Promise<DerivativeExpiriesResponse>;
  onState: (state: ExpiryState) => void;
}

/**
 * Framework-free controller for expiry discovery. Injectable fetch makes the
 * loading/success/empty/error/stale states, selection invalidation and the
 * late-response race testable without a DOM. A monotonic generation guard plus
 * AbortController ensures a response for an older underlying/provider can
 * never repopulate a newer selection.
 */
export function createExpiryController(deps: ExpiryControllerDeps) {
  let generation = 0;
  let controller: AbortController | null = null;
  let disposed = false;
  let state = initialExpiryState();
  let lastSelection: ExpirySelection | null = null;

  const emit = (patch: Partial<ExpiryState>) => {
    state = { ...state, ...patch };
    deps.onState(state);
  };
  const current = (gen: number) => !disposed && gen === generation;

  const clear = (): void => {
    generation++;
    if (controller) controller.abort();
    controller = null;
    lastSelection = null;
    emit({ value: "", origin: null, options: [], loadState: "idle", error: null, response: null, selection: null });
  };

  const load = (selection: ExpirySelection): void => {
    const underlyingCanonicalId = selection.underlyingCanonicalId.trim();
    const changed = !state.selection
      || state.selection.underlyingCanonicalId !== underlyingCanonicalId
      || state.selection.provider !== selection.provider;

    const gen = ++generation;
    if (controller) controller.abort();
    controller = null;

    if (!underlyingCanonicalId || !selection.provider) {
      lastSelection = null;
      emit({
        ...(changed ? { value: "", origin: null } : {}),
        options: [], loadState: "idle", error: null, response: null, selection: null
      });
      return;
    }

    controller = new AbortController();
    const signal = controller.signal;
    const active = { underlyingCanonicalId, provider: selection.provider };
    lastSelection = active;
    // Synchronous invalidation before any await: an old date/marker cannot be
    // carried across instruments or providers.
    emit({
      ...(changed ? { value: "", origin: null } : {}),
      options: [], loadState: "loading", error: null, response: null, selection: active
    });

    void deps.fetchExpiries({ ...active, signal })
      .then((response) => {
        if (!current(gen)) return;
        const options = response.expiries.slice();
        const trimmed = state.value.trim();
        // Relabel a manual date that now appears in this provider's list; keep
        // the manual warning when it is absent.
        const origin: ExpiryOrigin | null = trimmed ? expiryOrigin(trimmed, options) : null;
        emit({ loadState: "loaded", options, response, origin });
      })
      .catch((error: unknown) => {
        if (!current(gen)) return;
        if (error instanceof Error && error.name === "AbortError") return;
        // No current response confirms the value any more: keep it as a manual
        // fallback but drop a stale Catalogue provenance label.
        const trimmed = state.value.trim();
        emit({
          loadState: "error",
          error: error instanceof Error ? error.message : String(error),
          options: [], response: null,
          origin: trimmed ? expiryOrigin(trimmed, []) : null
        });
      });
  };

  /** Set the value from either the suggestion list or the manual input. */
  const setValue = (value: string): void => {
    const trimmed = value.trim();
    emit({ value, origin: trimmed ? expiryOrigin(trimmed, state.options) : null });
  };

  const retry = (): void => {
    if (lastSelection) load(lastSelection);
  };

  return {
    getState: () => state,
    load,
    clear,
    setValue,
    retry,
    dispose: () => {
      disposed = true;
      generation++;
      if (controller) controller.abort();
    }
  };
}

export type ExpiryController = ReturnType<typeof createExpiryController>;
