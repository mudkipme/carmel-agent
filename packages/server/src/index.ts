import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { migrate, seed } from "./db/index.ts";

migrate();
seed();

const app = createApp();
const port = Number(process.env.PORT ?? 8797);
const hostname = process.env.HOST ?? "0.0.0.0";

serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`Carmel agent listening on http://${hostname}:${info.port}`);
});
