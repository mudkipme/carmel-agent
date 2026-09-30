import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { AgentMcpServer } from "@carmel-agent/shared";
import type { AgentHarnessTool, ExecutionToolContext, JsonValue } from "@earendil-works/pi-agent-core";
import {
  McpClient,
  StreamableHttpTransport,
  toLlmContent,
  type McpTransport,
} from "@earendil-works/pi-mcp";
import type { agents } from "../db/schema.ts";
import { readAgentSecretEnv } from "../services/agent-secrets.ts";
import { errorMessage } from "../errors.ts";
import { sandboxEnv } from "./sandbox/bash-operations.ts";
import { ensureAgentContainer, holdAgentContainer, releaseAgentContainer, toContainerWorkdir } from "./sandbox/container-manager.ts";
import { attachExecStdio } from "./sandbox/podman.ts";
import { SandboxMcpTransport, sandboxMcpCommand } from "./sandbox/mcp-transport.ts";
import { createSecretRedactor } from "./sandbox/redaction.ts";

type AgentRecord = typeof agents.$inferSelect;
type Tool = AgentHarnessTool<ExecutionToolContext>;
type Secret = { name: string; value: string };
export type McpToolConnectionOptions = {
  signal?: AbortSignal;
  secrets?: Secret[];
  /** Host-supplied transport; Pi owns protocol, discovery, calls and cancellation. */
  createTransport?: (server: AgentMcpServer, signal: AbortSignal) => McpTransport;
};

