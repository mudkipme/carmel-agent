import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { pruneExpiredAuthSessions } from "./auth.ts";
import { migrate, seed } from "./db/index.ts";

migrate();
seed();
pruneExpiredAuthSessions();

const app = createApp();
const port = Number(process.env.PORT ?? 8797);
const hostname = process.env.HOST ?? "127.0.0.1";

serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`Carmel agent listening on http://${hostname}:${info.port}`);
});
