import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthStatusSchema } from "@markethub/contracts";
import { checkDatabase, openDatabase } from "@markethub/database";
import { nowIso } from "@markethub/shared";

const port = Number(process.env.PORT ?? 3001);
const db = openDatabase(process.env.MARKETHUB_DB_PATH);

const app = new Hono();

app.use("*", cors());

app.get("/health", (c) => {
  const payload = healthStatusSchema.parse({
    status: "ok",
    service: "markethub-api",
    timestamp: nowIso(),
    version: "0.1.0",
    checks: {
      api: "ok",
      database: checkDatabase(db.sqlite)
    }
  });
  return c.json(payload);
});

app.get("/", (c) => c.json({ name: "MarketHubTS API", health: "/health" }));

const server = Bun.serve({
  port,
  fetch: app.fetch
});

console.log(`MarketHubTS API listening on http://localhost:${server.port}`);

function shutdown() {
  db.close();
  server.stop(true);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
