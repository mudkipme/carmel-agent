import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { requireAuth, type AuthVariables } from "./auth.ts";
import { createApiRoutes } from "./routes/index.ts";
import { allowedCorsOrigin, rejectCrossOriginMutations } from "./security.ts";
import { isValidationError, validationErrorMessage } from "./validation.ts";

export function createApp() {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.onError((error, c) => {
    if (isValidationError(error)) return c.json({ error: validationErrorMessage(error) }, 400);
    console.error(error);
    return c.json({ error: "Internal server error." }, 500);
  });

  app.use("*", compress({ encoding: "gzip", threshold: 1024 }));
  app.use(
    "/api/*",
    cors({
      origin: (origin, c) => allowedCorsOrigin(origin, c.req.header("x-forwarded-host") ?? c.req.header("host")),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    }),
  );
  app.use("/api/*", rejectCrossOriginMutations);
  app.use("/api/*", requireAuth);
  app.route("/api", createApiRoutes());

  mountClient(app);
  return app;
}

function mountClient(app: Hono<{ Variables: AuthVariables }>) {
  const clientDistDir = process.env.CLIENT_DIST_DIR ?? fileURLToPath(new URL("../../client/dist/", import.meta.url));
  if (!existsSync(clientDistDir)) return;

  app.use("*", serveStatic({ root: clientDistDir }));
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) return c.notFound();
    return c.html(await readFile(join(clientDistDir, "index.html"), "utf-8"));
  });
}
