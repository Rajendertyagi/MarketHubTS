import { create } from "zustand";
import type { LiveSnapshot, SubscriptionStateView } from "@markethub/contracts";
import type { StreamState } from "../lib/live-stream";
import type { SubscriptionErrorKind } from "../lib/subscriptions";

export interface SubscriptionErrorState {
  kind: SubscriptionErrorKind | "runtime";
  message: string;
}

export interface LiveStoreState {
  snapshot: LiveSnapshot | null;
  subscriptions: SubscriptionStateView | null;
  stream: StreamState;
  subscriptionError: SubscriptionErrorState | null;
  setSnapshot: (snapshot: LiveSnapshot) => void;
  setSubscriptions: (view: SubscriptionStateView) => void;
  setStream: (state: StreamState) => void;
  setSubscriptionError: (error: SubscriptionErrorState | null) => void;
  reset: () => void;
}

const initialStream: StreamState = {
  streamStatus: "idle",
  refreshStatus: "idle",
  lastError: null,
  refreshError: null
};

/** Persists across controller instances (React StrictMode remounts). */
export const useLiveStore = create<LiveStoreState>((set) => ({
  snapshot: null,
  subscriptions: null,
  stream: initialStream,
  subscriptionError: null,
  setSnapshot: (snapshot) => set({ snapshot }),
  setSubscriptions: (subscriptions) => set({ subscriptions }),
  setStream: (stream) => set({ stream }),
  setSubscriptionError: (subscriptionError) => set({ subscriptionError }),
  reset: () => set({ snapshot: null, subscriptions: null, stream: initialStream, subscriptionError: null })
}));
