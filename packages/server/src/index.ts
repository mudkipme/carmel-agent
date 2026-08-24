import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { pruneExpiredAuthSessions } from "./auth.ts";
import { migrate, seed, sqlite } from "./db/index.ts";
import { shutdownActiveRuns } from "./runtime/run-stream.ts";
import { reapManagedContainers, shutdownContainerManager } from "./runtime/sandbox/container-manager.ts";
import { refreshConfiguredModelCatalogs } from "./services/model-catalog.ts";
import { loadInstalledExtensions } from "./runtime/extension-registry.ts";
import { errorMessage } from "./errors.ts";

migrate();
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

// Awaited before the server accepts traffic: a run that started while
// extensions were still loading would build its tool list from an incomplete
// registry and silently omit tools the agent is configured for.
await loadInstalledExtensions();

const app = createApp();
const port = Number(process.env.PORT ?? 8797);
const hostname = process.env.HOST ?? "127.0.0.1";

const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`Carmel agent listening on http://${hostname}:${info.port}`);
});

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
