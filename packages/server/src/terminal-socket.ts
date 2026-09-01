import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { eq } from "drizzle-orm";
import { WebSocketServer, type WebSocket } from "ws";
import { readAuthenticatedUser, readSessionCookie } from "./auth.ts";
import { db } from "./db/index.ts";
import { agents } from "./db/schema.ts";
import { attachTerminal } from "./runtime/sandbox/terminal-sessions.ts";
import { isAllowedBrowserOrigin } from "./security.ts";
import { errorMessage } from "./errors.ts";

/**
 * The terminal WebSocket, mounted on the HTTP server rather than on hono.
 *
 * An upgrade is settled at the TCP level before any hono routing runs, so this
 * lives outside the REST app on purpose: it is not an HTTP operation and does
 * not belong in the OpenAPI contract that describes them. What it does have to
 * borrow from the REST stack is the parts that decide who you are -- the
 * session cookie and the origin check -- and it calls the same functions the
 * middleware does rather than reimplementing them.
 */

export const terminalSocketPath = "/api/terminal";

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; rows: number; cols: number };

export function attachTerminalSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const url = safeUrl(request);
    if (url?.pathname !== terminalSocketPath) return;

    // A WebSocket handshake is not covered by the CORS preflight that guards
    // the REST API, and SameSite=Lax is a browser-side promise rather than a
    // server-side check. Validate the origin here or a page on another site
    // could open a shell with the visitor's cookie.
    const origin = request.headers.origin;
    const host = (request.headers["x-forwarded-host"] as string | undefined) ?? request.headers.host;
    if (origin && !isAllowedBrowserOrigin(origin, host)) return rejectUpgrade(socket, 403, "Forbidden");

    const user = readAuthenticatedUser(readSessionCookie(request.headers.cookie));
    if (!user) return rejectUpgrade(socket, 401, "Unauthorized");

    const agentId = url.searchParams.get("agent") ?? "";
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    // Owner-only, and deliberately not "anyone who can use a shared agent": a
    // terminal hands over the agent's whole environment, secrets included, with
    // none of the redaction that covers agent-run output.
    if (!agent || agent.ownerUserId !== user.id) return rejectUpgrade(socket, 404, "Not Found");
    if (!agent.permissions.bash) return rejectUpgrade(socket, 403, "Forbidden");

    wss.handleUpgrade(request, socket, head, (ws) => {
      void openTerminal(ws, agent, user.id, {
        rows: positiveInt(url.searchParams.get("rows"), 24),
        cols: positiveInt(url.searchParams.get("cols"), 80),
      });
    });
  });

  return wss;
}

async function openTerminal(
  ws: WebSocket,
  agent: typeof agents.$inferSelect,
  userId: string,
  size: { rows: number; cols: number },
) {
  const send = (message: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };

  let handle: Awaited<ReturnType<typeof attachTerminal>>;
  try {
    handle = await attachTerminal(
      agent,
      userId,
      {
        onData: (data) => send({ type: "output", data }),
        onClose: (reason) => {
          send({ type: "exit", reason });
          ws.close();
        },
      },
      size,
    );
  } catch (error) {
    send({ type: "error", message: errorMessage(error) });
    ws.close();
    return;
  }

  // The socket may have gone while the container was starting, which can take
  // seconds on a cold agent. Detach rather than leaving a subscriber nothing
  // will ever read from.
  if (ws.readyState !== ws.OPEN) {
    handle.detach();
    return;
  }

  send({ type: "ready" });

  ws.on("message", (raw) => {
    const message = parseMessage(raw.toString());
    if (!message) return;
    if (message.type === "input") handle.write(message.data);
    else handle.resize(message.rows, message.cols);
  });
  ws.on("close", () => handle.detach());
  ws.on("error", () => handle.detach());
}

function parseMessage(raw: string): ClientMessage | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<ClientMessage>;
    if (parsed.type === "input" && typeof parsed.data === "string") return { type: "input", data: parsed.data };
    if (parsed.type === "resize" && Number.isFinite(parsed.rows) && Number.isFinite(parsed.cols)) {
      return { type: "resize", rows: Number(parsed.rows), cols: Number(parsed.cols) };
    }
  } catch {
    // A malformed frame is ignored rather than fatal: it cannot reach the shell.
  }
  return undefined;
}

function safeUrl(request: IncomingMessage) {
  try {
    return new URL(request.url ?? "", `http://${request.headers.host ?? "localhost"}`);
  } catch {
    return undefined;
  }
}

function rejectUpgrade(socket: Duplex, status: number, reason: string) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function positiveInt(value: string | null, fallback: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
