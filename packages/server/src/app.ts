import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { requireAuth, type AuthVariables } from "./auth.ts";
import { createApiRoutes } from "./routes/index.ts";
import { createOpenAIRoutes } from "./routes/openai.ts";
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
    "*",
    secureHeaders({
      // TLS termination is deployment-specific (often a reverse proxy), and the
      // app may be reached over plain HTTP; don't force HSTS from here.
      strictTransportSecurity: false,
      // The web client may call the API cross-origin (see CARMEL_ALLOWED_ORIGINS);
      // CORS already governs that, and CORP: same-origin would block it.
      crossOriginResourcePolicy: false,
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        scriptSrc: ["'self'"],
        // CodeMirror and Radix inject <style>/style attributes at runtime.
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Same-origin assets, base64 attachments, and markdown-referenced images.
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        fontSrc: ["'self'", "data:"],
        // Nothing spawns workers today; keep same-origin only.
        workerSrc: ["'self'"],
        connectSrc: ["'self'"],
      },
    }),
  );
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

  // Bearer-key auth, not cookies, so any origin may call it: a browser holding
  // the key already has everything the key grants.
  app.use("/v1/*", cors({ origin: "*", allowHeaders: ["authorization", "content-type", "x-session-id"] }));
  app.route("/v1", createOpenAIRoutes());

  mountClient(app);
  return app;
}

function mountClient(app: Hono<{ Variables: AuthVariables }>) {
  const clientDistDir = process.env.CLIENT_DIST_DIR ?? fileURLToPath(new URL("../../client/dist/", import.meta.url));
  if (!existsSync(clientDistDir)) return;

  app.use("*", serveStatic({ root: clientDistDir }));
  app.get("*", async (c) => {
    if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/v1/")) return c.notFound();
    return c.html(await readFile(join(clientDistDir, "index.html"), "utf-8"));
  });
}
