import {
  subscriptionReplaceRequestSchema,
  subscriptionStateViewSchema,
  type SubscriptionSelection,
  type SubscriptionStateView
} from "@markethub/contracts";

export type SubscriptionErrorKind = "forbidden" | "validation" | "persistence" | "internal";

export class SubscriptionHttpError extends Error {
  constructor(readonly kind: SubscriptionErrorKind, message: string) {
    super(message);
    this.name = "SubscriptionHttpError";
  }
}

function classify(status: number, payload: unknown): SubscriptionErrorKind {
  if (status === 403) return "forbidden";
  if (status === 400) return "validation";
  if (status === 500 && payload && typeof payload === "object" && "error" in payload &&
      (payload as { error?: unknown }).error === "persistence_failed") {
    return "persistence";
  }
  return "internal";
}

function messageOf(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return `Subscription request failed (${status})`;
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function fetchSubscriptions(signal?: AbortSignal): Promise<SubscriptionStateView> {
  const response = await fetch("/api/market/subscriptions", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {})
  });
  const payload = await readPayload(response);
  if (!response.ok) throw new SubscriptionHttpError(classify(response.status, payload), messageOf(payload, response.status));
  return subscriptionStateViewSchema.parse(payload);
}

/** Serialized full-replacement writes; only the latest generation may apply. */
let writeQueue: Promise<void> = Promise.resolve();
let writeGeneration = 0;
/** Number of replace calls that have not yet settled (queued or in flight). */
let pendingWrites = 0;

/** Monotonic write version shared with the subscription poller's apply guard. */
export function getWriteGeneration(): number {
  return writeGeneration;
}

/** True while any serialized write is queued or in flight. */
export function isWritePending(): boolean {
  return pendingWrites > 0;
}

export interface ReplaceResult {
  /** null means a newer write superseded this one — do not mutate state. */
  view: SubscriptionStateView | null;
  /** Post-commit runtime reconciliation error reported by a successful PUT. */
  runtimeError: string | null;
}

export function replaceSubscriptions(selections: SubscriptionSelection[]): Promise<ReplaceResult> {
  const generation = ++writeGeneration;
  pendingWrites++;
  const run = async (): Promise<ReplaceResult> => {
    try {
      const body = subscriptionReplaceRequestSchema.parse({ selections });
      const response = await fetch("/api/market/subscriptions", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body)
      });
      const payload = await readPayload(response);
      if (!response.ok) throw new SubscriptionHttpError(classify(response.status, payload), messageOf(payload, response.status));
      const view = subscriptionStateViewSchema.parse(payload);
      if (generation !== writeGeneration) return { view: null, runtimeError: null };
      return { view, runtimeError: view.runtime.lastError };
    } finally {
      // Settles before the returned promise's reactions, so a caller that
      // resumes polling after `await` observes isWritePending() === false.
      pendingWrites--;
    }
  };
  const queued = writeQueue.then(run, run);
  writeQueue = queued.then(() => undefined, () => undefined);
  return queued;
}