/** Stable, provider-safe names even when raw names contain punctuation or exceed 64 chars. */
export function mcpToolName(serverId: string, toolName: string) {
  const hash = createHash("sha256").update(JSON.stringify([serverId, toolName])).digest("hex").slice(0, 12);
  return `mcp_${serverId}_${toolName}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 51) + `_${hash}`;
}

export function expandMcpSecrets(value: string, secrets: readonly Secret[]) {
  const values = new Map(secrets.map((secret) => [secret.name, secret.value]));
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const secret = values.get(name);
    if (secret === undefined) throw new Error(`Missing agent secret: ${name}.`);
    return secret;
  });
}

/** One MCP connection set per run, shared by that run's tool calls and closed at finalization. */
export class AgentMcpTools {
  readonly tools: Tool[] = [];
  readonly discoveredTools: Array<{ name: string; label: string }> = [];
  private readonly clients: McpClient[] = [];
  private readonly pendingCloses: Promise<void>[] = [];
  private closing?: Promise<void>;
  private closed = false;

  constructor(private readonly agent: AgentRecord, private readonly cwd: string) {}

  async connect(options: McpToolConnectionOptions = {}) {
    if (this.closed) throw new Error("MCP connections are closed.");
    const secrets = options.secrets ?? readAgentSecretEnv(this.agent.id);
    for (const server of this.agent.mcpServers ?? []) {
      if (!server.enabled || server.tools?.length === 0) continue;
      if (server.transport === "http" && !this.agent.permissions.network) continue;
      if (server.transport === "stdio" && !this.agent.permissions.bash) continue;
      const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(server.timeoutMs)]);
      signal.throwIfAborted();
      const client = new McpClient({
        name: "carmel-agent", version: "0.1.0", requestTimeoutMs: server.timeoutMs,
        roots: [{ uri: pathToFileURL(server.transport === "stdio" ? toContainerWorkdir(this.agent, this.cwd) : this.cwd).href, name: "workspace" }],
      });
      this.clients.push(client);
      const onAbort = () => { this.pendingCloses.push(client.close()); };
      signal.addEventListener("abort", onAbort, { once: true });
      let cancelConnect: (() => void) | undefined;
      try {
        const transport = options.createTransport?.(server, signal) ?? this.createTransport(server, secrets, signal);
        const cancelled = new Promise<never>((_resolve, reject) => {
          cancelConnect = () => reject(signal.reason);
          signal.addEventListener("abort", cancelConnect, { once: true });
        });
        await Promise.race([client.connect(transport), cancelled]);
        signal.throwIfAborted();
        const definitions = await client.listTools({ signal });
        this.discoveredTools.push(...definitions.map((tool) => ({ name: tool.name, label: redact(tool.title ?? tool.name, secrets) })));
        const names = new Set(definitions.map((tool) => tool.name));
        for (const selected of server.tools ?? []) {
          if (!names.has(selected)) throw new Error(`MCP tool '${selected}' is unavailable.`);
        }
        for (const definition of definitions) {
          if (server.tools && !server.tools.includes(definition.name)) continue;
          const tool: Tool = {
            name: mcpToolName(server.id, definition.name),
            label: redact(`MCP · ${server.id} · ${definition.title ?? definition.name}`, secrets),
            description: redact(`MCP server ${server.id}: ${definition.description ?? definition.name}`, secrets),
            // Pi accepts a JSON schema; keep the server's schema rather than rebuilding it.
            parameters: { ...definition.inputSchema, type: "object", properties: definition.inputSchema.properties ?? {} } as Tool["parameters"],
            outputSchema: definition.outputSchema as Tool["outputSchema"],
            async execute(_id, params, onUpdate, _context, _invocation, context) {
              try {
                const result = await client.callTool(definition.name, params as Record<string, unknown>, {
                  signal: context.abortSignal,
                  timeoutMs: server.timeoutMs,
                  onProgress: (progress) => onUpdate({
                    content: [{ type: "text", text: redact(progress.message ?? `Progress: ${progress.progress}${progress.total === undefined ? "" : `/${progress.total}`}`, secrets) }],
                    details: { serverId: server.id, toolName: definition.name, progress: progress.progress, ...(progress.total === undefined ? {} : { total: progress.total }) },
                  }),
                });
                const structuredContent = result.structuredContent === undefined ? undefined : redactValue(result.structuredContent, secrets) as JsonValue;
                return {
                  content: toLlmContent(result).map((part) => part.type === "text" ? { ...part, text: redact(part.text, secrets) } : part),
                  details: { serverId: server.id, toolName: definition.name, ...(structuredContent === undefined ? {} : { structuredContent }) },
                  structuredContent,
                  isError: result.isError === true,
                };
              } catch (error) {
                throw new Error(redact(`MCP ${server.id}/${definition.name}: ${errorMessage(error)}`, secrets));
              }
            },
          };
          this.tools.push(tool);
        }
      } catch (error) {
        await this.close();
        throw new Error(redact(`MCP server '${server.id}': ${errorMessage(error)}`, secrets));
      } finally {
        signal.removeEventListener("abort", onAbort);
        if (cancelConnect) signal.removeEventListener("abort", cancelConnect);
      }
    }
  }

  private createTransport(server: AgentMcpServer, secrets: Secret[], signal: AbortSignal): McpTransport {
    const expand = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandMcpSecrets(value, secrets)]));
    if (server.transport === "http") return new StreamableHttpTransport({ url: server.url, headers: expand(server.headers) });
    let held = false;
    return new SandboxMcpTransport(async () => {
      const agent = this.agent;
      const containerId = await ensureAgentContainer(agent, { network: agent.permissions.network });
      signal.throwIfAborted();
      holdAgentContainer(agent.id);
      held = true;
      const { socket } = await attachExecStdio(containerId, {
        cmd: sandboxMcpCommand(server.command, server.args.map((arg) => expandMcpSecrets(arg, secrets))),
        workingDir: toContainerWorkdir(agent, this.cwd),
        env: sandboxEnv({ PATH: "/home/agent/.npm-global/bin:/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", ...expand(server.env) }, secrets),
      }, signal);
      return socket;
    }, () => { if (held) { held = false; releaseAgentContainer(this.agent.id); } });
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.allSettled([...this.pendingCloses, ...this.clients.map((client) => client.close())]).then(() => {});
    return this.closing;
  }
}

function redact(value: string, secrets: readonly Secret[]) {
  const redactor = createSecretRedactor(secrets);
  return redactor.push(value) + redactor.flush();
}

function redactValue(value: unknown, secrets: readonly Secret[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry, secrets)]));
  return value;
}
