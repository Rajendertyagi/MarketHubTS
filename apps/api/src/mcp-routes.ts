import { networkInterfaces } from "node:os";
import type { Hono } from "hono";
import type { AppConfig } from "@markethub/config";
import {
  hostHeaderValidationResponse,
  originValidationResponse,
  type McpHttpHandler
} from "@modelcontextprotocol/server";
import { isPrivateLanIpv4 } from "./lib/net";

/**
 * Build the exact-hostname allowlist consumed by the SDK Host/Origin helpers.
 * Loopback always works; when LAN is enabled the machine's private IPv4
 * addresses are added so clients reaching the configured LAN interface pass.
 * A concrete configured host is included as-is (wildcard binds are skipped).
 */
export function buildMcpAllowlists(config: AppConfig): { allowedHostnames: string[]; allowedOrigins: string[] } {
  const hosts = new Set<string>(["localhost", "127.0.0.1", "[::1]"]);
  if (config.host && config.host !== "0.0.0.0" && config.host !== "::") {
    hosts.add(config.host);
  }
  if (config.lan) {
    try {
      for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (isPrivateLanIpv4(address.address)) hosts.add(address.address);
        }
      }
    } catch {
      // Best effort: loopback and any concrete configured host still work.
    }
  }
  const allowed = [...hosts];
  return { allowedHostnames: allowed, allowedOrigins: [...allowed] };
}

/** Apply SDK Host/Origin validation in front of the MCP handler. */
export function validateMcpRequest(
  request: Request,
  allowlists: { allowedHostnames: string[]; allowedOrigins: string[] }
): Response | undefined {
  return (
    hostHeaderValidationResponse(request, allowlists.allowedHostnames) ??
    originValidationResponse(request, allowlists.allowedOrigins)
  );
}

export interface McpRouteOptions {
  handler: McpHttpHandler;
  config: AppConfig;
}

/**
 * Mount the Streamable HTTP endpoint on the existing Hono app. Must be called
 * before the production static/SPA catch-all so /mcp is never intercepted.
 */
export function registerMcpRoute(app: Hono, options: McpRouteOptions): void {
  const allowlists = buildMcpAllowlists(options.config);
  app.all("/mcp", (c) => {
    const rejected = validateMcpRequest(c.req.raw, allowlists);
    if (rejected) return rejected;
    return options.handler.fetch(c.req.raw);
  });
}
