import { StringDecoder } from "node:string_decoder";
import type { Duplex } from "node:stream";
import type { agents } from "../../db/schema.ts";
import { attachExecStdio, createStreamDemuxer } from "./runtime-client.ts";
import { ensureAgentContainer, holdAgentContainer, releaseAgentContainer, toContainerWorkdir } from "./container-manager.ts";
import { resolveAgentWorkingDirPath } from "../resources.ts";
import { sandboxEnv } from "./bash-operations.ts";
import { browserBridgeScript } from "./browser-bridge.ts";
import { parseBrowserOutput } from "../../browser-protocol.ts";

type AgentRecord = typeof agents.$inferSelect;
export type BrowserConnection = { send: (message: unknown) => void; close: () => void };
const connections = new Map<string, Set<BrowserConnection>>();
const generations = new Map<string, number>();

/** Each viewer gets its own paced stream. All attach to the same agent browser. */
export async function connectBrowser(
  agent: AgentRecord,
  onMessage: (message: NonNullable<ReturnType<typeof parseBrowserOutput>>) => void,
  onClose: () => void,
  signal?: AbortSignal,
): Promise<BrowserConnection> {
  const generation = generations.get(agent.id) ?? 0;
  const containerId = await ensureAgentContainer(agent, { network: agent.permissions.network });
  signal?.throwIfAborted();
  holdAgentContainer(agent.id);
  let socket: Duplex | undefined;
  let closed = false;
  const connection: BrowserConnection = {
    send(message) { if (!closed && socket && socket.writableLength < 1024 * 1024) socket.write(`${JSON.stringify(message)}\n`); },
    close() {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", connection.close);
      // EOF stops only this bridge, preserving Chromium and the profile.
      socket?.end();
      const attached = socket;
      setTimeout(() => attached?.destroy(), 1000).unref();
      connections.get(agent.id)?.delete(connection);
      if (!connections.get(agent.id)?.size) connections.delete(agent.id);
      releaseAgentContainer(agent.id);
      onClose();
    },
  };
  signal?.addEventListener("abort", connection.close, { once: true });
  try {
    const attached = await attachExecStdio(containerId, {
      cmd: ["node", "-e", browserBridgeScript],
      workingDir: toContainerWorkdir(agent, resolveAgentWorkingDirPath(agent)),
      env: sandboxEnv({ AGENT_BROWSER_SESSION: "carmel" }),
    }, signal);
    socket = attached.socket;
    if (closed || signal?.aborted || (generations.get(agent.id) ?? 0) !== generation) {
      socket.end(); socket.destroy(); connection.close();
      throw new Error("Browser connection was cancelled.");
    }
    const viewers = connections.get(agent.id) ?? new Set();
    viewers.add(connection); connections.set(agent.id, viewers);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const demux = createStreamDemuxer((stream, chunk) => {
      if (stream !== 1) return;
      pending += decoder.write(chunk);
      if (pending.length > 16 * 1024 * 1024) throw new Error("Browser frame exceeds the limit.");
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line) {
          const message = parseBrowserOutput(JSON.parse(line));
          if (message) onMessage(message);
        }
      }
    }, 16 * 1024 * 1024);
    socket.on("data", (chunk: Buffer) => { try { demux(chunk); } catch { connection.close(); } });
    socket.on("error", connection.close);
    socket.on("close", connection.close);
    return connection;
  } catch (error) { connection.close(); throw error; }
}

export function closeAgentBrowsers(agentId: string) {
  generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
  for (const connection of connections.get(agentId) ?? []) connection.close();
}
export function shutdownBrowsers() {
  for (const agentId of connections.keys()) closeAgentBrowsers(agentId);
}
