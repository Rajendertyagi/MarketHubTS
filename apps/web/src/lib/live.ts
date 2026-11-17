import {
  liveSnapshotSchema,
  liveChangeEventSchema,
  snapshotRequiredEventSchema,
  refreshEventSchema,
  type LiveSnapshot,
  type LiveItem,
  type LiveChangeEvent,
  type ProviderId,
  type ProviderConnectionStatus,
  type SelectionMode,
  type LiveFreshnessState,
  type ObservationAgeBasis,
  type TimestampUnit,
  type AvailabilityState
} from "@markethub/contracts";

// --- Cursor / revision validation (matches backend parseCursorValue semantics) ---

export type CursorParse =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "value"; value: number };

/**
 * Validate a raw cursor string exactly like the backend: regex on the raw
 * string BEFORE numeric conversion, then safe-integer and non-negative checks.
 */
export function parseCursorValue(raw: string): CursorParse {
  if (raw === "" || !/^\d+$/.test(raw)) return { kind: "invalid", reason: "invalid-cursor" };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return { kind: "invalid", reason: "invalid-cursor" };
  return { kind: "value", value };
}

export function isSafeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Zod's inferred optional properties include `| undefined`, which is not
 * assignable to the hand-written contracts interfaces under
 * exactOptionalPropertyTypes. The schema remains the validation authority;
 * this cast only bridges that structural difference.
 */
export function parseSnapshot(payload: unknown): LiveSnapshot {
  return liveSnapshotSchema.parse(payload) as LiveSnapshot;
}

// --- SSE message parsing ---

export type ParsedSseMessage =
  | { kind: "snapshot"; snapshot: LiveSnapshot }
  | { kind: "data"; event: LiveChangeEvent }
  | { kind: "control"; control: "snapshot-required" | "refresh" }
  | { kind: "invalid"; reason: string };

/**
 * Parse an SSE message. Control events are identified by payload type only —
 * their MessageEvent.lastEventId may retain a previous data-event ID and is
 * never required to be empty. Data/snapshot events validate their id against
 * the payload revision with safe-integer checks.
 */
export function parseSseMessage(lastEventId: string, dataText: string): ParsedSseMessage {
  let payload: unknown;
  try {
    payload = JSON.parse(dataText);
  } catch {
    return { kind: "invalid", reason: "malformed-json" };
  }

  if (snapshotRequiredEventSchema.safeParse(payload).success) {
    return { kind: "control", control: "snapshot-required" };
  }
  if (refreshEventSchema.safeParse(payload).success) {
    return { kind: "control", control: "refresh" };
  }

  const snapshot = liveSnapshotSchema.safeParse(payload);
  if (snapshot.success) {
    const id = parseCursorValue(lastEventId);
    if (id.kind !== "value" || id.value !== snapshot.data.revision || !isSafeRevision(snapshot.data.revision)) {
      return { kind: "invalid", reason: "snapshot-id-mismatch" };
    }
    return { kind: "snapshot", snapshot: snapshot.data as LiveSnapshot };
  }

  const event = liveChangeEventSchema.safeParse(payload);
  if (!event.success || !isSafeRevision(event.data.revision)) {
    return { kind: "invalid", reason: "invalid-event" };
  }
  const id = parseCursorValue(lastEventId);
  if (id.kind !== "value" || id.value !== event.data.revision) {
    return { kind: "invalid", reason: "id-revision-mismatch" };
  }
  return { kind: "data", event: event.data };
}

// --- Pure reducer ---

export type ApplyResult =
  | { kind: "applied"; snapshot: LiveSnapshot }
  | { kind: "duplicate" }
  | { kind: "gap" }
  | { kind: "invalidation-required" }
  | { kind: "invalid"; reason: string };

/**
 * Apply a data event to a snapshot. provider-connection-changed is never
 * partially applied — it requires full snapshot invalidation/recovery.
 */
export function applyDataEvent(snapshot: LiveSnapshot, event: LiveChangeEvent): ApplyResult {
  if (!isSafeRevision(event.revision)) return { kind: "invalid", reason: "unsafe-revision" };
  // Ordering matters: a duplicate or stale provider-connection event must be
  // ignored before it can trigger a full snapshot invalidation.
  if (event.revision <= snapshot.revision) return { kind: "duplicate" };
  if (event.revision > snapshot.revision + 1) return { kind: "gap" };
  if (event.type === "provider-connection-changed") return { kind: "invalidation-required" };

  let items = snapshot.items;
  if (event.type === "item-updated") {
    const index = items.findIndex((item) => item.canonicalId === event.canonicalId);
    const item = event.item as LiveItem;
    items = index >= 0
      ? [...items.slice(0, index), item, ...items.slice(index + 1)]
      : [...items, item];
  } else {
    items = items.filter((item) => item.canonicalId !== event.canonicalId);
  }
  return { kind: "applied", snapshot: { ...snapshot, revision: event.revision, items } };
}

