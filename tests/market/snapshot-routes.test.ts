import { Hono } from "../../apps/api/node_modules/hono";
import { describe, expect, test } from "bun:test";
import { registerSnapshotRoutes } from "../../apps/api/src/snapshot-routes";
import type { OptionChainRequest, OptionChainSnapshotService } from "../../packages/market-core/src/index";
import type { SnapshotRepository } from "../../packages/database/src/index";

const localEnv = { requestIP: () => ({ address: "127.0.0.1" }) };

function makeApp() {
  const requests: OptionChainRequest[] = [];
  const service = {
    async captureOnDemand(request: OptionChainRequest) {
      requests.push(request);
      return { snapshot: null, error: "no provider available" };
    }
  } as unknown as OptionChainSnapshotService;
  const app = new Hono();
  registerSnapshotRoutes(app, { service, snapshots: {} as SnapshotRepository });
  return { app, requests };
}

function post(app: Hono, body: unknown) {
  return app.request("/api/snapshots/capture", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  }, localEnv);
}

describe("POST /api/snapshots/capture provider passthrough", () => {
  test("omitted provider stays omitted in the body passed to captureOnDemand; 422 intact", async () => {
    const { app, requests } = makeApp();
    const res = await post(app, { underlyingCanonicalId: "A", expiryDate: "2026-01-29" });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("capture_unavailable");
    expect(requests.length).toBe(1);
    expect("provider" in requests[0]!).toBe(false);
  });

  test("explicit provider passes through unchanged", async () => {
    const { app, requests } = makeApp();
    const res = await post(app, { underlyingCanonicalId: "A", expiryDate: "2026-01-29", provider: "UPSTOX" });
    expect(res.status).toBe(422);
    expect(requests.length).toBe(1);
    expect(requests[0]!.provider).toBe("UPSTOX");
  });

  test("invalid provider is still rejected with 400 and never reaches the service", async () => {
    const { app, requests } = makeApp();
    const res = await post(app, { underlyingCanonicalId: "A", expiryDate: "2026-01-29", provider: "NOPE" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
    expect(requests.length).toBe(0);
  });
});
