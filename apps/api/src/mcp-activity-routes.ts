import type { Hono } from "hono";
import {
  apiErrorSchema,
  mcpActivityCompleteRequestSchema,
  mcpActivityFiltersSchema,
  mcpActivityListSchema,
  mcpActivityStartRequestSchema,
  mcpActivityViewSchema, sanitizeSensitiveText
} from "@markethub/contracts";
import type { McpActivityRepository } from "@markethub/database";
import { isLocalPeer } from "./lib/net";

export interface McpActivityRouteDependencies {
  activities: McpActivityRepository;
}

function badRequest(c: { json: (body: unknown, status?: number) => Response }, message: string): Response {
  return c.json(apiErrorSchema.parse({ error: "invalid_request", message }), 400);
}

const MAX_BODY_BYTES = 4096;

/** Redact sensitive-looking values in an already-validated safe summary. */
function sanitizeSummaryJson(raw: string): string {
  if (!raw) return "{}";
  // Redact the whole JSON string so key/value patterns like "token":"..." match.
  const redacted = sanitizeSensitiveText(raw, 1000);
  try {
    JSON.parse(redacted); // must remain valid JSON after redaction
    return redacted;
  } catch {
    return "{}";
  }
}

/** Read a bounded JSON body; reject oversized or malformed payloads before parsing. */
async function readBoundedJson(c: { req: { raw: Request } }): Promise<unknown> {
  const declared = c.req.raw.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) throw new Error("request body too large");
  const text = await c.req.raw.text();
  if (text.length > MAX_BODY_BYTES) throw new Error("request body too large");
  return JSON.parse(text) as unknown;
}

/** Durable MCP activity: local-owner writes for STDIO, LAN-readable inspection. */
export function registerMcpActivityRoutes(app: Hono, deps: McpActivityRouteDependencies): void {
  // STDIO write endpoints. The API forces transport=STDIO; a local caller cannot
  // label an operation as HTTP (HTTP MCP writes through the in-process repository).
  app.post("/api/mcp/activity/start", async (c) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Activity writes are local-owner only" }), 403);
    }
    let parsed;
    try {
      parsed = mcpActivityStartRequestSchema.safeParse(await readBoundedJson(c));
    } catch {
      return badRequest(c, "Invalid activity start request");
    }
    if (!parsed.success) return badRequest(c, "Invalid activity start request");
    const result = deps.activities.start({
      ...parsed.data,
      transport: "STDIO",
      ...(parsed.data.summaryJson !== undefined
        ? { summaryJson: sanitizeSummaryJson(parsed.data.summaryJson) }
        : {})
    });
    if (!result.ok) {
      return c.json(apiErrorSchema.parse({ error: "conflict", message: result.message }), 409);
    }
    return c.json(result.value);
  });

  app.post("/api/mcp/activity/complete", async (c) => {
    if (!isLocalPeer(c.req.raw, c.env)) {
      return c.json(apiErrorSchema.parse({ error: "forbidden", message: "Activity writes are local-owner only" }), 403);
    }
    let parsed;
    try {
      parsed = mcpActivityCompleteRequestSchema.safeParse(await readBoundedJson(c));
    } catch {
      return badRequest(c, "Invalid activity complete request");
    }
    if (!parsed.success) return badRequest(c, "Invalid activity complete request");
    // Redact caller-supplied failure fields before persistence (defense in depth
    // for the local-owner STDIO write path; in-process path is already sanitized).
    const safeComplete = {
      ...parsed.data,
      ...(parsed.data.errorCategory !== undefined
        ? { errorCategory: sanitizeSensitiveText(parsed.data.errorCategory, 64) }
        : {}),
      ...(parsed.data.errorMessage !== undefined
        ? { errorMessage: sanitizeSensitiveText(parsed.data.errorMessage, 300) }
        : {})
    };
    const result = deps.activities.complete(safeComplete);
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : 409;
      return c.json(apiErrorSchema.parse({ error: result.reason, message: result.message }), status);
    }
    return c.json(result.value);
  });

  // LAN-readable collection. Always the list envelope; no response-shape switching.
  app.get("/api/mcp/activity", (c) => {
    const rawFilters = {
      ...(c.req.query("toolName") !== undefined ? { toolName: c.req.query("toolName") } : {}),
      ...(c.req.query("transport") !== undefined ? { transport: c.req.query("transport") } : {}),
      ...(c.req.query("status") !== undefined ? { status: c.req.query("status") } : {}),
      ...(c.req.query("from") !== undefined ? { from: c.req.query("from") } : {}),
      ...(c.req.query("to") !== undefined ? { to: c.req.query("to") } : {})
    };
    const filtersParsed = mcpActivityFiltersSchema.safeParse(rawFilters);
    if (!filtersParsed.success) return badRequest(c, "Invalid activity filters");
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 25 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return badRequest(c, "limit must be an integer between 1 and 100");
    const cursor = c.req.query("cursor");
    const result = deps.activities.list(filtersParsed.data, limit, cursor);
    if (!result.ok) return badRequest(c, result.message);
    return c.json(mcpActivityListSchema.parse(result.value));
  });

  // Static /by-operation segment MUST precede the dynamic /:id route.
  app.get("/api/mcp/activity/by-operation/:operationId", (c) => {
    const view = deps.activities.getByOperationId(c.req.param("operationId"));
    if (!view) return c.json(apiErrorSchema.parse({ error: "not_found", message: "Activity not found" }), 404);
    return c.json(mcpActivityViewSchema.parse(view));
  });

  app.get("/api/mcp/activity/:id", (c) => {
    const view = deps.activities.getById(c.req.param("id"));
    if (!view) return c.json(apiErrorSchema.parse({ error: "not_found", message: "Activity not found" }), 404);
    return c.json(mcpActivityViewSchema.parse(view));
  });
}
