import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { AgentHarnessTool, ExecutionToolContext } from "../effectors/pi-durable/index.ts";
import { guardBrowserHandoff } from "./browser-tools.ts";
import { browserControl, deleteBrowserControl } from "./browser-control.ts";
import { TEST_CONTEXT } from "../effectors/testing/pi-harness.ts";

test("manual handoff invalidates a prepared action even when it was not waiting inside a tool", async () => {
  const agentId = `browser-test-${randomUUID()}`;
  let effects = 0;
  const tool: AgentHarnessTool<ExecutionToolContext> = {
    name: "effect", label: "Effect", description: "test", parameters: { type: "object", properties: {} },
    execute: async () => { effects++; return { content: [], details: {} }; },
  };
  const wrapped = guardBrowserHandoff(agentId, tool, { revision: 0 });
  const args = ["call", {}, () => {}, {} as ExecutionToolContext, {} as Parameters<typeof wrapped.execute>[4], TEST_CONTEXT] as const;
  try {
    await wrapped.execute(...args);
    assert.equal(effects, 1);
    const control = browserControl(agentId);
    control.take("person", "Person");
    control.resume("person");
    const stale = await wrapped.execute(...args);
    assert.equal(effects, 1);
    assert.match(JSON.stringify(stale), /not executed/);
    await wrapped.execute(...args);
    assert.equal(effects, 2);
  } finally { deleteBrowserControl(agentId); }
});
