import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { agentMcpServerSchema, type AgentMcpServer, type AgentPermissions } from "@carmel-agent/shared";
import { SectionHeader } from "@/components/harness/form-primitives";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

export function AgentMcpSettings({ agentId, servers, permissions, onChange }: {
  agentId: string; servers: AgentMcpServer[]; permissions: AgentPermissions; onChange: (servers: AgentMcpServer[]) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [values, setValues] = useState("{}");
  const [tools, setTools] = useState("");
  const [allTools, setAllTools] = useState(true);
  const [timeoutMs, setTimeoutMs] = useState(60_000);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { message: string; error: boolean }>>({});

  const reset = () => {
    setEditing(null); setId(""); setUrl(""); setCommand(""); setArgs(""); setValues("{}"); setTools(""); setAllTools(true); setTimeoutMs(60_000); setError(null);
  };
  const edit = (server: AgentMcpServer) => {
    setEditing(server.id); setId(server.id); setTransport(server.transport);
    setUrl(server.transport === "http" ? server.url : "");
    setCommand(server.transport === "stdio" ? server.command : "");
    setArgs(server.transport === "stdio" ? server.args.join("\n") : "");
    setValues(JSON.stringify(server.transport === "http" ? server.headers : server.env, null, 2));
    setTools(server.tools?.join("\n") ?? ""); setAllTools(server.tools === undefined); setTimeoutMs(server.timeoutMs); setError(null);
  };
  const save = () => {
    try {
      const server = agentMcpServerSchema.parse({
        id: id.trim(), transport, timeoutMs,
        enabled: servers.find((entry) => entry.id === editing)?.enabled ?? true,
        tools: allTools ? undefined : tools.split("\n").map((name) => name.trim()).filter(Boolean),
        ...(transport === "http" ? { url: url.trim(), headers: JSON.parse(values) } : {
          command: command.trim(), args: args.split("\n").filter((arg) => arg.length > 0), env: JSON.parse(values),
        }),
      });
      if (servers.some((entry) => entry.id === server.id && entry.id !== editing)) throw new Error("Choose a unique server ID.");
      onChange(editing ? servers.map((entry) => entry.id === editing ? server : entry) : [...servers, server]);
      reset();
    } catch (error) {
      setError(errorMessage(error, "Check the server configuration."));
    }
  };
  const test = async (server: AgentMcpServer) => {
    setTesting(server.id);
    try {
      const result = await api.testAgentMcpServer(agentId, server);
      setResults((current) => ({ ...current, [server.id]: { error: false, message: `${result.tools.length} tools available${result.tools.length ? `: ${result.tools.map((tool) => tool.name).join(", ")}` : "."}` } }));
    } catch (error) {
      setResults((current) => ({ ...current, [server.id]: { error: true, message: errorMessage(error, "Connection failed.") } }));
    } finally { setTesting(null); }
  };

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader title="MCP servers" description="Connect this agent to tools from Model Context Protocol servers. Save changes to apply them to the next run." />
      {servers.map((server) => (
        <FieldSet key={server.id} className="rounded-md border p-3">
          <FieldLegend>{server.id}</FieldLegend>
          <FieldDescription>{server.transport === "http" ? server.url : [server.command, ...server.args].join(" ")}</FieldDescription>
          <FieldGroup>
            <Field orientation="horizontal">
              <Switch id={`mcp-enabled-${server.id}`} checked={server.enabled}
                onCheckedChange={(enabled) => onChange(servers.map((entry) => entry.id === server.id ? { ...entry, enabled } : entry))} />
              <FieldLabel htmlFor={`mcp-enabled-${server.id}`}>Enabled</FieldLabel>
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => edit(server)}>Edit</Button>
              <Button type="button" variant="outline" size="sm" disabled={testing !== null} onClick={() => void test(server)}>
                {testing === server.id ? "Connecting..." : "Test connection"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { onChange(servers.filter((entry) => entry.id !== server.id)); if (editing === server.id) reset(); }}>
                <Trash2Icon data-icon="inline-start" /> Remove
              </Button>
            </div>
            {results[server.id] ? <Field data-invalid={results[server.id].error}>
              {results[server.id].error ? <FieldError>{results[server.id].message}</FieldError> : <FieldDescription>{results[server.id].message}</FieldDescription>}
            </Field> : null}
          </FieldGroup>
        </FieldSet>
      ))}
      <FieldSet className="rounded-md border p-3">
        <FieldLegend>{editing ? `Edit ${editing}` : "Add server"}</FieldLegend>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="mcp-id">Server ID</FieldLabel>
            <Input id="mcp-id" value={id} onChange={(event) => setId(event.target.value)} placeholder="github" />
            <FieldDescription>Up to 32 letters, numbers, underscores, or hyphens.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="mcp-transport">Connection</FieldLabel>
            <Select value={transport} onValueChange={(value: "http" | "stdio") => { setTransport(value); setValues("{}"); }}>
              <SelectTrigger id="mcp-transport"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup><SelectItem value="http">Remote HTTP</SelectItem><SelectItem value="stdio">Sandbox stdio</SelectItem></SelectGroup></SelectContent>
            </Select>
            <FieldDescription>{transport === "http" ? "Requires network permission." : "Runs inside the agent sandbox and requires bash permission. The command must be installed in the runner."}
              {!permissions[transport === "http" ? "network" : "bash"] ? " Enable and save that permission before connecting." : ""}
            </FieldDescription>
          </Field>
          {transport === "http" ? <Field>
            <FieldLabel htmlFor="mcp-url">Server URL</FieldLabel>
            <Input id="mcp-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/mcp" />
          </Field> : <>
            <Field><FieldLabel htmlFor="mcp-command">Command</FieldLabel><Input id="mcp-command" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="npx" /></Field>
            <Field><FieldLabel htmlFor="mcp-args">Arguments</FieldLabel><Textarea id="mcp-args" value={args} onChange={(event) => setArgs(event.target.value)} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/workspace"} /><FieldDescription>One argument per line. Arguments are passed directly without shell expansion.</FieldDescription></Field>
          </>}
          <Field>
            <FieldLabel htmlFor="mcp-values">{transport === "http" ? "HTTP headers" : "Environment variables"}</FieldLabel>
            <Textarea id="mcp-values" value={values} onChange={(event) => setValues(event.target.value)} />
            <FieldDescription>{'Enter a JSON object of string values. Use ${SECRET_NAME} to reference an agent secret.'}</FieldDescription>
          </Field>
          <Field orientation="horizontal"><Switch id="mcp-all-tools" checked={allTools} onCheckedChange={setAllTools} /><FieldLabel htmlFor="mcp-all-tools">Expose all tools</FieldLabel></Field>
          {!allTools ? <Field><FieldLabel htmlFor="mcp-tools">Allowed tools</FieldLabel><Textarea id="mcp-tools" value={tools} onChange={(event) => setTools(event.target.value)} /><FieldDescription>One original tool name per line. An empty list exposes no tools.</FieldDescription></Field> : null}
          <Field><FieldLabel htmlFor="mcp-timeout">Request timeout (seconds)</FieldLabel><Input id="mcp-timeout" type="number" min={1} max={300} value={timeoutMs / 1000} onChange={(event) => setTimeoutMs(Number(event.target.value) * 1000)} /></Field>
          {error ? <Field data-invalid><FieldError>{error}</FieldError></Field> : null}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={save}><PlusIcon data-icon="inline-start" />{editing ? "Update server" : "Add server"}</Button>
            {editing ? <Button type="button" variant="ghost" onClick={reset}>Cancel</Button> : null}
          </div>
        </FieldGroup>
      </FieldSet>
    </section>
  );
}
