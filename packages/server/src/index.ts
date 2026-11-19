import {
  startCollaborationDispatcher,
  drainCollaborationResults,
  stopCollaborationDispatcher,
} from "./collaborations/service.ts";
import { startHelperHosts, pauseHelperHosts, shutdownHelperHosts } from "./runtime/helper-hosts.ts";
import {
  startHomeDispatcher,
  stopHomeDispatcher,
  drainHomeEvents,
  recoverHomeEvents,
} from "./services/home-events.ts";
import { startHomeMemoryIndexes, stopHomeMemoryIndexes } from "./home-memory/search.ts";
import { ensureHome } from "./services/agent-homes.ts";
import { startHomeMemoryCapture, stopHomeMemoryCapture } from "./home-memory/capture.ts";
import { imBindings, imIntegrations } from "./db/im-schema.ts";
import { eq } from "drizzle-orm";
import {
  recoverIssueAttempts,
  startIssueQueue,
  stopIssueQueue,
  drainIssueResults,
} from "./issues/service.ts";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { pruneExpiredAuthSessions } from "./auth.ts";
import { db, initialize, seed, sqlite } from "./db/index.ts";
import { shutdownActiveRuns } from "./runtime/run-stream.ts";
import {
  reapManagedContainers,
  shutdownContainerManager,
} from "./runtime/sandbox/container-manager.ts";
import { shutdownTerminals } from "./runtime/sandbox/terminal-sessions.ts";
import { attachTerminalSocket } from "./terminal-socket.ts";
import { attachBrowserSocket } from "./browser-socket.ts";
import { attachUpdateSocket } from "./update-socket.ts";
import { shutdownBrowsers } from "./runtime/sandbox/browser-sessions.ts";
import { refreshConfiguredModelCatalogs } from "./services/model-catalog.ts";
import { startTaskScheduler, stopTaskScheduler } from "./runtime/task-scheduler.ts";
import { startImManager, stopImManager, drainImManager } from "./runtime/im-manager.ts";
import { errorMessage } from "./errors.ts";
import { startWorkers, stopWorkers, type Worker } from "./workers.ts";
import { assertOidcConfig } from "./oidc/config.ts";
import { startKnowledgeScheduler, stopKnowledgeScheduler } from "./knowledge/service.ts";
import { reapKnowledgeWorkers, shutdownKnowledgeWorkers } from "./knowledge/worker-client.ts";

// Before anything else: a mistyped auth variable should stop the boot, not
// surface later as a sign-in button that fails for everyone.
const oidcConfig = assertOidcConfig();
if (oidcConfig) {
  console.log(
    `OIDC sign-in enabled via ${oidcConfig.issuer.href} (redirect URI ${oidcConfig.redirectUri})`,
  );
  console.log(
    oidcConfig.matchBy.length
      ? `OIDC: first sign-ins link to existing accounts by ${oidcConfig.matchBy.join(", then ")}.`
      : "OIDC: CARMEL_OIDC_MATCH_BY=none, so first sign-ins never link to existing accounts.",
  );
  if (oidcConfig.issuer.protocol === "http:")
    console.warn("OIDC issuer uses plain HTTP; use HTTPS outside local testing.");
}

initialize();
recoverIssueAttempts();
seed();
pruneExpiredAuthSessions();
void refreshConfiguredModelCatalogs()
  .then((errors) => {
    for (const [provider, error] of errors) {
      console.warn(`Failed to refresh ${provider} model catalog:`, error.message);
    }
  })
  .catch((error: unknown) => {
    console.warn("Failed to refresh configured model catalogs:", errorMessage(error));
  });

function ensureImHomes() {
  for (const { integration } of db
    .select({ integration: imIntegrations })
    .from(imIntegrations)
    .innerJoin(imBindings, eq(imBindings.integrationId, imIntegrations.id))
    .all()) {
    try {
      ensureHome(integration.userId, integration.agentId);
    } catch {
      /* Unconfigured or revoked agents remain unavailable. */
    }
  }
}

const workers: Worker[] = [
  // Remove sandbox containers and profile owners left by a previous process
  // before accepting new sandbox requests.
  { name: "sandbox containers", start: reapManagedContainers, close: shutdownContainerManager },
  { name: "knowledge workers", start: reapKnowledgeWorkers, close: shutdownKnowledgeWorkers },
  // Each open shell holds its container against teardown, so these close first.
  { name: "terminals", close: shutdownTerminals },
  { name: "browsers", close: shutdownBrowsers },
  { name: "agent runs", drain: () => shutdownActiveRuns() },
  {
    name: "home events",
    start: async () => {
      ensureImHomes();
      await recoverHomeEvents();
    },
  },
  {
    name: "helper hosts",
    start: startHelperHosts,
    stop: pauseHelperHosts,
    drain: shutdownHelperHosts,
  },
  {
    name: "home dispatcher",
    start: startHomeDispatcher,
    stop: stopHomeDispatcher,
    drain: drainHomeEvents,
  },
  { name: "home memory capture", start: startHomeMemoryCapture, stop: stopHomeMemoryCapture },
  { name: "home memory indexes", start: startHomeMemoryIndexes, close: stopHomeMemoryIndexes },
  { name: "task scheduler", start: startTaskScheduler, stop: stopTaskScheduler },
  { name: "IM manager", start: startImManager, stop: stopImManager, drain: drainImManager },
  { name: "knowledge scheduler", start: startKnowledgeScheduler, close: stopKnowledgeScheduler },
  {
    name: "issue queue",
    start: startIssueQueue,
    stop: stopIssueQueue,
    drain: drainIssueResults,
  },
  {
    name: "collaborations",
    start: startCollaborationDispatcher,
    stop: stopCollaborationDispatcher,
    drain: drainCollaborationResults,
  },
];
await startWorkers(workers);

const app = createApp();
const port = Number(process.env.PORT ?? 8797);
const hostname = process.env.HOST ?? "127.0.0.1";

const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`Carmel agent listening on http://${hostname}:${info.port}`);
});

// The terminal upgrade is handled on the raw HTTP server; see terminal-socket.ts.
attachTerminalSocket(server as unknown as import("node:http").Server);
attachBrowserSocket(server as unknown as import("node:http").Server);
const updateSockets = attachUpdateSocket(server as unknown as import("node:http").Server);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, draining active runs...`);
  await stopWorkers(workers);
  server.close();
  for (const client of updateSockets.clients) client.close(1001, "Server shutting down");
  try {
    sqlite.close();
  } catch {
    // Already closed.
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
