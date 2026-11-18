import { StringDecoder } from "node:string_decoder";
import type { Duplex } from "node:stream";
import { attachExecStdio, createStreamDemuxer } from "./runtime-client.ts";
import {
  ensureEnvironmentContainer,
  holdEnvironmentContainer,
  releaseEnvironmentContainer,
  containerWorkspace,
  type EnvironmentRecord,
} from "./container-manager.ts";
import { sandboxEnv } from "./bash-operations.ts";
import { browserBridgeScript } from "./browser-bridge.ts";
import { parseBrowserOutput } from "../../browser-protocol.ts";

export type BrowserConnection = { send: (message: unknown) => void; close: () => void };
const connections = new Map<string, Set<BrowserConnection>>();
const generations = new Map<string, number>();

/** Each viewer gets its own paced stream. All attach to the same environment browser. */
export async function connectBrowser(
  environment: EnvironmentRecord,
  onMessage: (message: NonNullable<ReturnType<typeof parseBrowserOutput>>) => void,
  onClose: () => void,
  signal?: AbortSignal,
): Promise<BrowserConnection> {
  const generation = generations.get(environment.id) ?? 0;
  const containerId = await ensureEnvironmentContainer(environment);
  signal?.throwIfAborted();
  holdEnvironmentContainer(environment.id);
  let socket: Duplex | undefined;
  let closed = false;
  const connection: BrowserConnection = {
    send(message) {
      if (!closed && socket && socket.writableLength < 1024 * 1024)
        socket.write(`${JSON.stringify(message)}\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", connection.close);
      // EOF stops only this bridge, preserving Chromium and the profile.
      socket?.end();
      const attached = socket;
      setTimeout(() => attached?.destroy(), 1000).unref();
      connections.get(environment.id)?.delete(connection);
      if (!connections.get(environment.id)?.size) connections.delete(environment.id);
      releaseEnvironmentContainer(environment.id);
      onClose();
    },
  };
  signal?.addEventListener("abort", connection.close, { once: true });
  try {
    const attached = await attachExecStdio(
      containerId,
      {
        cmd: ["node", "-e", browserBridgeScript],
        workingDir: containerWorkspace,
        env: sandboxEnv({ AGENT_BROWSER_SESSION: "carmel" }),
      },
      signal,
    );
    socket = attached.socket;
    if (closed || signal?.aborted || (generations.get(environment.id) ?? 0) !== generation) {
      socket.end();
      socket.destroy();
      connection.close();
      throw new Error("Browser connection was cancelled.");
    }
    const viewers = connections.get(environment.id) ?? new Set();
    viewers.add(connection);
    connections.set(environment.id, viewers);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const demux = createStreamDemuxer(
      (stream, chunk) => {
        if (stream !== 1) return;
        pending += decoder.write(chunk);
        if (pending.length > 16 * 1024 * 1024) throw new Error("Browser frame exceeds the limit.");
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (line) {
            const message = parseBrowserOutput(JSON.parse(line));
            if (message) onMessage(message);
          }
        }
      },
      16 * 1024 * 1024,
    );
    socket.on("data", (chunk: Buffer) => {
      try {
        demux(chunk);
      } catch {
        connection.close();
      }
    });
    socket.on("error", connection.close);
    socket.on("close", connection.close);
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

export function closeEnvironmentBrowsers(environmentId: string) {
  generations.set(environmentId, (generations.get(environmentId) ?? 0) + 1);
  for (const connection of connections.get(environmentId) ?? []) connection.close();
}
export function shutdownBrowsers() {
  for (const environmentId of connections.keys()) closeEnvironmentBrowsers(environmentId);
}
