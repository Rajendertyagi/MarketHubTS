import { isIP } from "node:net";

export function normalizeHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return hostname.slice(1, -1);
  return hostname;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = normalizeHostname(hostname).toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  if (isIP(h) === 4) {
    const parts = h.split(".").map((n) => Number(n));
    return parts.length === 4 && parts[0] === 127 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  }
  return false;
}

export function isPrivateLanIpv4(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (isIP(h) !== 4) return false;
  const parts = h.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** Single local-owner check for credential-changing routes. No app-level login. */
export function isLocalPeer(request: Request, env: unknown): boolean {
  const server = env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
  const ip = server?.requestIP?.(request);
  if (!ip) return false;
  const address = ip.address.toLowerCase();
  if (address === "::1" || address === "localhost") return true;
  if (address.startsWith("::ffff:")) return isLocalPeer(request, { requestIP: () => ({ address: address.slice(7) }) });
  return isLoopbackHost(address);
}
