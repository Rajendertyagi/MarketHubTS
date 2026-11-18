import { afterEach, describe, expect, test } from "bun:test";
import type { OptionChainCaptureConfig, OptionChainSnapshot } from "../../packages/contracts/src/index";
import {
  captureSnapshot, deleteCaptureConfig, fetchCaptureConfigs, fetchSnapshot, fetchSnapshots,
  saveCaptureConfig, SnapshotHttpError
} from "../../apps/web/src/lib/snapshots";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { status, body } = handler(String(input), init);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

const snapshot: OptionChainSnapshot = {
  id: "snap-1", configId: "cap-1", capturedAt: "2026-01-01T00:00:00.000Z", provider: "FYERS",
  envelope: {
    underlyingCanonicalId: "A", expiryDate: "2026-01-29", capturedAt: "2026-01-01T00:00:00.000Z",
    observationTimestamp: null, underlyingLtp: 25000,
    strikes: [
      { strike: 25000, optionType: "CE", ltp: 100, oi: 0, greeks: { delta: 0.5, gamma: null } },
      { strike: 25000, optionType: "PE", ltp: 0 }
    ],
    providerExtensions: { fyToken: "123" }
  },
  provenance: { source: "provider-feed", provider: "FYERS", receivedAt: "2026-01-01T00:00:00.000Z" }
};

const config: OptionChainCaptureConfig = {
  id: "cap-1", underlyingCanonicalId: "A", expiryDate: "2026-01-29", strikeRangeJson: null,
  captureEnabled: true, captureMode: "MANUAL", scheduleJson: null, streamingEnabled: false,
  provider: "FYERS", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("snapshot web client", () => {
  test("stored snapshots preserve null, zero and observation semantics", async () => {
    fakeFetch(() => ({ status: 200, body: { snapshots: [snapshot] } }));
    const list = await fetchSnapshots();
    expect(list.length).toBe(1);
    expect(list[0]!.envelope.observationTimestamp).toBeNull();
    expect(list[0]!.envelope.strikes[0]!.greeks!.gamma).toBeNull();
    expect(list[0]!.envelope.strikes[0]!.oi).toBe(0);
    expect(list[0]!.envelope.strikes[1]!.ltp).toBe(0);
    expect(list[0]!.envelope.providerExtensions.fyToken).toBe("123");
  });

  test("single snapshot retrieval and 404 classification", async () => {
    fakeFetch(() => ({ status: 200, body: { snapshot } }));
    expect((await fetchSnapshot("snap-1")).id).toBe("snap-1");

    fakeFetch(() => ({ status: 404, body: { error: "not_found", message: "missing" } }));
    try {
      await fetchSnapshot("missing");
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotHttpError);
      expect((error as SnapshotHttpError).kind).toBe("not-found");
    }
  });

  test("capture config CRUD round-trips and 403 is forbidden", async () => {
    fakeFetch(() => ({ status: 200, body: { configs: [config] } }));
    expect((await fetchCaptureConfigs()).length).toBe(1);

    fakeFetch(() => ({ status: 200, body: { config } }));
    expect((await saveCaptureConfig(config)).id).toBe("cap-1");

    fakeFetch(() => ({ status: 200, body: { ok: true } }));
    await expect(deleteCaptureConfig("cap-1")).resolves.toBeUndefined();

    fakeFetch(() => ({ status: 403, body: { error: "forbidden", message: "local only" } }));
    try {
      await saveCaptureConfig(config);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotHttpError);
      expect((error as SnapshotHttpError).kind).toBe("forbidden");
    }
  });

  test("manual capture unavailable (no provider wired) is classified", async () => {
    fakeFetch(() => ({ status: 422, body: { error: "capture_unavailable", message: "no provider available" } }));
    try {
      await captureSnapshot({ underlyingCanonicalId: "A", expiryDate: "2026-01-29" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SnapshotHttpError);
      expect((error as SnapshotHttpError).kind).toBe("unavailable");
    }
  });

  test("invalid snapshot payload is rejected", async () => {
    fakeFetch(() => ({ status: 200, body: { snapshots: [{ id: "x" }] } }));
    await expect(fetchSnapshots()).rejects.toBeDefined();
  });
});
