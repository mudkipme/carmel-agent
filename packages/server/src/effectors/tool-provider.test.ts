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

test("the first provider owns a duplicate tool name", () => {
  const first = provider("carmel.bash", [tool("bash", "bash")]);
  const second = provider("other", [tool("bash", "bash")]);
  const { tools, skipped } = collectAgentTools([first, second], context({ bash: true }));

  assert.equal(tools.length, 1);
  assert.equal(tools[0], first.provide(context({ bash: true }))[0]?.tool);
  assert.deepEqual(skipped, [
    { providerId: "other", toolName: "bash", reason: "name_taken", takenBy: "carmel.bash" },
  ]);
});

function provider(id: string, tools: ProvidedTool[]): ToolProvider {
  return {
    id,
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
