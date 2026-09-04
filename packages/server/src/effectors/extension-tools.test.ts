import test from "node:test";
import assert from "node:assert/strict";
import { TEST_CONTEXT } from "./testing/pi-harness.ts";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createExtensionToolContext,
  loadExtensionToolProviders,
} from "./pi-0-85/extension-tools.ts";
import { collectAgentTools, type ToolProvisionContext } from "./contracts/tool-provider.ts";

const EXTENSION_SOURCE = `
export default function weather(pi) {
  pi.registerTool({
    name: "weather",
    label: "Weather",
    description: "Report the weather.",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      ctx.ui.notify("looking it up");
      return { content: [{ type: "text", text: "Sunny in " + params.city + " (cwd " + ctx.cwd + ")" }] };
    },
  });
}
`;

test("a real Pi extension's tool loads, runs, and receives the synthesized context", async () => {
  const root = extensionRoot(EXTENSION_SOURCE);
  const notices: string[] = [];

  const { providers, errors } = await loadExtensionToolProviders(
    { root, entries: ["weather"] },
    (agentId) => ({ cwd: `/workspaces/${agentId}`, agentId }),
    { notify: (message) => notices.push(message) },
  );

  assert.deepEqual(errors, [], JSON.stringify(errors));
  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.source, "extension");

  const { tools } = collectAgentTools(providers, context(), {
    enabledProviderIds: new Set(providers.map((provider) => provider.id)),
  });
  assert.deepEqual(tools.map((tool) => tool.name), ["weather"]);

  const result = await tools[0]!.execute("call-1", { city: "Lisbon" } as never, () => {}, undefined as never, {} as never, TEST_CONTEXT);
  assert.match(JSON.stringify(result), /Sunny in Lisbon/);
  // The context is built from the agent it is running for, not from a global.
  assert.match(JSON.stringify(result), /cwd \/workspaces\/agent_1/);
  assert.deepEqual(notices, ["looking it up"]);
});

test("an extension tool is not offered until the agent enables its provider", async () => {
  const root = extensionRoot(EXTENSION_SOURCE);
  const { providers } = await loadExtensionToolProviders(
    { root, entries: ["weather"] },
    (agentId) => ({ cwd: "/tmp", agentId }),
  );

  const { tools, skipped } = collectAgentTools(providers, context(), { enabledProviderIds: new Set() });
  assert.deepEqual(tools, []);
  assert.equal(skipped[0]?.reason, "provider_not_enabled");
});

test("reaching for a terminal capability fails by name instead of silently", () => {
  // The compatibility boundary, made legible. An extension that only registers
  // tools works; one that wants Pi's TUI is told exactly what is missing.
  const ctx = createExtensionToolContext({ cwd: "/tmp", agentId: "agent_1" }, {}) as Record<string, never>;

  assert.equal(ctx.cwd, "/tmp" as never);
  assert.equal(ctx.hasUI, false as never);
  // Cosmetic terminal calls do nothing rather than throwing: an extension that
  // sets a status line should not fail because nobody is watching a footer.
  assert.doesNotThrow(() => (ctx.ui as { setStatus: (a: string, b: string) => void }).setStatus("k", "v"));
  assert.throws(() => ctx.sessionManager, /sessionManager is not available in Carmel/);
  assert.throws(
    () => (ctx.ui as unknown as { custom: unknown }).custom,
    /ctx\.ui\.custom is not available in Carmel/,
  );
});

function extensionRoot(source: string) {
  const root = mkdtempSync(join(tmpdir(), "carmel-ext-"));
  const dir = join(root, "weather");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.ts"), source);
  return root;
}

function context(): ToolProvisionContext {
  return {
    agentId: "agent_1",
    workingDir: "/workspaces/agent_1",
    permissions: { read: true, write: false, edit: false, bash: false, network: false },
    env: {} as never,
  };
}
