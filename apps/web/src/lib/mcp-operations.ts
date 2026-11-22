import {
  mcpOperationListSchema,
  type McpOperationDescriptor
} from "@markethub/contracts";

export type McpOperationsErrorKind = "forbidden" | "validation" | "unavailable" | "not-found" | "internal";

export class McpOperationsHttpError extends Error {
  constructor(readonly kind: McpOperationsErrorKind, message: string) {
    super(message);
    this.name = "McpOperationsHttpError";
  }
}

function classify(status: number): McpOperationsErrorKind {
  if (status === 403) return "forbidden";
  if (status === 400) return "validation";
  if (status === 404) return "not-found";
  if (status === 422) return "unavailable";
  return "internal";
}

function messageOf(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return `MCP operations request failed (${status})`;
}

async function readPayload(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

/**
 * Fetch the registration-owned MCP operation descriptors consumed by the
 * Activity selector. The optional signal is forwarded verbatim to `fetch` so
 * callers can abort on unmount. The response is validated with the shared
 * strict contract so a drifted or malformed payload fails loudly instead of
 * reaching the selector.
 */
export async function fetchMcpOperations(signal?: AbortSignal): Promise<McpOperationDescriptor[]> {
  const response = await fetch("/api/mcp/operations", {
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {})
  });
  const payload = await readPayload(response);
  if (!response.ok) throw new McpOperationsHttpError(classify(response.status), messageOf(payload, response.status));
  return mcpOperationListSchema.parse(payload).operations;
}
