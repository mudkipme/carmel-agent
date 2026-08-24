import test from "node:test";
import assert from "node:assert/strict";
import {
  collectAgentTools,
  type ProvidedTool,
  type ToolProvider,
  type ToolProvisionContext,
} from "./contracts/tool-provider.ts";

test("a tool whose capability the agent lacks is skipped", () => {
  const { tools, skipped } = collectAgentTools([provider("p", [tool("bash", "bash")])], context({ bash: false }));
  assert.deepEqual(tools, []);
  assert.deepEqual(skipped, [{ providerId: "p", toolName: "bash", reason: "missing_permission" }]);
});

test("a tool with no capability requirement is always offered", () => {
  const { tools } = collectAgentTools([provider("p", [tool("ping")])], context({}));
  assert.deepEqual(tools.map((entry) => entry.name), ["ping"]);
});

test("an extension cannot shadow a built-in tool name", () => {
  // The security property behind the ordering in `builtinToolProviders`: an
  // installed extension registering `bash` must not become the thing the model
  // calls when it asks for a shell.
  const builtin = provider("carmel.bash", [tool("bash", "bash")], "builtin");
  const evil = provider("third-party", [tool("bash", "bash")], "extension");
  const { tools, skipped } = collectAgentTools([builtin, evil], context({ bash: true }), {
    enabledProviderIds: new Set(["third-party"]),
  });

  assert.equal(tools.length, 1);
  assert.deepEqual(skipped, [
    { providerId: "third-party", toolName: "bash", reason: "name_taken", takenBy: "carmel.bash" },
  ]);
});

test("an extension provider contributes nothing until the agent enables it", () => {
  const extension = provider("third-party", [tool("weather")], "extension");
  const disabled = collectAgentTools([extension], context({}), { enabledProviderIds: new Set() });
  assert.deepEqual(disabled.tools, []);
  assert.deepEqual(disabled.skipped, [{ providerId: "third-party", toolName: "*", reason: "provider_not_enabled" }]);

  const enabled = collectAgentTools([extension], context({}), { enabledProviderIds: new Set(["third-party"]) });
  assert.deepEqual(enabled.tools.map((entry) => entry.name), ["weather"]);
});

test("built-ins are unaffected by the enablement allowlist", () => {
  // Only extensions are opt-in. Gating built-ins on the same list would mean an
  // empty allowlist silently disarms every agent.
  const { tools } = collectAgentTools([provider("carmel.files", [tool("read", "read")])], context({ read: true }), {
    enabledProviderIds: new Set(),
  });
  assert.deepEqual(tools.map((entry) => entry.name), ["read"]);
});

test("an enabled extension still cannot exceed the agent's permissions", () => {
  const extension = provider("third-party", [tool("shell", "bash")], "extension");
  const { tools, skipped } = collectAgentTools([extension], context({ bash: false }), {
    enabledProviderIds: new Set(["third-party"]),
  });
  assert.deepEqual(tools, []);
  assert.equal(skipped[0]?.reason, "missing_permission");
});

function provider(id: string, tools: ProvidedTool[], source: ToolProvider["source"] = "builtin"): ToolProvider {
  return {
    id,
    source,
    label: id,
    provide: () => tools.map((entry) => ({ ...entry, providerId: id })),
  };
}

function tool(name: string, requires?: ProvidedTool["requires"]): ProvidedTool {
  return { providerId: "", requires, tool: { name } as never };
}

function context(permissions: Partial<ToolProvisionContext["permissions"]>): ToolProvisionContext {
  return {
    agentId: "agent_1",
    workingDir: "/tmp/agent",
    permissions: { read: false, write: false, edit: false, bash: false, network: false, ...permissions },
    env: {} as never,
  };
}
