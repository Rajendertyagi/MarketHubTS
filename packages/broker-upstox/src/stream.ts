import type {
  CredentialStore,
  ProviderConnectionState
} from "@markethub/contracts";
import type { NormalizeObservationInput } from "@markethub/market-core";
import { fetchWithTimeout, sanitizeError, type FetchLike } from "@markethub/market-core";
import { decodeFeedResponse } from "./decode";
import { UPSTOX_TOKEN_CREDENTIAL } from "./constants";

export const UPSTOX_FEED_AUTHORIZE_URL = "https://api.upstox.com/v3/feed/market-data-feed/authorize";

/** Published V3 limits (verified 2026-11-16). Individual / combined. */
export const UPSTOX_V3_LIMITS = {
  connectionsPerUser: 2,
  ltpc: { individual: 5000, combined: 2000 },
  optionGreeks: { individual: 3000, combined: 2000 },
  full: { individual: 2000, combined: 1500 }
} as const;

export type UpstoxFeedMode = "ltpc" | "full" | "option_greeks" | "full_d30";

export interface UpstoxSubscription {
  /** Provider-native instrument key, e.g. "NSE_INDEX|Nifty 50". */
  instrumentKey: string;
  /** M2 canonical identity supplied by the caller — never invented here. */
  canonicalId: string;
  mode?: UpstoxFeedMode;
}

export interface UpstoxStreamCallbacks {
  onObservation: (input: NormalizeObservationInput) => void;
  onConnectionState: (state: ProviderConnectionState, error?: string | null) => void;
}

/** Minimal socket surface so tests can inject a mock without a real WS server. */
export interface StreamSocket {
  binaryType: string;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => StreamSocket;

export interface UpstoxStreamOptions {
  credentials: CredentialStore;
  now?: () => Date;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  webSocketFactory?: WebSocketFactory;
  /** Defaults to the conservative combined LTPC limit (2000). */
  maxSubscriptions?: number;
}

function defaultWebSocketFactory(url: string): StreamSocket {
  const socket = new WebSocket(url);
  // Bun extends BinaryType with "nodebuffer"; DOM lib types do not include it.
  (socket as unknown as { binaryType: string }).binaryType = "nodebuffer";
  return socket as unknown as StreamSocket;
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && typeof (data as { arrayBuffer?: unknown }).arrayBuffer === "function") {
    // Blob-like (browser default binaryType); callers should set nodebuffer.
    return null;
  }
  return null;
}

/**
 * Upstox V3 market-data stream. Owns only the provider protocol: authorize,
 * connect, binary subscribe/unsubscribe, protobuf decode and validation.
 * Emits shared NormalizeObservationInput values; it never owns a live store.
 */
export class UpstoxMarketDataStream {
  private readonly now: () => Date;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly maxSubscriptions: number;
  private socket: StreamSocket | null = null;
  private subscriptions = new Map<string, UpstoxSubscription>();
  private callbacks: UpstoxStreamCallbacks | null = null;
  private state: ProviderConnectionState = "NOT_STARTED";

  constructor(private readonly options: UpstoxStreamOptions) {
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? fetchWithTimeout;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.maxSubscriptions = options.maxSubscriptions ?? UPSTOX_V3_LIMITS.ltpc.combined;
  }

  getConnectionState(): ProviderConnectionState {
    return this.state;
  }

  getSubscriptions(): UpstoxSubscription[] {
    return [...this.subscriptions.values()].map((s) => ({ ...s }));
  }

  private setState(state: ProviderConnectionState, error: string | null = null): void {
    this.state = state;
    this.callbacks?.onConnectionState(state, error);
  }

  private validateSubscriptions(subscriptions: UpstoxSubscription[]): void {
    if (subscriptions.length === 0) throw new Error("At least one subscription is required");
    if (subscriptions.length > this.maxSubscriptions) {
      throw new Error(`Subscription count ${subscriptions.length} exceeds limit ${this.maxSubscriptions}`);
    }
    const seen = new Set<string>();
    for (const sub of subscriptions) {
      if (!sub.instrumentKey || !sub.canonicalId) {
        throw new Error("Each subscription requires an instrumentKey and canonicalId");
      }
      if (seen.has(sub.instrumentKey)) throw new Error(`Duplicate instrument key: ${sub.instrumentKey}`);
      seen.add(sub.instrumentKey);
    }
  }

