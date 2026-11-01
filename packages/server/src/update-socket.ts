import type { Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { UpdateServerMessage } from "@carmel-agent/shared";
import { readAuthenticatedUser, readSessionCookie } from "./auth.ts";
import { isAllowedBrowserOrigin } from "./security.ts";
import { agentRunSubscription } from "./runtime/run-stream.ts";
import { stateEpoch, stateRevision, subscribeStateChanges } from "./state-changes.ts";

export function attachUpdateSocket(server: Server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 16 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/updates") return;
    const reject = (status: number) =>
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    const host =
      (request.headers["x-forwarded-host"] as string | undefined) ?? request.headers.host;
    if (!request.headers.origin || !isAllowedBrowserOrigin(request.headers.origin, host))
      return reject(403);
    let token: string | undefined;
    try {
      token = readSessionCookie(request.headers.cookie);
    } catch {
      return reject(401);
    }
    const user = readAuthenticatedUser(token);
    if (!user) return reject(401);
    wss.handleUpgrade(request, socket, head, (ws) =>
      openUpdates(ws, user.id, () => Boolean(readAuthenticatedUser(token))),
    );
  });
  const shutdown = () => {
    for (const client of wss.clients) client.close(1001, "Server shutting down");
    wss.close();
  };
  server.once("close", shutdown);
  return wss;
}

function openUpdates(ws: WebSocket, userId: string, authenticated: () => boolean) {
  const runs = new Map<string, () => void>();
  const send = (message: UpdateServerMessage) => {
    if (ws.readyState !== ws.OPEN) return false;
    if (!authenticated()) {
      ws.close(1008, "Authentication required");
      return false;
    }
    if (ws.bufferedAmount > 16 * 1024 * 1024) {
      ws.close(1013, "Connection is too slow");
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  };
  const unsubscribe = subscribeStateChanges((revision, topics) =>
    send({ type: "state_changed", revision, topics }),
  );
  let alive = true;
  const heartbeat = setInterval(() => {
    if (!authenticated()) {
      ws.close(1008, "Authentication required");
      return;
    }
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 15_000);
  heartbeat.unref();
  ws.on("pong", () => {
    alive = true;
  });
  ws.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    for (const stop of runs.values()) stop();
    runs.clear();
  });
  ws.on("error", () => ws.terminate());
  ws.on("message", (raw) => {
    if (!authenticated()) {
      ws.close(1008, "Authentication required");
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      ws.close(1008, "Invalid update message");
      return;
    }
    if (!message || typeof message.id !== "string" || message.id.length > 128) {
      ws.close(1008, "Invalid subscription");
      return;
    }
    const { id } = message;
    if (message.type === "unwatch_run") {
      runs.get(id)?.();
      runs.delete(id);
      return;
    }
    if (
      message.type !== "watch_run" ||
      typeof message.runId !== "string" ||
      !Number.isSafeInteger(message.after) ||
      message.after < 0
    ) {
      ws.close(1008, "Invalid subscription");
      return;
    }
    runs.get(id)?.();
    runs.delete(id);
    const subscription = agentRunSubscription(userId, message.runId, message.after);
    if (!send({ type: "run_open", id, status: subscription.status }) || subscription.status !== 200)
      return;
    const stop = subscription.subscribe({
      enqueue: (envelope) => send({ type: "run_event", id, envelope }),
      close: () => {
        runs.delete(id);
        send({ type: "run_close", id });
      },
    });
    if (ws.readyState === ws.OPEN) runs.set(id, stop);
    else stop();
  });
  send({ type: "ready", epoch: stateEpoch, revision: stateRevision() });
}
