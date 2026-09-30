import { recoverIssueAttempts } from "./services/issues.ts";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { pruneExpiredAuthSessions } from "./auth.ts";
import { migrate, seed, sqlite } from "./db/index.ts";
import { shutdownActiveRuns } from "./runtime/run-stream.ts";
import { reapManagedContainers, shutdownContainerManager } from "./runtime/sandbox/container-manager.ts";
import { shutdownTerminals } from "./runtime/sandbox/terminal-sessions.ts";
import { attachTerminalSocket } from "./terminal-socket.ts";
import { refreshConfiguredModelCatalogs } from "./services/model-catalog.ts";
import { startTaskScheduler } from "./runtime/task-scheduler.ts";
import { errorMessage } from "./errors.ts";
import { assertOidcConfig } from "./oidc/config.ts";

// Before anything else: a mistyped auth variable should stop the boot, not
// surface later as a sign-in button that fails for everyone.
const oidcConfig = assertOidcConfig();
if (oidcConfig) {
  console.log(`OIDC sign-in enabled via ${oidcConfig.issuer.href} (redirect URI ${oidcConfig.redirectUri})`);
  console.log(
    oidcConfig.matchBy.length
      ? `OIDC: first sign-ins link to existing accounts by ${oidcConfig.matchBy.join(", then ")}.`
      : "OIDC: CARMEL_OIDC_MATCH_BY=none, so first sign-ins never link to existing accounts.",
  );
  if (oidcConfig.issuer.protocol === "http:") console.warn("OIDC issuer uses plain HTTP; use HTTPS outside local testing.");
}

migrate();
recoverIssueAttempts();
seed();
pruneExpiredAuthSessions();
// Remove any sandbox containers left behind by a previous process.
void reapManagedContainers();
void refreshConfiguredModelCatalogs()
  .then((errors) => {
    for (const [provider, error] of errors) {
      console.warn(`Failed to refresh ${provider} model catalog:`, error.message);
    }
  })
  .catch((error: unknown) => {
    console.warn(
      "Failed to refresh configured model catalogs:",
      errorMessage(error),
    );
  });

startTaskScheduler();

const app = createApp();
const port = Number(process.env.PORT ?? 8797);
const hostname = process.env.HOST ?? "127.0.0.1";

const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`Carmel agent listening on http://${hostname}:${info.port}`);
});

// The terminal upgrade is handled on the raw HTTP server; see terminal-socket.ts.
attachTerminalSocket(server as unknown as import("node:http").Server);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, draining active runs...`);
  try {
    await shutdownActiveRuns();
  } catch (error) {
    console.warn("Failed to drain active runs:", errorMessage(error));
  }
  // Terminals before containers: each open shell holds its container against
  // teardown, so releasing them first lets the container manager actually stop.
  try {
    shutdownTerminals();
  } catch (error) {
    console.warn("Failed to close terminal sessions:", errorMessage(error));
  }
  try {
    await shutdownContainerManager();
  } catch (error) {
    console.warn("Failed to stop sandbox containers:", errorMessage(error));
  }
  server.close();
  try {
    sqlite.close();
  } catch {
    // Already closed.
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
