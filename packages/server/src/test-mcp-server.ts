import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonRpcRequest, CallToolResult, Tool } from "@earendil-works/pi-mcp";

/** Real HTTP MCP fixture: exercise Pi's transport/protocol rather than mocking its client. */
export async function startMcpTestServer(options: {
  tools?: Tool[];
  onCall?: (request: JsonRpcRequest, response: ServerResponse) => CallToolResult | undefined;
  onNotification?: (request: JsonRpcRequest) => void;
} = {}) {
  const requests: Array<{ method: string; authorization?: string; message?: JsonRpcRequest }> = [];
  const server = createServer((request, response) => { void respond(request, response); });
  async function respond(request: IncomingMessage, response: ServerResponse) {
    const data = { method: request.method ?? "", authorization: request.headers.authorization, message: undefined as JsonRpcRequest | undefined };
    requests.push(data);
    if (request.method === "DELETE") { response.writeHead(200); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString()) as JsonRpcRequest;
    data.message = message;
    if (message.id === undefined) { options.onNotification?.(message); response.writeHead(202); response.end(); return; }
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2025-11-25", serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } };
    else if (message.method === "tools/list") result = { tools: options.tools ?? [{ name: "echo", description: "Echo a message", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
    else if (message.method === "tools/call") {
      result = options.onCall ? options.onCall(message, response) : { content: [{ type: "text", text: "echoed" }], structuredContent: { echo: true } };
      if (options.onCall && result === undefined) return;
      if (response.headersSent) return;
    } else result = {};
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
