import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { readAuthenticatedUser, readSessionCookie } from "./auth.ts";
import { readVisibleAgent } from "./services/agent-access.ts";
import { isAllowedBrowserOrigin } from "./security.ts";
import { browserControl } from "./runtime/browser-control.ts";
import { connectBrowser, type BrowserConnection } from "./runtime/sandbox/browser-sessions.ts";
import { parseBrowserInput } from "./browser-protocol.ts";
import { errorMessage } from "./errors.ts";
import type { BrowserServerMessage } from "@carmel-agent/shared";

export function attachBrowserSocket(server: Server, connect = connectBrowser) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024,
    perMessageDeflate: false,
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/browser") return;
    const reject = (status: number) => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
    };
    const origin = request.headers.origin;
    const host =
      (request.headers["x-forwarded-host"] as string | undefined) ?? request.headers.host;
    if (!origin || !isAllowedBrowserOrigin(origin, host)) return reject(403);
    let token: string | undefined;
    try {
      token = readSessionCookie(request.headers.cookie);
    } catch {
      return reject(401);
    }
    const user = readAuthenticatedUser(token);
    if (!user) return reject(401);
    const agent = readVisibleAgent(user.id, url.searchParams.get("agent") ?? "");
    if (!agent) return reject(404);
    if (!agent.permissions.bash) return reject(403);
    wss.handleUpgrade(request, socket, head, (ws) => {
      void openBrowser(
        ws,
        agent,
        user.id,
        user.username ?? user.name,
        () => Boolean(readAuthenticatedUser(token)),
        connect,
      ).catch(() => ws.close(1011, "Browser unavailable"));
    });
  });
  return wss;
}

async function openBrowser(
  ws: WebSocket,
  agent: NonNullable<ReturnType<typeof readVisibleAgent>>,
  userId: string,
  name: string,
  authenticated: () => boolean,
  connect: typeof connectBrowser,
) {
  const id = randomUUID();
  const control = browserControl(agent.id);
  const controller = new AbortController();
  let bridge: BrowserConnection | undefined;
  let connected = false;
  let commandId = 0;
  const pendingCommands = new Set<number>();
  const command = (args: string[]) => {
    const id = ++commandId;
    pendingCommands.add(id);
    bridge?.send({ type: "command", id, args });
  };
  const keys = new Map<string, { key?: string; code?: string; windowsVirtualKeyCode?: number }>();
  let pointer = { x: 0, y: 0 };
  const buttons = new Set<"left" | "middle" | "right">();
  const send = (message: BrowserServerMessage) => {
    if (ws.readyState !== ws.OPEN) return;
    // Frames are paced by renderer acknowledgements; slow clients cannot accumulate history.
    if (ws.bufferedAmount > 16 * 1024 * 1024) {
      ws.close(1013, "Connection is too slow");
      return;
    }
    ws.send(JSON.stringify(message));
  };
  const sendControl = () =>
    send({ type: "control", state: control.state, hasControl: control.canInput(id) });
  const unsubscribe = control.subscribe(sendControl);
  const resetInput = () => {
    for (const key of keys.values())
      bridge?.send({ type: "input_keyboard", eventType: "keyUp", ...key });
    for (const button of buttons)
      bridge?.send({ type: "input_mouse", eventType: "mouseReleased", ...pointer, button });
    keys.clear();
    buttons.clear();
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    resetInput();
    control.detach(id);
    unsubscribe();
    clearInterval(heartbeat);
    controller.abort();
    bridge?.close();
    if (ws.readyState === ws.OPEN) ws.close();
  };
  // Recheck login and agent visibility throughout long-lived connections, not just on upgrade.
  let alive = true;
  const heartbeat = setInterval(() => {
    const current = readVisibleAgent(userId, agent.id);
    if (!alive || !authenticated() || !current?.permissions.bash) {
      close();
      return;
    }
    alive = false;
    ws.ping();
  }, 15_000);
  heartbeat.unref();
  ws.on("pong", () => {
    alive = true;
  });
  ws.on("close", close);
  ws.on("error", close);
  ws.on("message", (raw) => {
    const message = parseBrowserInput(raw.toString());
    if (!message || closed) return;
    const current = readVisibleAgent(userId, agent.id);
    if (!authenticated() || !current?.permissions.bash) {
      close();
      return;
    }
    try {
      if (message.type === "ack") {
        bridge?.send(message);
        return;
      }
      if (!connected) throw new Error("Wait for the browser to connect.");
      if (message.type === "take_control") {
        control.take(id, name);
        return;
      }
      if (!control.canInput(id))
        throw new Error("Take control before interacting with the browser.");
      if (message.type === "release_input") {
        resetInput();
        return;
      }
      if (message.type === "resume") {
        if (pendingCommands.size)
          throw new Error("Wait for the browser action to finish before resuming.");
        resetInput();
        control.resume(id);
        return;
      }
      if (message.type === "navigate") command(["open", message.url]);
      else if (message.type === "tab") command(["tab", message.id]);
      else if (["back", "forward", "reload"].includes(message.type)) command([message.type]);
      else {
        if (message.type === "input_keyboard") {
          const key = message.code ?? message.key ?? "";
          if (message.eventType === "keyDown")
            keys.set(key, {
              key: message.key,
              code: message.code,
              windowsVirtualKeyCode: message.windowsVirtualKeyCode,
            });
          else if (message.eventType === "keyUp") keys.delete(key);
        }
        if (message.type === "input_mouse") {
          pointer = { x: message.x, y: message.y };
          if (message.eventType === "mousePressed") buttons.add(message.button ?? "left");
          else if (message.eventType === "mouseReleased") buttons.delete(message.button ?? "left");
        }
        bridge?.send(message);
      }
    } catch (error) {
      send({ type: "error", message: errorMessage(error) });
    }
  });
  sendControl();
  try {
    bridge = await connect(
      agent,
      (message) => {
        if (message.type === "command_done") {
          pendingCommands.delete(message.id);
          return;
        }
        if (message.type === "ready") connected = true;
        if (message.type === "status" && !message.connected) connected = false;
        send(message);
      },
      close,
      controller.signal,
    );
    if (closed) bridge.close();
  } catch (error) {
    send({ type: "error", message: errorMessage(error) });
    close();
  }
}