// --- Canonical display-model projection (no depth, no provider-native data) ---

export interface DisplayProvenance {
  source: string;
  provider?: ProviderId;
  sourceObservedAt?: string;
  receivedAt?: string;
  syncedAt?: string;
  sourceVersion?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  notes?: string;
}

export interface DisplayItem {
  canonicalId: string;
  ltp?: number;
  lastTradedQuantity?: number;
  close?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  mode: SelectionMode;
  freshness: LiveFreshnessState;
  reason: string;
  provider: ProviderId | null;
  observationProvider?: ProviderId;
  observationFreshness?: LiveFreshnessState;
  ageBasis?: ObservationAgeBasis;
  timestampTrusted?: boolean;
  normalizedProviderTimestampMs?: number | null;
  rawProviderTimestamp?: number | null;
  providerTimestampUnit?: TimestampUnit;
  providerTimestampMeaning?: string;
  receivedAtMs?: number;
  providerSequence?: number | null;
  availability?: AvailabilityState;
  provenance?: DisplayProvenance;
  updatedAtMs: number;
}

export interface DisplayModel {
  revision: number;
  capturedAtMs: number;
  items: DisplayItem[];
  connections: ProviderConnectionStatus[];
}

/**
 * Project a snapshot into an explicit allow-list of canonical fields.
 * `value.native` and any unrecognized field are never copied.
 */
export function projectDisplayModel(snapshot: LiveSnapshot): DisplayModel {
  return {
    revision: snapshot.revision,
    capturedAtMs: snapshot.capturedAtMs,
    connections: snapshot.connections.map((c) => ({ ...c })),
    items: snapshot.items.map((item) => {
      const selected = item.selected;
      const value = selected.value;
      const observation = selected.observation;
      const projected: DisplayItem = {
        canonicalId: item.canonicalId,
        mode: selected.mode,
        freshness: selected.freshness,
        reason: selected.reason,
        provider: selected.provider,
        updatedAtMs: item.updatedAtMs
      };
      if (value) {
        if (value.ltp !== undefined) projected.ltp = value.ltp;
        if (value.lastTradedQuantity !== undefined) projected.lastTradedQuantity = value.lastTradedQuantity;
        if (value.close !== undefined) projected.close = value.close;
        if (value.open !== undefined) projected.open = value.open;
        if (value.high !== undefined) projected.high = value.high;
        if (value.low !== undefined) projected.low = value.low;
        if (value.volume !== undefined) projected.volume = value.volume;
      }
      if (observation) {
        projected.observationProvider = observation.provider;
        projected.observationFreshness = observation.freshness;
        projected.ageBasis = observation.ageBasis;
        projected.timestampTrusted = observation.timestampTrusted;
        projected.normalizedProviderTimestampMs = observation.normalizedProviderTimestampMs;
        projected.rawProviderTimestamp = observation.rawProviderTimestamp;
        projected.providerTimestampUnit = observation.providerTimestampUnit;
        projected.providerTimestampMeaning = observation.providerTimestampMeaning;
        projected.receivedAtMs = observation.receivedAtMs;
        projected.providerSequence = observation.providerSequence;
        projected.availability = observation.availability;
        const p = observation.provenance;
        projected.provenance = {
          source: p.source,
          ...(p.provider !== undefined ? { provider: p.provider } : {}),
          ...(p.sourceObservedAt !== undefined ? { sourceObservedAt: p.sourceObservedAt } : {}),
          ...(p.receivedAt !== undefined ? { receivedAt: p.receivedAt } : {}),
          ...(p.syncedAt !== undefined ? { syncedAt: p.syncedAt } : {}),
          ...(p.sourceVersion !== undefined ? { sourceVersion: p.sourceVersion } : {}),
          ...(p.effectiveFrom !== undefined ? { effectiveFrom: p.effectiveFrom } : {}),
          ...(p.effectiveTo !== undefined ? { effectiveTo: p.effectiveTo } : {}),
          ...(p.notes !== undefined ? { notes: p.notes } : {})
        };
      }
      return projected;
    })
  };
}
