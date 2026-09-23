import test from "node:test";
import assert from "node:assert/strict";
import { migrate } from "../db/index.ts";
import { createSession } from "../test-support.ts";
import { openPiSession } from "../services/pi-session-storage.ts";
import { attachTestHarness, fauxHarnessModels, TEST_CONTEXT } from "./testing/pi-harness.ts";
import { reconcileLaneConfiguration, type PiConfigLane } from "./pi-0-87/agent-driver.ts";
import { FakeSessionLog } from "./testing/fake-session-log.ts";
import { runSessionLogContract } from "./testing/session-log-contract.ts";
import { dispatchPrompt } from "./dispatch-prompt.ts";
import type { DriverResources, PromptDispatcher } from "./contracts/agent-driver.ts";

migrate();

// Both implementations answer to the same suite. That equivalence is what lets
// tests above the port use the fake, and what will decide whether a v2 adapter
// is finished.
const piHarnessOptions = fauxHarnessModels();
const piModel = piHarnessOptions.model;

await runSessionLogContract({ name: "FakeSessionLog", create: () => new FakeSessionLog() }, (name, run) =>
  test(name, run),
);

await runSessionLogContract(
  {
    name: "PiSessionLog",
    async create() {
      const { sessionId } = createSession();
      // 0.85 keeps per-lane configuration off the session tree, so the adapter
      // needs an open lane -- and a lane needs a harness, faux provider and all.
      const pi = await attachTestHarness(await openPiSession(sessionId), piHarnessOptions);
      return pi.log;
    },
    dispose: (log) => log.close(),
  },
  (name, run) => test(name, run),
);

test("lane configuration round-trips through a real lane, tool order included", async () => {
  const { sessionId } = createSession();
  const pi = await attachTestHarness(await openPiSession(sessionId), piHarnessOptions);
  try {
    await reconcileLaneConfiguration(pi.lane, pi.context, {
      model: piModel,
      thinkingLevel: "medium",
      activeToolNames: ["read", "bash"],
    });
    const model = await pi.lane.getModel(pi.context);
    assert.deepEqual([model?.provider, model?.id], [piModel.provider, piModel.id]);
    assert.equal(await pi.lane.getThinkingLevel(pi.context), "medium");
    assert.deepEqual(await pi.lane.getActiveTools(pi.context), ["read", "bash"]);

    // Order is part of the cached prompt prefix, so a reorder is a real change.
    await reconcileLaneConfiguration(pi.lane, pi.context, {
      model: piModel,
      thinkingLevel: "medium",
      activeToolNames: ["bash", "read"],
    });
    assert.deepEqual(await pi.lane.getActiveTools(pi.context), ["bash", "read"]);
  } finally {
    await pi.close();
  }
});

test("lane reconciliation writes only what differs", async () => {
  const writes: string[] = [];
  const state = { model: { provider: piModel.provider, id: piModel.id }, thinkingLevel: "off", tools: ["read"] };
  const lane = {
    getModel: async () => state.model,
    setModel: async () => void writes.push("model"),
    getThinkingLevel: async () => state.thinkingLevel,
    setThinkingLevel: async () => void writes.push("thinking"),
    getActiveTools: async () => state.tools,
    setActiveTools: async () => void writes.push("tools"),
  } as unknown as PiConfigLane;

  await reconcileLaneConfiguration(lane, TEST_CONTEXT, { model: piModel, thinkingLevel: "off", activeToolNames: ["read"] });
  assert.deepEqual(writes, [], "matching configuration must not be rewritten");

  await reconcileLaneConfiguration(lane, TEST_CONTEXT, { model: piModel, thinkingLevel: "high", activeToolNames: ["read"] });
  assert.deepEqual(writes, ["thinking"]);
});

test("plain text goes straight to prompt", async () => {
  const { driver, calls } = recordingDriver();
  await dispatchPrompt(driver, "hello");
  assert.deepEqual(calls, [["prompt", "hello", undefined]]);
});

test("a namespaced skill command invokes the skill with trimmed arguments", async () => {
  const { driver, calls } = recordingDriver({ skills: [{ name: "pdf" }], promptTemplates: [] });
  await dispatchPrompt(driver, "/skill:pdf   summarise it  ");
  assert.deepEqual(calls, [["invokeSkill", "pdf", "summarise it", undefined]]);
});

test("a skill command with no arguments passes undefined, not an empty string", async () => {
  const { driver, calls } = recordingDriver({ skills: [{ name: "pdf" }], promptTemplates: [] });
  await dispatchPrompt(driver, "/skill:pdf");
  assert.deepEqual(calls, [["invokeSkill", "pdf", undefined, undefined]]);
});

test("a template command keeps its arguments untrimmed for the driver to parse", async () => {
  const { driver, calls } = recordingDriver({ skills: [], promptTemplates: [{ name: "review" }] });
  await dispatchPrompt(driver, "/review a=1 b=2");
  assert.deepEqual(calls, [["invokeTemplate", "review", "a=1 b=2", undefined]]);
});

test("a skill: token matching no skill falls through to a template of that exact name", async () => {
  const { driver, calls } = recordingDriver({ skills: [], promptTemplates: [{ name: "skill:pdf" }] });
  await dispatchPrompt(driver, "/skill:pdf go");
  assert.deepEqual(calls, [["invokeTemplate", "skill:pdf", "go", undefined]]);
});

test("an unknown command is sent as ordinary text, slash and all", async () => {
  const { driver, calls } = recordingDriver();
  await dispatchPrompt(driver, "/nope do a thing");
  assert.deepEqual(calls, [["prompt", "/nope do a thing", undefined]]);
});

test("images ride along with a named invocation rather than forcing plain text", async () => {
  // The inlining workaround belongs to the driver; dispatch must not pre-empt it.
  const images = [{ type: "image" as const, data: "AA==", mimeType: "image/png" }];
  const { driver, calls } = recordingDriver({ skills: [{ name: "pdf" }], promptTemplates: [] });
  await dispatchPrompt(driver, "/skill:pdf look", images);
  assert.deepEqual(calls, [["invokeSkill", "pdf", "look", images]]);
});

function recordingDriver(resources: DriverResources = { skills: [], promptTemplates: [] }) {
  const calls: unknown[][] = [];
  const driver: PromptDispatcher = {
    listResources: async () => resources,
    async prompt(text, images) {
      calls.push(["prompt", text, images]);
    },
    async invokeSkill(name, instructions, images) {
      calls.push(["invokeSkill", name, instructions, images]);
    },
    async invokeTemplate(name, args, images) {
      calls.push(["invokeTemplate", name, args, images]);
    },
  };
  return { driver, calls };
}