  /** Fetch a fresh single-use socket URL. No generic retry: each attempt authorizes anew. */
  private async authorize(): Promise<string> {
    const token = await this.options.credentials.get("UPSTOX", UPSTOX_TOKEN_CREDENTIAL);
    if (!token) throw new Error("Upstox Analytics Token is not configured");
    const init: RequestInit = {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
    };
    const response = await this.fetchImpl(UPSTOX_FEED_AUTHORIZE_URL, init, this.timeoutMs);
    if (response.status !== 200) throw new Error(`Upstox feed authorization failed with HTTP ${response.status}`);
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Upstox feed authorization returned a malformed response");
    }
    const uri = payload?.data?.authorized_redirect_uri;
    if (payload?.status !== "success" || typeof uri !== "string" || !uri.startsWith("wss://")) {
      throw new Error("Upstox feed authorization returned an unexpected response shape");
    }
    return uri;
  }

  /** Connect and subscribe. Callers drive reconnection by calling start() again. */
  async start(subscriptions: UpstoxSubscription[], callbacks: UpstoxStreamCallbacks): Promise<void> {
    this.validateSubscriptions(subscriptions);
    if (this.socket) throw new Error("Upstox stream is already connected");
    this.callbacks = callbacks;
    this.setState("CONNECTING");
    try {
      const uri = await this.authorize();
      const socket = this.webSocketFactory(uri);
      socket.onopen = () => {
        this.setState("STREAMING");
        this.sendFrame("sub", [...this.subscriptions.values()]);
      };
      socket.onmessage = (event) => this.handleMessage(event);
      socket.onclose = () => {
        this.socket = null;
        this.setState("DISCONNECTED");
      };
      socket.onerror = () => {
        this.setState("ERROR", "Upstox feed socket error");
      };
      this.subscriptions = new Map(subscriptions.map((s) => [s.instrumentKey, { ...s }]));
      this.socket = socket;
    } catch (error) {
      this.setState("ERROR", sanitizeError(error));
      throw error;
    }
  }

  /** Diff desired subscriptions and send the appropriate binary frames. */
  async updateSubscriptions(subscriptions: UpstoxSubscription[]): Promise<void> {
    this.validateSubscriptions(subscriptions);
    const next = new Map(subscriptions.map((s) => [s.instrumentKey, { ...s }]));
    const removed = [...this.subscriptions.keys()].filter((key) => !next.has(key));
    const added = [...next.values()].filter((s) => !this.subscriptions.has(s.instrumentKey));
    const modeChanged = [...next.values()].filter((s) => {
      const current = this.subscriptions.get(s.instrumentKey);
      return current && current.mode !== s.mode;
    });
    this.subscriptions = next;
    if (!this.socket || this.socket.readyState !== 1) return; // apply on next open
    if (removed.length) this.sendFrame("unsub", removed.map((key) => ({ instrumentKey: key, canonicalId: "" })));
    if (added.length) this.sendFrame("sub", added);
    if (modeChanged.length) this.sendFrame("change_mode", modeChanged);
  }

  private sendFrame(method: "sub" | "unsub" | "change_mode", subs: UpstoxSubscription[]): void {
    if (!this.socket || subs.length === 0) return;
    const mode = subs[0]?.mode ?? "ltpc";
    const frame: Record<string, unknown> = {
      guid: crypto.randomUUID(),
      method,
      data: { instrumentKeys: subs.map((s) => s.instrumentKey) }
    };
    if (method !== "unsub") (frame.data as Record<string, unknown>).mode = mode;
    this.socket.send(new TextEncoder().encode(JSON.stringify(frame)));
  }

  private handleMessage(event: { data: unknown }): void {
    const bytes = toBytes(event.data);
    if (!bytes) {
      this.setState("ERROR", "Upstox feed delivered an unsupported binary frame type");
      return;
    }
    let decoded;
    try {
      decoded = decodeFeedResponse(bytes);
    } catch (error) {
      this.setState("ERROR", sanitizeError(error));
      return;
    }
    if (decoded.type === "market_info") return; // status tick, no observation
    const receivedAtMs = this.now().getTime();
    for (const entry of decoded.entries) {
      const sub = this.subscriptions.get(entry.instrumentKey);
      if (!sub) continue; // not subscribed — never fabricate a mapping
      const value: Record<string, unknown> = { ltp: entry.ltp };
      if (entry.lastTradedQty !== null) value.lastTradedQuantity = entry.lastTradedQty;
      if (entry.close !== null) value.close = entry.close;
      if (Object.keys(entry.native).length) value.native = entry.native;
      this.callbacks?.onObservation({
        provider: "UPSTOX",
        canonicalId: sub.canonicalId,
        value,
        rawProviderTimestamp: entry.lastTradedTimeMs,
        providerTimestampUnit: "MS",
        providerTimestampMeaning: "last traded time",
        receivedAtMs,
        providerSequence: null,
        sourceVersion: "v3"
      });
    }
  }

  /** Close the socket and clear subscriptions. Idempotent. */
  stop(): void {
    const socket = this.socket;
    this.socket = null;
    this.subscriptions = new Map();
    this.callbacks = null;
    if (socket) {
      try { socket.close(); } catch {}
    }
    this.setState("DISCONNECTED");
  }
}
