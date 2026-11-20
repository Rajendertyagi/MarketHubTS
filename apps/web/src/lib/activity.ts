import {
  mcpActivityListSchema, mcpActivityViewSchema,
  type McpActivityFilters, type McpActivityList, type McpActivityView
} from "@markethub/contracts";

export type ActivityErrorKind = "forbidden" | "validation" | "unavailable" | "not-found" | "internal";

export class ActivityHttpError extends Error {
  constructor(readonly kind: ActivityErrorKind, message: string) {
    super(message);
    this.name = "ActivityHttpError";
  }
}

function classify(status: number): ActivityErrorKind {
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
  return `Activity request failed (${status})`;
}

async function readPayload(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}

export interface ActivityQuery extends McpActivityFilters {
  limit?: number;
  cursor?: string;
}

export async function fetchActivity(query: ActivityQuery = {}): Promise<McpActivityList> {
  const params = new URLSearchParams();
  if (query.toolName) params.set("toolName", query.toolName);
  if (query.transport) params.set("transport", query.transport);
  if (query.status) params.set("status", query.status);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const qs = params.toString();
  const response = await fetch(`/api/mcp/activity${qs ? `?${qs}` : ""}`, { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new ActivityHttpError(classify(response.status), messageOf(payload, response.status));
  return mcpActivityListSchema.parse(payload);
}

export async function fetchActivityById(id: string): Promise<McpActivityView> {
  const response = await fetch(`/api/mcp/activity/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new ActivityHttpError(classify(response.status), messageOf(payload, response.status));
  return mcpActivityViewSchema.parse(payload);
}

export async function fetchActivityByOperation(operationId: string): Promise<McpActivityView> {
  const response = await fetch(`/api/mcp/activity/by-operation/${encodeURIComponent(operationId)}`, { headers: { Accept: "application/json" } });
  const payload = await readPayload(response);
  if (!response.ok) throw new ActivityHttpError(classify(response.status), messageOf(payload, response.status));
  return mcpActivityViewSchema.parse(payload);
}
