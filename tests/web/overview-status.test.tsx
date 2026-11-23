import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
// react/react-dom are workspace dependencies of @markethub/web, not the repo root.
import { createElement } from "../../apps/web/node_modules/react";
import { renderToStaticMarkup } from "../../apps/web/node_modules/react-dom/server";
import { OverviewStatus } from "../../apps/web/src/components/OverviewStatus";

function render(mcpHttpHandlerMounted: boolean): string {
  return renderToStaticMarkup(createElement(OverviewStatus, { mcpHttpHandlerMounted }));
}

const mounted = render(true);
const notMounted = render(false);

describe("WP6C — Overview status accuracy", () => {
  test("MCP HTTP handler label follows the mounted flag", () => {
    expect(mounted).toMatch(/>Mounted<\/span>/);
    expect(mounted).not.toMatch(/>Not mounted<\/span>/);

    expect(notMounted).toMatch(/>Not mounted<\/span>/);
    expect(notMounted).not.toMatch(/>Mounted<\/span>/);
  });

  test("implemented foundations are labelled Implemented / Implemented foundation", () => {
    for (const label of ["Runtime &amp; config", "SQLite &amp; migrations", "API health/readiness", "WebUI shell"]) {
      expect(mounted).toContain(label);
    }
    // Four foundation rows carry the plain "Implemented" badge.
    expect((mounted.match(/>Implemented<\/span>/g) ?? []).length).toBe(4);
    expect(mounted).toContain("Provider management / authentication / status");
    expect(mounted).toMatch(/>Implemented foundation<\/span>/);
  });

  test("provider foundation does not imply credentials, broker connection or live feed", () => {
    expect(mounted).toContain("does not mean credentials are configured, a broker is connected, or a live feed has been verified");
  });

  test("live feed is locked / not activated, not operational", () => {
    expect(mounted).toContain("Live market-data feed");
    expect(mounted).toMatch(/>Locked \/ not activated<\/span>/);
    expect(mounted).toContain("no real provider sockets or live feed are active");
  });

  test("catalog is implemented but population is explicitly incomplete", () => {
    expect(mounted).toContain("Catalog search and instrument picker");
    expect(mounted).toMatch(/>Implemented; catalog population incomplete<\/span>/);
    expect(mounted).toContain("the full NSE/BSE instrument and derivative catalog is not populated");
    expect(mounted).not.toContain("full catalog populated");
    expect(mounted).not.toContain("fully populated");
  });

  test("historical/snapshot persistence is offline with provider-backed retrieval inactive", () => {
    expect(mounted).toContain("Historical and snapshot persistence");
    expect(mounted).toMatch(/>Implemented offline; provider-backed retrieval inactive<\/span>/);
    expect(mounted).toContain("Provider-backed historical and option-chain retrieval is inactive in the normal application composition");
    expect(mounted).toContain("no live broker data is fetched");
  });

  test("MCP mount status is explicitly distinguished from M6-D/E acceptance", () => {
    expect(mounted).toContain("MCP HTTP handler");
    expect(mounted).toContain("This reflects only whether the MCP HTTP handler is mounted");
    expect(mounted).toContain("not evidence that M6-D/E notification/client conformance has been accepted");
    expect(mounted).toContain("HTTP integration acceptance has passed");
  });

  test("M6-D/E conformance is not accepted and alerts/scanners are not implemented", () => {
    expect(mounted).toContain("M6-D/E notification / client conformance");
    expect(mounted).toMatch(/>Not accepted<\/span>/);
    expect(mounted).toContain("completion is unverified; the phases are neither accepted nor complete");

    expect(mounted).toContain("Alerts and scanners");
    expect(mounted).toMatch(/>Not implemented<\/span>/);
  });

  test("no stale 'not implemented' claims remain in the Overview", () => {
    for (const html of [mounted, notMounted]) {
      expect(html).not.toContain("Market data/providers");
      expect(html).not.toContain("MCP HTTP transport");
      expect(html).not.toContain("Market data, providers, catalog, alerts, and MCP HTTP are not implemented");
      expect(html).not.toContain("not implemented in this foundation milestone");
    }

    const appSource = readFileSync(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8");
    expect(appSource).not.toContain("Market data, providers, catalog, alerts, and MCP HTTP are not implemented");
    expect(appSource).not.toContain("not implemented in this foundation milestone");
    expect(appSource).toContain("<OverviewStatus mcpHttpHandlerMounted=");
  });
});
