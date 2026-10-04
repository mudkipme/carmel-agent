import { StringDecoder } from "node:string_decoder";
import type { Duplex } from "node:stream";
import {
  McpConnectionClosedError,
  parseJsonRpcMessage,
  type JsonRpcMessage,
  type McpTransport,
  type McpTransportMessageListener,
  type McpTransportErrorListener,
  type McpTransportCloseListener,
} from "@earendil-works/pi-mcp";
import { createStreamDemuxer } from "./runtime-client.ts";

/** Bridge Docker's multiplexed exec socket to Pi's public MCP transport interface. */
export class SandboxMcpTransport implements McpTransport {
  private socket?: Duplex;
  private closed = false;
  private closing?: Promise<void>;
  private readonly messages = new Set<McpTransportMessageListener>();
  private readonly errors = new Set<McpTransportErrorListener>();
  private readonly closes = new Set<McpTransportCloseListener>();

  constructor(private readonly open: () => Promise<Duplex>, private readonly release: () => void) {}

  onMessage(listener: McpTransportMessageListener) { this.messages.add(listener); return () => { this.messages.delete(listener); }; }
  onError(listener: McpTransportErrorListener) { this.errors.add(listener); return () => { this.errors.delete(listener); }; }
  onClose(listener: McpTransportCloseListener) { this.closes.add(listener); return () => { this.closes.delete(listener); }; }

  async start() {
    if (this.closed) throw new McpConnectionClosedError();
    const socket = await this.open();
    if (this.closed) { socket.destroy(); this.release(); throw new McpConnectionClosedError(); }
    this.socket = socket;
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const demux = createStreamDemuxer((stream, chunk) => {
      // stderr must never enter the JSON-RPC parser or a model transcript.
      if (stream !== 1) return;
      pending += decoder.write(chunk);
      let end: number;
      try {
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw new Error("MCP message exceeds 16 MiB.");
          if (!line.trim()) continue;
          const message = parseJsonRpcMessage(JSON.parse(line));
          for (const listener of this.messages) listener(message);
        }
        if (Buffer.byteLength(pending) > 16 * 1024 * 1024) throw new Error("MCP message exceeds 16 MiB.");
      } catch {
        for (const listener of this.errors) listener(new Error("Invalid MCP stdio message."));
        void this.close();
      }
    }, 16 * 1024 * 1024);
    socket.on("data", (chunk: Buffer) => {
      try { demux(chunk); } catch {
        for (const listener of this.errors) listener(new Error("Invalid MCP stdio frame."));
        void this.close();
      }
    });
    socket.on("error", (error) => { for (const listener of this.errors) listener(error); void this.close(); });
    socket.on("close", () => { void this.close(); });
  }

  async send(message: JsonRpcMessage) {
    if (this.closed || !this.socket) throw new McpConnectionClosedError();
    const socket = this.socket;
    await new Promise<void>((resolve, reject) => socket.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve()));
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.finishClose();
    return this.closing;
  }

  private async finishClose() {
    // EOF closes the MCP server's stdin. Never kill a container shared with a terminal.
    const socket = this.socket;
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { socket.destroy(); resolve(); }, 1000);
        socket.end(() => { clearTimeout(timeout); socket.destroy(); resolve(); });
      });
    }
    this.release();
    for (const listener of this.closes) listener();
  }
}

/** Keep MCP subprocesses inside the runner and terminate their process group on stdin EOF. */
export function sandboxMcpCommand(command: string, args: string[]) {
  return ["node", "-e", sandboxMcpSupervisor, "--", command, ...args];
}

// This supervisor only owns process lifetime; Pi owns every MCP protocol operation.
const sandboxMcpSupervisor = `
const { spawn } = require("node:child_process");
const child = spawn(process.argv[1], process.argv.slice(2), { stdio: ["pipe", "inherit", "inherit"], detached: true });
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  process.stdin.unpipe(child.stdin);
  child.stdin.end();
  if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} process.exit(0); }, 2000);
  } else process.exit(1);
}
process.stdin.pipe(child.stdin);
process.stdin.on("end", stop);
process.stdin.on("error", stop);
child.stdin.on("error", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", () => { process.stderr.write("MCP command could not be started.\\n"); stop(); });
child.on("exit", stop);
`;
